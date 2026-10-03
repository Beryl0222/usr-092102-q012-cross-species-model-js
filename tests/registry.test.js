import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore, ConcurrencyError } from "../src/store/event-store.js";
import { Registry, RegistryError } from "../src/registry.js";
import { project, visibleOverview } from "../src/projections.js";
import { buildModelCard, resolveFigure } from "../src/model-card.js";
import { makeRegistry, seedDatasetsAndVocab, trainingSpec, ACTORS, SHA, HEX } from "./helpers/scenario.js";

const FUTURE = "2027-12-31T00:00:00Z";
const PAST = "2000-01-01T00:00:00Z";

test("数据集先登记：六要素（实验室/组织/物种/同意/质控/访问）全部落账", () => {
  const { store, registry } = makeRegistry();
  const id = seedDatasetsAndVocab(registry).sponge;
  const ov = project(store.allEvents());
  const d = ov.datasets.get(id);
  assert.equal(d.lab, ACTORS.marine.lab);
  assert.equal(d.tissue, "成体中胶层解离细胞");
  assert.equal(d.consent.basis, "broad");
  assert.equal(d.quality_control.status, "passed");
  assert.equal(d.access.tier, "open");
});

test("人类原始数据：无 raw 授权的项目不能登记使用该数据的运行", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  // 无任何授权 -> 拒绝
  assert.throws(
    () =>
      registry.registerRun(
        {
          idempotency_key: "cb-1",
          project_id: "proj-noauth",
          dataset_ids: [s.sponge, s.human],
          vocabulary_id: s.vocab2018,
          ortholog_set_id: s.ortho2018,
          training: trainingSpec(),
          embargo_until: FUTURE,
        },
        ACTORS.rival
      ),
    (e) => e instanceof RegistryError && e.code === "ACCESS_DENIED"
  );
});

test("人类原始数据：raw 授权必须记录批准方与时间边界，授权后可运行", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  // 缺批准方
  assert.throws(
    () => registry.grantAccess({ dataset_id: s.human, project_id: "proj-paper", scope: "raw" }, ACTORS.comp),
    (e) => e.code === "AUTHORIZATION_REQUIRED"
  );
  // 缺时间边界
  assert.throws(
    () => registry.grantAccess({ dataset_id: s.human, project_id: "proj-paper", scope: "raw", granted_by: "dac" }, ACTORS.dac),
    (e) => e.code === "AUTHORIZATION_BOUNDARY_REQUIRED"
  );
  // 合规授权
  registry.grantAccess(
    { dataset_id: s.human, project_id: "proj-paper", scope: "raw", granted_by: "数据访问委员会", expires_at: "2028-01-01T00:00:00Z" },
    ACTORS.dac
  );
  const run = registry.registerRun(
    {
      run_id: "run-paper",
      idempotency_key: "cb-paper",
      project_id: "proj-paper",
      dataset_ids: [s.sponge, s.worm, s.frog, s.human],
      vocabulary_id: s.vocab2018,
      ortholog_set_id: s.ortho2018,
      training: trainingSpec(),
      embargo_until: FUTURE,
      expected_species: ["Amphimedon queenslandica", "Caenorhabditis elegans", "Xenopus tropicalis", "Homo sapiens"],
    },
    ACTORS.comp
  );
  assert.equal(run.aggregate_id, "run-paper");
});

test("授权过期后不能再用于新运行", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.grantAccess(
    { dataset_id: s.human, project_id: "p", scope: "raw", granted_by: "dac", expires_at: "2020-01-01T00:00:00Z" },
    ACTORS.dac
  );
  assert.throws(
    () =>
      registry.registerRun(
        { idempotency_key: "k", project_id: "p", dataset_ids: [s.human], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: FUTURE },
        ACTORS.comp
      ),
    (e) => e.code === "ACCESS_EXPIRED"
  );
});

