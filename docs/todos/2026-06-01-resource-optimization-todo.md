---
title: "todo: Chrome automation resource optimization"
status: active
date: 2026-06-01
---

# Chrome automation resource optimization

## Context

This repo already avoids the biggest obvious waste: it keeps one persistent browser daemon and one long-lived CDP WebSocket instead of reconnecting on every command.

The next resource wins are mostly about reducing expensive CDP behaviors, shrinking response payloads, and steering agent usage toward cheaper primitives by default.

## Working assumptions

- The dominant resource cost is usually Chrome-side work plus CDP payload size, not the Node.js daemon itself.
- `snap`, `shot`, and full-page `html` are the highest-risk commands for oversized output or expensive page inspection.
- Agent usage strategy matters as much as script implementation because the skill decides which primitive gets called first.

## Todo list

### Completed: first group

- [x] Make `inspect` the default first-pass read path everywhere the skill explains usage.
- [x] Prefer scoped `html` and one combined `eval` before escalating to `snap` or `shot`.
- [x] Reduce unnecessary CLI round trips such as requiring users to manually run `list` before every target command.
- [x] Add bounded output defaults for commands likely to return large payloads.
- [x] Extend `stats` so it helps distinguish slow commands from oversized responses.

### Next target: second group

- Add more granular screenshot modes such as clipped or element-scoped capture instead of always taking the full viewport.
- Add tighter scope controls for `inspect`, `html`, and `net` where that improves payload discipline without making the CLI awkward.
- Add short-lived caching for cheap metadata such as page lists and target resolution, but avoid stale DOM-heavy caching.
- Add more detailed observability around target enumeration, attach cost, and command categories.

### Recommended next move

The next implementation pass should start with screenshot scope reduction and finer daemon observability:

- Screenshot scope reduction creates a genuinely cheaper path for visual verification work.
- Finer observability makes the next optimization round evidence-based instead of guess-based.
- Metadata cache tuning should follow after the observability shape is good enough to justify it.

### Lower ROI or later-stage work

- Consider daemon idle shutdown if background footprint becomes a real complaint.
- Consider Rust only if the goals include lower idle footprint, single-binary distribution, or removing the Node runtime dependency. Do not treat a rewrite as the first resource lever.

## Non-goals for now

- Do not optimize for Chrome renderer CPU attribution in the first pass.
- Do not introduce cross-platform process inspection just to estimate browser CPU or memory.
- Do not broaden the command surface unless the new command clearly creates a cheaper path than existing ones.

## Decision rule

Prioritize changes that:

- reduce the number of expensive commands issued
- reduce the size of returned data
- reduce the number of daemon ↔ Chrome ↔ CLI round trips
- improve measurement enough to stop guessing where the cost is
