# chrome-cdp on Termux (Android)

This guide covers running Chromium + chrome-cdp on Termux (Android aarch64/Linux).

## Prerequisites

- Termux from F-Droid (not Google Play)
- Node.js 22+ (install via `pkg install nodejs`)
- 512MB+ free RAM for Chromium headless

## Install Chromium

```bash
pkg install x11-repo        # Chromium is in the x11 repo
pkg install chromium        # installs chromium-browser binary
```

**Current version**: Chromium 146 (as of 2026-05)

## Known Pitfalls

### 1. Chromium requires `x11-repo`

Chromium is **not** in the default Termux repository. You must add `x11-repo` first:

```bash
pkg install x11-repo
```

### 2. Playwright does NOT work on Android

```bash
npm install playwright-core
npx playwright-core install chromium   # Fails: "Unsupported platform: android"
```

Playwright's dependency graph (e.g., `@playwright/browser-chromium`) ships platform-specific binaries and refuses to install on Android. **Do not use Playwright** — use headless Chromium directly.

### 3. No `DevToolsActivePort` file

Termux's Chromium does **not** create the `DevToolsActivePort` file that chrome-cdp normally auto-discovers. You must use the `CDP_PORT` environment variable instead.

### 4. `--headless` has no display output

Headless Chromium on Termux works correctly — it renders HTML, evaluates JS, takes screenshots, etc. You just won't see a window.

## Quick Start

### 1. Launch Chromium with remote debugging

```bash
chromium-browser \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 &
```

Key flags:
- `--headless` — no visible window (required on Termux, no display server)
- `--no-sandbox` — required in Termux (no user namespace support)
- `--disable-gpu` — no GPU available on most Android devices
- `--disable-dev-shm-usage` — avoid `/dev/shm` issues in containerized environments

### 2. Set the CDP port

```bash
export CDP_PORT=9222
```

This tells chrome-cdp to discover the WebSocket URL via `http://127.0.0.1:9222/json/version` instead of scanning for `DevToolsActivePort`.

### 3. Verify connection

```bash
node scripts/cdp.mjs list
```

You should see a list of open pages (may be empty on first launch — Chromium opens a blank page).

### 4. Navigate to a page and inspect

```bash
node scripts/cdp.mjs list                    # copy a target prefix
node scripts/cdp.mjs snap <target>           # accessibility snapshot
node scripts/cdp.mjs eval <target>           # evaluate JS
```

## Automation Script

Save this as `start-cdp.sh`:

```bash
#!/data/data/com.termux/files/usr/bin/bash
# Start headless Chromium with CDP on Termux
CHROMIUM=chromium-browser
PORT=${1:-9222}

pkill -f "$CHROMIUM.*remote-debugging" 2>/dev/null
sleep 1

$CHROMIUM \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=$PORT &

echo "Waiting for CDP on port $PORT..."
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:$PORT/json/version >/dev/null 2>&1; then
    echo "CDP ready: http://127.0.0.1:$PORT"
    echo "Run: CDP_PORT=$PORT node scripts/cdp.mjs list"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for CDP"
exit 1
```

## Environment Variables for Termux

| Variable | Purpose | Example |
|----------|---------|---------|
| `CDP_PORT` | Port Chromium is listening on (required on Termux) | `export CDP_PORT=9222` |
| `CDP_HOST` | Host address (default: 127.0.0.1) | `export CDP_HOST=127.0.0.1` |
| `CDP_PORT_FILE` | Direct path to DevToolsActivePort (not used on Termux) | — |