test("长训练分片恢复：从检查点续跑，remaining_shards 正确", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "run-long", idempotency_key: "long-1", project_id: "p", dataset_ids: [s.sponge, s.worm], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
    ACTORS.comp
  );
  registry.recordCheckpoint("run-long", { shard_index: 0, shard_count: 4, checkpoint_sha256: SHA("a"), metrics: { loss: 0.9 } }, ACTORS.comp);
  registry.recordCheckpoint("run-long", { shard_index: 2, shard_count: 4, checkpoint_sha256: SHA("c") }, ACTORS.comp);

  const plan = registry.resumePlan("run-long");
  assert.deepEqual(plan.remaining_shards, [1, 3]);

  // 续跑补齐剩余分片
  registry.recordCheckpoint("run-long", { shard_index: 1, shard_count: 4, checkpoint_sha256: SHA("b") }, ACTORS.comp);
  registry.recordCheckpoint("run-long", { shard_index: 3, shard_count: 4, checkpoint_sha256: SHA("d") }, ACTORS.comp);
  assert.deepEqual(registry.resumePlan("run-long").remaining_shards, []);

  const completed = registry.completeRun("run-long", { final_weights_sha256: SHA("f"), metrics: { loss: 0.21 } }, ACTORS.comp);
  assert.equal(completed.event_type, "RUN_COMPLETED");
});

test("重复回调不产生第二个运行：相同 idempotency_key 返回首次事件", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  const input = { idempotency_key: "cb-dup", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST };
  const first = registry.registerRun(input, ACTORS.comp);
  const second = registry.registerRun({ ...input, embargo_until: FUTURE }, ACTORS.rival); // 即使参数不同
  assert.equal(first.event_id, second.event_id);
  assert.equal(store.allEvents().filter((e) => e.event_type === "RUN_REGISTERED").length, 1);

  // EventStore 层直接验证 duplicate 标志
  const { event, duplicate } = store.append(
    { event_type: "VOCABULARY_FROZEN", aggregate_type: "gene_vocabulary", aggregate_id: "vdup", idempotency_key: "vk", summary: "x", payload: { name: "n", version: "1", content_sha256: SHA("0") } },
    {}
  );
  assert.equal(duplicate, false);
  const again = store.append(
    { event_type: "VOCABULARY_FROZEN", aggregate_type: "gene_vocabulary", aggregate_id: "vdup2", idempotency_key: "vk", summary: "x", payload: { name: "n", version: "1", content_sha256: SHA("0") } },
    {}
  );
  assert.equal(again.duplicate, true);
  assert.equal(again.event.event_id, event.event_id);
});

test("检查点重复回调（同校验值）不追加事件；不同校验值报冲突", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "r", idempotency_key: "k", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
    ACTORS.comp
  );
  const cp1 = registry.recordCheckpoint("r", { shard_index: 0, shard_count: 4, checkpoint_sha256: SHA("a") }, ACTORS.comp);
  const cp2 = registry.recordCheckpoint("r", { shard_index: 0, shard_count: 4, checkpoint_sha256: SHA("a") }, ACTORS.comp);
  assert.equal(cp1.event_id, cp2.event_id);
  assert.equal(store.allEvents().filter((e) => e.event_type === "CHECKPOINT_RECORDED").length, 1);
  assert.throws(
    () => registry.recordCheckpoint("r", { shard_index: 0, shard_count: 4, checkpoint_sha256: SHA("b") }, ACTORS.comp),
    (e) => e.code === "CHECKPOINT_CONFLICT"
  );
});

test("保密期内竞争结果并存：互不可见，过期后公开；同项目始终可见", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  // 两个竞争项目各自用开放数据训练，保密到未来
  registry.registerRun(
    { run_id: "run-lab-a", idempotency_key: "a", project_id: "proj-A", dataset_ids: [s.sponge, s.worm], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: FUTURE },
    ACTORS.marine
  );
  registry.registerRun(
    { run_id: "run-lab-b", idempotency_key: "b", project_id: "proj-B", dataset_ids: [s.frog, s.worm], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2026, training: trainingSpec(), embargo_until: FUTURE },
    ACTORS.rival
  );
  const ov = project(store.allEvents());
  // 全局两者并存
  assert.equal(ov.runs.size >= 2, true);
  // B 看不到 A
  const viewB = visibleOverview(ov, { project_id: "proj-B" }, new Date("2026-10-01T00:00:00Z"));
  assert.ok(viewB.runs.has("run-lab-b"));
  assert.ok(!viewB.runs.has("run-lab-a"));
  // A 看得到自己
  const viewA = visibleOverview(ov, { project_id: "proj-A" }, new Date("2026-10-01T00:00:00Z"));
  assert.ok(viewA.runs.has("run-lab-a"));
  // 保密期过后公开
  const viewLater = visibleOverview(ov, { project_id: "proj-B" }, new Date("2028-01-01T00:00:00Z"));
  assert.ok(viewLater.runs.has("run-lab-a"));
});

