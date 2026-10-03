/**
 * 端到端场景：四物种（海绵 / 线虫 / 青蛙 / 人类）细胞共嵌入的
 * 预登记、冻结、分片训练、主张分级、模型卡与图表溯源，以及
 * 注释升级、来源撤回后的历史复查。
 *
 * 运行：node examples/cross-species-figure.js
 * 产物：examples/output/ 下的模型卡（md/json）与图表溯源包（md）。
 *
 * 场景中的 sha256 由内容字符串确定性生成，仅用于演示校验值锁定机制。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventRegistry, RegistryError } from "../src/registry.js";
import {
  figureProvenanceAsMarkdown,
  modelCardAsJson,
  modelCardAsMarkdown,
} from "../src/modelCard.js";

const sha = (text) => ({
  algorithm: "sha256",
  value: createHash("sha256").update(text).digest("hex"),
});
const ref = (type, id, checksum) => ({ aggregate_type: type, aggregate_id: id, ...(checksum ? { checksum } : {}) });

const results = [];
function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  const icon = condition ? "✓" : "✗";
  console.log(`${icon} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
}
async function expectCode(code, fn, label) {
  try {
    await fn();
    check(label, false, `应抛出 ${code}，但调用成功`);
  } catch (error) {
    if (error instanceof RegistryError) check(label, error.code === code, `RegistryError(${error.code})`);
    else throw error;
  }
}

const registry = new EventRegistry({ now: () => "2026-09-15T08:00:00.000Z" });

/* ---------- 1. 先登记分析：所有跨物种分析先登记再引用 ---------- */

const analysis = registry.registerAnalysis({
  title: "四门类物种细胞嵌入空间对应关系研究",
  lead_lab: "进化发育生物学联合实验室",
  planned_species: [
    "Amphimedon queenslandica",
    "Caenorhabditis elegans",
    "Xenopus tropicalis",
    "Homo sapiens",
  ],
  intended_use: "跨物种细胞类型相似性假设生成，不用于临床或同源性断言",
  hypotheses: ["免疫效应样细胞在深分歧物种间可能占据相邻嵌入区域"],
});
const analysisId = analysis.aggregate_id;

/* ---------- 2. 数据集登记：实验室/物种/组织/同意/质控/访问限制 ---------- */

const sponge = registry.registerDataset({
  lab: "Ludwig 海洋生物学站",
  species: { scientific_name: "Amphimedon queenslandica", common_name: "海绵", taxonomy_id: "NCBI:400915" },
  tissue: "幼虫全细胞",
  sample_consent: "unrestricted_research",
  human_subject: false,
  access_tier: "public",
  quality_control: { passed: true, checks: ["每簇细胞数≥500", "doublet 比例<5%", "线粒体读数<10%"] },
  source_uri: "s3://cell-atlas-demo/sponge-larvae-v1",
  checksum: sha("dataset:sponge:v1"),
});
const worm = registry.registerDataset({
  lab: "MRC 线虫库",
  species: { scientific_name: "Caenorhabditis elegans", common_name: "线虫", taxonomy_id: "NCBI:6239" },
  tissue: "L2 幼虫全细胞",
  sample_consent: "unrestricted_research",
  human_subject: false,
  access_tier: "public",
  quality_control: { passed: true, checks: ["每簇细胞数≥300", "doublet 比例<4%"] },
  checksum: sha("dataset:worm:v1"),
});
const frog = registry.registerDataset({
  lab: "图宾根发育基因组学组",
  species: { scientific_name: "Xenopus tropicalis", common_name: "热带爪蟾", taxonomy_id: "NCBI:8364" },
  tissue: "尾芽期胚胎",
  sample_consent: "unrestricted_research",
  human_subject: false,
  access_tier: "public",
  quality_control: { passed: true, checks: ["每簇细胞数≥500", "doublet 比例<6%"], notes: "批次效应按发育阶段校正" },
  checksum: sha("dataset:frog:v1"),
});
const human = registry.registerDataset({
  lab: "人类细胞图谱合作中心",
  species: { scientific_name: "Homo sapiens", common_name: "人类", taxonomy_id: "NCBI:9606" },
  tissue: "外周血与脑（多组织汇总）",
  sample_consent: "controlled_access",
  human_subject: true,
  access_tier: "controlled",
  access_restrictions: ["仅 DAC-2026-014 授权项目可用", "禁止个体层面数据导出", "禁止流向未授权项目"],
  quality_control: { passed: true, checks: ["供体去标识化复核", "每簇细胞数≥800", "doublet 比例<3%"] },
  checksum: sha("dataset:human:v1"),
});
const spongeId = sponge.aggregate_id, humanId = human.aggregate_id;

