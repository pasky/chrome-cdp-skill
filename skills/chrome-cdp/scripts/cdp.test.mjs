import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

const testRuntimeBase = mkdtempSync('/tmp/chrome-cdp-test-');
process.env.XDG_RUNTIME_DIR = testRuntimeBase;

const { testInternals: cdp } = await import('./cdp.mjs');

test.after(() => {
  rmSync(testRuntimeBase, { recursive: true, force: true });
});

function createFakeDaemon(entry, { requireToken = true } = {}) {
  const requests = [];
  let closed = false;

  class FakeConnection {
    constructor() {
      this.handlers = new Map();
    }

    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(handler);
    }

    off(event, handler) {
      this.handlers.get(event)?.delete(handler);
    }

    emit(event, payload) {
      for (const handler of this.handlers.get(event) || []) {
        handler(payload);
      }
    }

    write(line) {
      const req = JSON.parse(line.trim());
      requests.push(req);
      const response = requireToken && req.token !== entry.token
        ? { ok: false, error: 'Unauthorized daemon request', id: req.id ?? null }
        : { ok: true, result: req.cmd === 'stop' ? '' : 'ok', id: req.id };
      this.emit('data', Buffer.from(`${JSON.stringify(response)}\n`));
      this.emit('end');
      this.emit('close');
      if (req.cmd === 'stop') closed = true;
    }

    end() {}
  }

  return {
    closed: () => closed,
    connect: async () => new FakeConnection(),
    requests,
  };
}

test('runtime root is created with owner-only permissions', () => {
  cdp.listDaemonMetadataFiles();
  assert.equal(existsSync(cdp.RUNTIME_ROOT), true);
  assert.equal(statSync(cdp.RUNTIME_ROOT).mode & 0o777, cdp.DIR_MODE);
  assert.match(cdp.RUNTIME_ROOT, new RegExp(`^${testRuntimeBase}`));
  assert.equal(statSync(cdp.DAEMONS_DIR).mode & 0o777, cdp.DIR_MODE);
});

test('writePrivateJson writes owner-only files', () => {
  const filePath = join(cdp.RUNTIME_ROOT, 'private.json');
  cdp.writePrivateJson(filePath, { ok: true });

  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), { ok: true });
  assert.equal(statSync(filePath).mode & 0o777, cdp.FILE_MODE);
});

test('createDaemonSession writes one owner-only metadata file with randomized socket metadata', () => {
  const before = cdp.listDaemonMetadataFiles();
  const entry = cdp.createDaemonSession('target-session-test');
  const after = cdp.listDaemonMetadataFiles();

  assert.equal(after.length, before.length + 1);
  assert.equal(typeof entry.daemonId, 'string');
  assert.equal(typeof entry.token, 'string');
  assert.equal(entry.token.length, 48);
  assert.match(entry.socketPath, /^.*daemon-[a-f0-9]+\.sock$/);
  assert.match(entry.metadataPath, /^.*daemons\/[a-f0-9]+\.json$/);
  assert.equal(statSync(entry.metadataPath).mode & 0o777, cdp.FILE_MODE);
  assert.deepEqual(cdp.readDaemonMetadata(entry.metadataPath), entry);
});

test('discoverDaemonEntries classifies valid, invalid, and stale entries without mutating', () => {
  const valid = cdp.createDaemonSession('valid-target');
  const stale = cdp.createDaemonSession('stale-target');
  const invalidMetadataPath = join(cdp.DAEMONS_DIR, 'invalid.json');

  writeFileSync(valid.socketPath, '', { mode: cdp.FILE_MODE });
  cdp.writePrivateJson(invalidMetadataPath, { nope: true });
  cdp.testHooks.isSocketFile = (filePath) => filePath === valid.socketPath;

  const discovered = cdp.discoverDaemonEntries();

  assert.equal(discovered.valid.some(d => d.daemonId === valid.daemonId), true);
  assert.equal(discovered.stale.some(d => d.entry.daemonId === stale.daemonId), true);
  assert.equal(discovered.invalidMetadata.some(d => d.metadataPath === invalidMetadataPath), true);
  assert.equal(existsSync(stale.metadataPath), true);
  assert.equal(existsSync(invalidMetadataPath), true);
  cdp.testHooks.isSocketFile = null;
});

