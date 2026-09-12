/**
 * VENDOR INVARIANT (tokencamp patch P2 — see PATCHES.md «P2»)
 *
 * In standalone deploy mode the engine must not mirror raw conversation text
 * to `conversations/<date>.jsonl` — zero-raw-text means no append-only copies.
 * The mirror is now gated behind a single switch
 * (`TDAI_STANDALONE_JSONL_MIRROR`, default OFF) enforced at both writers:
 * the v2 `/conversation/add` mirror and the v1 `/capture` l0-recorder.
 *
 * Covered here:
 *  - v2 standalone write stores L0 rows but appends no JSONL by default;
 *  - v1 recordConversation writes no JSONL file by default;
 *  - parity remains reachable: with the switch on, both mirrors write again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { handleConversationAdd } from "../../src/gateway/v2-router.js";
import type { V2RouterDeps } from "../../src/gateway/v2-router.js";
import { recordConversation } from "../../src/core/conversation/l0-recorder.js";
import type { StorageAdapter } from "../../src/core/storage/adapter.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let tmpDir: string;
let store: VectorStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p2-"));
  store = new VectorStore(path.join(tmpDir, "vectors.db"), 0, silentLogger);
  store.init();
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    store.close();
  } catch {
    /* best-effort */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function jsonlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonlFilesUnder(full));
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

describe("P2: standalone writes produce no JSONL mirror by default", () => {
  it("v2 /conversation/add stores L0 rows but appends no conversations/*.jsonl", async () => {
    const appendFile = vi.fn(async () => {});
    const deps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({ appendFile }) as unknown as StorageAdapter,
      logger: silentLogger,
      deployMode: "standalone",
      requestIsolation: { teamId: "t1", userId: "u1", agentId: "a1", sessionId: "sess-p2" },
    } as unknown as V2RouterDeps;

    const res = await handleConversationAdd(
      {
        session_id: "sess-p2",
        messages: [
          { role: "user", content: "raw secret content one" },
          { role: "assistant", content: "raw secret content two" },
        ],
      },
      { apiKey: "k", serviceId: "inst-1" },
      "req-1",
      deps,
    );

    expect(res.code).toBe(0);
    // Authoritative store received the rows …
    expect(store.queryL0ForL1("sess-p2", undefined, 100)).toHaveLength(2);
    // … and the JSONL mirror stayed off.
    expect(appendFile).not.toHaveBeenCalled();
    expect(jsonlFilesUnder(tmpDir)).toHaveLength(0);
  });

  it("v1 recordConversation returns messages but writes no JSONL file by default", async () => {
    const messages = await recordConversation({
      sessionKey: "sess-p2-v1",
      sessionId: "sess-p2-v1",
      userId: "u1",
      agentId: "a1",
      rawMessages: [
        { role: "user", content: "raw secret content three", timestamp: 1_760_000_000_001 },
        { role: "assistant", content: "raw secret content four", timestamp: 1_760_000_000_002 },
      ],
      baseDir: tmpDir,
      logger: silentLogger,
    });

    expect(messages.length).toBeGreaterThan(0);
    expect(jsonlFilesUnder(tmpDir)).toHaveLength(0);
  });

  it("parity: with TDAI_STANDALONE_JSONL_MIRROR=1 both mirrors write again", async () => {
    vi.stubEnv("TDAI_STANDALONE_JSONL_MIRROR", "1");

    const appendFile = vi.fn(async () => {});
    const deps = {
      getStore: () => store,
      getEmbedding: () => undefined,
      getStorage: () => ({ appendFile }) as unknown as StorageAdapter,
      logger: silentLogger,
      deployMode: "standalone",
      requestIsolation: { teamId: "t1", userId: "u1", agentId: "a1", sessionId: "sess-p2" },
    } as unknown as V2RouterDeps;

    await handleConversationAdd(
      { session_id: "sess-p2", messages: [{ role: "user", content: "mirrored content" }] },
      { apiKey: "k", serviceId: "inst-1" },
      "req-2",
      deps,
    );
    expect(appendFile).toHaveBeenCalled();

    await recordConversation({
      sessionKey: "sess-p2-v1",
      rawMessages: [{ role: "user", content: "mirrored v1 content", timestamp: 1_760_000_000_003 }],
      baseDir: tmpDir,
      logger: silentLogger,
    });
    expect(jsonlFilesUnder(tmpDir).length).toBeGreaterThan(0);
  });
});
