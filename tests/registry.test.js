import assert from "node:assert/strict";
import test from "node:test";

import { EventRegistry, RegistryError } from "../src/registry.js";
import { bootRegistry, completeRunWithEmbedding, ref, sha } from "./fixtures.js";

function assertCode(code, fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RegistryError, `期望 RegistryError，实际 ${error?.constructor?.name}`);
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}`);
    return true;
  });
}

/* ------------------------------ 版本与日志 ------------------------------ */

test("聚合版本号单调递增且事件不可变", () => {
  const { registry, human } = bootRegistry();
  const events = registry.events({ aggregateId: human.aggregate_id });
  assert.equal(events.length, 1);
  assert.equal(events[0].version, 1);
});

test("日志导出后可完整重建，重建后行为一致", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology, project: "P-1" });
  const log = registry.exportLog();

  // 导出副本是深拷贝，调用方无法篡改日志。
  log.length = 0;
  assert.ok(registry.exportLog().length > 0);

  const rebuilt = EventRegistry.replay(registry.exportLog());
  assert.equal(rebuilt.exportLog().length, registry.exportLog().length);
  const runs = rebuilt.listRuns({ auditor: true });
  assert.equal(runs.length, 1);
});

test("重建时版本不连续被拒绝", () => {
  const bad = [
    {
      event_id: "evt-1",
      event_type: "ANALYSIS_REGISTERED",
      aggregate_type: "analysis_registration",
      aggregate_id: "analysis-1",
      occurred_at: "2026-09-15T08:00:00Z",
      version: 1,
      summary: "s",
      payload: {
        title: "t", lead_lab: "l", planned_species: ["A"],
        intended_use: "u", registered_at: "2026-09-15T08:00:00Z",
      },
    },
    {
      event_id: "evt-2",
      event_type: "ANALYSIS_REGISTERED",
      aggregate_type: "analysis_registration",
      aggregate_id: "analysis-1",
      occurred_at: "2026-09-15T08:01:00Z",
      version: 3,
      summary: "s",
      payload: {
        title: "t", lead_lab: "l", planned_species: ["A"],
        intended_use: "u", registered_at: "2026-09-15T08:01:00Z",
      },
    },
  ];
  assertCode("VERSION_CONFLICT", () => EventRegistry.replay(bad));
});

/* ---------------------------- 先登记再引用 ---------------------------- */

test("训练运行必须挂接到已登记分析", () => {
  const { registry, sponge, vocab, orthology } = bootRegistry();
  assertCode("UNREGISTERED_ANALYSIS", () =>
    registry.registerRun({
      idempotencyKey: "k",
      analysis_ref: "analysis-ghost",
      lab: "L",
      project_id: "P-1",
      dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
});

/* ------------------------------ 受控数据 ------------------------------ */

test("无授权项目不得引用受控（人类）数据", () => {
  const { registry, analysis, human, vocab, orthology } = bootRegistry();
  assertCode("ACCESS_DENIED", () =>
    registry.registerRun({
      idempotencyKey: "rogue",
      analysis_ref: analysis.aggregate_id,
      lab: "外部组",
      project_id: "P-NO-GRANT",
      dataset_refs: [ref("dataset_release", human.aggregate_id, human.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
});

test("过期授权等同于无授权", () => {
  const { registry, analysis, human, vocab, orthology } = bootRegistry();
  registry.authorizeAccess({
    project_id: "P-TEMP",
    dataset_refs: [ref("dataset_release", human.aggregate_id, human.payload.checksum)],
    granted_by: "DAC",
    expires_at: "2026-09-01T00:00:00Z",
  });
  assertCode("ACCESS_DENIED", () =>
    registry.registerRun({
      idempotencyKey: "temp",
      analysis_ref: analysis.aggregate_id,
      lab: "L",
      project_id: "P-TEMP",
      dataset_refs: [ref("dataset_release", human.aggregate_id, human.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
});

/* --------------------------- 词表 / 同源组冻结 --------------------------- */

test("同源组必须覆盖运行所用词表，禁止跨源拼装", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const other = registry.freezeVocabulary({
    name: "另一词表",
    vocab_version: "x",
    source_release: "NCBI",
    checksum: sha("other"),
  });
  assertCode("ORTHOLOGY_VOCAB_MISMATCH", () =>
    registry.registerRun({
      idempotencyKey: "mismatch",
      analysis_ref: analysis.aggregate_id,
      lab: "L",
      project_id: "P-1",
      dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", other.aggregate_id, other.payload.checksum),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
  // 词表引用校验值与冻结值不符也被拒绝。
  assertCode("CHECKSUM_MISMATCH", () =>
    registry.registerRun({
      idempotencyKey: "badchecksum",
      analysis_ref: analysis.aggregate_id,
      lab: "L",
      project_id: "P-1",
      dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, sha("tampered")),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
});

/* --------------------------- 分片训练与幂等 --------------------------- */

test("训练注册与分片回调的幂等：重复不产生第二个运行/事件", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const input = {
    idempotencyKey: "same-key",
    analysis_ref: analysis.aggregate_id,
    lab: "L",
    project_id: "P-1",
    dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
    vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
    orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
    training_config: { checksum: sha("c") },
    code: { repository: "r", commit: "c", checksum: sha("code") },
    shard_total: 2,
  };
  const first = registry.registerRun(input);
  const second = registry.registerRun({ ...input, lab: "被篡改的实验室名" });
  assert.equal(second.event_id, first.event_id);
  assert.equal(second.payload.lab, "L");
  const runId = first.aggregate_id;

  const cb = {
    idempotencyKey: "shard:0:cp",
    shard_index: 0,
    state: "checkpoint",
    checkpoint_checksum: sha("cp1"),
  };
  const cb1 = registry.progressShard(runId, cb);
  const cb2 = registry.progressShard(runId, { ...cb, checkpoint_checksum: sha("tampered") });
  assert.equal(cb2.event_id, cb1.event_id);
  assert.equal(cb2.payload.checkpoint_checksum.value, sha("cp1").value);
});

test("分片序号越界、未知检查点恢复、未齐完成均被拒绝", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const run = registry.registerRun({
    idempotencyKey: "k",
    analysis_ref: analysis.aggregate_id,
    lab: "L",
    project_id: "P-1",
    dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
    vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
    orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
    training_config: { checksum: sha("c") },
    code: { repository: "r", commit: "c", checksum: sha("code") },
    shard_total: 2,
  });
  const id = run.aggregate_id;

  assertCode("BAD_SHARD_INDEX", () =>
    registry.progressShard(id, { idempotencyKey: "x", shard_index: 2, state: "started", checkpoint_checksum: sha("x") })
  );
  assertCode("UNKNOWN_CHECKPOINT", () =>
    registry.progressShard(id, {
      idempotencyKey: "resume",
      shard_index: 0,
      state: "checkpoint",
      checkpoint_checksum: sha("cp2"),
      resumes_from_checkpoint: sha("never-existed"),
    })
  );
  registry.progressShard(id, { idempotencyKey: "s0done", shard_index: 0, state: "completed", checkpoint_checksum: sha("s0") });
  assertCode("SHARDS_INCOMPLETE", () =>
    registry.completeRun(id, { weights: { checksum: sha("w") }, embedding_checksum: sha("e") })
  );
});

test("运行完成后配置/代码校验值以登记锁定值为准", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const completed = registry.events({ aggregateId: run.aggregate_id }).find((e) => e.event_type === "RUN_COMPLETED");
  assert.equal(completed.payload.config_checksum.value, sha("config").value);
  assert.equal(completed.payload.code_checksum.value, sha("code").value);
});

/* --------------------------- 嵌入 / 主张 / 验证 --------------------------- */

test("嵌入、主张、验证是三种独立聚合状态", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });

  const claim = registry.recordClaim({
    embedding_ref: embedding.aggregate_id,
    statement: "相似",
    recorded_by: "L",
  });
  assert.equal(claim.aggregate_type, "biological_claim");
  assert.equal(claim.payload.validation_level, "exploratory");
  const view = registry.getClaim(claim.aggregate_id);
  assert.equal(view.level, "exploratory");
  assert.equal(view.history.length, 1);
});

test("验证等级只能逐级提升，且独立复现/实验验证有附加门槛", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });
  const id = claim.aggregate_id;

  const independentLab = { lab: "独立组", independent: true };

  // 跳级
  assertCode("LEVEL_SKIPPED", () =>
    registry.validateClaim(id, { new_level: "independent_replication", method: "m", validated_by: independentLab, evidence: { description: "e" } })
  );
  registry.validateClaim(id, {
    new_level: "computational_replication",
    method: "m",
    validated_by: { lab: "本组", independent: false },
    evidence: { description: "e" },
  });
  // 降级也被禁止
  assertCode("LEVEL_SKIPPED", () =>
    registry.validateClaim(id, { new_level: "exploratory", method: "m", validated_by: independentLab, evidence: { description: "e" } })
  );
  // 独立复现必须独立实验室
  assertCode("NOT_INDEPENDENT", () =>
    registry.validateClaim(id, { new_level: "independent_replication", method: "m", validated_by: { lab: "本组", independent: false }, evidence: { description: "e" } })
  );
  registry.validateClaim(id, {
    new_level: "independent_replication",
    method: "m",
    validated_by: independentLab,
    evidence: { description: "e" },
  });
  // 实验验证必须附后续实验引用
  assertCode("EXPERIMENT_REF_REQUIRED", () =>
    registry.validateClaim(id, { new_level: "experimental_validation", method: "m", validated_by: independentLab, evidence: { description: "e" } })
  );
  registry.validateClaim(id, {
    new_level: "experimental_validation",
    method: "谱系追踪",
    validated_by: independentLab,
    evidence: { description: "实验结果", experiment_ref: "experiment-2026-099" },
  });
  const view = registry.getClaim(id);
  assert.equal(view.level, "experimental_validation");
  assert.equal(view.history.length, 4);
});

/* ------------------------------ 保密与并存 ------------------------------ */

test("保密期竞争结果并存且按项目隔离", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const a = completeRunWithEmbedding(registry, {
    analysis, datasets: [sponge], vocab, orthology, project: "P-A", idempotencyKey: "run-a",
  });
  const b = registry.registerRun({
    idempotencyKey: "run-b",
    analysis_ref: analysis.aggregate_id,
    lab: "竞争组",
    project_id: "P-B",
    dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
    vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
    orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
    training_config: { checksum: sha("c") },
    code: { repository: "r", commit: "c", checksum: sha("code2") },
    shard_total: 1,
    embargo: { owner_project: "P-B" },
  });

  const all = registry.listRuns({ auditor: true });
  assert.equal(all.length, 2);

  const bAsSeenByA = registry.listRuns({ project: "P-A" }).find((r) => r.run_id === b.aggregate_id);
  assert.equal(bAsSeenByA.status, "redacted");
  assertCode("EMBARGOED", () => registry.getRun(b.aggregate_id, { project: "P-A" }));

  // 所有方与审查视角可见；A 自己的公开运行任何人可见。
  assert.equal(registry.getRun(b.aggregate_id, { project: "P-B" }).id, b.aggregate_id);
  assert.equal(registry.getRun(a.run.aggregate_id).status, "completed");
});

/* --------------------------- 撤回与注释升级 --------------------------- */

test("来源撤回只标记受影响运行/主张/图表，历史完整保留", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });
  const figure = registry.publishFigure({
    title: "图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [claim.aggregate_id],
  });

  const eventCountBefore = registry.exportLog().length;
  const withdrawal = registry.withdrawSource(sponge.aggregate_id, { reason: "授权撤回" });

  assert.ok(withdrawal.payload.affected.affected_run_refs.includes(run.aggregate_id));
  assert.ok(withdrawal.payload.affected.affected_claim_refs.includes(claim.aggregate_id));
  assert.ok(withdrawal.payload.affected.affected_figure_refs.includes(figure.aggregate_id));
  assert.match(withdrawal.payload.affected.retained_history_note, /保留/);

  // 日志只增不删。
  assert.equal(registry.exportLog().length, eventCountBefore + 1);
  // 历史图表仍可打开，溯源包带撤回标记。
  const packet = registry.figureProvenance(figure.aggregate_id, { auditor: true });
  assert.ok(packet.markers.some((m) => m.kind === "source_withdrawn"));
  // 受影响运行不得发布新产物。
  assertCode("RUN_SOURCE_WITHDRAWN", () =>
    registry.publishModelCard({
      run_ref: run.aggregate_id,
      embedding_ref: embedding.aggregate_id,
      intended_uses: ["x"],
      out_of_scope_uses: ["y"],
    })
  );
  // 撤回数据集不得进入新运行。
  const { registry: r2, analysis: a2, sponge: s2, vocab: v2, orthology: o2 } = bootRegistry();
  r2.withdrawSource(s2.aggregate_id, { reason: "撤回" });
  assertCode("SOURCE_WITHDRAWN_REFUSED", () =>
    completeRunWithEmbedding(r2, { analysis: a2, datasets: [s2], vocab: v2, orthology: o2 })
  );
});

test("注释升级自动计算影响面，并阻断旧注释产物的继续发布", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });
  registry.publishFigure({
    title: "图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [claim.aggregate_id],
  });

  const vocab2 = registry.freezeVocabulary({
    name: vocab.payload.name,
    vocab_version: "v2",
    source_release: "Ensembl 115",
    checksum: sha("vocab2"),
    supersedes: vocab.aggregate_id,
  });
  const orthology2 = registry.freezeOrthology({
    name: orthology.payload.name,
    mapping_version: "v2",
    source: "Compara 115",
    vocabulary_refs: [ref("gene_vocabulary", vocab2.aggregate_id, vocab2.payload.checksum)],
    checksum: sha("orthology2"),
    supersedes: orthology.aggregate_id,
  });
  const upgrade = registry.upgradeAnnotation(vocab.aggregate_id, {
    new_ref: ref("gene_vocabulary", vocab2.aggregate_id, vocab2.payload.checksum),
    reason: "基因模型更新",
  });
  assert.ok(upgrade.payload.affected.affected_run_refs.includes(run.aggregate_id));
  assert.ok(upgrade.payload.affected.affected_claim_refs.includes(claim.aggregate_id));

  // 旧冻结版本不能再用于新运行；旧运行不能发布新图表。
  assertCode("ANNOTATION_SUPERSEDED", () =>
    registry.registerRun({
      idempotencyKey: "stale",
      analysis_ref: analysis.aggregate_id,
      lab: "L",
      project_id: "P-1",
      dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
      vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
      orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
      training_config: { checksum: sha("c") },
      code: { repository: "r", commit: "c", checksum: sha("code") },
      shard_total: 1,
    })
  );
  assertCode("RUN_ANNOTATION_UPGRADED", () =>
    registry.publishFigure({
      title: "新图",
      run_ref: run.aggregate_id,
      embedding_ref: embedding.aggregate_id,
      claim_refs: [],
    })
  );
  // 新版本正常可用。
  const rerun = registry.registerRun({
    idempotencyKey: "fresh",
    analysis_ref: analysis.aggregate_id,
    lab: "L",
    project_id: "P-1",
    dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
    vocabulary_ref: ref("gene_vocabulary", vocab2.aggregate_id, vocab2.payload.checksum),
    orthology_ref: ref("orthology_set", orthology2.aggregate_id, orthology2.payload.checksum),
    training_config: { checksum: sha("c2") },
    code: { repository: "r", commit: "c2", checksum: sha("code2") },
    shard_total: 1,
  });
  assert.ok(rerun.aggregate_id);
});

/* ------------------------------ 模型卡 / 图表 ------------------------------ */

test("图表发布即冻结溯源包，验证等级取所引主张的最低值", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });

  const fig1 = registry.publishFigure({
    title: "无主张图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [],
  });
  assert.equal(fig1.payload.validation_level, "exploratory");

  registry.validateClaim(claim.aggregate_id, {
    new_level: "computational_replication",
    method: "m",
    validated_by: { lab: "本组", independent: false },
    evidence: { description: "e" },
  });
  const fig2 = registry.publishFigure({
    title: "带主张图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [claim.aggregate_id],
  });
  assert.equal(fig2.payload.validation_level, "computational_replication");

  const packet = registry.figureProvenance(fig2.aggregate_id);
  assert.equal(packet.datasets[0].checksum.value, sponge.payload.checksum.value);
  assert.equal(packet.vocabulary.checksum.value, vocab.payload.checksum.value);
  assert.equal(packet.orthology.checksum.value, orthology.payload.checksum.value);
  assert.equal(packet.config_checksum.value, sha("config").value);
  assert.equal(packet.weights_checksum.value, sha(`weights:${run.aggregate_id}`).value);
  assert.equal(packet.claims[0].level, "computational_replication");
});

test("图表不能并入不属于其嵌入的主张", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const first = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology, idempotencyKey: "r1" });
  const second = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology, idempotencyKey: "r2" });
  const foreignClaim = registry.recordClaim({ embedding_ref: second.embedding.aggregate_id, statement: "s", recorded_by: "L" });
  assertCode("CLAIM_EMBEDDING_MISMATCH", () =>
    registry.publishFigure({
      title: "混搭图",
      run_ref: first.run.aggregate_id,
      embedding_ref: first.embedding.aggregate_id,
      claim_refs: [foreignClaim.aggregate_id],
    })
  );
});

test("模型卡按最高主张等级生成且重复发布幂等", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });
  registry.validateClaim(claim.aggregate_id, {
    new_level: "computational_replication",
    method: "m",
    validated_by: { lab: "本组", independent: false },
    evidence: { description: "e" },
  });

  const card = registry.publishModelCard({
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    intended_uses: ["假设生成"],
    out_of_scope_uses: ["临床"],
  });
  const again = registry.publishModelCard({
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    intended_uses: ["假设生成"],
    out_of_scope_uses: ["临床"],
  });
  assert.equal(again.event_id, card.event_id);

  const data = registry.modelCardData(card.aggregate_id);
  assert.equal(data.validation_level, "computational_replication");
  assert.equal(data.vocabulary.version, "v1");
  assert.equal(data.datasets[0].human_subject, false);
});