test("嵌入结果/推断主张/实验验证是三个状态：相似性不能直接写成事实", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "r", idempotency_key: "k", project_id: "p", dataset_ids: [s.sponge, s.human].slice(0, 1), vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
    ACTORS.comp
  );
  // 开放数据集即可（只用海绵）
  assert.throws(
    () => registry.recordClaim({ run_id: "r", statement: "海绵与人类某细胞同源", status: "validated" }, ACTORS.comp),
    (e) => e.code === "ILLEGAL_CLAIM_STATUS"
  );
  const emb = registry.publishEmbedding({ run_id: "r", artifact_sha256: SHA("e"), status: "exploratory", species_covered: ["sponge", "human"] }, ACTORS.comp);
  const claim = registry.recordClaim({ run_id: "r", embedding_id: emb.aggregate_id, statement: "海绵领细胞与人类小胶质细胞在嵌入空间邻近", status: "exploratory_hint" }, ACTORS.comp);
  // 合作方误写成事实 -> 系统里它仍然是探索线索，模型卡必须这样呈现
  const card = buildModelCard(project(registry.store.allEvents()), "r");
  assert.equal(card.validation_summary.exploratory_hints[0].id, claim.aggregate_id);
  assert.equal(card.validation_summary.highest_level, null);
  assert.ok(card.applicability.known_limits.some((l) => l.includes("不得表述为生物学事实")));

  // 推进为推断主张，再经预注册湿实验验证
  registry.demoteClaim(claim.aggregate_id, { to_status: "proposed", reason: "线索足够稳定，提出可检验推断" }, ACTORS.comp);
  registry.validateClaim(
    claim.aggregate_id,
    { validation_level: "wetlab_preregistered", evidence: ["实验登记 OSF-2026-xx", "谱系示踪 n=6", "单细胞共刺激响应一致"], validated_by: "独立湿实验平台" },
    ACTORS.comp
  );
  const card2 = buildModelCard(project(registry.store.allEvents()), "r");
  assert.equal(card2.validation_summary.highest_level, "wetlab_preregistered");
  assert.equal(card2.validation_summary.validated[0].validation_level, "wetlab_preregistered");
});

test("词表撤回：只标记受影响运行与下游，历史事件仍可完整复查", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "run-old-vocab", idempotency_key: "old", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
    ACTORS.comp
  );
  registry.registerRun(
    { run_id: "run-new-ortho", idempotency_key: "new", project_id: "p2", dataset_ids: [s.worm], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2026, embargo_until: PAST, training: trainingSpec() },
    ACTORS.rival
  );
  const eventsBefore = store.allEvents().length;
  // 旧词表撤稿：登记撤回事件（两个运行都引用了该词表，投影应按血缘补全）
  registry.flagSource({ kind: "withdrawn", target_type: "gene_vocabulary", target_id: s.vocab2018, reason: "论文撤稿：词表映射错误无法复原" }, ACTORS.marine);

  const ov = project(store.allEvents());
  assert.equal(ov.vocabularies.get(s.vocab2018).withdrawn, true);
  for (const rid of ["run-old-vocab", "run-new-ortho"]) {
    const run = ov.runs.get(rid);
    assert.ok(run.impact_flags.some((f) => f.kind === "withdrawn"), `${rid} 应被血缘标记`);
  }
  // 未引用该词表的对象不受影响（这里数据集不打标记）
  assert.deepEqual(ov.datasets.get(s.sponge).annotations, []);
  // 历史未被删除/改写
  assert.equal(store.allEvents().length, eventsBefore + 1);
  const firstRun = store.readStream("model_run", "run-old-vocab")[0];
  assert.equal(firstRun.event_type, "RUN_REGISTERED");
  assert.equal(firstRun.payload.vocabulary_id, s.vocab2018);

  // 撤回词表不得用于新运行
  assert.throws(
    () =>
      registry.registerRun(
        { idempotency_key: "x", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
        ACTORS.comp
      ),
    (e) => e.code === "SOURCE_WITHDRAWN"
  );
});

