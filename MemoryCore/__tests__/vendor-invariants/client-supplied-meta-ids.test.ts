/**
 * VENDOR INVARIANT (tokencamp patch P7 — see PATCHES.md «P7»)
 *
 * The v3 meta team/agent create routes accept a CLIENT-SUPPLIED id
 * (`team_id` / `agent_id`): the zod schemas keep the fields (upstream
 * stripped them, so the store always minted its own `team-*` / `agt-*`
 * ids) and both store adapters honor them on insert. tokencamp registers
 * its pure-function isolation ids (team = "tokencamp", agent = the
 * project UUID) through these routes, which is what makes the
 * deterministic chat_memory asset id `chat_memory-tokencamp-<project>`
 * resolvable for the clear/archive lifecycle operations.
 *
 * Covered here:
 *  - the schemas keep client-supplied ids (upstream zod-strip regresses
 *    silently otherwise — the failure mode this patch exists to kill);
 *  - create honors them end-to-end and the chat_memory asset registers
 *    under the deterministic id;
 *  - omitting the id keeps the upstream server-minted shape;
 *  - a duplicate client id ERRORS (the PK-retry loop must never mint a
 *    different id behind the caller's back).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SqliteMetadataStore } from "../../src/metadata/store/sqlite-adapter.js";
import { MetadataService } from "../../src/metadata/service/metadata-service.js";
import {
  agentCreateSchema,
  teamCreateSchema,
} from "../../src/metadata/router/v3-meta-schemas.js";
import { buildChatMemoryAssetId } from "../../src/metadata/utils/chat-memory-asset.js";
import type { V3AuthContext } from "../../src/metadata/router/auth.js";

const OWNER_ID = "usr-vendor-p7-owner";
const TEAM_ID = "tokencamp";
const AGENT_ID = "4d2b9c51-6f0a-4b1e-9f3a-2c8d7e5a1b02";

let tmpDir: string;
let store: SqliteMetadataStore;
let svc: MetadataService;

const ownerCtx: V3AuthContext = {
  token: "sk-vendor-p7",
  userId: OWNER_ID,
  isAdmin: false,
  isSystemAdmin: false,
};

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-p7-"));
  store = new SqliteMetadataStore(path.join(tmpDir, "metadata.db"));
  await store.init();
  svc = new MetadataService(store);
  await svc.createNormalUser({ username: "vendor-p7-owner", user_id: OWNER_ID });
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("P7: the create schemas keep client-supplied ids", () => {
  it("teamCreateSchema keeps team_id", () => {
    const parsed = teamCreateSchema.parse({
      name: "tokencamp",
      owner_user_id: OWNER_ID,
      team_id: TEAM_ID,
    });
    expect(parsed.team_id).toBe(TEAM_ID);
  });

  it("agentCreateSchema keeps agent_id", () => {
    const parsed = agentCreateSchema.parse({
      team_id: TEAM_ID,
      owner_user_id: OWNER_ID,
      name: "project",
      agent_id: AGENT_ID,
    });
    expect(parsed.agent_id).toBe(AGENT_ID);
  });
});

describe("P7: create honors the client-supplied ids end-to-end", () => {
  it("team + agent carry the supplied ids and register the deterministic chat_memory asset", async () => {
    const team = await svc.createTeamForCaller(
      { team_id: TEAM_ID, name: "tokencamp", owner_user_id: OWNER_ID },
      ownerCtx,
    );
    expect(team.team_id).toBe(TEAM_ID);

    const agent = await svc.createAgentForCaller(
      { agent_id: AGENT_ID, team_id: TEAM_ID, owner_user_id: OWNER_ID, name: "project" },
      ownerCtx,
    );
    expect(agent.agent_id).toBe(AGENT_ID);
    expect(agent.team_id).toBe(TEAM_ID);

    // The point of the mapping: createAgent's ensureChatMemoryAsset binds
    // the asset under the deterministic id the clear/archive lifecycle
    // addresses (tokencamp mapping::chat_memory_asset_id).
    const asset = await svc.getAssetById(buildChatMemoryAssetId(TEAM_ID, AGENT_ID));
    expect(asset).not.toBeNull();
    expect(asset?.team_id).toBe(TEAM_ID);
    expect(asset?.asset_type).toBe("chat_memory");
  });

  it("omitting the id keeps the upstream server-minted shape", async () => {
    const team = await svc.createTeamForCaller(
      { name: "minted", owner_user_id: OWNER_ID },
      ownerCtx,
    );
    expect(team.team_id).toMatch(/^team-/);

    const agent = await svc.createAgentForCaller(
      { team_id: team.team_id, owner_user_id: OWNER_ID, name: "minted-agent" },
      ownerCtx,
    );
    expect(agent.agent_id).toMatch(/^agt-/);
  });

  it("a duplicate client id errors instead of silently minting a different one", async () => {
    await svc.createTeamForCaller(
      { team_id: TEAM_ID, name: "first", owner_user_id: OWNER_ID },
      ownerCtx,
    );
    await expect(
      svc.createTeamForCaller(
        { team_id: TEAM_ID, name: "second", owner_user_id: OWNER_ID },
        ownerCtx,
      ),
    ).rejects.toThrow();
    // The original row stands; no second team appeared behind the caller.
    expect((await svc.getTeamById(TEAM_ID))?.name).toBe("first");
  });
});
