/**
 * 端到端演示：海绵 / 线虫 / 青蛙 / 人类细胞同一嵌入空间。
 *
 * 运行：node examples/demo.mjs
 * 全部状态承接 contracts/domain.schema.json 的统一事件信封；
 * 这里使用内存 EventStore，换成 new EventStore("events.jsonl") 即可持久化、跨进程重放。
 */
import { EventStore } from "../src/store/event-store.js";
import { Registry } from "../src/registry.js";
import { project, visibleOverview } from "../src/projections.js";
import { buildModelCard, resolveFigure } from "../src/model-card.js";

const SHA = (ch) => ch.repeat(64);
const HEX = (n) => n.toString(16).padStart(64, "0");
const ACTORS = {
  marine: { agent: "li.researcher", lab: "海洋比较生物学实验室" },
  comp: { agent: "wang.researcher", lab: "比较基因组学实验室" },
  dac: { agent: "dac@institute", lab: "数据访问委员会" },
  rival: { agent: "kim.researcher", lab: "竞争实验室" },
};

const registry = new Registry(new EventStore());
const log = (title, extra = "") => {
  console.log(`\n=== ${title} ===${extra ? "\n" + extra : ""}`);
};

// 1. 先登记：四个物种数据集，人类数据为受控层 -------------------------------
const sponge = registry.registerDataset(
  {
    id: "ds-sponge-2018", lab: "海洋比较生物学实验室", tissue: "成体中胶层解离细胞",
    species: "Amphimedon queenslandica", human_raw_data: false,
    consent: { basis: "broad", secondary_use: true, documents: ["MTA-2018-07"] },
    quality_control: { status: "passed", checks: ["doublet_removal", "min_genes_500"] },
    access: { tier: "open", restrictions: [] }, content_sha256: SHA("1"),
  }, ACTORS.marine).aggregate_id;
const worm = registry.registerDataset(
  {
    id: "ds-worm-2018", lab: "模式动物中心", tissue: "L1 幼虫全虫", species: "Caenorhabditis elegans",
    consent: { basis: "broad", secondary_use: true },
    quality_control: { status: "passed", checks: ["min_genes_300"] },
    access: { tier: "open", restrictions: [] }, content_sha256: SHA("2"),
  }, ACTORS.comp).aggregate_id;
const frog = registry.registerDataset(
  {
    id: "ds-frog-2018", lab: "发育生物学实验室", tissue: "囊胚期胚胎", species: "Xenopus tropicalis",
    consent: { basis: "broad", secondary_use: true },
    quality_control: { status: "flagged", checks: ["batch_effect_noted"], notes: "两批次混样" },
    access: { tier: "open", restrictions: [] }, content_sha256: SHA("3"),
  }, ACTORS.comp).aggregate_id;
const human = registry.registerDataset(
  {
    id: "ds-human-controlled", lab: "人类细胞图谱合作组", tissue: "外周血单个核细胞", species: "Homo sapiens",
    human_raw_data: true,
    consent: { basis: "explicit", secondary_use: false, documents: ["ICFR-HCA-2019"] },
    quality_control: { status: "passed", checks: ["doublet_removal", "ambient_rna"] },
    access: { tier: "restricted", restrictions: ["禁止再识别", "仅限授权项目", "不得流出受控环境"] },
    content_sha256: SHA("4"),
  }, ACTORS.marine).aggregate_id;
log("1. 数据集先登记（实验室/组织/物种/同意/质控/访问）", `海绵 ${sponge}、线虫 ${worm}、青蛙 ${frog}、人类 ${human}（restricted）`);

// 2. 词表与同源组单独冻结：论文版 + 复现者只能拿到的 2026 版 ------------------
const vocab2018 = registry.freezeVocabulary(
  { id: "vocab-paper-2018", name: "paper-gene-table", version: "2018-03", content_sha256: SHA("5"), entry_count: 21042 },
  ACTORS.marine).aggregate_id;
const ortho2018 = registry.freezeOrthologSet(
  { id: "ortho-paper-2018", name: "paper-ortholog-map", version: "2018-03", content_sha256: SHA("6"), species_covered: ["sponge", "worm", "frog", "human"], group_count: 8811 },
  ACTORS.marine).aggregate_id;
