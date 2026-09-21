/**
 * VENDOR INVARIANT (tokencamp patch P10 — see PATCHES.md «P10»)
 *
 * generateMemoryId() is the ONLY mint point for L1 record ids, and the
 * store lands them with INSERT ... ON CONFLICT(record_id) DO UPDATE — an
 * id collision silently OVERWRITES an existing entry. Upstream mints only
 * 32 bits of random entropy (crypto.randomBytes(4)); at 10k records on one
 * instance the birthday bound is ~1.2%. The patch widens the entropy to
 * 64 bits (randomBytes(8)) while keeping the `m_<epochMs>_<hex>` shape the
 * tokencamp gateway relies on (a `manual_`-prefixed client id can never
 * collide with an engine-minted one).
 *
 * Covered here:
 *  - every minted id matches /^m_\d+_[0-9a-f]{16}$/ (16 hex = 8 bytes);
 *  - consecutive mints never repeat;
 *  - the `m_` prefix is unchanged (the `manual_` namespace stays disjoint).
 */

import { describe, expect, it } from "vitest";

import { generateMemoryId } from "../../src/core/record/l1-writer.js";

describe("vendor P10: L1 record_id mint entropy", () => {
  it("mints the m_<epochMs>_<16 hex> shape", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateMemoryId()).toMatch(/^m_\d+_[0-9a-f]{16}$/);
    }
  });

  it("never repeats across consecutive mints", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = generateMemoryId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("keeps the m_ prefix (the manual_ namespace stays disjoint)", () => {
    const id = generateMemoryId();
    expect(id.startsWith("m_")).toBe(true);
    expect(id.startsWith("manual_")).toBe(false);
  });
});
