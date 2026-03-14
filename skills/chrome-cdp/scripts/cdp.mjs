#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import net from 'net';
import { homedir, platform, tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const SOCKET_MODE = 0o600;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ALLOW_UNSAFE_ENV = 'CDP_ALLOW_UNSAFE';

process.umask(0o077);

const RUNTIME_ROOT = initRuntimeRoot();
const PAGES_CACHE = join(RUNTIME_ROOT, 'pages.json');
const DAEMONS_DIR = join(RUNTIME_ROOT, 'daemons');
// Test-only hooks that let the unit tests fake socket classification,
// connections, and process spawning without affecting production behavior.
const testHooks = {
  isSocketFile: null,
  connectToSocket: null,
  spawn: null,
};

// Prefer an OS-specific private runtime directory, but fall back to a
// per-user tmpdir location when the preferred path is unavailable.
function runtimeRootCandidates() {
  const candidates = [];
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir) candidates.push(join(xdgRuntimeDir, 'chrome-cdp'));
  if (platform() === 'darwin') candidates.push(resolve(homedir(), 'Library/Caches/chrome-cdp/runtime'));
  const uid = typeof process.getuid === 'function' ? process.getuid() : basename(homedir()) || 'user';
  candidates.push(resolve(tmpdir(), `chrome-cdp-${uid}`));
  return candidates;
}

