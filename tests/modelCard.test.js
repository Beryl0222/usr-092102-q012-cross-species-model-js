import assert from "node:assert/strict";
import test from "node:test";

import { figureProvenanceAsMarkdown, modelCardAsJson, modelCardAsMarkdown } from "../src/modelCard.js";
import { bootRegistry, completeRunWithEmbedding } from "./fixtures.js";

test("探索线索模型卡明确禁止表述为已验证事实", () => {
  const { registry, analysis, sponge, human, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, {
    analysis, datasets: [sponge, human], vocab, orthology,
  });
  const card = registry.publishModelCard({
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    intended_uses: ["假设生成"],
    out_of_scope_uses: ["临床"],
  });
  const data = registry.modelCardData(card.aggregate_id);
  const json = modelCardAsJson(data);
  const md = modelCardAsMarkdown(data);

  assert.equal(json.validation.is_verified_biological_fact, false);
  assert.match(json.validation.note, /探索线索/);
  assert.match(md, /探索线索/);
  assert.match(md, /不得引用为“经过验证的生物学事实”/);
  // 适用边界
  assert.deepEqual(json.scope.species.sort(), ["Amphimedon queenslandica", "Homo sapiens"].sort());
  assert.equal(json.scope.human_subject_data, true);
  assert.equal(json.scope.most_restrictive_access, "controlled");
  // 复现配方锁定全部校验值
  assert.equal(json.reproduction.weights_checksum.value, data.weights_checksum.value);
  assert.match(md, /sha256:/);
});

test("实验验证后的模型卡把事实状态标记为已验证", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const claim = registry.recordClaim({ embedding_ref: embedding.aggregate_id, statement: "s", recorded_by: "L" });
  for (const [level, method, by, evidence] of [
    ["computational_replication", "复算", { lab: "本组", independent: false }, { description: "e" }],
    ["independent_replication", "独立重复", { lab: "独立组", independent: true }, { description: "e" }],
    ["experimental_validation", "实验", { lab: "独立组", independent: true }, { description: "e", experiment_ref: "exp-1" }],
  ]) {
    registry.validateClaim(claim.aggregate_id, { new_level: level, method, validated_by: by, evidence });
  }
  const card = registry.publishModelCard({
    run_ref: registry.events().filter((e) => e.event_type === "RUN_REGISTERED")[0].aggregate_id,
    embedding_ref: embedding.aggregate_id,
    intended_uses: ["x"],
    out_of_scope_uses: ["y"],
  });
  const json = modelCardAsJson(registry.modelCardData(card.aggregate_id));
  assert.equal(json.validation.is_verified_biological_fact, true);
});

test("模型卡与溯源包渲染撤回/升级标记", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const card = registry.publishModelCard({
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    intended_uses: ["x"],
    out_of_scope_uses: ["y"],
  });
  const figure = registry.publishFigure({
    title: "图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [],
  });
  registry.withdrawSource(sponge.aggregate_id, { reason: "样本授权撤回" });

  const md = modelCardAsMarkdown(registry.modelCardData(card.aggregate_id, { auditor: true }));
  assert.match(md, /来源撤回标记/);
  assert.match(md, /样本授权撤回/);
  assert.match(md, /仅供历史复查/);

  const packet = registry.figureProvenance(figure.aggregate_id, { auditor: true });
  const figMd = figureProvenanceAsMarkdown(packet);
  assert.match(figMd, /图表溯源：图/);
  assert.match(figMd, /来源已撤回/);
  // 同一标记在横幅中只出现一次（run 级与 figure 级去重）。
  assert.equal((figMd.match(/来源撤回标记/g) ?? []).length, 1);
});

test("溯源包暴露词表上游发布版本，支持差异归因", () => {
  const { registry, analysis, sponge, vocab, orthology } = bootRegistry();
  const { run, embedding } = completeRunWithEmbedding(registry, { analysis, datasets: [sponge], vocab, orthology });
  const figure = registry.publishFigure({
    title: "图",
    run_ref: run.aggregate_id,
    embedding_ref: embedding.aggregate_id,
    claim_refs: [],
  });
  const packet = registry.figureProvenance(figure.aggregate_id);
  assert.equal(packet.vocabulary.source_release, "Ensembl 112");
  assert.equal(packet.orthology.source, "Compara 112");
  const md = figureProvenanceAsMarkdown(packet);
  assert.match(md, /Ensembl 112/);
  assert.match(md, /Compara 112/);
});