/* ---------- 3. 基因词表与同源组“分别冻结” ---------- */

const vocabV1 = registry.freezeVocabulary({
  name: "Ensembl 四物种基因词表",
  vocab_version: "2024-03",
  source_release: "Ensembl 112",
  species_coverage: ["Amphimedon queenslandica", "Caenorhabditis elegans", "Xenopus tropicalis", "Homo sapiens"],
  checksum: sha("vocab:v1"),
});
const orthoV1 = registry.freezeOrthology({
  name: "四物种同源组（一爪一妻映射）",
  mapping_version: "2024-03-compara",
  source: "Ensembl Compara release 112",
  mapping_policy: "仅保留 1:1 直系同源；多映射基因剔除",
  vocabulary_refs: [ref("gene_vocabulary", vocabV1.aggregate_id, vocabV1.payload.checksum)],
  checksum: sha("orthology:v1"),
});

/* ---------- 4. 受控数据授权：人类原始数据只流向授权项目 ---------- */

registry.authorizeAccess({
  project_id: "P-CROSS-1",
  dataset_refs: [ref("dataset_release", humanId, human.payload.checksum)],
  granted_by: "DAC-2026-014",
});

/* ---------- 5. 长训练：注册幂等 + 分片恢复 + 重复回调去重 ---------- */

const runInput = {
  idempotencyKey: "train:labA:2026-09-15:fig3:01",
  analysis_ref: analysisId,
  lab: "联合实验室-A 组",
  project_id: "P-CROSS-1",
  dataset_refs: [
    ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum),
    ref("dataset_release", worm.aggregate_id, worm.payload.checksum),
    ref("dataset_release", frog.aggregate_id, frog.payload.checksum),
    ref("dataset_release", humanId, human.payload.checksum),
  ],
  vocabulary_ref: ref("gene_vocabulary", vocabV1.aggregate_id, vocabV1.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV1.aggregate_id, orthoV1.payload.checksum),
  training_config: { checksum: sha("config:fig3:v1"), hyperparameters_uri: "s3://cell-atlas-demo/configs/fig3.yaml" },
  code: { repository: "git+https://git.example.institute/cross-species/cell-embed", commit: "a1b2c2d9", checksum: sha("code:v1") },
  shard_total: 3,
};
const runA = registry.registerRun(runInput);
const runAId = runA.aggregate_id;
const runADuplicate = registry.registerRun(runInput);
check("训练注册重复提交不产生第二个运行", runADuplicate.event_id === runA.event_id, runAId);

// 分片 0 正常推进至完成
registry.progressShard(runAId, { idempotencyKey: "runA:shard0:started", shard_index: 0, state: "started", checkpoint_checksum: sha("runA:s0:started") });
registry.progressShard(runAId, { idempotencyKey: "runA:shard0:cp1", shard_index: 0, state: "checkpoint", checkpoint_checksum: sha("runA:s0:cp1") });
const s0done = registry.progressShard(runAId, { idempotencyKey: "runA:shard0:done", shard_index: 0, state: "completed", checkpoint_checksum: sha("runA:s0:done"), resumes_from_checkpoint: sha("runA:s0:cp1") });
const s0doneRetry = registry.progressShard(runAId, { idempotencyKey: "runA:shard0:done", shard_index: 0, state: "completed", checkpoint_checksum: sha("runA:s0:done"), resumes_from_checkpoint: sha("runA:s0:cp1") });
check("分片完成回调重放返回同一事件", s0doneRetry.event_id === s0done.event_id);

