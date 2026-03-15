#!/usr/bin/env node
/**
 * Unit tests for cdp.mjs utility functions
 * Run with: node --test cdp.test.mjs
 * Requires Node.js 22+ (built-in test runner)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test utilities - reimplemented from cdp.mjs for isolated testing
// ---------------------------------------------------------------------------

const MIN_TARGET_PREFIX_LEN = 8;

function resolvePrefix(prefix, candidates, noun = "target", missingHint = "") {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter((candidate) =>
    candidate.toUpperCase().startsWith(upper)
  );
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : "";
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`
    );
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map((id) => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(
      targetIds.map((id) => id.slice(0, len).toUpperCase())
    );
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

function sockPath(targetId) {
  return `/tmp/cdp-${targetId}.sock`;
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || "";
  const name = node.name?.value ?? "";
  const value = node.value?.value;
  if (compact && role === "InlineTextBox") return false;
  return (
    role !== "none" &&
    role !== "generic" &&
    !(name === "" && (value === "" || value == null))
  );
}

function formatAxNode(node, depth) {
  const role = node.role?.value || "";
  const name = node.name?.value ?? "";
  const value = node.value?.value;
  const indent = "  ".repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== "") line += ` ${name}`;
  if (!(value === "" || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePrefix", () => {
  const candidates = [
    "6BE827FA1234",
    "6BE827FB5678",
    "ABC123456789",
    "DEF987654321",
  ];

  it("should resolve exact match", () => {
    const result = resolvePrefix("6BE827FA1234", candidates);
    assert.equal(result, "6BE827FA1234");
  });

  it("should resolve unique prefix", () => {
    const result = resolvePrefix("ABC", candidates);
    assert.equal(result, "ABC123456789");
  });

  it("should be case-insensitive", () => {
    const result = resolvePrefix("abc", candidates);
    assert.equal(result, "ABC123456789");
  });

  it("should throw on no match", () => {
    assert.throws(
      () => resolvePrefix("XYZ", candidates),
      /No target matching prefix "XYZ"/
    );
  });

  it("should throw on ambiguous prefix", () => {
    assert.throws(
      () => resolvePrefix("6BE827F", candidates),
      /Ambiguous prefix "6BE827F"/
    );
  });

  it("should include custom noun in error", () => {
    assert.throws(
      () => resolvePrefix("XYZ", candidates, "daemon"),
      /No daemon matching prefix "XYZ"/
    );
  });

  it("should include hint in error when provided", () => {
    assert.throws(
      () => resolvePrefix("XYZ", candidates, "target", "Run cdp list first."),
      /Run cdp list first/
    );
  });
});

describe("getDisplayPrefixLength", () => {
  it("should return MIN_TARGET_PREFIX_LEN for empty array", () => {
    assert.equal(getDisplayPrefixLength([]), MIN_TARGET_PREFIX_LEN);
  });

  it("should return MIN_TARGET_PREFIX_LEN when all IDs are unique at that length", () => {
    const ids = ["AAAAAAAA1111", "BBBBBBBB2222"];
    assert.equal(getDisplayPrefixLength(ids), MIN_TARGET_PREFIX_LEN);
  });

  it("should return longer length when needed to disambiguate", () => {
    const ids = ["AAAAAAAA1111", "AAAAAAAA2222"];
    assert.equal(getDisplayPrefixLength(ids), 9);
  });

  it("should handle single ID", () => {
    const ids = ["ABC123456789"];
    assert.equal(getDisplayPrefixLength(ids), MIN_TARGET_PREFIX_LEN);
  });

  it("should be case-insensitive", () => {
    const ids = ["aaaaaaaa1111", "AAAAAAAA2222"];
    assert.equal(getDisplayPrefixLength(ids), 9);
  });
});

describe("sockPath", () => {
  it("should generate correct socket path", () => {
    assert.equal(sockPath("ABC123"), "/tmp/cdp-ABC123.sock");
  });

  it("should handle empty targetId", () => {
    assert.equal(sockPath(""), "/tmp/cdp-.sock");
  });
});

describe("shouldShowAxNode", () => {
  it("should hide nodes with role none", () => {
    const node = { role: { value: "none" }, name: { value: "test" } };
    assert.equal(shouldShowAxNode(node), false);
  });

  it("should hide nodes with role generic", () => {
    const node = { role: { value: "generic" }, name: { value: "test" } };
    assert.equal(shouldShowAxNode(node), false);
  });

  it("should hide nodes with empty name and no value", () => {
    const node = { role: { value: "button" }, name: { value: "" } };
    assert.equal(shouldShowAxNode(node), false);
  });

  it("should show nodes with name", () => {
    const node = { role: { value: "button" }, name: { value: "Submit" } };
    assert.equal(shouldShowAxNode(node), true);
  });

  it("should show nodes with value", () => {
    const node = {
      role: { value: "textbox" },
      name: { value: "" },
      value: { value: "hello" },
    };
    assert.equal(shouldShowAxNode(node), true);
  });

  it("should hide InlineTextBox in compact mode", () => {
    const node = { role: { value: "InlineTextBox" }, name: { value: "text" } };
    assert.equal(shouldShowAxNode(node, true), false);
    assert.equal(shouldShowAxNode(node, false), true);
  });
});

describe("formatAxNode", () => {
  it("should format node with role only", () => {
    const node = { role: { value: "button" } };
    assert.equal(formatAxNode(node, 0), "[button]");
  });

  it("should format node with name", () => {
    const node = { role: { value: "button" }, name: { value: "Submit" } };
    assert.equal(formatAxNode(node, 0), "[button] Submit");
  });

  it("should format node with value", () => {
    const node = {
      role: { value: "textbox" },
      name: { value: "Email" },
      value: { value: "test@example.com" },
    };
    assert.equal(formatAxNode(node, 0), '[textbox] Email = "test@example.com"');
  });

  it("should indent based on depth", () => {
    const node = { role: { value: "button" }, name: { value: "Submit" } };
    assert.equal(formatAxNode(node, 2), "    [button] Submit");
  });

  it("should cap indentation at depth 10", () => {
    const node = { role: { value: "button" } };
    const result = formatAxNode(node, 15);
    assert.equal(result, "                    [button]");
  });
});