test('cleanup helpers remove invalid metadata and stale daemon metadata while preserving non-socket files', () => {
  const stale = cdp.createDaemonSession('stale-cleanup-target');
  const invalidMetadataPath = join(cdp.DAEMONS_DIR, 'invalid-cleanup.json');
  const fakeFileAtSocketPath = join(cdp.RUNTIME_ROOT, 'daemon-not-a-socket.sock');
  const poisonedEntry = {
    daemonId: 'poisoned-file',
    targetId: 'poisoned-target',
    socketPath: fakeFileAtSocketPath,
    token: 'z'.repeat(48),
    createdAt: '2026-03-14T00:00:02.000Z',
    metadataPath: join(cdp.DAEMONS_DIR, 'poisoned-file.json'),
  };

  cdp.writePrivateJson(invalidMetadataPath, { nope: true });
  writeFileSync(fakeFileAtSocketPath, 'keep-me', { mode: cdp.FILE_MODE });
  cdp.writeDaemonMetadata(poisonedEntry);

  const discovered = cdp.discoverDaemonEntries();
  const invalidResults = cdp.cleanupInvalidDaemonMetadata(discovered.invalidMetadata);
  const staleResults = cdp.cleanupStaleDaemonEntries(discovered.stale);

  assert.equal(invalidResults.some(r => r.metadataPath === invalidMetadataPath && r.metadataResult.removed), true);
  assert.equal(staleResults.some(r => r.daemonId === stale.daemonId && r.metadataResult.removed), true);
  assert.equal(staleResults.some(r => r.daemonId === 'poisoned-file' && r.socketResult.reason === 'not_socket'), true);
  assert.equal(existsSync(fakeFileAtSocketPath), true);
  assert.equal(readFileSync(fakeFileAtSocketPath, 'utf8'), 'keep-me');
});

test('listDaemonSockets returns multiple daemon entries from independent metadata files', async () => {
  const first = cdp.createDaemonSession('target-a');
  const second = cdp.createDaemonSession('target-b');
  cdp.testHooks.isSocketFile = (filePath) => filePath === first.socketPath || filePath === second.socketPath;
  writeFileSync(first.socketPath, '', { mode: cdp.FILE_MODE });
  writeFileSync(second.socketPath, '', { mode: cdp.FILE_MODE });

  const daemons = cdp.listDaemonSockets().filter(d => d.daemonId === first.daemonId || d.daemonId === second.daemonId);

  assert.deepEqual(daemons.map(d => d.targetId).sort(), ['target-a', 'target-b']);
  cdp.testHooks.isSocketFile = null;
});

test('poisoned metadata outside runtime root is dropped without deleting external file', () => {
  const externalFile = join(testRuntimeBase, 'outside.txt');
  const poisonedMetadataPath = join(cdp.DAEMONS_DIR, 'poisoned.json');
  writeFileSync(externalFile, 'keep-me', { mode: cdp.FILE_MODE });
  cdp.writePrivateJson(poisonedMetadataPath, {
    daemonId: 'poisoned',
    targetId: 'poisoned-target',
    socketPath: externalFile,
    token: 'c'.repeat(48),
    createdAt: '2026-03-14T00:00:02.000Z',
  });

  const daemons = cdp.listDaemonSockets();

  assert.equal(daemons.some(d => d.daemonId === 'poisoned'), false);
  assert.equal(existsSync(poisonedMetadataPath), false);
  assert.equal(existsSync(externalFile), true);
  assert.equal(readFileSync(externalFile, 'utf8'), 'keep-me');
});

test('removeDaemonSession reports metadata removal and preserves non-socket files at socket paths', () => {
  const entry = cdp.createDaemonSession('cleanup-target');
  writeFileSync(entry.socketPath, '', { mode: cdp.FILE_MODE });
  const result = cdp.removeDaemonSession(entry);

  assert.equal(existsSync(entry.metadataPath), false);
  assert.equal(existsSync(entry.socketPath), true);
  assert.equal(result.socketResult.reason, 'not_socket');
  assert.equal(result.metadataResult.removed, true);
});

