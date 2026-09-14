/**
 * VENDOR INVARIANT (tokencamp patch P8 — see PATCHES.md «P8»)
 *
 * Every LLM/embedding callback the engine sends upstream must name its work
 * kind via the `x-tc-work` header — the gateway's memory-callback channel
 * (tokencamp-pro crates/gateway/src/memory_callback.rs) derives the ledger
 * note from this token and FAILS CLOSED without it (400, the vocabulary must
 * stay honest — never guessed). The chat vocabulary is the closed set
 * `distill-l1` | `distill-l2` | `distill-l3`; every remote embedding call is
 * `embed`. The runner refuses to emit a chat call with a missing or
 * out-of-vocabulary token BEFORE any request leaves the process — the same
 * posture P3 took for attribution.
 *
 * Covered here:
 *  - StandaloneLLMRunner sends `x-tc-work` for each distill token;
 *  - missing token or a token outside the vocabulary (including `embed`,
 *    which belongs to the embeddings surface) → throw, zero requests;
 *  - the distillation task sites thread their token: L1 pipeline e2e emits
 *    `distill-l1`, the L2 scene extractor `distill-l2`, the L3 persona
 *    generator `distill-l3`;
 *  - remote embedding calls (embed + embedBatch) carry `x-tc-work: embed`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { StandaloneLLMRunner } from "../../src/adapters/standalone/llm-runner.js";
import { OpenAIEmbeddingService } from "../../src/core/store/embedding.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { createL1Runner } from "../../src/utils/pipeline-factory.js";
import { SceneExtractor } from "../../src/core/scene/scene-extractor.js";
import { PersonaGenerator } from "../../src/core/persona/persona-generator.js";
import { TC_CHAT_WORK_TOKENS } from "../../src/core/types.js";
import type { LLMRunParams } from "../../src/core/types.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { L0Record } from "../../src/core/store/types.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const DIMS = 4;

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let baseUrl: string;
let captured: CapturedRequest[];

const EMBED_RESPONSE = JSON.stringify({
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: new Array(DIMS).fill(0.1) }],
  model: "stub-embed",
  usage: { prompt_tokens: 1, total_tokens: 1 },
});

const CHAT_COMPLETION = JSON.stringify({
  id: "chatcmpl-vendor-p8",
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
      captured.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.endsWith("/embeddings") ? EMBED_RESPONSE : CHAT_COMPLETION);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function chatRequests(): CapturedRequest[] {
  return captured.filter((r) => !r.url.endsWith("/embeddings"));
}

function makeRunner(): StandaloneLLMRunner {
  return new StandaloneLLMRunner({
    config: { baseUrl, apiKey: "test-key", model: "stub-model" },
  });
}

describe("P8: StandaloneLLMRunner emits x-tc-work from the closed vocabulary", () => {
  it("sends x-tc-work for each distill token", async () => {
    for (const token of TC_CHAT_WORK_TOKENS) {
      captured = [];
      const runner = makeRunner();
      await runner.run({
        prompt: "extract",
        taskId: "l1-extraction",
        instanceId: "inst-1",
        agentId: "agent-1",
        work: token,
      });
      expect(chatRequests().length).toBeGreaterThan(0);
      for (const req of chatRequests()) {
        expect(req.headers["x-tc-work"]).toBe(token);
      }
    }
    // The vocabulary is exactly the three distill tokens (gateway mirror).
    expect([...TC_CHAT_WORK_TOKENS]).toEqual(["distill-l1", "distill-l2", "distill-l3"]);
  });

  it("fails closed when the work token is missing — no request leaves the process", async () => {
    const runner = makeRunner();
    await expect(
      runner.run({ prompt: "extract", taskId: "l1-extraction", instanceId: "inst-1", agentId: "agent-1" }),
    ).rejects.toThrow(/x-tc-work/);
    expect(captured).toHaveLength(0);
  });

  it("fails closed on tokens outside the vocabulary — no request leaves the process", async () => {
    for (const token of ["skill-extract", "wiki-build", "embed", "memory distill L1", "distill-l4", " "]) {
      const runner = makeRunner();
      await expect(
        runner.run({
          prompt: "extract",
          taskId: "l1-extraction",
          instanceId: "inst-1",
          agentId: "agent-1",
          work: token,
        }),
      ).rejects.toThrow(/x-tc-work/);
    }
    expect(captured).toHaveLength(0);
  });
});

describe("P8: distillation task sites thread their work token", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p8-"));
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
        id: `rec-p8-${i}`,
        sessionKey: "sk-p8",
        sessionId: "sess-p8",
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

  it("L1 pipeline distillation calls carry x-tc-work: distill-l1", async () => {
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

    await runL1({ sessionKey: "sk-p8" });

    expect(chatRequests().length).toBeGreaterThan(0);
    for (const req of chatRequests()) {
      expect(req.headers["x-tc-instance"]).toBe("inst-7");
      expect(req.headers["x-tc-agent"]).toBe("agent-9");
      expect(req.headers["x-tc-work"]).toBe("distill-l1");
    }
  });

  /** A runner double that records the params each task site hands over. */
  function capturingRunner(): { params: LLMRunParams[] } & import("../../src/core/types.js").LLMRunner {
    const params: LLMRunParams[] = [];
    return {
      params,
      async run(p: LLMRunParams): Promise<string> {
        params.push(p);
        return "";
      },
    };
  }

  it("L2 scene extractor asks the runner for distill-l2 work", async () => {
    const runner = capturingRunner();
    const extractor = new SceneExtractor({
      dataDir: tmpDir,
      config: {},
      llmRunner: runner,
      instanceId: "inst-2",
      traceContext: { agentId: "agent-2" },
      logger: silentLogger,
    });
    // Post-LLM scene-file reconciliation is not under test here.
    await extractor
      .extract([{ content: "user enjoys jasmine tea", created_at: new Date().toISOString(), id: "m1" }])
      .catch(() => {});

    expect(runner.params.length).toBeGreaterThan(0);
    expect(runner.params[0]!.work).toBe("distill-l2");
  });

  it("L3 persona generator asks the runner for distill-l3 work", async () => {
    const runner = capturingRunner();
    const generator = new PersonaGenerator({
      dataDir: tmpDir,
      config: {},
      llmRunner: runner,
      instanceId: "inst-3",
      traceContext: { agentId: "agent-3" },
      logger: silentLogger,
    });
    // Post-LLM persona.md reconciliation is not under test here.
    await generator.generateLocalPersona("vendor-p8").catch(() => {});

    expect(runner.params.length).toBeGreaterThan(0);
    expect(runner.params[0]!.work).toBe("distill-l3");
  });
});

describe("P8: remote embedding calls are named embed", () => {
  function makeEmbeddingService(): OpenAIEmbeddingService {
    return new OpenAIEmbeddingService({
      provider: "openai",
      baseUrl,
      apiKey: "test-key",
      model: "stub-embed",
      dimensions: DIMS,
    });
  }

  it("embed and embedBatch carry x-tc-work: embed", async () => {
    const svc = makeEmbeddingService();
    await svc.embed("hello", { instanceId: "inst-1", agentId: "agent-1" });
    await svc.embedBatch(["a", "b"], { instanceId: "inst-1", agentId: "agent-1" });

    const reqs = captured.filter((r) => r.url.endsWith("/embeddings"));
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const req of reqs) {
      expect(req.headers["x-tc-instance"]).toBe("inst-1");
      expect(req.headers["x-tc-agent"]).toBe("agent-1");
      expect(req.headers["x-tc-work"]).toBe("embed");
    }
  });
});
