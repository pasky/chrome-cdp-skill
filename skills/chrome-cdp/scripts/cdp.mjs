#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Master daemon architecture: ONE daemon per browser port holds a single
// WebSocket to the browser, multiplexing CDP sessions across tabs.
// Chrome's "Allow debugging" modal fires ONCE per master daemon.
// Daemons auto-exit after 20min idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const PAGES_CACHE = '/tmp/cdp-pages.json';
const SESSION_FILE = '/tmp/cdp-session.json';

function masterSockPath(port) { return `/tmp/cdp-master-${port}.sock`; }
const CONTEXT_MAP_FILE = '/tmp/cdp-context-profiles.json';

// Browser profile paths keyed by short name.
const BROWSER_PROFILES = {
  chrome: {
    darwin: 'Library/Application Support/Google/Chrome',
    linux: '.config/google-chrome',
  },
  brave: {
    darwin: 'Library/Application Support/BraveSoftware/Brave-Browser',
    linux: '.config/BraveSoftware/Brave-Browser',
  },
  edge: {
    darwin: 'Library/Application Support/Microsoft Edge',
    linux: '.config/microsoft-edge',
  },
  chromium: {
    darwin: 'Library/Application Support/Chromium',
    linux: '.config/chromium',
  },
  arc: {
    darwin: 'Library/Application Support/Arc/User Data',
    linux: null,
  },
  dia: {
    darwin: 'Library/Application Support/Dia/User Data',
    linux: null,
  },
};

const platform = process.platform === 'darwin' ? 'darwin' : 'linux';

function getBrowserCandidates(browserName) {
  if (browserName) {
    const key = browserName.toLowerCase();
    const profile = BROWSER_PROFILES[key];
    if (!profile) throw new Error(`Unknown browser "${browserName}". Known: ${Object.keys(BROWSER_PROFILES).join(', ')}`);
    const dir = profile[platform];
    if (!dir) throw new Error(`Browser "${browserName}" is not supported on ${platform}`);
    return [resolve(homedir(), dir, 'DevToolsActivePort')];
  }
  // Auto-discover: try all browsers
  return Object.values(BROWSER_PROFILES)
    .map(p => p[platform])
    .filter(Boolean)
    .map(dir => resolve(homedir(), dir, 'DevToolsActivePort'));
}

// Parsed from argv in main(), set globally for getWsUrl().
// Priority: CLI flags > env vars > saved session
let gBrowser = process.env.CDP_BROWSER || null;
let gPort = process.env.CDP_PORT || null;

function loadSession() {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (!gBrowser && !gPort) {
      if (data.browser) gBrowser = data.browser;
      if (data.port) gPort = data.port;
    }
  } catch {}
}

function saveSession(browser, port) {
  const data = {};
  if (browser) data.browser = browser;
  if (port) data.port = port;
  writeFileSync(SESSION_FILE, JSON.stringify(data));
}

function clearSession() {
  try { unlinkSync(SESSION_FILE); } catch {}
}

// ---------------------------------------------------------------------------
// Profile support — reads Chrome's Local State to map profiles
// ---------------------------------------------------------------------------

// Get the browser data directory for the current browser.
function getBrowserDataDir() {
  const key = (gBrowser || 'chrome').toLowerCase();
  const profile = BROWSER_PROFILES[key];
  if (!profile) return null;
  const dir = profile[platform];
  return dir ? resolve(homedir(), dir) : null;
}

// Read all profile names from the browser's Local State file.
// Returns [{dir: "Default", name: "Work"}, {dir: "Profile 2", name: "Casual Me"}, ...]
function readProfiles() {
  const dataDir = getBrowserDataDir();
  if (!dataDir) return [];
  const localStatePath = resolve(dataDir, 'Local State');
  try {
    const state = JSON.parse(readFileSync(localStatePath, 'utf8'));
    const cache = state?.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      dir,
      name: info.name || dir,
      gaia: info.gaia_name || '',
    }));
  } catch { return []; }
}