// 分片 1：训练进程崩溃后从检查点恢复
registry.progressShard(runAId, { idempotencyKey: "runA:shard1:cp1", shard_index: 1, state: "checkpoint", checkpoint_checksum: sha("runA:s1:cp1") });
const resumed = registry.progressShard(runAId, {
  idempotencyKey: "runA:shard1:resume",
  shard_index: 1,
  state: "checkpoint",
  checkpoint_checksum: sha("runA:s1:cp2"),
  resumes_from_checkpoint: sha("runA:s1:cp1"),
});
check("长训练可从既有检查点分片恢复", resumed.payload.resumes_from_checkpoint.value === sha("runA:s1:cp1").value);
await expectCode("UNKNOWN_CHECKPOINT", () => registry.progressShard(runAId, {
  idempotencyKey: "runA:shard1:badresume",
  shard_index: 1,
  state: "checkpoint",
  checkpoint_checksum: sha("runA:s1:cpX"),
  resumes_from_checkpoint: sha("checkpoint:that:never:existed"),
}), "从未知检查点恢复被拒绝");
registry.progressShard(runAId, { idempotencyKey: "runA:shard1:done", shard_index: 1, state: "completed", checkpoint_checksum: sha("runA:s1:done"), resumes_from_checkpoint: sha("runA:s1:cp2") });
registry.progressShard(runAId, { idempotencyKey: "runA:shard2:started", shard_index: 2, state: "started", checkpoint_checksum: sha("runA:s2:started") });

await expectCode("SHARDS_INCOMPLETE", () => registry.completeRun(runAId, {
  weights: { checksum: sha("weights:runA") }, embedding_checksum: sha("embedding:runA"),
}), "分片未齐时禁止完成运行");
registry.progressShard(runAId, { idempotencyKey: "runA:shard2:done", shard_index: 2, state: "completed", checkpoint_checksum: sha("runA:s2:done"), resumes_from_checkpoint: sha("runA:s2:started") });
const completed = registry.completeRun(runAId, {
  weights: { checksum: sha("weights:runA"), artifact_uri: "s3://cell-atlas-demo/weights/runA.pt" },
  embedding_checksum: sha("embedding:runA"),
  metrics: { neighbor_recall: 0.81 },
});
const completedRetry = registry.completeRun(runAId, {
  weights: { checksum: sha("weights:runA") }, embedding_checksum: sha("embedding:runA"),
});
check("运行完成回调幂等", completedRetry.event_id === completed.event_id);

/* ---------- 6. 嵌入结果 / 推断主张 / 实验验证：三种状态严格分离 ---------- */

const embedding = registry.publishEmbedding(runAId, {
  checksum: sha("embedding:runA"),
  artifact_uri: "s3://cell-atlas-demo/embeddings/runA.zarr",
  dimensionality: 256,
  entities: ["海绵-幼虫细胞", "线虫-L2 细胞", "爪蟾-尾芽细胞", "人类-免疫/神经细胞"],
});
const embeddingId = embedding.aggregate_id;

await expectCode("CHECKSUM_MISMATCH", () => registry.publishEmbedding(runAId, {
  checksum: sha("embedding:tampered"),
}), "嵌入校验值与运行锁定值不一致时拒绝发布");

