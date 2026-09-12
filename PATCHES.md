# PATCHES.md — tokencamp vendor 分支 patch 台账

本仓是 `TencentCloud/TencentDB-Agent-Memory` 的 fork(tokencamp-pro #215/#216)。
`vendor` 分支基于锁定的上游基线 **`0468a2a`**(上游默认线 `feat/server_team` HEAD),
以原子 commit 承载 tokencamp 所需的全部引擎改动。本台账是每个 patch 的唯一权威登记:
动机、落点、不变量、测试位置、以及对上游行为的每一处有意偏离。

## 维护口径(新 patch 入册规则)

1. **一个 patch 一个原子 commit**,commit message 以 `vendor(Pn):` / `vendor(<名>):` 开头,
   并引用本文件对应章节;实现代码处打 `VENDOR PATCH Pn` 注释锚点。
2. 每个 patch 必须配**不变量测试**(TDD,先红后绿),放在
   `MemoryCore/__tests__/vendor-invariants/` 或 `MemoryKnowledge/__tests__/vendor-invariants/`,
   由 fork CI(`.github/workflows/vendor-invariants.yml`)强制常绿。
3. 改完必须更新本文件:落点(文件:行)、动机、不变量、测试位置、偏离声明。
4. 与上游 follow 的新 backport 单独成章(见 «FTS5»),commit message 注明来源 commit。
5. 禁止在 vendor 分支上做与台账无关的改动;升级基线走独立 rebase 流程,不走本台账。

---

## P1 — L1 蒸馏游标持久化后删除已消费 L0 行

- **commit**: `007104d`
- **动机**: 零原文存储。L0 行被蒸馏进 L1 且游标持久化后,原文行不应继续留库。
- **落点**: `MemoryCore/src/utils/pipeline-factory.ts:676` 附近 ——
  `markL1ExtractionComplete`(游标落盘)之后,按本批 `processed` 行的 id 逐行
  `deleteL0`。仅 DB 路径;best-effort(删失败只记日志,不影响主流程)。
- **不变量**: 游标先落盘再删行(崩溃只重蒸馏,不丢未蒸馏行);按 id 删,
  未消费的尾部行绝不被删;`IMemoryStore.deleteL0` 是既有必选方法,**零 store 改动**。
- **测试**: `MemoryCore/__tests__/vendor-invariants/l0-deletion-after-distill.test.ts`

## P2 — 关闭 standalone JSONL 原文镜像(单开关,默认关)

- **commit**: `4e0ea70`
- **动机**: 零原文存储。standalone 模式下 `conversations/<date>.jsonl` 是一份
  append-only 原文拷贝,没有按行删除面,与 P1 的删除语义冲突。
- **落点**:
  - 新 reader `readStandaloneJsonlMirrorEnabled()`(`TDAI_STANDALONE_JSONL_MIRROR`,
    默认 **关**):`MemoryCore/src/utils/env-config.ts:204`
  - 执行点 1(v2 `/conversation/add` 镜像):`MemoryCore/src/gateway/v2-router.ts:788`
  - 执行点 2(v1 `/capture` recorder):`MemoryCore/src/core/conversation/l0-recorder.ts:303`
- **不变量**: 默认不写任何 `conversations/*.jsonl`;置 env 即恢复上游行为(同一条开关)。
- **对 ADR 落点的扩展声明(一)**: 设计落点原本只列 v2-router 一处;实现发现 v1
  recorder 存在**第二份同样语义的镜像**,同一开关一并管住(单一实现原则,不开第二个开关)。
- **测试**: `MemoryCore/__tests__/vendor-invariants/standalone-jsonl-mirror.test.ts`

## P3 — standalone LLM chat 回调注入归属头,缺头 fail-closed

- **commit**: `f2334f0`
- **动机**: 成本归属。引擎发出的每个 LLM chat 请求必须携带
  `x-tc-instance` + `x-tc-agent`;归属缺失时在**发出 HTTP 请求之前**抛错(fail-closed),
  绝不发未归属请求。
- **落点**:
  - fail-closed + 注头:`MemoryCore/src/adapters/standalone/llm-runner.ts:284-319`
    (`createOpenAI({ ..., headers })`)
  - `LLMRunParams` 加 `agentId?`:`MemoryCore/src/core/types.ts:108`
  - 穿引:L1 extract/dedup(`core/record/l1-extractor.ts`、`core/record/l1-dedup.ts`)、
    L2 scene(`scene-extractor`)、L3 persona(`persona-generator`)、skill(`skill-extractor`)
    各自传在作用域内的 `instanceId` / `agentId`。
- **对 ADR 落点的扩展声明(二)——组合规则**: `extractL1Memories` 把 LLM 错误吞成
  `success: false`,而 pipeline-factory 原本不看 success。若不改,fail-closed(或 402)
  会导致游标越过未蒸馏行,再叠加 P1 删行 = **静默丢失原文**。因此新增组合规则:
  **`!l1Result.success` 即抛错,整个 L1 run abort 于游标推进与行删除之前**
  (`pipeline-factory.ts:638`);`L1ExtractionResult` 加 `errorMessage?` 透出原因。
- **明确不改**: OpenClaw-host runner 路径(宿主自带 LLM,不经 standalone runner)。
- **测试**: `MemoryCore/__tests__/vendor-invariants/llm-attribution-headers.test.ts`

## P4 — embedding 回调注入归属头,缺头 fail-closed

- **commit**: `4fce8fc`
- **动机**: 同 P3,覆盖 embeddings 通道。
- **落点**:
  - `EmbeddingCallOptions` 加 `instanceId?`/`agentId?`;fail-closed + 注头:
    `MemoryCore/src/core/store/embedding.ts:70`、`:529`
  - v2 网关:`/conversation/add`(`v2-router.ts:756`)、atomic update(`:1116`)、
    memory search(`:1238`)、conversation search(`:959`)——
    均传 `{ instanceId: auth.serviceId, agentId: iso?.agentId }`
  - 搜索工具链:`core/tools/memory-search.ts`、`core/tools/conversation-search.ts`、
    `core/tools/l1-candidate-recall.ts` 透传 `embeddingCallOpts`
  - L1 管道:dedup 候选召回(`core/record/l1-dedup.ts` embedBatch + 逐条 recall)、
    写入双写(`core/record/l1-writer.ts` + `l1-extractor.ts` 的
    `applyDecisions`/`storeAllDirectly` 传 `instanceId`)
- **有意不穿引(fail-closed 后走既有 catch 降级,不产生未归属请求,也不计费)**:
  - `core/hooks/auto-recall.ts`(废弃 OpenClaw hook 路径,唯一调用方
    `tdai-core.ts:378` 写死 `default_user`)
  - `core/hooks/auto-capture.ts`(v1 路径,embed 错误已按条 catch)
  - `core/tdai-core.ts` 的 search 工具调用(OpenClaw 宿主路径,无 tokencamp 归属概念;
    embed 抛错被既有 catch 吞掉,降级 FTS)
- **不变量**: 缺 `instanceId` 或 `agentId` 时 `embed`/`embedBatch` 在发请求前抛错;
  各生产路径(v2 网关 + L1 管道)发出的 embedding 请求必带两个头。
- **测试**: `MemoryCore/__tests__/vendor-invariants/embedding-attribution-headers.test.ts`

## P5 — wiki(MemoryKnowledge)LLM 回调注入归属头,缺头 fail-closed

- **commit**: `79262d1`
- **动机**: 同 P3,覆盖 wiki ingest 链(AI SDK 直连,`ai` + `@ai-sdk/openai` /
  `@ai-sdk/anthropic`)。
- **落点**:
  - `RawLlmConfig` 加 `instanceId?`/`agentId?`,`normalizeLlmConfig` 透传,
    `createLlmClient` 仿 apiKey/baseUrl 检查 fail-closed,两个 provider 工厂
    (openai/anthropic)均注头:`MemoryKnowledge/src/engines/wiki/ingest-v2/llm.ts`
  - 穿引:`MemoryKnowledge/src/module.ts` realWikiWorker(ingest 主链)、
    `MemoryKnowledge/src/callback.ts` generateWikiSummary(摘要链,归属由
    `store/wiki-service.ts` 传入 `row.service_id`/`row.team_id`)
- **槽位语义声明**: wiki 链**没有 agent 概念**——`x-tc-agent` 槽位承载 **team 域**
  (`x-tc-instance` = service_id)。tokencamp 网关侧会因 teamId 非 project 而拒绝,
  这与 wiki 属第二波(wave-2)接入一致;wave-2 再定 project 映射。
- **测试**: `MemoryKnowledge/__tests__/vendor-invariants/wiki-attribution-headers.test.ts`

## FTS5 — 上游 main 线 MATCH 注入修复 backport

- **commit**: `36e20fc`,backport 自上游 main **`1d4f84b`**
  ("fix(store): sanitize FTS5 query tokens to prevent MATCH injection", Resolves #160)
- **背景**: 上游 main 与本线(`feat/server_team`)**无公共祖先**,只能手工搬运;
  上游修在 `src/core/store/sqlite.ts`,本线对应物是
  `MemoryCore/src/core/store/tokenize.ts` 的 `buildFtsQuery`。
- **落点**: `tokenize.ts` 新增 `sanitizeFtsToken`(双引号包 phrase,内部 `"` 转义为
  `""`——旧实现**删除**引号,伤 recall)与 `sanitizeFtsWhitelist`(字符级白名单,
  defence-in-depth);`buildFtsQuery` 改用 `sanitizeFtsToken`。
- **不变量**: 含 FTS5 操作符(`" * ( ) : ^ AND OR NEAR`)的查询被字面化,
  对真实 FTS5 表不产生语法错误、不改变结果集语义;带引号 token 转义而非删除。
- **测试**: `MemoryCore/__tests__/vendor-invariants/fts5-sanitize.test.ts`
  (含 fake-jieba 判别用例 + 真实 FTS5 表召回对照)

---

## 已知的上游既有问题(不属于本台账,仅登记)

- `MemoryCore` `npm run build` 的 `build:seed-v2` 脚本引用了不存在的
  `scripts/seed-v2/tsconfig.json`(基线 `0468a2a` 即如此);`build:plugin`(tsdown)正常。
- `MemoryKnowledge` `npm run typecheck` 在基线上即有 1 个错误
  (`src/middleware/response-envelope.ts:47`);本台账全部改动**不新增** typecheck 错误。