// Build/update the browserContextId → profile name mapping.
// We discover mappings by seeing which contexts exist for pages.
// Saved to a temp file so it persists across CLI invocations.
function loadContextMap() {
  try { return JSON.parse(readFileSync(CONTEXT_MAP_FILE, 'utf8')); }
  catch { return {}; }
}

function saveContextMap(map) {
  writeFileSync(CONTEXT_MAP_FILE, JSON.stringify(map));
}

// Given pages with browserContextId and the known profiles, try to map contexts to profiles.
// Only the defaultBrowserContextId gets auto-mapped (via Local State's last_used).
// Other contexts are discovered via the probe mechanism or stay as "?" until identified.
function updateContextMap(pages, defaultContextId) {
  const map = loadContextMap();
  const profiles = readProfiles();

  // Auto-map unmapped contexts to profiles using last_active_profiles order.
  // Chrome's chrome://inspect toggle doesn't use "default context" meaningfully,
  // so we map by matching unmapped contexts to unmapped active profiles in order.
  const dataDir = getBrowserDataDir();
  if (dataDir && profiles.length > 0) {
    try {
      const state = JSON.parse(readFileSync(resolve(dataDir, 'Local State'), 'utf8'));
      const lastActive = state?.profile?.last_active_profiles || [];
      const alreadyMappedNames = new Set(Object.values(map).filter(Boolean));

      // Count pages per context to prioritize (contexts with pages are real profiles)
      const contextPageCount = {};
      for (const p of pages) {
        contextPageCount[p.browserContextId] = (contextPageCount[p.browserContextId] || 0) + 1;
      }

      // Get unmapped contexts that have pages, sorted by page count desc
      const unmappedContexts = Object.entries(contextPageCount)
        .filter(([ctx]) => !map[ctx] || map[ctx] === null)
        .sort((a, b) => b[1] - a[1])
        .map(([ctx]) => ctx);

      // Get unmapped active profiles in order
      const unmappedProfiles = lastActive
        .map(dir => profiles.find(p => p.dir === dir))
        .filter(p => p && !alreadyMappedNames.has(p.name));

      // Assign in order: most-tabs context → first unmapped active profile
      for (let i = 0; i < Math.min(unmappedContexts.length, unmappedProfiles.length); i++) {
        map[unmappedContexts[i]] = unmappedProfiles[i].name;
      }
    } catch {}
  }

  // Register unknown contexts but don't guess their profile — leave as null
  const knownContexts = new Set(Object.keys(map));
  const contextIds = new Set(pages.map(p => p.browserContextId));
  for (const ctx of contextIds) {
    if (!knownContexts.has(ctx)) {
      map[ctx] = null; // unknown — discover via `list --profile` or probe
    }
  }

  saveContextMap(map);
  return map;
}

// Resolve a profile name or dir to a profile directory.
function resolveProfileDir(nameOrDir) {
  const profiles = readProfiles();
  const lower = nameOrDir.toLowerCase();
  // Exact match on dir
  const byDir = profiles.find(p => p.dir.toLowerCase() === lower);
  if (byDir) return byDir;
  // Match on name (case-insensitive)
  const byName = profiles.filter(p => p.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  // Prefix match on name
  const byPrefix = profiles.filter(p => p.name.toLowerCase().startsWith(lower));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) throw new Error(`Ambiguous profile "${nameOrDir}" — matches: ${byPrefix.map(p => p.name).join(', ')}`);
  throw new Error(`Unknown profile "${nameOrDir}". Available: ${profiles.map(p => p.name).join(', ')}`);
}