const claim = registry.recordClaim({
  embedding_ref: embeddingId,
  statement: "海绵领细胞与人类小胶质样细胞在共嵌入空间相邻，提示免疫效应样细胞的深谱系对应可能",
  recorded_by: "联合实验室-A 组",
  caveats: ["空间相邻不等于同源", "仅覆盖四物种与有限组织", "基因词表与同源组为 2024-03 冻结版"],
});
const claimId = claim.aggregate_id;
check("新登记主张一律为探索线索", claim.payload.validation_level === "exploratory");

await expectCode("LEVEL_SKIPPED", () => registry.validateClaim(claimId, {
  new_level: "experimental_validation",
  method: "口头讨论",
  validated_by: { lab: "联合实验室-A 组", independent: false },
  evidence: { description: "无" },
}), "不得把模型相似性跳跃记为实验验证事实");

registry.validateClaim(claimId, {
  new_level: "computational_replication",
  method: "独立留出批次上重算嵌入，最近邻标签一致率 0.81",
  validated_by: { lab: "联合实验室-A 组（内部复算）", independent: false },
  evidence: { description: "留出批次复算报告", artifact_uri: "s3://cell-atlas-demo/reports/replica-internal.pdf", checksum: sha("evidence:internal-replica") },
});
await expectCode("NOT_INDEPENDENT", () => registry.validateClaim(claimId, {
  new_level: "independent_replication",
  method: "同组复算",
  validated_by: { lab: "联合实验室-A 组", independent: false },
  evidence: { description: "内部复算" },
}), "独立复现等级强制要求独立实验室");
registry.validateClaim(claimId, {
  new_level: "independent_replication",
  method: "B 组用自有预处理管线在相同冻结词表/同源组上重复",
  validated_by: { lab: "进化基因组学-B 组", independent: true },
  evidence: { description: "独立实验室复现报告", checksum: sha("evidence:independent-lab-b") },
});
await expectCode("EXPERIMENT_REF_REQUIRED", () => registry.validateClaim(claimId, {
  new_level: "experimental_validation",
  method: "谱系追踪",
  validated_by: { lab: "海洋实验站", independent: true },
  evidence: { description: "尚未完成" },
}), "实验验证等级必须附后续实验引用");
check("主张停在独立复现等级（实验验证尚未完成）", registry.getClaim(claimId).level === "independent_replication");

/* ---------- 7. 模型卡与图表：发布即冻结溯源 ---------- */

const card = registry.publishModelCard({
  run_ref: runAId,
  embedding_ref: embeddingId,
  intended_uses: ["跨物种细胞类型假设生成", "指导后续谱系追踪实验的优先级排序"],
  out_of_scope_uses: ["临床诊断或预后判断", "将嵌入空间相邻表述为已证实的细胞同源", "外推到未覆盖物种/组织/发育阶段"],
  warnings: ["每物种组织覆盖有限", "1:1 同源策略剔除了基因家族扩张物种的大量基因"],
});
const cardId = card.aggregate_id;
const figure = registry.publishFigure({
  title: "图3 四物种细胞共嵌入空间（海绵/线虫/蛙/人）",
  run_ref: runAId,
  embedding_ref: embeddingId,
  claim_refs: [claimId],
  artifact_uri: "s3://cell-atlas-demo/figures/fig3.umap.svg",
});
const figureId = figure.aggregate_id;
check("图表验证等级随所引主张保守取值", figure.payload.validation_level === "independent_replication");

/* ---------- 8. 保密期竞争结果并存 + 可见性隔离 ---------- */

