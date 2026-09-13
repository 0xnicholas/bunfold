/**
 * VENDOR INVARIANT (tokencamp patch P6 — see PATCHES.md «P6»)
 *
 * Destroying an instance must erase its on-disk store in sqlite
 * (standalone) mode: the forgetting-rights / org-dissolution caller
 * treats destroy as the physical end of the workspace's memory. An
 * evict-only destroy leaves vectors.db on disk and silently re-opens
 * it on the next access — the "destroyed" data stays fully queryable.
 *
 * Covered here:
 *  - deleteInstanceData removes the per-instance directory (db + wal
 *    + shm) and reports whether on-disk data existed;
 *  - the pool handle dies with the data: the next getStore re-creates
 *    an EMPTY store (no resurrection of pre-delete rows);
 *  - the "default" instance removes only its db files, never the
 *    shared dataDir around them (.metadata/ and friends survive);
 *  - service (non-sqlite) mode deletes nothing on disk but still
 *    evicts the pool handle.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorePool } from "../../src/core/store/store-pool.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { L0Record } from "../../src/core/store/types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let tmpDir: string;

function makePool(mode: "sqlite" | "tcvdb" = "sqlite"): StorePool {
  return new StorePool({
    mode,
    memoryCfg: {
      bm25: { enabled: false },
      embedding: { enabled: false },
    } as unknown as MemoryTdaiConfig,
    dataDir: tmpDir,
    logger: silentLogger,
  });
}

function l0Row(id: string): L0Record {
  return {
    id,
    sessionKey: "sess-key",
    sessionId: "sess",
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    role: "user",
    messageText: `raw message ${id}`,
    recordedAt: new Date(1_760_000_000_000).toISOString(),
    timestamp: 1_760_000_000_000,
  };
}

async function countL0(pool: StorePool, instanceId: string): Promise<number> {
  const pooled = await pool.getStore(instanceId, null);
  return (pooled.store as VectorStore).countL0();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p6-"));
});

afterEach(() => {
  // No pool close: the grace-close delay (30s, CR-5) is unref'd and
  // never blocks worker exit; awaiting it would stall the suite.
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("P6: instance destroy physically deletes the on-disk store (sqlite standalone)", () => {
  it("removes the per-instance directory and reports deleted=true", async () => {
    const pool = makePool();
    const pooled = await pool.getStore("inst-a", null);
    (pooled.store as VectorStore).upsertL0(l0Row("rec-1"));
    const dir = path.join(tmpDir, "instances", "inst-a");
    expect(fs.existsSync(path.join(dir, "vectors.db"))).toBe(true);
    expect(await countL0(pool, "inst-a")).toBe(1);

    const result = await pool.deleteInstanceData("inst-a");

    expect(result.deleted).toBe(true);
    expect(result.path).toBe(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("kills the pool handle with the data — the next store is EMPTY (no resurrection)", async () => {
    const pool = makePool();
    const pooled = await pool.getStore("inst-a", null);
    (pooled.store as VectorStore).upsertL0(l0Row("rec-1"));

    await pool.deleteInstanceData("inst-a");

    // A subsequent access re-creates the store at the same path; it
    // must come back empty — the pre-delete rows are gone for good.
    expect(await countL0(pool, "inst-a")).toBe(0);
  });

  it("reports deleted=false for an instance that never had data", async () => {
    const pool = makePool();
    const result = await pool.deleteInstanceData("inst-never");
    expect(result.deleted).toBe(false);
  });

  it("the default instance loses only its db files — the shared dataDir survives", async () => {
    const pool = makePool();
    const pooled = await pool.getStore("default", null);
    (pooled.store as VectorStore).upsertL0(l0Row("rec-1"));
    // Neighbour bookkeeping that must NOT be deleted with the store.
    const metadataDir = path.join(tmpDir, ".metadata");
    fs.mkdirSync(metadataDir, { recursive: true });
    fs.writeFileSync(path.join(metadataDir, "recall_checkpoint.json"), "{}");
    expect(fs.existsSync(path.join(tmpDir, "vectors.db"))).toBe(true);

    const result = await pool.deleteInstanceData("default");

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "vectors.db"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "vectors.db-wal"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "vectors.db-shm"))).toBe(false);
    expect(fs.existsSync(path.join(metadataDir, "recall_checkpoint.json"))).toBe(true);
    expect(await countL0(pool, "default")).toBe(0);
  });

  it("service (non-sqlite) mode deletes nothing on disk", async () => {
    const pool = makePool("tcvdb");
    const result = await pool.deleteInstanceData("inst-a");
    expect(result.deleted).toBe(false);
    expect(result.path).toBe("");
  });
});