function initRuntimeRoot() {
  const errors = [];
  for (const candidate of runtimeRootCandidates()) {
    try {
      ensurePrivateDir(candidate);
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Unable to create a private runtime directory. Tried: ${errors.join('; ')}`);
}

function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

// Runtime files are created with owner-only permissions so daemon metadata and
// tokens are not exposed through world-readable temp files.
function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  chmodSync(dirPath, DIR_MODE);
  const stats = statSync(dirPath);
  if (!stats.isDirectory()) throw new Error(`Runtime path is not a directory: ${dirPath}`);
  if ((stats.mode & 0o777) !== DIR_MODE) {
    throw new Error(`Runtime directory must be owner-only (0700): ${dirPath}`);
  }
}

function ensurePrivateFile(filePath) {
  if (!existsSync(filePath)) return;
  chmodSync(filePath, FILE_MODE);
  const stats = statSync(filePath);
  if ((stats.mode & 0o777) !== FILE_MODE) {
    throw new Error(`Runtime file must be owner-only (0600): ${filePath}`);
  }
}

function writePrivateFile(filePath, content) {
  ensurePrivateDir(dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomHex(4)}.tmp`;
  writeFileSync(tempPath, content, { mode: FILE_MODE });
  chmodSync(tempPath, FILE_MODE);
  renameSync(tempPath, filePath);
  ensurePrivateFile(filePath);
}

function writePrivateJson(filePath, value) {
  writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// The runtime root contains cache files plus a per-daemon metadata directory.
function ensureRuntimeRoot() {
  ensurePrivateDir(RUNTIME_ROOT);
  ensurePrivateDir(DAEMONS_DIR);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isWithinDir(filePath, dirPath) {
  if (!filePath || !dirPath) return false;
  const resolvedDir = `${resolve(dirPath)}/`;
  const resolvedPath = resolve(filePath);
  return resolvedPath.startsWith(resolvedDir);
}

function isSocketFile(filePath) {
  if (testHooks.isSocketFile) return testHooks.isSocketFile(filePath);
  try {
    return statSync(filePath).isSocket();
  } catch {
    return false;
  }
}

function safeRemoveRuntimeSocket(socketPath) {
  if (!isWithinDir(socketPath, RUNTIME_ROOT)) {
    return { removed: false, reason: 'outside_runtime_root' };
  }
  if (!isSocketFile(socketPath)) {
    // Intentionally leave non-socket files in place even if they share the
    // same pathname. Safety is preferred over aggressive cleanup here.
    return { removed: false, reason: 'not_socket' };
  }
  try {
    unlinkSync(socketPath);
    return { removed: true, reason: 'removed_socket' };
  } catch {
    return { removed: false, reason: 'unlink_failed' };
  }
}

function safeRemoveDaemonMetadata(metadataPath) {
  if (!isWithinDir(metadataPath, DAEMONS_DIR)) {
    return { removed: false, reason: 'outside_daemons_dir' };
  }
  try {
    unlinkSync(metadataPath);
    return { removed: true, reason: 'removed_metadata' };
  } catch {
    return { removed: false, reason: 'unlink_failed' };
  }
}

function daemonMetadataPath(daemonId) {
  return join(DAEMONS_DIR, `${daemonId}.json`);
}

// Each daemon keeps its own metadata file so concurrent daemon starts/stops do
// not contend on a shared index file.
function readDaemonMetadata(metadataPath) {
  const entry = readJsonFile(metadataPath, null);
  if (!entry || typeof entry !== 'object') return null;
  const { daemonId, targetId, socketPath, token, createdAt } = entry;
  if (!daemonId || !targetId || !socketPath || !token || !createdAt) return null;
  return {
    daemonId,
    targetId,
    socketPath,
    token,
    createdAt,
    metadataPath,
  };
}

function listDaemonMetadataFiles() {
  ensureRuntimeRoot();
  return readdirSync(DAEMONS_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => join(DAEMONS_DIR, name));
}

function writeDaemonMetadata(entry) {
  writePrivateJson(entry.metadataPath, {
    daemonId: entry.daemonId,
    targetId: entry.targetId,
    socketPath: entry.socketPath,
    token: entry.token,
    createdAt: entry.createdAt,
  });
}

function discoverDaemonEntries() {
  // Discovery is intentionally read-only. It classifies daemon metadata into
  // valid, invalid, and stale buckets; cleanup happens in a separate step.
  const valid = [];
  const invalidMetadata = [];
  const stale = [];

  for (const metadataPath of listDaemonMetadataFiles()) {
    const entry = readDaemonMetadata(metadataPath);
    if (!entry) {
      invalidMetadata.push({ metadataPath, reason: 'invalid_metadata' });
      continue;
    }
    if (!isWithinDir(entry.socketPath, RUNTIME_ROOT)) {
      stale.push({ entry, reason: 'socket_outside_runtime_root' });
      continue;
    }
    if (!existsSync(entry.socketPath)) {
      stale.push({ entry, reason: 'socket_missing' });
      continue;
    }
    if (!isSocketFile(entry.socketPath)) {
      stale.push({ entry, reason: 'socket_path_is_not_a_socket' });
      continue;
    }
    valid.push(entry);
  }

  return { valid, invalidMetadata, stale };
}

function cleanupInvalidDaemonMetadata(entries) {
  return entries.map(({ metadataPath, reason }) => ({
    type: 'invalid_metadata',
    reason,
    metadataPath,
    metadataResult: safeRemoveDaemonMetadata(metadataPath),
  }));
}

function cleanupStaleDaemonEntries(entries) {
  return entries.map(({ entry, reason }) => ({
    type: 'stale_daemon',
    reason,
    daemonId: entry.daemonId,
    metadataPath: entry.metadataPath,
    socketPath: entry.socketPath,
    socketResult: safeRemoveRuntimeSocket(entry.socketPath),
    metadataResult: safeRemoveDaemonMetadata(entry.metadataPath),
  }));
}

function listDaemonSockets() {
  const discovered = discoverDaemonEntries();
  cleanupInvalidDaemonMetadata(discovered.invalidMetadata);
  cleanupStaleDaemonEntries(discovered.stale);
  return discovered.valid;
}

function createDaemonSession(targetId) {
  ensureRuntimeRoot();
  const daemonId = randomHex(8);
  const entry = {
    daemonId,
    targetId,
    socketPath: join(RUNTIME_ROOT, `daemon-${daemonId}.sock`),
    token: randomHex(24),
    createdAt: new Date().toISOString(),
    metadataPath: daemonMetadataPath(daemonId),
  };
  writeDaemonMetadata(entry);
  return entry;
}

function removeDaemonSession(entry) {
  if (!entry) return { socketResult: { removed: false, reason: 'missing_entry' }, metadataResult: { removed: false, reason: 'missing_entry' } };
  // Metadata should always be removed for a dead daemon entry. The socket path
  // is only removed when it is still a real Unix socket inside the runtime dir.
  return {
    socketResult: safeRemoveRuntimeSocket(entry.socketPath),
    metadataResult: safeRemoveDaemonMetadata(entry.metadataPath),
  };
}

function defaultScreenshotPath() {
  ensureRuntimeRoot();
  return join(RUNTIME_ROOT, `screenshot-${Date.now()}-${randomHex(4)}.png`);
}

// Chrome exposes the active DevTools endpoint through DevToolsActivePort.
function getWsUrl() {
  const candidates = [
    resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    resolve(homedir(), '.config/google-chrome/DevToolsActivePort'),
  ];
  const portFile = candidates.find(path => existsSync(path));
  if (!portFile) throw new Error(`Could not find DevToolsActivePort file in: ${candidates.join(', ')}`);
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath) {
  // Get device scale factor so we can report coordinate mapping.
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  if (dpr === 1) {
    // Fallback: ask the page for devicePixelRatio if the CDP metrics path does
    // not provide a usable answer.
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || defaultScreenshotPath();
  writeFileSync(out, Buffer.from(data, 'base64'), { mode: FILE_MODE });
  ensurePrivateFile(out);

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100 / dpr) / 100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : 'document.documentElement.outerHTML';
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const parsed = JSON.parse(result);
  if (!parsed.ok) throw new Error(parsed.error);
  return `Clicked <${parsed.tag}> "${parsed.text}"`;
}

async function clickXyStr(cdp, sid, x, y) {
  // Click at CSS pixel coordinates using Input.dispatchMouseEvent.
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

async function typeStr(cdp, sid, text) {
  // Input.insertText works in cross-origin iframes where eval-driven typing
  // would fail.
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  // Repeatedly click a "load more" control until it disappears or a hard cap
  // is reached.
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function evalRawStr(cdp, sid, method, paramsJson) {
  // Raw CDP passthrough stays available for advanced cases, but the CLI gates
  // access behind --allow-unsafe before requests reach the daemon.
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

async function runDaemon(targetId, daemonId, socketPath, token, metadataPath) {
  ensureRuntimeRoot();
  safeRemoveRuntimeSocket(socketPath);

  // The daemon owns one attached CDP session for one tab and serves commands
  // over a local authenticated Unix socket.
  const cdp = new CDP();
  try {
    await cdp.connect(getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    removeDaemonSession({ daemonId, socketPath, metadataPath });
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    removeDaemonSession({ daemonId, socketPath, metadataPath });
    cdp.close();
    process.exit(1);
  }

  let alive = true;
  let server;
  function shutdown() {
    if (!alive) return;
    alive = false;
    removeDaemonSession({ daemonId, socketPath, metadataPath });
    server?.close();
    cdp.close();
    process.exit(0);
  }

  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle daemons auto-exit so abandoned tab sessions do not linger forever.
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap':
        case 'snapshot':
          result = await snapshotStr(cdp, sessionId, true);
          break;
        case 'eval':
          result = await evalStr(cdp, sessionId, args[0]);
          break;
        case 'shot':
        case 'screenshot':
          result = await shotStr(cdp, sessionId, args[0]);
          break;
        case 'html':
          result = await htmlStr(cdp, sessionId, args[0]);
          break;
        case 'nav':
        case 'navigate':
          result = await navStr(cdp, sessionId, args[0]);
          break;
        case 'net':
        case 'network':
          result = await netStr(cdp, sessionId);
          break;
        case 'click':
          result = await clickStr(cdp, sessionId, args[0]);
          break;
        case 'clickxy':
          result = await clickXyStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'type':
          result = await typeStr(cdp, sessionId, args[0]);
          break;
        case 'loadall':
          result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1], 10) : 1500);
          break;
        case 'evalraw':
          result = await evalRawStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'stop':
          return { ok: true, result: '', stopAfter: true };
        default:
          return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        // Every daemon request must present the per-daemon token from that
        // daemon's private metadata file.
        if (req.token !== token) {
          conn.write(JSON.stringify({ ok: false, error: 'Unauthorized daemon request', id: req.id ?? null }) + '\n');
          conn.end();
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, SOCKET_MODE);
      writeDaemonMetadata({
        daemonId,
        targetId,
        socketPath,
        token,
        createdAt: new Date().toISOString(),
        metadataPath,
      });
    } catch (e) {
      process.stderr.write(`Daemon: failed to secure socket: ${e.message}\n`);
      shutdown();
    }
  });
}

function connectToSocket(socketPath) {
  if (testHooks.connectToSocket) return testHooks.connectToSocket(socketPath);
  return new Promise((resolveConn, rejectConn) => {
    const conn = net.connect(socketPath);
    conn.on('connect', () => resolveConn(conn));
    conn.on('error', rejectConn);
  });
}

async function cleanupStaleDaemon(entry) {
  return removeDaemonSession(entry);
}

// Reuse an existing daemon for the target when possible; otherwise spawn a new
// detached helper and wait for its socket to come up. The order is:
// 1. try reachable existing daemon metadata
// 2. create metadata for a new daemon
// 3. spawn the helper process
// 4. poll until its socket is connectable
async function getOrStartTabDaemon(targetId) {
  const existing = listDaemonSockets().find(daemon => daemon.targetId === targetId);
  if (existing) {
    try {
      const conn = await connectToSocket(existing.socketPath);
      return { conn, token: existing.token };
    } catch {
      await cleanupStaleDaemon(existing);
    }
  }

  const entry = createDaemonSession(targetId);
  const spawnFn = testHooks.spawn || spawn;
  const child = spawnFn(process.execPath, [
    process.argv[1],
    '_daemon',
    targetId,
    entry.daemonId,
    entry.socketPath,
    entry.token,
    entry.metadataPath,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try {
      const conn = await connectToSocket(entry.socketPath);
      return { conn, token: entry.token };
    } catch {}
  }

  await cleanupStaleDaemon(entry);
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req, token) {
  return new Promise((resolveResponse, rejectResponse) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolveResponse(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResponse(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    // The daemon protocol is newline-delimited JSON; one request, one response.
    req.id = 1;
    req.token = token;
    conn.write(JSON.stringify(req) + '\n');
  });
}

function findAnyDaemonSocket() {
  return listDaemonSockets()[0] || null;
}

// Stop either one daemon matched by target prefix, or all running daemons.
async function stopDaemons(targetPrefix) {
  const daemons = listDaemonSockets();

  if (targetPrefix) {
    const targetId = resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon');
    const daemon = daemons.find(d => d.targetId === targetId);
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' }, daemon.token);
    } catch {
      await cleanupStaleDaemon(daemon);
    }
    return;
  }

  for (const daemon of daemons) {
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' }, daemon.token);
    } catch {
      await cleanupStaleDaemon(daemon);
    }
  }
}

function isUnsafeAllowed(argv) {
  if (process.env[ALLOW_UNSAFE_ENV] === '1') return true;
  if (process.env[ALLOW_UNSAFE_ENV]?.toLowerCase?.() === 'true') return true;
  return argv.includes('--allow-unsafe');
}

function stripGlobalFlags(argv) {
  return argv.filter(arg => arg !== '--allow-unsafe');
}

function assertUnsafeAllowed(cmd, allowUnsafe) {
  if (!['eval', 'evalraw'].includes(cmd) || allowUnsafe) return;
  throw new Error(
    `Command "${cmd}" is disabled by default because it can execute arbitrary page/CDP code. ` +
    `Re-run with --allow-unsafe or set ${ALLOW_UNSAFE_ENV}=1 if you explicitly trust this session.`
  );
}

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp [--allow-unsafe] <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression (requires --allow-unsafe)
  shot  <target> [file]             Screenshot (default: private runtime path); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; requires --allow-unsafe
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

UNSAFE COMMANDS
  eval and evalraw are disabled by default because they can execute arbitrary
  JavaScript or raw CDP methods against the attached tab.
  To enable them for a trusted session:
    Run the command with the flag:
      cdp --allow-unsafe eval <target> "document.title"
    Or set the env var for that command:
      ${ALLOW_UNSAFE_ENV}=1 cdp eval <target> "document.title"
    If you use this through a skill/agent, update the command it runs so it
    includes --allow-unsafe for eval/evalraw commands.

RUNTIME SECURITY
  Runtime files live under a private per-user directory:
    ${RUNTIME_ROOT}
  Cache and daemon metadata files are owner-only (0600). Daemon sockets are randomized,
  stored in that directory, and authenticated with a per-daemon session token.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at a randomized Unix socket path inside the
  private runtime directory above. Daemon metadata lives under that runtime root.
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "token":"<session-token>", "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, evalraw, stop. Use evalraw only in explicitly trusted flows.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap', 'snapshot', 'eval', 'shot', 'screenshot', 'html', 'nav', 'navigate',
  'net', 'network', 'click', 'clickxy', 'type', 'loadall', 'evalraw',
]);

