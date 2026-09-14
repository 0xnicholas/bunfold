/**
 * VENDOR INVARIANT (tokencamp patch P3 — see PATCHES.md «P3»)
 *
 * Every LLM chat call the engine makes in standalone mode must carry the
 * cost-attribution headers `x-tc-instance` (tenant instance) and
 * `x-tc-agent` (agent/project). When either value cannot be resolved the
 * call must fail closed: the error is raised BEFORE any HTTP request leaves
 * the process. A failed-closed L1 run must not consume L0 rows (cursor not
 * persisted, rows kept for the scheduler's natural retry).
 *
 * Covered here:
 *  - StandaloneLLMRunner sends both headers when attribution is provided;
 *  - missing instanceId or agentId → throw, zero requests on the wire;
 *  - end-to-end through the L1 pipeline: distillation calls arrive at the
 *    LLM endpoint carrying the group agentId + instanceId;
 *  - unresolved attribution aborts the L1 run before the cursor persists
 *    (L0 rows are preserved for retry, nothing is billed).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { StandaloneLLMRunner } from "../../src/adapters/standalone/llm-runner.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { createL1Runner } from "../../src/utils/pipeline-factory.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { L0Record } from "../../src/core/store/types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let baseUrl: string;
let captured: CapturedRequest[];

const CHAT_COMPLETION = JSON.stringify({
  id: "chatcmpl-vendor-p3",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "stub-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "[]" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeEach(async () => {
  captured = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(CHAT_COMPLETION);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function makeRunner(): StandaloneLLMRunner {
  return new StandaloneLLMRunner({
    config: { baseUrl, apiKey: "test-key", model: "stub-model" },
  });
}

describe("P3: StandaloneLLMRunner attribution headers", () => {
  it("sends x-tc-instance and x-tc-agent on every call", async () => {
    const runner = makeRunner();
    const text = await runner.run({
      prompt: "extract",
      taskId: "l1-extraction",
      instanceId: "inst-1",
      agentId: "agent-1",
      // P8: the runner also requires a work token now (see
      // work-token-headers.test.ts for the x-tc-work invariant).
      work: "distill-l1",
    });

    expect(text).toBe("[]");
    expect(captured.length).toBeGreaterThan(0);
    for (const req of captured) {
      expect(req.headers["x-tc-instance"]).toBe("inst-1");
      expect(req.headers["x-tc-agent"]).toBe("agent-1");
    }
  });

  it("fails closed when instanceId is missing — no request leaves the process", async () => {
    const runner = makeRunner();
    await expect(
      runner.run({ prompt: "extract", taskId: "l1-extraction", agentId: "agent-1" }),
    ).rejects.toThrow(/x-tc-instance/);
    expect(captured).toHaveLength(0);
  });

  it("fails closed when agentId is missing — no request leaves the process", async () => {
    const runner = makeRunner();
    await expect(
      runner.run({ prompt: "extract", taskId: "l1-extraction", instanceId: "inst-1" }),
    ).rejects.toThrow(/x-tc-agent/);
    expect(captured).toHaveLength(0);
  });
});

describe("P3: attribution threads through the L1 distillation pipeline", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p3-"));
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

  function seedRows(): void {
    const baseMs = 1_760_000_000_000;
    for (let i = 0; i < 2; i++) {
      const recordedAtMs = baseMs + i;
      const record: L0Record = {
        id: `rec-p3-${i}`,
        sessionKey: "sk-p3",
        sessionId: "sess-p3",
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-9",
        role: i % 2 === 0 ? "user" : "assistant",
        messageText: `message ${i}`,
        recordedAt: new Date(recordedAtMs).toISOString(),
        timestamp: recordedAtMs,
      };
      store.upsertL0(record);
    }
  }

  function makeCfg(): MemoryTdaiConfig {
    return {
      extraction: { enableDedup: false, maxMemoriesPerSession: 20, model: "stub-model", promptMode: "default" },
      embedding: { conflictRecallTopK: 5, timeoutMs: 1_000 },
    } as unknown as MemoryTdaiConfig;
  }

  it("distillation LLM calls carry the pipeline instanceId and group agentId", async () => {
    seedRows();
    const runL1 = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      getInstanceId: () => "inst-7",
      llmRunner: makeRunner(),
    });

    await runL1({ sessionKey: "sk-p3" });

    expect(captured.length).toBeGreaterThan(0);
    for (const req of captured) {
      expect(req.headers["x-tc-instance"]).toBe("inst-7");
      expect(req.headers["x-tc-agent"]).toBe("agent-9");
    }
  });

  it("unresolved attribution aborts the run: cursor not persisted, L0 rows kept, nothing billed", async () => {
    seedRows();
    const runL1 = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      getInstanceId: () => undefined,
      llmRunner: makeRunner(),
    });

    await expect(runL1({ sessionKey: "sk-p3" })).rejects.toThrow(/x-tc-instance/);

    // Fail-closed: zero requests hit the LLM endpoint …
    expect(captured).toHaveLength(0);
    // … the run did not consume the rows (retry can reprocess them) …
    expect(store.queryL0ForL1("sk-p3", undefined, 100)).toHaveLength(2);
    // … and a later run with attribution resolved distills them normally.
    const runL1Fixed = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: makeCfg(),
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger: silentLogger,
      getInstanceId: () => "inst-7",
      llmRunner: makeRunner(),
    });
    await runL1Fixed({ sessionKey: "sk-p3" });
    expect(captured.length).toBeGreaterThan(0);
    expect(store.queryL0ForL1("sk-p3", undefined, 100)).toHaveLength(0);
  });
});