test('sendCommand injects the daemon token and parses one NDJSON response', async () => {
  const entry = cdp.createDaemonSession('send-command-target');
  const fake = createFakeDaemon(entry);
  const conn = await fake.connect();

  const response = await cdp.sendCommand(conn, { cmd: 'list_raw' }, entry.token);

  assert.equal(response.ok, true);
  assert.equal(fake.requests[0].token, entry.token);
  assert.equal(fake.requests[0].cmd, 'list_raw');
});

test('getOrStartTabDaemon reuses an existing reachable daemon entry', async () => {
  const entry = cdp.createDaemonSession('reuse-target');
  const fake = createFakeDaemon(entry);
  cdp.testHooks.isSocketFile = (filePath) => filePath === entry.socketPath;
  cdp.testHooks.connectToSocket = async (socketPath) => {
    assert.equal(socketPath, entry.socketPath);
    return fake.connect();
  };
  writeFileSync(entry.socketPath, '', { mode: cdp.FILE_MODE });

  const { conn, token } = await cdp.getOrStartTabDaemon('reuse-target');
  const response = await cdp.sendCommand(conn, { cmd: 'list_raw' }, token);

  assert.equal(token, entry.token);
  assert.equal(response.ok, true);
  assert.equal(fake.requests[0].cmd, 'list_raw');
  cdp.testHooks.connectToSocket = null;
  cdp.testHooks.isSocketFile = null;
});

test('stopDaemons can discover and stop a fake daemon via metadata', async () => {
  const entry = cdp.createDaemonSession('stop-target');
  const fake = createFakeDaemon(entry);
  cdp.testHooks.isSocketFile = (filePath) => filePath === entry.socketPath;
  cdp.testHooks.connectToSocket = async (socketPath) => {
    assert.equal(socketPath, entry.socketPath);
    return fake.connect();
  };
  writeFileSync(entry.socketPath, '', { mode: cdp.FILE_MODE });

  await cdp.stopDaemons('stop-target');

  assert.equal(fake.requests.some(req => req.cmd === 'stop'), true);
  assert.equal(fake.closed(), true);
  cdp.testHooks.connectToSocket = null;
  cdp.testHooks.isSocketFile = null;
});

test('fake daemon rejects unauthorized requests in harnessed flow', async () => {
  const entry = cdp.createDaemonSession('auth-target');
  const fake = createFakeDaemon(entry);
  const conn = await fake.connect();

  const response = await cdp.sendCommand(conn, { cmd: 'list_raw' }, 'wrong-token');

  assert.equal(response.ok, false);
  assert.match(response.error, /Unauthorized/);
});

test('unsafe gating rejects eval and evalraw unless explicitly allowed', () => {
  assert.throws(() => cdp.assertUnsafeAllowed('eval', false), /disabled by default/);
  assert.throws(() => cdp.assertUnsafeAllowed('evalraw', false), /disabled by default/);
  assert.doesNotThrow(() => cdp.assertUnsafeAllowed('snap', false));
  assert.doesNotThrow(() => cdp.assertUnsafeAllowed('eval', true));
});

test('unsafe flag helpers recognize CLI flag and env var', () => {
  delete process.env[cdp.ALLOW_UNSAFE_ENV];
  assert.equal(cdp.isUnsafeAllowed(['list']), false);
  assert.equal(cdp.isUnsafeAllowed(['--allow-unsafe', 'eval']), true);
  process.env[cdp.ALLOW_UNSAFE_ENV] = 'true';
  assert.equal(cdp.isUnsafeAllowed(['list']), true);
  delete process.env[cdp.ALLOW_UNSAFE_ENV];
  assert.deepEqual(cdp.stripGlobalFlags(['--allow-unsafe', 'eval', 'abc']), ['eval', 'abc']);
});

test('default screenshot path stays inside the private runtime root', () => {
  const screenshotPath = cdp.defaultScreenshotPath();
  assert.match(screenshotPath, new RegExp(`^${cdp.RUNTIME_ROOT}`));
  assert.match(screenshotPath, /screenshot-.*\.png$/);
});