async function main() {
  ensureRuntimeRoot();

  const rawArgv = process.argv.slice(2);
  const allowUnsafe = isUnsafeAllowed(rawArgv);
  const argv = stripGlobalFlags(rawArgv);
  const [cmd, ...args] = argv;

  if (cmd === '_daemon') {
    // Internal mode used only by the parent CLI when it spawns a background
    // per-tab daemon.
    await runDaemon(args[0], args[1], args[2], args[3], args[4]);
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    let pages;
    const existingDaemon = findAnyDaemonSocket();
    if (existingDaemon) {
      try {
        // Listing through an existing daemon avoids an extra Chrome attach and
        // therefore avoids another "Allow debugging" prompt.
        const conn = await connectToSocket(existingDaemon.socketPath);
        const resp = await sendCommand(conn, { cmd: 'list_raw' }, existingDaemon.token);
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {
        await cleanupStaleDaemon(existingDaemon);
      }
    }
    if (!pages) {
      const cdp = new CDP();
      await cdp.connect(getWsUrl());
      pages = await getPages(cdp);
      cdp.close();
    }
    writePrivateJson(PAGES_CACHE, pages);
    console.log(formatPageList(pages));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  assertUnsafeAllowed(cmd, allowUnsafe);

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  let targetId;
  const daemons = listDaemonSockets();
  const daemonTargetIds = daemons.map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    // Prefer a running daemon when one already exists for the target prefix.
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(PAGES_CACHE)) {
      console.error('No page list cached. Run "cdp list" first.');
      process.exit(1);
    }
    ensurePrivateFile(PAGES_CACHE);
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  const { conn, token } = await getOrStartTabDaemon(targetId);
  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) {
      console.error('Error: expression required');
      process.exit(1);
    }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    const text = cmdArgs.join(' ');
    if (!text) {
      console.error('Error: text required');
      process.exit(1);
    }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) {
      console.error('Error: CDP method required');
      process.exit(1);
    }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs }, token);

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

