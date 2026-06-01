---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path
- Set `CDP_HOST` if Chrome's debugging socket is not reachable on `127.0.0.1`

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Lightweight page inspection

```bash
scripts/cdp.mjs inspect <target> [selector]
```

Use `inspect` first for page state: title, URL, ready state, focus, visible controls, links, inputs, forms, headings, and a bounded text sample. Prefer scoped `html` or one combined `eval` before escalating to `snap` for full accessibility structure or `shot` for visual evidence.

### Daemon stats

```bash
scripts/cdp.mjs stats
```

Shows browser daemon uptime, session/page counts, and recent command timings. Use this when local Chrome automation feels slow or resource-heavy.

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # scoped HTML, truncated when large
scripts/cdp.mjs inspect <target> [selector]   # lightweight page summary
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # slowest resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab via the browser daemon
scripts/cdp.mjs stats                          # daemon health and recent command timings
scripts/cdp.mjs stop                           # stop the browser daemon
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Prefer `inspect` for first-pass page state; use scoped `html` or one combined `eval` before reaching for `snap` or `shot`.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Prefer one combined `eval` over many small `eval` calls when collecting structured page data.
- Use `stats` to spot commands that return unusually large payloads, not just slow ones.
- Chrome shows an "Allow debugging" modal once per Chrome session. A background browser daemon keeps the CDP connection alive so subsequent commands need no further approval until Chrome disconnects or you run `stop`.
