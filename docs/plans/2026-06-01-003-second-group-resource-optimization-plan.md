---
title: "plan: Second-group resource optimization"
type: plan
status: active
date: 2026-06-01
---

# Second-group resource optimization

## Goal

Implement the next most valuable resource optimizations after the first high-ROI pass:

- cheaper visual capture paths
- more granular observability
- safer short-lived metadata caching

## Scope

This plan targets the second optimization tier only. It does not include daemon idle shutdown or any language rewrite.

## Planned work

### P1. Add cheaper screenshot paths

- Support clipped or element-scoped screenshots instead of only viewport-wide capture
- Keep CSS-pixel coordinate behavior explicit so clipped capture still works with `clickxy`
- Preserve the current default screenshot behavior for backward compatibility

### P2. Add tighter scope controls where they materially reduce payload size

- Extend read-heavy commands with optional scope controls only where they improve output discipline without making the CLI awkward
- Keep defaults simple and human-readable

### P3. Improve daemon observability depth

- Separate high-level command timing from likely sub-costs such as page enumeration or attach/re-attach
- Make it easier to see whether slowness came from command body work or from setup work around it

### P4. Add short TTL metadata caching

- Cache cheap metadata such as page lists and target resolution for a short window
- Avoid caching DOM-heavy or interaction-sensitive state
- Keep cache invalidation conservative and easy to reason about

## Recommended implementation order

1. Screenshot scope reduction
2. Observability depth
3. Metadata caching
4. Optional extra scope controls on read-heavy commands

## Verification

- `node --check skills/chrome-cdp/scripts/cdp.mjs`
- Manual screenshot verification against a live Chrome session
- Manual `stats` verification showing the new observability fields
- Confirm backward compatibility for existing `shot` usage
