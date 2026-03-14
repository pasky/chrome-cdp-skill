# chrome-cdp

Let your AI agent see and interact with your **live Chrome session** — the tabs you already have open, your logged-in accounts, your current page state. No browser automation framework, no separate browser instance, no re-login.

Works with normal Chrome. Turn on Chrome remote debugging once, then your agent can inspect and interact with the tabs you already have open.

## Why this matters

Most browser automation tools launch a fresh, isolated browser. This one connects to the Chrome you're already running, so your agent can:

- Read pages you're logged into (Gmail, GitHub, internal tools, ...)
- Interact with tabs you're actively working in
- See the actual state of a page mid-workflow, not a clean reload

## Quick start

1. Install the skill.
2. In Chrome, open `chrome://inspect/#remote-debugging` and turn on remote debugging.
3. Open Codex, Claude Code, or another agent that can use this skill.
4. Ask the agent to use your current Chrome tabs.

Example prompts:

- "Use the chrome-cdp skill and list my open Chrome tabs."
- "Use chrome-cdp to inspect the current page in my open Chrome tab."
- "Use chrome-cdp to click the Save button in the tab I already have open."
- "Use chrome-cdp to take a screenshot of my current tab."
- "Use chrome-cdp to navigate the current tab to https://example.com."

The agent handles the skill details for you. In normal use, you do not need to
know or run the underlying script yourself.

If Chrome shows an "Allow debugging" prompt the first time, approve it for the
tab you want the agent to use.

## Installation

### As a pi skill

```bash
pi install git:github.com/pasky/chrome-cdp-skill@v1.0.1
```

### For other agents (Amp, Claude Code, Cursor, etc.)

Clone or copy the `skills/chrome-cdp/` directory wherever your agent loads skills or context from. The only runtime dependency is **Node.js 22+** — no npm install needed.

### Enable remote debugging in Chrome

Open `chrome://inspect/#remote-debugging` in Chrome and turn the switch on.

The first time a tab is accessed, Chrome may show an "Allow debugging" prompt. Approve it for tabs you want the agent to use.

## What the skill can do

- Read what is on the current page
- Save a screenshot
- Click buttons, links, and other elements
- Type into the currently focused field
- Navigate the current tab to another URL
- Inspect network timing information
- Run page JavaScript or raw CDP commands in advanced cases

Example prompts:

- "Use chrome-cdp to list my open tabs."
- "Use chrome-cdp to inspect the current page."
- "Use chrome-cdp to click the Continue button in my open Chrome tab."
- "Use chrome-cdp to type into the currently focused field."
- "Use chrome-cdp to take a screenshot."
- "Use chrome-cdp to navigate my current tab to https://example.com."
- "Use chrome-cdp to show network timings for the current page."

## Why this skill exists

This skill is built for live agent work against the Chrome session you already use.

Compared to tools that reconnect on every command, `chrome-cdp` keeps one small background helper per tab. That matters because:

- Chrome asks for debugging approval only once per tab, not over and over
- Commands are faster after the first attach
- It works better when you have many tabs open

Internally it talks directly to Chrome DevTools Protocol over Chrome's debugging socket. You usually do not need to care about those details unless you are extending the skill.

## Why not chrome-devtools-mcp?

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is relevant comparison because it solves a similar problem.

The main difference is connection style:

- `chrome-devtools-mcp` reconnects on each command
- `chrome-cdp` keeps one small background daemon per tab

Why that matters in practice:

- Chrome asks for debugging approval once per tab instead of over and over
- Follow-up commands are faster after the first attach
- It behaves better when you have many tabs open

## Security model

`chrome-cdp` is a local-user tool. Once you approve Chrome debugging for a tab, this tool can act with that tab's full session state, including logged-in content and privileged workflows.

In plain terms:

- Files are kept in a private per-user runtime directory instead of global `/tmp`
- Daemon socket names are random, not predictable
- Only the current user can read the cache and daemon metadata files
- Every daemon request needs a session token

### `--allow-unsafe`

Most users do **not** need this.

You only need unsafe mode when you explicitly want the agent to:

- run JavaScript in the page
- send raw CDP commands

Examples:

- "Use chrome-cdp in unsafe mode and run `document.title` in the current page."
- "Use chrome-cdp in unsafe mode and send a raw CDP command."

If you maintain the skill or wrapper yourself, unsafe mode maps to the
underlying `--allow-unsafe` flag. Leave it off for normal reading, clicking,
typing, navigation, and screenshots.

Use it only for trusted flows. These commands can run arbitrary page JavaScript or raw CDP methods against your live Chrome tab.

This makes the local setup safer, but it is not a full sandbox. If something already runs as your user, it may still be able to use the Chrome session you approved. The main improvement is simple: no predictable `/tmp` paths and no unauthenticated local daemon access.

## For maintainers and manual debugging

Most users can ignore this section.

The skill is backed by `scripts/cdp.mjs`. If you are debugging the skill itself
from a terminal, these are the underlying commands:

```bash
scripts/cdp.mjs list                              # list open tabs
scripts/cdp.mjs shot   <target>                   # screenshot -> private runtime path
scripts/cdp.mjs snap   <target>                   # accessibility tree
scripts/cdp.mjs html   <target> [".selector"]     # full HTML or scoped HTML
scripts/cdp.mjs --allow-unsafe eval <target> "expression"
scripts/cdp.mjs nav    <target> https://...       # navigate and wait for load
scripts/cdp.mjs net    <target>                   # network timing
scripts/cdp.mjs click  <target> "selector"        # click element by selector
scripts/cdp.mjs clickxy <target> <x> <y>          # click at CSS pixel coordinates
scripts/cdp.mjs type   <target> "text"            # type at focused element
scripts/cdp.mjs loadall <target> "selector"       # click "load more" until gone
scripts/cdp.mjs --allow-unsafe evalraw <target> <method> [json]
scripts/cdp.mjs stop   [target]                   # stop daemon(s)
```

`<target>` is a unique prefix of the target id shown by `list`.