// Narrow internal export surface used by the test suite. This is not intended
// to be treated as a stable API outside tests and local maintenance work.
const testInternals = {
  ALLOW_UNSAFE_ENV,
  DAEMONS_DIR,
  DIR_MODE,
  FILE_MODE,
  PAGES_CACHE,
  RUNTIME_ROOT,
  SOCKET_MODE,
  assertUnsafeAllowed,
  cleanupInvalidDaemonMetadata,
  cleanupStaleDaemonEntries,
  createDaemonSession,
  daemonMetadataPath,
  defaultScreenshotPath,
  discoverDaemonEntries,
  ensurePrivateDir,
  ensurePrivateFile,
  findAnyDaemonSocket,
  initRuntimeRoot,
  isSocketFile,
  isUnsafeAllowed,
  isWithinDir,
  listDaemonMetadataFiles,
  listDaemonSockets,
  readDaemonMetadata,
  removeDaemonSession,
  runtimeRootCandidates,
  safeRemoveDaemonMetadata,
  safeRemoveRuntimeSocket,
  sendCommand,
  stopDaemons,
  stripGlobalFlags,
  writeDaemonMetadata,
  writePrivateFile,
  writePrivateJson,
  getOrStartTabDaemon,
  testHooks,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}

export { testInternals };