const runB = registry.registerRun({
  idempotencyKey: "train:labB:2026-09:competing:01",
  analysis_ref: analysisId,
  lab: "进化基因组学-B 组",
  project_id: "P-COMPETE-B",
  dataset_refs: [
    ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum),
    ref("dataset_release", worm.aggregate_id, worm.payload.checksum),
    ref("dataset_release", frog.aggregate_id, frog.payload.checksum),
  ],
  vocabulary_ref: ref("gene_vocabulary", vocabV1.aggregate_id, vocabV1.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV1.aggregate_id, orthoV1.payload.checksum),
  training_config: { checksum: sha("config:labB:v1") },
  code: { repository: "git+https://git.example.institute/lab-b/ortho-embed", commit: "77aa91f", checksum: sha("code:labB:v1") },
  shard_total: 1,
  embargo: { owner_project: "P-COMPETE-B", visible_to_projects: [], embargo_until: "2027-09-01T00:00:00Z" },
});
const runBId = runB.aggregate_id;
const visibleToLabA = registry.listRuns({ project: "P-CROSS-1" }).find((x) => x.run_id === runBId);
const visibleToAuditor = registry.listRuns({ auditor: true }).find((x) => x.run_id === runBId);
check("竞争结果在保密期内允许并存", registry.listRuns({ auditor: true }).filter((x) => x.status !== "redacted").length >= 2);
check("未授权项目只见竞争运行的脱敏占位", visibleToLabA.status === "redacted");
check("研究所审查视角可见全部运行", visibleToAuditor.status === "registered" && visibleToAuditor.embargoed);
await expectCode("EMBARGOED", () => registry.getRun(runBId, { project: "P-CROSS-1" }), "保密期运行详情对竞争方不可见");

/* ---------- 9. 人类原始数据不得流向无授权项目 ---------- */

await expectCode("ACCESS_DENIED", () => registry.registerRun({
  idempotencyKey: "train:rogue:01",
  analysis_ref: analysisId,
  lab: "外部合作组 X",
  project_id: "P-ROGUE-NO-GRANT",
  dataset_refs: [ref("dataset_release", humanId, human.payload.checksum)],
  vocabulary_ref: ref("gene_vocabulary", vocabV1.aggregate_id, vocabV1.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV1.aggregate_id, orthoV1.payload.checksum),
  training_config: { checksum: sha("config:rogue") },
  code: { repository: "git+https://git.example.institute/x/rogue", commit: "deadbee", checksum: sha("code:rogue") },
  shard_total: 1,
}), "无授权项目引用人类受控数据被拒绝");

/* ---------- 10. 复现方只能拿到最新映射：注释升级与差异归因 ---------- */

const vocabV2 = registry.freezeVocabulary({
  name: "Ensembl 四物种基因词表",
  vocab_version: "2026-06",
  source_release: "Ensembl 115",
  species_coverage: vocabV1.payload.species_coverage,
  checksum: sha("vocab:v2"),
  supersedes: vocabV1.aggregate_id,
});
const orthoV2 = registry.freezeOrthology({
  name: "四物种同源组（一爪一妻映射）",
  mapping_version: "2026-06-compara",
  source: "Ensembl Compara release 115",
  mapping_policy: "仅保留 1:1 直系同源；多映射基因剔除",
  vocabulary_refs: [ref("gene_vocabulary", vocabV2.aggregate_id, vocabV2.payload.checksum)],
  checksum: sha("orthology:v2"),
  supersedes: orthoV1.aggregate_id,
});
// 另一套现行但来源不同的词表：未被取代，却不被 orthoV2 覆盖——用于演示配套校验。
const vocabAlt = registry.freezeVocabulary({
  name: "四物种基因词表（NCBI 整理）",
  vocab_version: "2026-06-alt",
  source_release: "NCBI Gene 2026-06",
  species_coverage: vocabV1.payload.species_coverage,
  checksum: sha("vocab:alt"),
});

await expectCode("ORTHOLOGY_VOCAB_MISMATCH", () => registry.registerRun({
  idempotencyKey: "repro:mismatch:01",
  analysis_ref: analysisId,
  lab: "复现实验室-R",
  project_id: "P-REPRO",
  dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
  vocabulary_ref: ref("gene_vocabulary", vocabAlt.aggregate_id, vocabAlt.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV2.aggregate_id, orthoV2.payload.checksum), // 现行同源组但不覆盖该词表
  training_config: { checksum: sha("config:repro:v2") },
  code: { repository: "git+https://git.example.institute/cross-species/cell-embed", commit: "e3f4a51", checksum: sha("code:v2") },
  shard_total: 1,
}), "禁止现行同源组与未覆盖的现行词表跨源拼装");

