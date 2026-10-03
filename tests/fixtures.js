import { createHash } from "node:crypto";

import { EventRegistry } from "../src/registry.js";

export const sha = (text) => ({
  algorithm: "sha256",
  value: createHash("sha256").update(text).digest("hex"),
});

export const ref = (type, id, checksum) => ({
  aggregate_type: type,
  aggregate_id: id,
  ...(checksum ? { checksum } : {}),
});

/**
 * 搭出一条最小合规链路：分析 + 公开海绵数据 + 受控人类数据 +
 * 冻结词表/同源组 + P-1 对人类数据的授权。
 */
export function bootRegistry() {
  const registry = new EventRegistry({ now: () => "2026-09-15T08:00:00.000Z" });

  const analysis = registry.registerAnalysis({
    title: "测试分析",
    lead_lab: "测试实验室",
    planned_species: ["Amphimedon queenslandica", "Homo sapiens"],
    intended_use: "测试用途",
  });

  const sponge = registry.registerDataset({
    lab: "海洋站",
    species: { scientific_name: "Amphimedon queenslandica", common_name: "海绵" },
    tissue: "幼虫",
    sample_consent: "unrestricted_research",
    human_subject: false,
    access_tier: "public",
    quality_control: { passed: true, checks: ["qc-1"] },
    checksum: sha("sponge"),
  });

  const human = registry.registerDataset({
    lab: "人类图谱中心",
    species: { scientific_name: "Homo sapiens", common_name: "人类" },
    tissue: "外周血",
    sample_consent: "controlled_access",
    human_subject: true,
    access_tier: "controlled",
    access_restrictions: ["禁止流向无授权项目"],
    quality_control: { passed: true, checks: ["qc-h-1"] },
    checksum: sha("human"),
  });

  const vocab = registry.freezeVocabulary({
    name: "测试词表",
    vocab_version: "v1",
    source_release: "Ensembl 112",
    checksum: sha("vocab"),
  });

  const orthology = registry.freezeOrthology({
    name: "测试同源组",
    mapping_version: "v1",
    source: "Compara 112",
    vocabulary_refs: [ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum)],
    checksum: sha("orthology"),
  });

  registry.authorizeAccess({
    project_id: "P-1",
    dataset_refs: [ref("dataset_release", human.aggregate_id, human.payload.checksum)],
    granted_by: "DAC-TEST",
  });

  return { registry, analysis, sponge, human, vocab, orthology };
}

/** 注册并跑完整条训练链（默认单分片、公开数据），返回运行与嵌入。 */
export function completeRunWithEmbedding(
  registry,
  {
    analysis,
    datasets,
    vocab,
    orthology,
    project = "P-1",
    lab = "测试实验室",
    shardTotal = 1,
    embargo = undefined,
    idempotencyKey = "run:test:01",
  }
) {
  const run = registry.registerRun({
    idempotencyKey,
    analysis_ref: analysis.aggregate_id,
    lab,
    project_id: project,
    dataset_refs: datasets.map((d) => ref("dataset_release", d.aggregate_id, d.payload.checksum)),
    vocabulary_ref: ref("gene_vocabulary", vocab.aggregate_id, vocab.payload.checksum),
    orthology_ref: ref("orthology_set", orthology.aggregate_id, orthology.payload.checksum),
    training_config: { checksum: sha("config") },
    code: { repository: "git+https://example/test", commit: "abc123", checksum: sha("code") },
    shard_total: shardTotal,
    ...(embargo ? { embargo } : {}),
  });
  for (let i = 0; i < shardTotal; i += 1) {
    registry.progressShard(run.aggregate_id, {
      idempotencyKey: `shard:${i}:done`,
      shard_index: i,
      state: "completed",
      checkpoint_checksum: sha(`cp:${run.aggregate_id}:${i}`),
    });
  }
  registry.completeRun(run.aggregate_id, {
    weights: { checksum: sha(`weights:${run.aggregate_id}`) },
    embedding_checksum: sha(`embedding:${run.aggregate_id}`),
  });
  const embedding = registry.publishEmbedding(run.aggregate_id, {
    checksum: sha(`embedding:${run.aggregate_id}`),
    dimensionality: 64,
  });
  return { run, embedding };
}