const ortho2026 = registry.freezeOrthologSet(
  { id: "ortho-latest-2026", name: "paper-ortholog-map", version: "2026-09", content_sha256: SHA("7"), species_covered: ["sponge", "worm", "frog", "human"], group_count: 9407 },
  ACTORS.comp).aggregate_id;
log("2. 基因词表与同源组分别冻结", `论文词表 ${vocab2018}；论文同源组 ${ortho2018}；最新同源组 ${ortho2026}`);

// 3. 人类原始数据授权闸门 -----------------------------------------------------
try {
  registry.registerRun(
    { idempotency_key: "will-fail", project_id: "proj-paper", dataset_ids: [sponge, human], vocabulary_id: vocab2018, ortholog_set_id: ortho2018, training: { config_sha256: SHA("8"), code_sha256: SHA("9"), weights_sha256: "pending", shard_count: 4 }, embargo_until: "2027-12-31T00:00:00Z" },
    ACTORS.comp);
} catch (e) {
  log("3. 无 raw 授权被闸门拦截", e.message);
}
registry.grantAccess(
  { id: "grant-human-paper", dataset_id: human, project_id: "proj-paper", scope: "raw", granted_by: "数据访问委员会", expires_at: "2029-01-01T00:00:00Z" },
  ACTORS.dac);
log("3b. DAC 登记 raw 授权（批准方+到期边界）", "grant-human-paper");

// 4. 幂等登记论文运行：训练回调被投递两次 -------------------------------------
const runInput = {
  run_id: "run-paper-2018", idempotency_key: "train-callback-7f3a", project_id: "proj-paper",
  dataset_ids: [sponge, worm, frog, human], vocabulary_id: vocab2018, ortholog_set_id: ortho2018,
  training: { config_sha256: SHA("8"), code_sha256: SHA("9"), weights_sha256: "pending", shard_count: 4 },
  embargo_until: "2027-12-31T00:00:00Z",
  expected_species: ["Amphimedon queenslandica", "Caenorhabditis elegans", "Xenopus tropicalis", "Homo sapiens"],
};
const r1 = registry.registerRun(runInput, ACTORS.comp);
const r2 = registry.registerRun(runInput, ACTORS.comp); // 重复回调
log("4. 训练运行幂等登记", `两次回调事件 id 相同：${r1.event_id === r2.event_id}，运行只有一个：${r1.aggregate_id}`);

// 5. 长训练分片恢复：0、2 完成后“重启”，按 resumePlan 续 1、3 -----------------
registry.recordCheckpoint("run-paper-2018", { shard_index: 0, shard_count: 4, checkpoint_sha256: HEX(100), metrics: { loss: 0.91 } }, ACTORS.comp);
registry.recordCheckpoint("run-paper-2018", { shard_index: 2, shard_count: 4, checkpoint_sha256: HEX(102) }, ACTORS.comp);
const plan = registry.resumePlan("run-paper-2018");
log("5. 长训练从检查点恢复（不新建运行）", `剩余分片：${JSON.stringify(plan.remaining_shards)}`);
for (const i of plan.remaining_shards) {
  registry.recordCheckpoint("run-paper-2018", { shard_index: i, shard_count: 4, checkpoint_sha256: HEX(200 + i) }, ACTORS.comp);
}
registry.completeRun("run-paper-2018", { final_weights_sha256: HEX(900), metrics: { loss: 0.18 } }, ACTORS.comp);
log("5b. 分片补齐，运行完成", `最终权重 sha256=${HEX(900).slice(0, 16)}…`);

// 6. 嵌入结果与主张严格分列：合作方误把相似性写成“已验证事实” ----------------
const emb = registry.publishEmbedding(
  { run_id: "run-paper-2018", artifact_sha256: HEX(800), status: "frozen", species_covered: ["sponge", "worm", "frog", "human"] },
  ACTORS.comp).aggregate_id;
const claim = registry.recordClaim(
  { run_id: "run-paper-2018", embedding_id: emb, statement: "海绵领细胞与人类小胶质细胞在嵌入空间邻近，功能同源", status: "exploratory_hint" },
  ACTORS.comp).aggregate_id;
log("6. 嵌入相似性只能先登记为探索线索", claim);