await expectCode("ANNOTATION_SUPERSEDED", () => registry.registerRun({
  idempotencyKey: "repro:stalevocab:01",
  analysis_ref: analysisId,
  lab: "复现实验室-R",
  project_id: "P-REPRO",
  dataset_refs: [ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum)],
  vocabulary_ref: ref("gene_vocabulary", vocabV1.aggregate_id, vocabV1.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV1.aggregate_id, orthoV1.payload.checksum),
  training_config: { checksum: sha("config:repro:v2") },
  code: { repository: "git+https://git.example.institute/cross-species/cell-embed", commit: "e3f4a51", checksum: sha("code:v2") },
  shard_total: 1,
}), "新运行不得再引用已被取代的冻结词表");

// 复现运行：最新词表+同源组，公开三物种，分片跑完
const reproRun = registry.registerRun({
  idempotencyKey: "repro:2026-06:01",
  analysis_ref: analysisId,
  lab: "复现实验室-R",
  project_id: "P-REPRO",
  dataset_refs: [
    ref("dataset_release", sponge.aggregate_id, sponge.payload.checksum),
    ref("dataset_release", worm.aggregate_id, worm.payload.checksum),
    ref("dataset_release", frog.aggregate_id, frog.payload.checksum),
  ],
  vocabulary_ref: ref("gene_vocabulary", vocabV2.aggregate_id, vocabV2.payload.checksum),
  orthology_ref: ref("orthology_set", orthoV2.aggregate_id, orthoV2.payload.checksum),
  training_config: { checksum: sha("config:repro:v2") },
  code: { repository: "git+https://git.example.institute/cross-species/cell-embed", commit: "e3f4a51", checksum: sha("code:v2") },
  shard_total: 1,
});
const reproId = reproRun.aggregate_id;
registry.progressShard(reproId, { idempotencyKey: "repro:s0:done", shard_index: 0, state: "completed", checkpoint_checksum: sha("repro:s0:done") });
registry.completeRun(reproId, { weights: { checksum: sha("weights:repro") }, embedding_checksum: sha("embedding:repro"), metrics: { neighbor_recall: 0.74 } });
const reproEmbedding = registry.publishEmbedding(reproId, { checksum: sha("embedding:repro"), dimensionality: 256 });

const reproCard = registry.publishModelCard({
  run_ref: reproId,
  embedding_ref: reproEmbedding.aggregate_id,
  intended_uses: ["与 2024-03 冻结版结果对比，量化注释升级带来的差异"],
  out_of_scope_uses: ["任何生物学结论（复算差异尚未归因完毕）", "临床用途"],
  warnings: [
    "本运行使用 Ensembl/Compara 115 重跑；与原论文图3 的任何差异应先比对词表与同源组校验值，再讨论模型权重。",
    "不含人类受控数据（复现项目无 DAC 授权），覆盖物种少于原运行。",
  ],
});
const reproCardId = reproCard.aggregate_id;

// 登记处把旧注释标记为升级，受影响运行/主张/图表自动计算，历史不删除
const vocabUpgrade = registry.upgradeAnnotation(vocabV1.aggregate_id, {
  new_ref: ref("gene_vocabulary", vocabV2.aggregate_id, vocabV2.payload.checksum),
  reason: "Ensembl 112→115 基因模型更新：海绵/爪蟾基因结构修订约 4%",
});
const orthoUpgrade = registry.upgradeAnnotation(orthoV1.aggregate_id, {
  new_ref: ref("orthology_set", orthoV2.aggregate_id, orthoV2.payload.checksum),
  reason: "Compara 112→115 同源关系重算：旧图差异应先归因注释版本",
});
check("注释升级自动标记原图与原主张",
  vocabUpgrade.payload.affected.affected_figure_refs.includes(figureId) &&
  vocabUpgrade.payload.affected.affected_claim_refs.includes(claimId) &&
  orthoUpgrade.payload.affected.affected_run_refs.includes(runAId));

