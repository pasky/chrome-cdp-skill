---
title: "plan: High ROI resource optimization"
type: plan
status: active
date: 2026-06-01
---

# High ROI resource optimization

## Goal

Implement the first group of resource-optimization changes that are most likely to lower end-to-end Chrome automation cost without changing the tool's core architecture.

## Scope

This plan only covers the first ROI tier:

- cheaper default agent behavior
- fewer unnecessary round trips
- bounded output for heavy-read commands
- better observability for payload-heavy commands

It does not cover screenshot clipping, idle shutdown, or any rewrite.

## Planned work

### P1. Make the low-cost path explicit

- Keep `inspect` as the default first read in `README.md` and `skills/chrome-cdp/SKILL.md`
- Explicitly steer users toward scoped `html` and one combined `eval`
- Keep `snap` and `shot` framed as escalation steps

### P2. Remove avoidable friction in target resolution

- Let page commands refresh the page cache when needed instead of forcing a manual `list` prerequisite
- Preserve the existing target-prefix workflow so current scripts do not break

### P3. Bound expensive output by default

- Truncate oversized `html` responses with a visible notice
- Limit `net` output to the most useful subset by default
- Keep command outputs human-readable rather than switching to verbose JSON by default

### P4. Improve observability for output cost

- Record response size in daemon command history
- Show payload size in `stats` so large-return commands become visible

## Verification

- `node --check skills/chrome-cdp/scripts/cdp.mjs`
- Manual `list`, `inspect`, `html`, `net`, and `stats` runs against a live Chrome session
- Confirm that commands remain backward compatible where possible and fail clearly where not

## Next phase after this plan

If this first group is stable and useful, the next plan should cover:

- clipped or element-scoped screenshots
- more granular observability
- short TTL metadata caching
