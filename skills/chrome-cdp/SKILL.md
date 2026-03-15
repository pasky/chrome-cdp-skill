---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Browser Selection (IMPORTANT — read before first use)

Multiple Chromium browsers may be running simultaneously. The skill must target the right one.

**Priority order for browser selection:**
1. **Project CLAUDE.md** — check for a `cdp-browser` setting (e.g. `cdp-browser: canary`). If found, use `--browser <value>` on all commands.
2. **User instruction** — if the user says "use Chrome Canary" or "check my Brave tabs", use `--browser canary` or `--browser brave`.
3. **Ask the user** — on first invocation in a session where no preference is set, ask which browser to target. Remember the answer for the rest of the session.
4. **Auto-discovery** — if none of the above apply, the CLI auto-detects the first running browser.

**Available `--browser` values:** `chrome`, `canary`, `beta`, `testing`, `chromium`, `brave`, `edge`

**Usage:** Prepend `--browser <name>` before the command:
```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs --browser chrome list
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs --browser canary snap <target>
```

Or set `CDP_BROWSER=canary` as environment variable for the session.

## Prerequisites

- Chrome/Chromium/Brave/Edge with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `${CLAUDE_SKILL_DIR}/scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs list
```

### Take a screenshot

```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs shot <target> [file]    # default: ~/.cache/cdp/screenshot-*.png
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs net     <target>               # resource timing entries
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
${CLAUDE_SKILL_DIR}/scripts/cdp.mjs stop    [target]               # stop daemon(s)
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
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
