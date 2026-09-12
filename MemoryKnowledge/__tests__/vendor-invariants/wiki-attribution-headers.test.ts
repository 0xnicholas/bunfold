/**
 * VENDOR INVARIANT (tokencamp patch P5 — see PATCHES.md «P5»)
 *
 * Every LLM call the wiki ingest chain makes must carry the cost-attribution
 * headers `x-tc-instance` and `x-tc-agent`; when either value is unresolved,
 * createLlmClient fails closed (throws at construction, BEFORE any HTTP
 * request). The wiki chain has no agent concept — the x-tc-agent slot carries
 * the team domain (see PATCHES.md for the wave-2 note).
 *
 * Covered here:
 *  - openai protocol: /chat/completions carries both headers;
 *  - anthropic protocol: /messages carries both headers;
 *  - missing attribution → constructor throws, zero requests on the wire.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createLlmClient } from "../../src/engines/wiki/ingest-v2/llm.js";

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let baseUrl: string;
let captured: CapturedRequest[];

const CHAT_COMPLETION = JSON.stringify({
  id: "chatcmpl-vendor-p5",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "stub-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "wiki text" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const ANTHROPIC_MESSAGE = JSON.stringify({
  id: "msg-vendor-p5",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "wiki text" }],
  model: "stub-model",
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

beforeEach(async () => {
  captured = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url?.endsWith("/messages") ? ANTHROPIC_MESSAGE : CHAT_COMPLETION);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function fullConfig(protocol: "openai" | "anthropic" = "openai") {
  return {
    protocol,
    baseUrl,
    apiKey: "test-key",
    model: "stub-model",
    timeoutMs: 5_000,
    instanceId: "inst-wiki-1",
    agentId: "team-wiki-1",
  };
}

describe("P5: wiki ingest LLM attribution headers", () => {
  it("openai protocol: /chat/completions carries x-tc-instance + x-tc-agent", async () => {
    const client = createLlmClient(fullConfig("openai"));
    const text = await client.chat({ system: "s", prompt: "p", label: "test" });
    expect(text).toBe("wiki text");

    const reqs = captured.filter((r) => r.url.endsWith("/chat/completions"));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers["x-tc-instance"]).toBe("inst-wiki-1");
    expect(reqs[0].headers["x-tc-agent"]).toBe("team-wiki-1");
  });

  it("anthropic protocol: /messages carries x-tc-instance + x-tc-agent", async () => {
    const client = createLlmClient(fullConfig("anthropic"));
    const text = await client.chat({ system: "s", prompt: "p", label: "test" });
    expect(text).toBe("wiki text");

    const reqs = captured.filter((r) => r.url.endsWith("/messages"));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers["x-tc-instance"]).toBe("inst-wiki-1");
    expect(reqs[0].headers["x-tc-agent"]).toBe("team-wiki-1");
  });

  it("fails closed when attribution is missing — no request leaves the process", () => {
    const { instanceId: _i, ...noInstance } = fullConfig();
    expect(() => createLlmClient(noInstance)).toThrow(/x-tc-instance/);

    const { agentId: _a, ...noAgent } = fullConfig();
    expect(() => createLlmClient(noAgent)).toThrow(/x-tc-agent/);

    const { instanceId: _i2, agentId: _a2, ...neither } = fullConfig();
    expect(() => createLlmClient(neither)).toThrow(/x-tc-/);

    expect(captured).toHaveLength(0);
  });
});