// Discover which browserContextId belongs to which profile by opening a temp page
// in a specific profile and seeing what context it gets.
async function discoverProfileContext(profileDir, port) {
  const dataDir = getBrowserDataDir();
  if (!dataDir) throw new Error('Cannot determine browser data directory');

  // Open a temporary page in the target profile
  const marker = `cdp-profile-probe-${Date.now()}`;
  const markerUrl = `data:text/html,<title>${marker}</title>`;

  // Use the OS to open Chrome with the specific profile
  const browserApp = {
    chrome: 'Google Chrome', brave: 'Brave Browser', edge: 'Microsoft Edge',
    chromium: 'Chromium', dia: 'Dia', arc: 'Arc',
  }[(gBrowser || 'chrome').toLowerCase()] || 'Google Chrome';

  spawn('open', ['-na', browserApp, '--args', `--profile-directory=${profileDir}`, markerUrl], {
    detached: true, stdio: 'ignore',
  }).unref();

  // Wait for the probe tab to appear, then read its browserContextId
  const conn = await getOrStartMasterDaemon(port);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const resp = await sendCommand(await getOrStartMasterDaemon(port), { cmd: 'list_raw' });
    if (!resp.ok) continue;
    const pages = JSON.parse(resp.result);
    const probe = pages.find(p => p.title === marker || p.url.includes(marker));
    if (probe) {
      // Found it — record the mapping
      const map = loadContextMap();
      const profiles = readProfiles();
      const profile = profiles.find(p => p.dir === profileDir);
      map[probe.browserContextId] = profile?.name || profileDir;
      saveContextMap(map);

      // Close the probe tab
      try {
        await sendCommand(await getOrStartMasterDaemon(port), {
          cmd: 'evalraw', targetId: probe.targetId,
          args: ['Target.closeTarget', JSON.stringify({ targetId: probe.targetId })]
        });
      } catch {}

      return probe.browserContextId;
    }
  }
  throw new Error(`Could not discover context for profile "${profileDir}" — probe tab didn't appear`);
}

// Discover the default browserContextId from the master daemon.
async function getDefaultContextId(port) {
  const conn = await getOrStartMasterDaemon(port);
  const resp = await sendCommand(conn, { cmd: 'get_default_context' });
  return resp.ok ? resp.result : null;
}

// Discover the WebSocket URL by querying the HTTP endpoint on a given port.
async function discoverWsUrl(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.webSocketDebuggerUrl || null;
  } catch { return null; }
}

