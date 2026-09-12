/**
 * VENDOR INVARIANT (tokencamp patch P4 — see PATCHES.md «P4»)
 *
 * Every remote embedding call the engine makes must carry the cost-attribution
 * headers `x-tc-instance` and `x-tc-agent`; when either value is unresolved
 * the call fails closed (throws BEFORE any HTTP request). Attribution is
 * threaded through the production embed paths: L0 capture (v2 router),
 * retrieval search (v2 router memory search) and the L1 distillation pipeline
 * (dedup candidate recall + write dual-write).
 *
 * Covered here:
 *  - OpenAIEmbeddingService sends both headers when attribution is provided;
 *  - missing attribution → throw, zero requests on the wire;
 *  - /conversation/add embeds carry auth.serviceId + isolation agentId;
 *  - memory search embeds carry auth.serviceId + isolation agentId;
 *  - distillation embeds (dedup + write) carry the pipeline identity.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { OpenAIEmbeddingService } from "../../src/core/store/embedding.js";
import { StandaloneLLMRunner } from "../../src/adapters/standalone/llm-runner.js";
import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import { handleConversationAdd, handleAtomicSearch } from "../../src/gateway/v2-router.js";
import type { V2RouterDeps } from "../../src/gateway/v2-router.js";
import { createL1Runner } from "../../src/utils/pipeline-factory.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { L0Record } from "../../src/core/store/types.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import type { StorageAdapter } from "../../src/core/storage/adapter.js";

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

const ONE_MEMORY_EXTRACTION = JSON.stringify([{
  scene_name: "tea preferences",
  message_ids: [],
  memories: [{
    content: "user enjoys jasmine tea in the morning",
    type: "preference",
    priority: 60,
    source_message_ids: [],
    metadata: {},
  }],
}]);

const CHAT_COMPLETION = JSON.stringify({
  id: "chatcmpl-vendor-p4",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "stub-model",
  choices: [
    { index: 0, message: { role: "assistant", content: ONE_MEMORY_EXTRACTION }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeEach(async () => {
  captured = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: req.headers });
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

function embeddingRequests(): CapturedRequest[] {
  return captured.filter((r) => r.url.endsWith("/embeddings"));
}

function makeEmbeddingService(): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "openai",
    baseUrl,
    apiKey: "test-key",
    model: "stub-embed",
    dimensions: DIMS,
  });
}

describe("P4: OpenAIEmbeddingService attribution headers", () => {
  it("sends x-tc-instance and x-tc-agent on embed and embedBatch", async () => {
    const svc = makeEmbeddingService();
    await svc.embed("hello", { instanceId: "inst-1", agentId: "agent-1" });
    await svc.embedBatch(["a", "b"], { instanceId: "inst-1", agentId: "agent-1" });

    const reqs = embeddingRequests();
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    for (const req of reqs) {
      expect(req.headers["x-tc-instance"]).toBe("inst-1");
      expect(req.headers["x-tc-agent"]).toBe("agent-1");
    }
  });

  it("fails closed when attribution is missing — no request leaves the process", async () => {
    const svc = makeEmbeddingService();
    await expect(svc.embed("hello")).rejects.toThrow(/x-tc-instance/);
    await expect(svc.embed("hello", { instanceId: "inst-1" })).rejects.toThrow(/x-tc-agent/);
    await expect(svc.embedBatch(["a"])).rejects.toThrow(/x-tc-instance/);
    expect(embeddingRequests()).toHaveLength(0);
  });
});

describe("P4: attribution threads through the gateway embed paths", () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p4-"));
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

  function makeDeps(): V2RouterDeps {
    return {
      getStore: () => store,
      getEmbedding: () => makeEmbeddingService(),
      getStorage: () => undefined as unknown as StorageAdapter,
      logger: silentLogger,
      deployMode: "standalone",
      requestIsolation: { teamId: "t1", userId: "u1", agentId: "agent-3", sessionId: "sess-p4" },
    } as unknown as V2RouterDeps;
  }

  it("/conversation/add embeds carry auth.serviceId + isolation agentId", async () => {
    const res = await handleConversationAdd(
      { session_id: "sess-p4", messages: [{ role: "user", content: "raw content to embed" }] },
      { apiKey: "k", serviceId: "inst-5" },
      "req-1",
      makeDeps(),
    );
    expect(res.code).toBe(0);

    const reqs = embeddingRequests();
    expect(reqs.length).toBeGreaterThan(0);
    for (const req of reqs) {
      expect(req.headers["x-tc-instance"]).toBe("inst-5");
      expect(req.headers["x-tc-agent"]).toBe("agent-3");
    }
  });

  it("memory search embeds carry auth.serviceId + isolation agentId", async () => {
    const res = await handleAtomicSearch(
      { query: "tea", limit: 3 },
      { apiKey: "k", serviceId: "inst-6" },
      "req-2",
      makeDeps(),
    );
    expect(res.code).toBe(0);

    const reqs = embeddingRequests();
    expect(reqs.length).toBeGreaterThan(0);
    for (const req of reqs) {
      expect(req.headers["x-tc-instance"]).toBe("inst-6");
      expect(req.headers["x-tc-agent"]).toBe("agent-3");
    }
  });

  it("distillation embeds (dedup recall + write dual-write) carry the pipeline identity", async () => {
    // Seed an existing L1 record so dedup candidate recall embeds the new memory.
    const now = new Date().toISOString();
    const seeded: MemoryRecord = {
      id: "mem-seed-1",
      content: "user dislikes black coffee",
      type: "preference",
      priority: 50,
      scene_name: "beverages",
      source_message_ids: [],
      metadata: {},
      timestamps: [],
      createdAt: now,
      updatedAt: now,
      sessionKey: "sk-p4",
      sessionId: "sess-p4",
      teamId: "t1",
      userId: "u1",
      agentId: "agent-4",
    };
    store.upsertL1(seeded);

    const baseMs = 1_760_000_000_000;
    const row: L0Record = {
      id: "rec-p4-1",
      sessionKey: "sk-p4",
      sessionId: "sess-p4",
      teamId: "t1",
      userId: "u1",
      agentId: "agent-4",
      role: "user",
      messageText: "I really enjoy drinking jasmine tea every morning",
      recordedAt: new Date(baseMs).toISOString(),
      timestamp: baseMs,
    };
    store.upsertL0(row);

    const runL1 = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: {
        extraction: { enableDedup: true, maxMemoriesPerSession: 20, model: "stub-model", promptMode: "default" },
        embedding: { conflictRecallTopK: 5, timeoutMs: 5_000 },
      } as unknown as MemoryTdaiConfig,
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: makeEmbeddingService(),
      logger: silentLogger,
      getInstanceId: () => "inst-9",
      llmRunner: new StandaloneLLMRunner({
        config: { baseUrl, apiKey: "test-key", model: "stub-model" },
      }),
    });

    await runL1({ sessionKey: "sk-p4" });

    // Every callback the pipeline made — chat AND embeddings — is attributed.
    expect(captured.length).toBeGreaterThan(0);
    for (const req of captured) {
      expect(req.headers["x-tc-instance"]).toBe("inst-9");
      expect(req.headers["x-tc-agent"]).toBe("agent-4");
    }
    expect(embeddingRequests().length).toBeGreaterThan(0);
  });
});
