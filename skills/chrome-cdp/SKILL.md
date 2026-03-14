---
name: chrome-cdp
description: Interact with local Chromium browser sessions (Chrome, Dia, Brave, Edge, Arc) via CDP - list tabs, take screenshots, evaluate JS, click elements, navigate pages. Supports multiple browsers simultaneously with --browser and --port flags. Master daemon architecture means Chrome's Allow popup only fires once per session.
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection. Supports multiple Chromium-based browsers and profiles simultaneously.

## Prerequisites

- A Chromium-based browser with remote debugging enabled
- Node.js 22+ (uses built-in WebSocket)

### Enabling remote debugging per browser

| Browser | How to enable | Default port |
|---------|--------------|--------------|
| **Chrome** | Toggle at `chrome://inspect/#remote-debugging` (one-time Allow popup) | 9222 |
| **Dia** | Launch with `--remote-debugging-port=9223` (use "Dia Debug" app or `dia` alias) | 9223 |
| **Brave** | Launch with `--remote-debugging-port=9224` | 9224 |
| **Edge** | Launch with `--remote-debugging-port=9225` | 9225 |
| **Arc** | Launch with `--remote-debugging-port=9227` | 9227 |

**Chrome 146+ note:** `--remote-debugging-port` requires `--user-data-dir` (blank profile). For your real profile, use the `chrome://inspect` toggle instead. Other browsers work fine with the launch flag.

## Architecture

A **master daemon** per browser port holds a single WebSocket connection and multiplexes CDP sessions across all tabs. This means:
- Chrome's "Allow remote debugging?" popup fires **once** per session (when daemon starts)
- Multiple agents can connect simultaneously via the Unix socket
- Daemon auto-exits after 20 min idle
- Socket path: `/tmp/cdp-master-<port>.sock`

## Selecting a browser

```bash
# Target by port directly (recommended)
scripts/cdp.mjs --port 9222 list    # Chrome
scripts/cdp.mjs --port 9223 list    # Dia

# Target by browser name (reads DevToolsActivePort file)
scripts/cdp.mjs --browser chrome list
scripts/cdp.mjs --browser dia list

# Session persistence (single-agent use only)
scripts/cdp.mjs use 9223            # Set Dia as active
scripts/cdp.mjs list                # Now targets Dia automatically
scripts/cdp.mjs use auto            # Clear session

# Environment variables
CDP_BROWSER=dia scripts/cdp.mjs list
CDP_PORT=9223 scripts/cdp.mjs list
```

**Multiple agents:** Use `--port` flags directly instead of `use` — the session file is shared.

## Profiles

Browsers can have multiple profiles (e.g., Work, Personal, Glints). All profiles share the same debug port.

```bash
# List all profiles
scripts/cdp.mjs --port 9222 profiles

# List shows profile name for each tab
scripts/cdp.mjs --port 9222 list
# D8D3BE54  [Work        ]  Example Page  https://example.com

# Filter tabs by profile
scripts/cdp.mjs --port 9222 list --profile Work

# Open URL in default profile
scripts/cdp.mjs --port 9222 open "https://example.com"

# Open URL in specific profile
scripts/cdp.mjs --port 9222 open "https://example.com" --profile "Casual Me"
```

**Note:** Opening in a specific profile only works if that profile window is already open. CDP cannot switch profiles — the user must open the profile window first via Chrome's profile picker.

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list                        # all tabs, all profiles
scripts/cdp.mjs list --profile Work         # filter by profile
scripts/cdp.mjs --port 9223 list            # specific browser
```

### Profiles

```bash
scripts/cdp.mjs profiles                    # list all browser profiles
```

### Open a new tab

```bash
scripts/cdp.mjs open <url>                  # default profile
scripts/cdp.mjs open <url> --profile Work   # specific profile (window must be open)
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: /tmp/screenshot.png
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs stop    [target]               # stop master daemon (or detach a tab)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once when the master daemon starts. Subsequent commands reuse the connection — no more popups.
- Dia and other browsers launched with `--remote-debugging-port` never show the popup.
- Only **loaded** tabs appear in `list`. Suspended/discarded tabs are invisible until clicked in the browser.
- **Multi-browser workflow:** Chrome on 9222 and Dia on 9223 simultaneously. Use `--port` to switch.
- **Multi-agent safety:** Use `--port` flags (not `use`) when multiple agents run concurrently.
