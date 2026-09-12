/**
 * VENDOR INVARIANT (tokencamp patch P1 — see PATCHES.md «P1»)
 *
 * After an L1 distillation run completes, the L0 raw rows it consumed must be
 * physically gone from the store (zero-raw-text posture). The L1 extraction
 * cursor is persisted FIRST; only then are the consumed rows deleted.
 *
 * Covered here:
 *  - consumed rows are deleted after a successful run (meta gone, none
 *    re-readable via the L1 query path);
 *  - rows NOT consumed by the run (past the processing batch) survive;
 *  - the cursor advances monotonically, so a second run does not re-distill
 *    already-consumed history.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { createL1Runner, L1_BATCH_PROCESS } from "../../src/utils/pipeline-factory.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { L0Record } from "../../src/core/store/types.js";
import type { LLMRunner } from "../../src/core/types.js";

const SESSION_KEY = "sk-vendor-p1";
const SESSION_ID = "sess-vendor-p1";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCfg(): MemoryTdaiConfig {
  return {
    extraction: {
      enableDedup: false,
      maxMemoriesPerSession: 20,
      model: "stub-model",
      promptMode: "default",
    },
    embedding: {
      conflictRecallTopK: 5,
      timeoutMs: 1_000,
    },
  } as unknown as MemoryTdaiConfig;
}

/** LLM runner stub: returns a valid empty extraction result (0 memories). */
const emptyExtractionRunner: LLMRunner = {
  run: async () => "[]",
};

let tmpDir: string;
let store: VectorStore;

function l0Row(idx: number, baseMs: number): L0Record {
  const recordedAtMs = baseMs + idx;
  return {
    id: `rec-${baseMs}-${idx}`,
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    role: idx % 2 === 0 ? "user" : "assistant",
    messageText: `raw message ${idx}`,
    recordedAt: new Date(recordedAtMs).toISOString(),
    timestamp: recordedAtMs,
  };
}

function remainingL0(): number {
  const rows = store.queryL0ForL1(SESSION_KEY, undefined, 10_000);
  return rows.length;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p1-"));
  store = new VectorStore(path.join(tmpDir, "vectors.db"), 0, silentLogger);
  store.init();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* best-effort */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("P1: consumed L0 rows are physically deleted after L1 distillation", () => {
  it("deletes every consumed row after the cursor is persisted", async () => {
    const baseMs = 1_760_000_000_000;
    for (let i = 0; i < 4; i++) {
      store.upsertL0(l0Row(i, baseMs));
    }
    expect(remainingL0()).toBe(4);

    const runL1 = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      llmRunner: emptyExtractionRunner,
    });

    const result = await runL1({ sessionKey: SESSION_KEY });
    expect(result.processedCount).toBe(4);

    // Invariant: no consumed raw text remains — not via count, not via query.
    expect(remainingL0()).toBe(0);
    expect(store.countL0()).toBe(0);

    // Cursor advanced: a second run finds nothing to re-distill.
    const second = await runL1({ sessionKey: SESSION_KEY });
    expect(second.processedCount).toBe(0);
  });

  it("keeps rows that were not consumed by the run (beyond the processing batch)", async () => {
    const baseMs = 1_760_000_100_000;
    const total = L1_BATCH_PROCESS + 5;
    for (let i = 0; i < total; i++) {
      // Distinct recordedAtMs per row → no same-ms boundary extension.
      store.upsertL0(l0Row(i, baseMs + i * 10));
    }

    const runL1 = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      llmRunner: emptyExtractionRunner,
    });

    const first = await runL1({ sessionKey: SESSION_KEY });
    expect(first.processedCount).toBe(L1_BATCH_PROCESS);
    expect(first.hasMore).toBe(true);
    expect(remainingL0()).toBe(total - L1_BATCH_PROCESS);

    // Drain the backlog: the tail is consumed (and deleted) by the next run.
    const second = await runL1({ sessionKey: SESSION_KEY });
    expect(second.processedCount).toBe(total - L1_BATCH_PROCESS);
    expect(remainingL0()).toBe(0);
  });
});
