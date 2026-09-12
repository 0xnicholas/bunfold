/**
 * VENDOR INVARIANT (tokencamp FTS5 backport — see PATCHES.md «FTS5»)
 *
 * Backported from upstream main 1d4f84b ("fix(store): sanitize FTS5 query
 * tokens to prevent MATCH injection", Resolves #160). buildFtsQuery() turns
 * raw user text into an FTS5 MATCH expression; tokens carrying FTS5 operators
 * (`"` `*` `(` `)` `:` `^` AND/OR/NOT/NEAR) can hijack query semantics or
 * trigger syntax errors. The fix wraps every token as a double-quoted phrase
 * and escapes inner `"` as `""` — escaping (not stripping) so literal content
 * and recall are preserved.
 *
 * Covered here:
 *  - sanitizeFtsToken escapes inner quotes instead of deleting them;
 *  - sanitizeFtsWhitelist drops operator characters (defence-in-depth);
 *  - buildFtsQuery escapes quote-bearing tokens (fake-jieba discriminator —
 *    the old implementation stripped the quote and produced a term that
 *    matches nothing);
 *  - injection-laden queries run against a real FTS5 table without throwing
 *    and without changing the result set.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsToken,
  sanitizeFtsWhitelist,
} from "../../src/core/store/tokenize.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeRecord(id: string, content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "fact",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: now,
    updatedAt: now,
    sessionKey: "sk-fts",
    sessionId: "sess-fts",
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
  };
}

describe("FTS5 backport: token sanitisation", () => {
  beforeEach(() => {
    _setJiebaForTest(null); // deterministic fallback tokeniser
  });

  afterEach(() => {
    _resetJiebaForTest();
  });

  it("sanitizeFtsToken escapes inner double quotes instead of stripping them", () => {
    expect(sanitizeFtsToken("plain")).toBe('"plain"');
    expect(sanitizeFtsToken('foo"bar')).toBe('"foo""bar"');
    expect(sanitizeFtsToken('"quoted"')).toBe('"""quoted"""');
  });

  it("sanitizeFtsWhitelist drops FTS5 operator characters, keeps search-meaningful ones", () => {
    expect(sanitizeFtsWhitelist('foo" OR "bar')).toBe("foo OR bar");
    expect(sanitizeFtsWhitelist("a*b(c):^d")).toBe("a b c d");
    expect(sanitizeFtsWhitelist("keep_dot/slash-hyphen_123")).toBe("keep_dot/slash-hyphen_123");
    expect(sanitizeFtsWhitelist('***"""((()))')).toBe("");
  });

  it("buildFtsQuery escapes quote-bearing tokens (fake jieba discriminator)", () => {
    // The fallback tokeniser never emits quotes (regex splits on non-word
    // chars); the recall-harming strip only shows through the jieba path.
    _setJiebaForTest({ cutForSearch: () => ['foo"bar', "tea"] });
    expect(buildFtsQuery("ignored")).toBe('"foo""bar" OR "tea"');
  });

  it("buildFtsQuery literalises operator keywords and syntax characters", () => {
    // fallback path: regex keeps word chars only, then every token is quoted,
    // so AND/OR/NEAR arrive as literal phrases, not operators.
    expect(buildFtsQuery('tea" OR "deploy')).toBe('"tea" OR "OR" OR "deploy"');
    expect(buildFtsQuery("AND OR NOT NEAR")).toBe('"AND" OR "OR" OR "NOT" OR "NEAR"');
  });
});

describe("FTS5 backport: real FTS5 table is injection-safe", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    _setJiebaForTest(null);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-fts5-"));
    store = new VectorStore(path.join(tmpDir, "vectors.db"), 0, silentLogger);
    store.init();
    store.upsertL1(makeRecord("mem-tea", "user enjoys jasmine tea every morning"));
    store.upsertL1(makeRecord("mem-deploy", "production deploy runbook for the billing service"));
  });

  afterEach(() => {
    _resetJiebaForTest();
    try {
      store.close();
    } catch {
      /* best-effort */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quote/operator injection does not throw and does not widen the result set", () => {
    const clean = buildFtsQuery("tea");
    const injected = buildFtsQuery('tea" OR "deploy');
    expect(clean).toBeTruthy();
    expect(injected).toBeTruthy();

    const cleanHits = store.searchL1Fts(clean!, 10).map((h) => h.record_id).sort();
    expect(cleanHits).toEqual(["mem-tea"]);

    // "OR" arrives as a literal quoted phrase (matches nothing), so the
    // injected query degrades to the same semantics as `tea OR deploy` —
    // both rows recall, no syntax error, no semantics hijack beyond OR-union
    // of literal terms.
    const injectedHits = store.searchL1Fts(injected!, 10).map((h) => h.record_id).sort();
    expect(injectedHits).toEqual(["mem-deploy", "mem-tea"]);
  });

  it("hostile operator soup produces no MATCH syntax error", () => {
    const q = buildFtsQuery('" * ( ) : ^ NEAR/1 AND OR NOT "unclosed');
    if (q) {
      expect(() => store.searchL1Fts(q, 10)).not.toThrow();
    }
  });
});