// Check if a port is actually listening by attempting a TCP connection.
async function isPortOpen(port) {
  const { createConnection } = await import('net');
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

async function getWsUrl() {
  // Direct port override
  if (gPort) {
    // Try HTTP discovery first (works for Dia, Brave, etc.)
    const wsUrl = await discoverWsUrl(gPort);
    if (wsUrl) return wsUrl;
    // Chrome's chrome://inspect toggle doesn't expose HTTP endpoints,
    // but the WebSocket works directly. Fall back to generic URL.
    if (await isPortOpen(gPort)) {
      return `ws://127.0.0.1:${gPort}/devtools/browser`;
    }
    throw new Error(`No CDP server responding on port ${gPort}`);
  }

  const candidates = getBrowserCandidates(gBrowser);
  const portFile = candidates.find(path => existsSync(path));
  if (!portFile) {
    const tried = candidates.join('\n  ');
    const hint = gBrowser
      ? `Is ${gBrowser} running with remote debugging enabled?`
      : 'Is any Chromium browser running with remote debugging enabled?';
    throw new Error(`Could not find DevToolsActivePort file.\n  Tried:\n  ${tried}\n  ${hint}\n  Tip: use --browser <name> or CDP_BROWSER env to target a specific browser (${Object.keys(BROWSER_PROFILES).join(', ')})`);
  }
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  const filePort = lines[0];
  const filePath = lines[1];

  // Try HTTP discovery first (gets the fresh WS URL even if file is stale)
  const wsUrl = await discoverWsUrl(filePort);
  if (wsUrl) return wsUrl;

  // HTTP failed — port might still be open (Chrome's toggle doesn't expose HTTP)
  if (await isPortOpen(filePort)) {
    return `ws://127.0.0.1:${filePort}${filePath}`;
  }

  // File is stale — try common debug ports as fallback
  if (gBrowser) {
    const browserKey = gBrowser.toLowerCase();
    const defaultPorts = { chrome: 9222, dia: 9223, brave: 9224, edge: 9225, chromium: 9226, arc: 9227 };
    const fallbackPort = defaultPorts[browserKey];
    if (fallbackPort && fallbackPort !== parseInt(filePort)) {
      const fallbackUrl = await discoverWsUrl(fallbackPort);
      if (fallbackUrl) {
        process.stderr.write(`Note: DevToolsActivePort was stale (port ${filePort}), found ${gBrowser} on port ${fallbackPort}\n`);
        return fallbackUrl;
      }
      if (await isPortOpen(fallbackPort)) {
        process.stderr.write(`Note: DevToolsActivePort was stale (port ${filePort}), found ${gBrowser} on port ${fallbackPort}\n`);
        return `ws://127.0.0.1:${fallbackPort}/devtools/browser`;
      }
    }
  }

  // Last resort: use the file as-is
  return `ws://127.0.0.1:${filePort}${filePath}`;
}

// Extract port number from a ws:// URL
function extractPort(wsUrl) {
  const m = wsUrl.match(/:(\d+)\//);
  return m ? m[1] : '9222';
}

// Resolve the canonical port for the master daemon identity.
// IMPORTANT: Avoid calling getWsUrl() here — it probes the port via TCP,
// which Chrome treats as a new debug connection (triggering Allow popup).
// Instead, read the port from the DevToolsActivePort file without connecting.
async function resolvePort() {
  if (gPort) return String(gPort);

  // Try to read port from DevToolsActivePort file (no network connection needed)
  const candidates = getBrowserCandidates(gBrowser);
  const portFile = candidates.find(path => existsSync(path));
  if (portFile) {
    const lines = readFileSync(portFile, 'utf8').trim().split('\n');
    return lines[0];
  }

  // Fallback to known defaults
  if (gBrowser) {
    const defaultPorts = { chrome: '9222', dia: '9223', brave: '9224', edge: '9225', chromium: '9226', arc: '9227' };
    const key = gBrowser.toLowerCase();
    if (defaultPorts[key]) return defaultPorts[key];
  }

  // Last resort: try getWsUrl (will probe)
  const wsUrl = await getWsUrl();
  return extractPort(wsUrl);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function listMasterSockets() {
  return readdirSync('/tmp')
    .filter(f => f.startsWith('cdp-master-') && f.endsWith('.sock'))
    .map(f => ({
      port: f.slice(11, -5),
      socketPath: `/tmp/${f}`,
    }));
}

// Also clean up legacy per-tab sockets
function listLegacySockets() {
  return readdirSync('/tmp')
    .filter(f => f.startsWith('cdp-') && !f.startsWith('cdp-master-') && f.endsWith('.sock'))
    .map(f => `/tmp/${f}`);
}

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

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

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
            // Pass full msg so handlers can filter by sessionId
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

  // Wait for an event, optionally filtered by sessionId for multiplexed sessions.
  waitForEvent(method, timeout = TIMEOUT, filterSessionId = null) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params, msg) => {
        if (settled) return;
        // If filtering by session, skip events from other sessions
        if (filterSessionId && msg.sessionId !== filterSessionId) return;
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

function formatPageList(pages, contextMap = null) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  const showProfile = contextMap && Object.values(contextMap).some(v => v);
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const profileName = contextMap?.[p.browserContextId];
    const profileCol = showProfile
      ? `[${(profileName || '?').substring(0, 12).padEnd(12)}]  `
      : '';
    const titleLen = showProfile ? 40 : 54;
    const title = p.title.substring(0, titleLen).padEnd(titleLen);
    return `${id}  ${profileCol}${title}  ${p.url}`;
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
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || '/tmp/screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
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
  // Filter by sessionId so we don't catch load events from other tabs
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT, sid);
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

// Click element by CSS selector
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
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
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

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
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

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Master daemon — one per browser port, multiplexes all tab sessions
// ---------------------------------------------------------------------------

async function runMasterDaemon(port) {
  const sp = masterSockPath(port);

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
  } catch (e) {
    process.stderr.write(`Master daemon: cannot connect to browser: ${e.message}\n`);
    process.exit(1);
  }

  // Session management: targetId → sessionId (lazy attach)
  const sessions = new Map();
  const pendingAttach = new Map();

  async function attachSession(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    // Prevent double-attach from concurrent requests
    if (pendingAttach.has(targetId)) return pendingAttach.get(targetId);
    const p = (async () => {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessions.set(targetId, sessionId);
      pendingAttach.delete(targetId);
      return sessionId;
    })();
    pendingAttach.set(targetId, p);
    try { return await p; }
    catch (e) { pendingAttach.delete(targetId); throw e; }
  }

  async function detachSession(targetId) {
    const sessionId = sessions.get(targetId);
    if (!sessionId) return;
    sessions.delete(targetId);
    try { await cdp.send('Target.detachFromTarget', { sessionId }); } catch {}
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Clean up sessions when tabs close (but keep the master daemon running)
  cdp.onEvent('Target.targetDestroyed', (params) => {
    sessions.delete(params.targetId);
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    // Find and remove the session by sessionId
    for (const [tid, sid] of sessions) {
      if (sid === params.sessionId) { sessions.delete(tid); break; }
    }
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command — now includes targetId for tab-scoped commands
  async function handleCommand({ cmd, targetId, args }) {
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
        case 'detach': {
          await detachSession(targetId);
          result = 'Detached';
          break;
        }
        case 'get_default_context': {
          const { defaultBrowserContextId } = await cdp.send('Target.getBrowserContexts');
          result = defaultBrowserContextId || '';
          break;
        }
        case 'open': {
          // Open a new tab, optionally in a specific browserContextId
          const url = args[0] || 'about:blank';
          const browserContextId = args[1] || undefined;
          const params = { url };
          if (browserContextId) params.browserContextId = browserContextId;
          const { targetId: newId } = await cdp.send('Target.createTarget', params);
          result = newId;
          break;
        }
        case 'close': {
          if (!targetId) return { ok: false, error: 'targetId required' };
          await cdp.send('Target.closeTarget', { targetId });
          sessions.delete(targetId);
          result = 'Closed';
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: {
          // Tab commands — need a session
          if (!targetId) return { ok: false, error: 'targetId required for this command' };
          let sessionId;
          try {
            sessionId = await attachSession(targetId);
          } catch (e) {
            sessions.delete(targetId);
            return { ok: false, error: `Failed to attach to tab: ${e.message}` };
          }
          switch (cmd) {
            case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, true); break;
            case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
            case 'shot': case 'screenshot': result = await shotStr(cdp, sessionId, args[0]); break;
            case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
            case 'nav': case 'navigate': result = await navStr(cdp, sessionId, args[0]); break;
            case 'net': case 'network': result = await netStr(cdp, sessionId); break;
            case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
            case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
            case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
            case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
            case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
            default: return { ok: false, error: `Unknown command: ${cmd}` };
          }
        }
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server — NDJSON protocol, supports multiple concurrent connections
  // Request:  { "id": <number>, "cmd": "<command>", "targetId": "<optional>", "args": [...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
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

  try { unlinkSync(sp); } catch {}
  server.listen(sp);
  process.stderr.write(`Master daemon running on port ${port} (socket: ${sp})\n`);
}

// ---------------------------------------------------------------------------
// CLI ↔ master daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartMasterDaemon(port) {
  const sp = masterSockPath(port);
  // Try existing master daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  try { unlinkSync(sp); } catch {}

  // Spawn master daemon — forward browser/port flags
  const daemonArgs = [process.argv[1]];
  if (gBrowser) daemonArgs.push('--browser', gBrowser);
  if (gPort) daemonArgs.push('--port', gPort);
  daemonArgs.push('_master', port);
  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow on Chrome)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Master daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
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
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  const masters = listMasterSockets();

  if (targetPrefix) {
    // Stop/detach a specific tab session on all master daemons
    for (const master of masters) {
      try {
        const conn = await connectToSocket(master.socketPath);
        await sendCommand(conn, { cmd: 'detach', targetId: targetPrefix });
      } catch {}
    }
    return;
  }

  // Stop all master daemons
  for (const master of masters) {
    try {
      const conn = await connectToSocket(master.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(master.socketPath); } catch {}
    }
  }

  // Clean up any legacy per-tab sockets
  for (const sp of listLegacySockets()) {
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(sp); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp [--browser <name>] [--port <number>] <command> [args]

Global flags:
  --browser <name>   Target a specific browser: chrome, brave, edge, chromium, arc, dia
                     (env: CDP_BROWSER)
  --port <number>    Connect to a specific debug port instead of auto-discovering
                     (env: CDP_PORT)

Commands:

  use <browser|port>                Set active browser for subsequent commands
                                    e.g. "use dia", "use chrome", "use 9223"
                                    Use "use auto" to clear and auto-discover
  profiles                          List all browser profiles
  list [--profile <name>]           List open pages (shows unique target prefixes)
                                    With --profile, filter to a specific profile
  open <url> [--profile <name>]     Open URL in a new tab (default profile unless specified)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: /tmp/screenshot.png); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  stop  [target]                    Stop master daemon (or detach a specific tab)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

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

MASTER DAEMON
  A single master daemon per browser port holds the WebSocket connection
  and multiplexes CDP sessions across tabs. This means Chrome's "Allow
  remote debugging?" popup only fires ONCE per session, not per tab.
  Socket path: /tmp/cdp-master-<port>.sock
  Multiple agents can connect simultaneously — the daemon handles
  concurrent requests across different tabs.
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "targetId":"<optional>", "args":[...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  The daemon auto-exits after 20 min of inactivity.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

async function main() {
  // Extract global flags before command parsing
  const rawArgs = process.argv.slice(2);
  const filteredArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--browser' && i + 1 < rawArgs.length) {
      gBrowser = rawArgs[++i];
    } else if (rawArgs[i] === '--port' && i + 1 < rawArgs.length) {
      gPort = rawArgs[++i];
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }
  const [cmd, ...args] = filteredArgs;

  // Master daemon mode (internal)
  if (cmd === '_master') { await runMasterDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  // Use command — set active browser session
  if (cmd === 'use') {
    const val = args[0];
    if (!val || val === 'auto' || val === 'clear') {
      clearSession();
      console.log('Session cleared — will auto-discover browser.');
      return;
    }
    if (/^\d+$/.test(val)) {
      saveSession(null, val);
      console.log(`Session set to port ${val}. All commands will target this port.`);
    } else {
      const key = val.toLowerCase();
      if (!BROWSER_PROFILES[key]) {
        console.error(`Unknown browser "${val}". Known: ${Object.keys(BROWSER_PROFILES).join(', ')}`);
        process.exit(1);
      }
      saveSession(key, null);
      console.log(`Session set to ${key}. All commands will target this browser.`);
    }
    return;
  }

  // Load saved session (only if no CLI flags or env vars set)
  loadSession();

  // Extract --profile flag from args
  let gProfile = null;
  const cleanArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && i + 1 < args.length) {
      gProfile = args[++i];
    } else {
      cleanArgs.push(args[i]);
    }
  }

  // Resolve canonical port for master daemon
  const port = await resolvePort();

  // Profiles — list all browser profiles
  if (cmd === 'profiles') {
    const profiles = readProfiles();
    if (profiles.length === 0) {
      console.log('No profiles found.');
    } else {
      // Also show context mapping if available
      const defaultCtxId = await getDefaultContextId(port).catch(() => null);
      if (defaultCtxId) updateContextMap([], defaultCtxId);
      const map = loadContextMap();
      const reverseMap = {};
      for (const [ctx, name] of Object.entries(map)) {
        if (name) reverseMap[name] = ctx;
      }
      for (const p of profiles) {
        const ctx = reverseMap[p.name];
        const status = ctx ? '●' : '○';
        const gaiaStr = p.gaia ? ` (${p.gaia})` : '';
        console.log(`  ${status} ${p.name}${gaiaStr}  [${p.dir}]`);
      }
      console.log(`\n  ● = has loaded tabs    ○ = no loaded tabs`);
    }
    return;
  }

  // List — route through master daemon, with optional profile filter
  if (cmd === 'list' || cmd === 'ls') {
    const conn = await getOrStartMasterDaemon(port);
    const resp = await sendCommand(conn, { cmd: 'list_raw' });
    if (!resp.ok) { console.error('Error:', resp.error); process.exit(1); }
    let pages = JSON.parse(resp.result);

    // Get default context and update profile mapping
    const defaultCtxId = await getDefaultContextId(port).catch(() => null);
    const contextMap = updateContextMap(pages, defaultCtxId);

    // Filter by profile if specified
    if (gProfile) {
      const profile = resolveProfileDir(gProfile);
      const matchingContexts = new Set();
      for (const [ctx, name] of Object.entries(contextMap)) {
        if (name === profile.name) matchingContexts.add(ctx);
      }
      // If no contexts mapped yet for this profile, try to discover
      if (matchingContexts.size === 0) {
        try {
          const ctx = await discoverProfileContext(profile.dir, port);
          matchingContexts.add(ctx);
          // Re-fetch pages after probe
          const resp2 = await sendCommand(await getOrStartMasterDaemon(port), { cmd: 'list_raw' });
          if (resp2.ok) pages = JSON.parse(resp2.result);
        } catch (e) {
          console.error(`Warning: ${e.message}`);
        }
      }
      if (matchingContexts.size > 0) {
        pages = pages.filter(p => matchingContexts.has(p.browserContextId));
      }
    }

    writeFileSync(PAGES_CACHE, JSON.stringify(pages));
    console.log(formatPageList(pages, contextMap));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Open — create a new tab, optionally in a specific profile
  if (cmd === 'open') {
    const url = cleanArgs[0] || 'about:blank';
    if (gProfile) {
      // Open in a specific profile using the OS (-na forces new instance for profile routing)
      const profile = resolveProfileDir(gProfile);
      const browserApp = {
        chrome: 'Google Chrome', brave: 'Brave Browser', edge: 'Microsoft Edge',
        chromium: 'Chromium', dia: 'Dia', arc: 'Arc',
      }[(gBrowser || 'chrome').toLowerCase()] || 'Google Chrome';

      // Snapshot contexts before opening
      const connBefore = await getOrStartMasterDaemon(port);
      const respBefore = await sendCommand(connBefore, { cmd: 'list_raw' });
      const contextsBefore = new Set();
      if (respBefore.ok) {
        JSON.parse(respBefore.result).forEach(p => contextsBefore.add(p.browserContextId));
      }

      spawn('open', ['-na', browserApp, '--args', `--profile-directory=${profile.dir}`, url], {
        detached: true, stdio: 'ignore',
      }).unref();

      // Wait for the new tab and discover its context
      for (let i = 0; i < 15; i++) {
        await sleep(500);
        const conn2 = await getOrStartMasterDaemon(port);
        const resp2 = await sendCommand(conn2, { cmd: 'list_raw' });
        if (!resp2.ok) continue;
        const pages = JSON.parse(resp2.result);
        const newPage = pages.find(p => !contextsBefore.has(p.browserContextId) || p.url === url || p.url === url + '/');
        if (newPage) {
          // Map the new context to this profile
          const map = loadContextMap();
          if (!map[newPage.browserContextId] || map[newPage.browserContextId] === null) {
            map[newPage.browserContextId] = profile.name;
            saveContextMap(map);
          }
          console.log(`Opened ${url} in profile "${profile.name}" (target: ${newPage.targetId.slice(0,8)})`);
          setTimeout(() => process.exit(0), 100);
          return;
        }
      }
      console.log(`Opening ${url} in profile "${profile.name}" (tab may still be loading)`);
    } else {
      // Open in default context via CDP
      const conn = await getOrStartMasterDaemon(port);
      const resp = await sendCommand(conn, { cmd: 'open', args: [url] });
      if (!resp.ok) { console.error('Error:', resp.error); process.exit(1); }
      console.log(`Opened ${url} (target: ${resp.result})`);
    }
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(cleanArgs[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = cleanArgs[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from cache
  let targetId;
  if (!existsSync(PAGES_CACHE)) {
    console.error('No page list cached. Run "cdp list" first.');
    process.exit(1);
  }
  const cachedPages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  targetId = resolvePrefix(targetPrefix, cachedPages.map(p => p.targetId), 'target', 'Run "cdp list".');

  // Connect to master daemon
  const conn = await getOrStartMasterDaemon(port);

  const cmdArgs = cleanArgs.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, targetId, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