test("注释升级：冻结新旧两版同源组，受影响运行被标记但不抹除，模型卡给适用边界", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.grantAccess({ dataset_id: s.human, project_id: "p", scope: "raw", granted_by: "dac", expires_at: "2029-01-01T00:00:00Z" }, ACTORS.dac);
  registry.registerRun(
    { run_id: "run-paper-fig", idempotency_key: "figrun", project_id: "p", dataset_ids: [s.sponge, s.worm, s.frog, s.human], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(HEX(32)), embargo_until: PAST, expected_species: ["sponge", "worm", "frog", "human"] },
    ACTORS.comp
  );
  registry.completeRun("run-paper-fig", { final_weights_sha256: HEX(32), metrics: { loss: 0.18 } }, ACTORS.comp);
  const emb = registry.publishEmbedding({ run_id: "run-paper-fig", artifact_sha256: HEX(33), status: "frozen", species_covered: ["sponge", "worm", "frog", "human"] }, ACTORS.comp);
  const claim = registry.recordClaim({ run_id: "run-paper-fig", embedding_id: emb.aggregate_id, statement: "四物种细胞在同一空间按功能聚类", status: "proposed" }, ACTORS.comp);

  // 复现实验人员只能用最新同源映射重跑
  registry.registerRun(
    { run_id: "run-repro-2026", idempotency_key: "repro", project_id: "p", dataset_ids: [s.sponge, s.worm, s.frog, s.human], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2026, training: { ...trainingSpec(HEX(34)), resume_from_run: "run-paper-fig" }, embargo_until: PAST },
    ACTORS.comp
  );

  // 同源组升级登记
  registry.flagSource({ kind: "upgraded", target_type: "ortholog_set", target_id: s.ortho2018, reason: "2026 版新增 596 组，旧版一因多效映射被修正", new_version_id: s.ortho2026 }, ACTORS.comp);

  const ov = project(store.allEvents());
  const oldRun = ov.runs.get("run-paper-fig");
  assert.ok(oldRun.impact_flags.some((f) => f.kind === "upgraded"));
  // 新运行引用的是 2026 版，不被该升级标记
  assert.ok(!ov.runs.get("run-repro-2026").impact_flags.some((f) => f.kind === "upgraded"));
  // 嵌入也被标记
  assert.ok(ov.embeddings.get(emb.aggregate_id).impact_flags.some((f) => f.kind === "upgraded"));

  const card = buildModelCard(ov, "run-paper-fig");
  assert.ok(card.applicability.known_limits.some((l) => l.includes("注释已升级")));
  // 模型卡复现要素齐全
  assert.equal(card.reproducibility.config_sha256, SHA("8"));
  assert.equal(card.reproducibility.final_weights_sha256, HEX(32));
  assert.equal(card.reproducibility.vocabulary.content_sha256, SHA("5"));
  assert.deepEqual(card.reproducibility.datasets.map((d) => d.id).sort(), [s.sponge, s.worm, s.frog, s.human].sort());
});