// 7. 保密期内竞争实验室并存提交 ------------------------------------------------
registry.registerRun(
  { run_id: "run-rival-embargo", idempotency_key: "rival-1", project_id: "proj-rival",
    dataset_ids: [sponge, worm], vocabulary_id: vocab2018, ortholog_set_id: ortho2018,
    training: { config_sha256: SHA("8"), code_sha256: SHA("9"), weights_sha256: "pending", shard_count: 2 },
    embargo_until: "2027-12-31T00:00:00Z" },
  ACTORS.rival);
const ovNow = project(registry.store.allEvents());
const rivalView = visibleOverview(ovNow, { project_id: "proj-paper" }, new Date("2026-10-03T00:00:00Z"));
log("7. 保密期竞争结果并存", `登记处全局运行数：${ovNow.runs.size}；论文项目此刻能看到的运行：${[...rivalView.runs.keys()].join(", ")}`);

// 8. 复现者拿不到 2018 词表语境，只能用 2026 同源映射重跑 ---------------------
const repro = registry.registerRun(
  { run_id: "run-repro-2026", idempotency_key: "repro-1", project_id: "proj-paper",
    dataset_ids: [sponge, worm, frog, human], vocabulary_id: vocab2018, ortholog_set_id: ortho2026,
    training: { config_sha256: SHA("8"), code_sha256: SHA("9"), weights_sha256: HEX(950), shard_count: 4, resume_from_run: "run-paper-2018" },
    embargo_until: "2000-01-01T00:00:00Z" },
  ACTORS.comp).aggregate_id;
log("8. 复现实验用最新同源映射重跑（与旧运行并存）", repro);

// 9. 来源撤回 / 注释升级：只标记受影响运行，历史不删 --------------------------
registry.flagSource(
  { kind: "withdrawn", target_type: "gene_vocabulary", target_id: vocab2018, reason: "论文撤稿：2018 词表映射错误且原始词表不可复原" },
  ACTORS.marine);
registry.flagSource(
  { kind: "upgraded", target_type: "ortholog_set", target_id: ortho2018, reason: "2026 版修正一因多效映射并新增 596 组", new_version_id: ortho2026 },
  ACTORS.comp);
const ov = project(registry.store.allEvents());
log("9. 撤回 + 注释升级",
  `旧运行受影响标记：${ov.runs.get("run-paper-2018").impact_flags.map((f) => f.kind).join(", ")}；` +
  `复现运行（已用 2026 版）升级标记：${ov.runs.get("run-repro-2026").impact_flags.filter((f) => f.kind === "upgraded").length}；` +
  `历史事件总数仍完整：${registry.store.allEvents().length}`);

// 10. 论文图表发布；点开即取词表/数据/配置/验证等级 ---------------------------
const figure = registry.publishFigure(
  { run_ids: ["run-paper-2018"], vocabulary_id: vocab2018, ortholog_set_id: ortho2018,
    dataset_ids: [sponge, worm, frog, human], claim_ids: [claim], embedding_ids: [emb] },
  ACTORS.comp).aggregate_id;
const pack = resolveFigure(project(registry.store.allEvents()), figure);
log("10. 图表溯源包（点开图表即得）",
  `词表=${pack.vocabulary.version}(${pack.vocabulary.content_sha256.slice(0, 12)}…) ` +
  `同源组=${pack.ortholog_set.version} 数据=${pack.datasets.map((d) => d.species).join("/")} ` +
  `配置=${pack.runs[0].config_sha256.slice(0, 12)}… ` +
  `主张状态=${pack.claims[0].status} 验证等级=${pack.claims[0].validation_level ?? "无"} ` +
  `警告=${pack.impact_flags.map((f) => f.kind).join(",") || "无"}`);

// 11. 模型卡：足以复现并判断适用边界 ------------------------------------------
const card = buildModelCard(project(registry.store.allEvents()), "run-paper-2018", {
  known_limits: ["青蛙数据为 flagged 质控（两批次混样），跨物种结论对批次效应敏感"],
});
registry.publishModelCard("run-paper-2018", { known_limits: card.applicability.known_limits }, ACTORS.comp);
log("11. 模型卡（MODEL_CARD_PUBLISHED 已落账，亦可随时由事件流重算）");
console.log(JSON.stringify(card, null, 2));
