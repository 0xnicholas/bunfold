/**
 * VENDOR INVARIANT (tokencamp patch P9 — see PATCHES.md «P9»)
 *
 * The gateway (tokencamp-pro crates/memory/src/engine.rs) writes manual L1
 * entries through `POST /v3/atomic/create` — the L1 direct-write endpoint
 * this patch adds — and reads the provenance mark (`metadata_json`) back
 * through `/atomic/query`. The endpoint mints the stock L1 id shape
 * (`m_<epochMs>_<hex>`) when the caller omits `id`, honors a client-supplied
 * id, and rejects a duplicate id with envelope 409 (never an upsert
 * overwrite). `/atomic/update` must preserve the row's metadata_json across
 * an overwrite so the provenance mark survives edits.
 *
 * Covered here:
 *  - omitted id → engine-minted `m_*` id, metadata_json defaults to "{}",
 *    row queryable with metadata_json projected and version 1 (the public
 *    wire contract: 新建初始 v1, first update receipt v2);
 *  - client id → row lands under exactly that id, metadata_json verbatim;
 *  - duplicate client id → envelope 409, the existing row untouched;
 *  - content empty / >8192 chars and malformed metadata_json → envelope 400;
 *  - /atomic/query projects metadata_json (plus background / user_id /
 *    created_at / updated_at) per row;
 *  - /atomic/update preserves metadata_json across an overwrite — with a
 *    second row present, so the exact-row read is pinned (sqlite's
 *    queryL1Records ignores the recordIds filter);
 *  - v3 strict isolation applies to the new route (missing triple member →
 *    422) and the route is v3-only (no /v2 mount).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import { VectorStore } from "../../src/core/store/sqlite/memory-store.js";
import {
  handleAtomicCreate,
  handleAtomicQuery,
  handleAtomicUpdate,
  handleV2Route,
  type V2RouterDeps,
} from "../../src/gateway/v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "../../src/gateway/v2-schemas.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const TEAM = "tokencamp";
const AGENT = "4d2b9c51-6f0a-4b1e-9f3a-2c8d7e5a1b02";
const USER = "usr-vendor-p9";
const MANUAL_MARK = `{"origin":"manual"}`;

const auth: V2AuthContext = { apiKey: "k", serviceId: "inst-p9" };

let tmpDir: string;
let store: VectorStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p9-"));
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
    getEmbedding: () => undefined,
    getStorage: () => undefined,
    logger: silentLogger,
    deployMode: "standalone",
    requestIsolation: { teamId: TEAM, userId: USER, agentId: AGENT, sessionId: "default" },
  } as unknown as V2RouterDeps;
}

function create(body: Record<string, unknown>): Promise<ApiResponseEnvelope> {
  return handleAtomicCreate(body, auth, "req-p9", makeDeps());
}

async function queryItems(body: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  const res = await handleAtomicQuery(body, auth, "req-p9-q", makeDeps());
  expect(res.code).toBe(0);
  return (res.data as { items: Array<Record<string, unknown>> }).items;
}

describe("P9: /atomic/create mints and honors ids", () => {
  it("omitted id → engine-minted m_* id, metadata_json defaults to \"{}\", row queryable", async () => {
    const res = await create({ team_id: TEAM, agent_id: AGENT, user_id: USER, content: "manual fact" });
    expect(res.code).toBe(0);
    const data = res.data as { id: string; created_at: string };
    // The stock L1 mint (generateMemoryId): m_<epochMs>_<hex> — 16 hex
    // since patch P10 widened the entropy from 32 to 64 bits.
    expect(data.id).toMatch(/^m_\d+_[0-9a-f]{16}$/);
    // created_at is the same RFC 3339 wire shape /atomic/query rows emit.
    expect(data.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const items = await queryItems({ team_id: TEAM, agent_id: AGENT, user_id: USER });
    const row = items.find((r) => r.id === data.id);
    expect(row).toBeDefined();
    expect(row?.metadata_json).toBe("{}");
    expect(row?.created_at).toBe(data.created_at);
    // Public wire contract (AtomicDetail doc): a freshly created row IS v1.
    expect(row?.version).toBe(1);
  });

  it("client id lands under exactly that id; metadata_json stored verbatim", async () => {
    const res = await create({
      team_id: TEAM,
      agent_id: AGENT,
      user_id: USER,
      id: "manual-0001",
      content: "operator-supplied fact",
      background: "ops",
      metadata_json: MANUAL_MARK,
    });
    expect(res.code).toBe(0);
    expect((res.data as { id: string }).id).toBe("manual-0001");

    const items = await queryItems();
    const row = items.find((r) => r.id === "manual-0001");
    expect(row).toBeDefined();
    expect(row?.metadata_json).toBe(MANUAL_MARK);
    expect(row?.background).toBe("ops");
  });

  it("duplicate client id → envelope 409 and no row mutation", async () => {
    const first = await create({ id: "dup-1", content: "original", metadata_json: MANUAL_MARK });
    expect(first.code).toBe(0);

    const second = await create({ id: "dup-1", content: "overwrite attempt" });
    expect(second.code).toBe(409);

    const items = await queryItems();
    const matches = items.filter((r) => r.id === "dup-1");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.content).toBe("original");
    expect(matches[0]?.metadata_json).toBe(MANUAL_MARK);
  });
});

describe("P9: /atomic/create validation", () => {
  it("rejects empty and over-cap content with envelope 400", async () => {
    expect((await create({ content: "" })).code).toBe(400);
    expect((await create({ content: "x".repeat(8193) })).code).toBe(400);
    // Boundary: exactly 8192 chars is accepted.
    expect((await create({ content: "x".repeat(8192) })).code).toBe(0);
  });

  it("rejects malformed metadata_json with envelope 400", async () => {
    for (const bad of ["{not json", "[1,2]", `"scalar"`, "42", "null"]) {
      expect((await create({ content: "ok", metadata_json: bad })).code).toBe(400);
    }
    expect((await create({ content: "ok", metadata_json: "{}" })).code).toBe(0);
  });

  it("rejects over-cap client ids with envelope 400", async () => {
    expect((await create({ id: "x".repeat(129), content: "ok" })).code).toBe(400);
    expect((await create({ id: "", content: "ok" })).code).toBe(400);
  });
});

describe("P9: /atomic/query projects metadata_json per row", () => {
  it("projects metadata_json alongside background / user_id / created_at / updated_at", async () => {
    await create({ id: "q-1", content: "first", background: "scene-a", metadata_json: MANUAL_MARK });
    await create({ id: "q-2", content: "second" });

    const items = await queryItems();
    const q1 = items.find((r) => r.id === "q-1");
    const q2 = items.find((r) => r.id === "q-2");
    expect(q1?.metadata_json).toBe(MANUAL_MARK);
    expect(q2?.metadata_json).toBe("{}");
    for (const row of [q1, q2]) {
      expect(row?.user_id).toBe(USER);
      expect(typeof row?.created_at).toBe("string");
      expect(typeof row?.updated_at).toBe("string");
    }
    expect(q1?.background).toBe("scene-a");
  });
});

describe("P9: /atomic/update preserves metadata_json across an overwrite", () => {
  it("keeps the provenance mark on the target row and never leaks it to a sibling", async () => {
    await create({ id: "row-a", content: "manual a", metadata_json: MANUAL_MARK });
    await create({ id: "row-b", content: "distilled b" });

    // Update the OLDER row: the mark must survive the content overwrite.
    const updA = await handleAtomicUpdate(
      { id: "row-a", content: "manual a v2", background: "edited" },
      auth,
      "req-p9-u1",
      makeDeps(),
    );
    expect(updA.code).toBe(0);
    // Documented version semantics: created at v1, first update receipt is v2.
    expect((updA.data as { version: string }).version).toBe("v2");
    let items = await queryItems();
    expect(items.find((r) => r.id === "row-a")?.version).toBe(2);
    expect(items.find((r) => r.id === "row-a")?.metadata_json).toBe(MANUAL_MARK);
    expect(items.find((r) => r.id === "row-a")?.content).toBe("manual a v2");
    expect(items.find((r) => r.id === "row-a")?.background).toBe("edited");

    // Update the NEWER row: with two rows present this pins the exact-row
    // read — a first-row read would copy row-a's mark onto row-b.
    const updB = await handleAtomicUpdate({ id: "row-b", content: "distilled b v2" }, auth, "req-p9-u2", makeDeps());
    expect(updB.code).toBe(0);
    items = await queryItems();
    expect(items.find((r) => r.id === "row-b")?.metadata_json).toBe("{}");
    expect(items.find((r) => r.id === "row-a")?.metadata_json).toBe(MANUAL_MARK);
  });

  it("unknown id is a true 404 even when the pool is non-empty", async () => {
    await create({ id: "only-row", content: "present" });
    const res = await handleAtomicUpdate({ id: "missing", content: "nope" }, auth, "req-p9-u3", makeDeps());
    expect(res.code).toBe(404);
    const items = await queryItems();
    expect(items.find((r) => r.id === "only-row")?.content).toBe("present");
  });
});

describe("P9: v3 mounting and strict isolation", () => {
  function dispatch(body: Record<string, unknown>, pathname = "/v3/atomic/create") {
    const sent: { status?: number; envelope?: ApiResponseEnvelope } = {};
    const req = {
      headers: { authorization: "Bearer k", "x-tdai-service-id": "inst-p9" },
      url: pathname,
    } as unknown as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const handled = handleV2Route(
      req,
      res,
      pathname,
      "POST",
      async () => body,
      (_r, status, payload) => {
        sent.status = status;
        sent.envelope = payload as ApiResponseEnvelope;
      },
      {
        getStore: () => store,
        getEmbedding: () => undefined,
        getStorage: () => undefined,
        logger: silentLogger,
        deployMode: "standalone",
      } as unknown as V2RouterDeps,
    );
    return { handled, sent };
  }

  it("missing a triple member → the standard v3 422 rejection", async () => {
    const { handled, sent } = dispatch({ team_id: TEAM, agent_id: AGENT, content: "no user" });
    expect(await handled).toBe(true);
    expect(sent.status).toBe(422);
    expect(sent.envelope?.code).toBe(422);
    expect(sent.envelope?.message).toContain("user_id");
  });

  it("full triple through dispatch lands the row under the isolation scope", async () => {
    const { handled, sent } = dispatch({
      team_id: TEAM,
      agent_id: AGENT,
      user_id: USER,
      id: "via-dispatch",
      content: "dispatched",
      metadata_json: MANUAL_MARK,
    });
    expect(await handled).toBe(true);
    expect(sent.status).toBe(200);
    expect(sent.envelope?.code).toBe(0);
    expect((sent.envelope?.data as { id: string }).id).toBe("via-dispatch");

    const rows = store.queryL1Paginated({ limit: 20, offset: 0, teamId: TEAM, userId: USER, agentId: AGENT }).rows;
    const row = rows.find((r) => r.record_id === "via-dispatch");
    expect(row).toBeDefined();
    expect(row?.metadata_json).toBe(MANUAL_MARK);
  });

  it("is not mounted on legacy /v2", async () => {
    const { handled } = dispatch({ team_id: TEAM, agent_id: AGENT, user_id: USER, content: "legacy" }, "/v2/atomic/create");
    expect(await handled).toBe(false);
  });
});