await expectCode("RUN_ANNOTATION_UPGRADED", () => registry.publishFigure({
  title: "基于旧注释的新插图",
  run_ref: runAId,
  embedding_ref: embeddingId,
  claim_refs: [],
}), "旧注释运行不得继续发布新图表");

/* ---------- 11. 来源撤回：只标记受影响运行与结论，历史仍可复查 ---------- */

const withdrawal = registry.withdrawSource(spongeId, {
  reason: "提供方 2026-09 复核撤回部分样本授权",
});
check("撤回只追加标记且不删除事件",
  withdrawal.payload.affected.affected_run_refs.includes(runAId) &&
  withdrawal.payload.affected.affected_figure_refs.includes(figureId) &&
  registry.events({ aggregateId: figureId }).length === 1);
check("撤回保留历史复查说明",
  withdrawal.payload.affected.retained_history_note.includes("可随时复查复跑"));

// 历史图表仍可被审查人员打开，溯源包自带撤回与升级警示
const packet = registry.figureProvenance(figureId, { auditor: true });
check("点开历史图表仍可取回完整溯源",
  packet.datasets.length === 4 &&
  packet.vocabulary.checksum.value === sha("vocab:v1").value &&
  packet.weights_checksum.value === sha("weights:runA").value);
check("图表溯源包同时承载撤回与注释升级标记",
  packet.markers.some((m) => m.kind === "source_withdrawn") &&
  packet.markers.some((m) => m.kind === "annotation_upgraded"));

await expectCode("RUN_SOURCE_WITHDRAWN", () => registry.publishModelCard({
  run_ref: runAId,
  embedding_ref: embeddingId,
  intended_uses: ["x"],
  out_of_scope_uses: ["y"],
}), "撤回运行不得发布新模型卡");

/* ---------- 12. 日志可重建（分片训练跨进程恢复的底座） ---------- */

const rebuilt = EventRegistry.replay(registry.exportLog());
check("事件日志可完整重建登记处", rebuilt.exportLog().length === registry.exportLog().length);
const rebuiltPacket = rebuilt.figureProvenance(figureId, { auditor: true });
check("重建后图表溯源一致", JSON.stringify(rebuiltPacket) === JSON.stringify(packet));

/* ---------- 13. 写出模型卡与图表溯源包 ---------- */

const cardData = registry.modelCardData(cardId, { auditor: true });
const reproCardData = registry.modelCardData(reproCardId, { auditor: true });
const outDir = join(dirname(fileURLToPath(import.meta.url)), "output");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "model-card-runA.json"), JSON.stringify(modelCardAsJson(cardData), null, 2) + "\n");
await writeFile(join(outDir, "model-card-runA.md"), modelCardAsMarkdown(cardData) + "\n");
await writeFile(join(outDir, "model-card-reproduction.md"), modelCardAsMarkdown(reproCardData) + "\n");
await writeFile(join(outDir, "figure3-provenance.md"), figureProvenanceAsMarkdown(packet) + "\n");

const failed = results.filter((x) => !x.ok);
console.log(`\n场景检查：${results.length - failed.length}/${results.length} 通过`);
console.log(`事件总数：${registry.exportLog().length}；产物目录：${outDir}`);
if (process.env.DUMP_LOG) {
  // 供契约校验工具消费：把 JSONL 形式的不可变事件日志写到 DUMP_LOG 指定路径。
  await writeFile(process.env.DUMP_LOG, registry.exportLog().map((e) => JSON.stringify(e)).join("\n") + "\n");
}
if (failed.length > 0) process.exitCode = 1;