test("图表点开即取得词表/数据/配置与验证等级；带标记的图表携带警告", () => {
  const { registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "r", idempotency_key: "k", project_id: "p", dataset_ids: [s.sponge, s.frog], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(HEX(32)), embargo_until: PAST },
    ACTORS.comp
  );
  registry.completeRun("r", { final_weights_sha256: HEX(32) }, ACTORS.comp);
  const claim = registry.recordClaim({ run_id: "r", statement: "跨物种邻近", status: "proposed" }, ACTORS.comp);
  registry.validateClaim(claim.aggregate_id, { validation_level: "independent_dataset", evidence: ["独立数据集 D2 复现邻近关系"] }, ACTORS.rival);
  const fig = registry.publishFigure(
    { run_ids: ["r"], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, dataset_ids: [s.sponge, s.frog], claim_ids: [claim.aggregate_id] },
    ACTORS.comp
  );
  const pack = resolveFigure(project(registry.store.allEvents()), fig.aggregate_id);
  assert.equal(pack.vocabulary.id, s.vocab2018);
  assert.equal(pack.ortholog_set.id, s.ortho2018);
  assert.deepEqual(pack.datasets.map((d) => d.id).sort(), [s.sponge, s.frog].sort());
  assert.equal(pack.runs[0].config_sha256, SHA("8"));
  assert.equal(pack.claims[0].validation_level, "independent_dataset");
  assert.deepEqual(pack.impact_flags, []);

  // 升级后图表溯源包出现警告
  registry.flagSource({ kind: "upgraded", target_type: "ortholog_set", target_id: s.ortho2018, reason: "映射修正", new_version_id: s.ortho2026 }, ACTORS.comp);
  const pack2 = resolveFigure(project(registry.store.allEvents()), fig.aggregate_id);
  assert.ok(pack2.impact_flags.some((f) => f.kind === "upgraded"));
  assert.ok(pack2.claims[0].impact_flags.some((f) => f.kind === "upgraded"));
});

test("JSONL 持久化：进程重启重放后状态、幂等与检查点恢复一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  const file = join(dir, "events.jsonl");
  try {
    const r1 = makeRegistry(file);
    const s = seedDatasetsAndVocab(r1.registry);
    r1.registry.registerRun(
      { run_id: "run-persist", idempotency_key: "persist", project_id: "p", dataset_ids: [s.sponge, s.worm], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
      ACTORS.comp
    );
    r1.registry.recordCheckpoint("run-persist", { shard_index: 0, shard_count: 4, checkpoint_sha256: SHA("a") }, ACTORS.comp);

    // 模拟新进程
    const r2 = makeRegistry(file);
    assert.deepEqual(r2.registry.resumePlan("run-persist").remaining_shards, [1, 2, 3]);
    const dup = r2.registry.registerRun(
      { run_id: "run-persist", idempotency_key: "persist", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
      ACTORS.comp
    );
    assert.equal(dup.aggregate_id, "run-persist");
    const ov = project(r2.store.allEvents());
    assert.equal(ov.runs.get("run-persist").dataset_ids.length, 2); // 仍是首次参数
    // JSONL 每行一个事件
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, r2.store.allEvents().length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("乐观并发：expectedVersion 冲突时拒绝写入", () => {
  const store = new EventStore();
  store.append({ event_type: "VOCABULARY_FROZEN", aggregate_type: "gene_vocabulary", aggregate_id: "v", summary: "x", payload: { name: "n", version: "1", content_sha256: SHA("0") } });
  assert.throws(
    () =>
      store.append(
        { event_type: "VOCABULARY_FROZEN", aggregate_type: "gene_vocabulary", aggregate_id: "v2", summary: "x", payload: { name: "n", version: "2", content_sha256: SHA("1") } },
        { expectedVersion: 5 }
      ),
    (e) => e instanceof ConcurrencyError
  );
});

test("模型卡发布为事件快照，且可随时由事件流重新派生", () => {
  const { store, registry } = makeRegistry();
  const s = seedDatasetsAndVocab(registry);
  registry.registerRun(
    { run_id: "r", idempotency_key: "k", project_id: "p", dataset_ids: [s.sponge], vocabulary_id: s.vocab2018, ortholog_set_id: s.ortho2018, training: trainingSpec(), embargo_until: PAST },
    ACTORS.comp
  );
  const evt = registry.publishModelCard("r", { species_scope: ["Amphimedon queenslandica"], known_limits: ["仅在成体解离细胞条件下成立"] }, ACTORS.comp);
  assert.equal(evt.event_type, "MODEL_CARD_PUBLISHED");
  const ov = project(store.allEvents());
  const card = ov.modelCards.get("card-r");
  assert.ok(card.applicability.known_limits.includes("仅在成体解离细胞条件下成立"));
  assert.equal(card.reproducibility.vocabulary.id, s.vocab2018);
});
