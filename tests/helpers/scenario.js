/**
 * 构造“海绵 / 线虫 / 青蛙 / 人类细胞同一嵌入空间”的标准测试场景。
 * 供 registry.test.js 与演示脚本复用。
 */
import { EventStore } from "../../src/store/event-store.js";
import { Registry } from "../../src/registry.js";

export const SHA = (ch) => ch.repeat(64);
/** 用非负整数生成确定的合法 64 位十六进制校验值。 */
export const HEX = (n) => n.toString(16).padStart(64, "0");

export function makeRegistry(StoreOrFile = undefined) {
  const store = StoreOrFile instanceof EventStore ? StoreOrFile : new EventStore(StoreOrFile);
  return { store, registry: new Registry(store) };
}

export const ACTORS = {
  marine: { agent: "li.researcher", lab: "海洋比较生物学实验室" },
  comp: { agent: "wang.researcher", lab: "比较基因组学实验室" },
  dac: { agent: "dac@institute", lab: "数据访问委员会" },
  rival: { agent: "kim.researcher", lab: "竞争实验室" },
};

/**
 * 登记四个物种数据集 + 冻结旧版词表/同源组。
 * 返回固定 id，便于断言。
 */
export function seedDatasetsAndVocab(registry) {
  const sponge = registry.registerDataset(
    {
      id: "ds-sponge-2018",
      lab: "海洋比较生物学实验室",
      tissue: "成体中胶层解离细胞",
      species: "Amphimedon queenslandica",
      human_raw_data: false,
      consent: { basis: "broad", secondary_use: true, documents: ["MTA-2018-07"] },
      quality_control: { status: "passed", checks: ["doublet_removal", "min_genes_500"] },
      access: { tier: "open", restrictions: [] },
      source_uri: "s3://registry/datasets/sponge-2018.h5ad",
      content_sha256: SHA("1"),
    },
    ACTORS.marine
  ).aggregate_id;

  const worm = registry.registerDataset(
    {
      id: "ds-worm-2018",
      lab: "模式动物中心",
      tissue: "L1 幼虫全虫",
      species: "Caenorhabditis elegans",
      consent: { basis: "broad", secondary_use: true },
      quality_control: { status: "passed", checks: ["min_genes_300"] },
      access: { tier: "open", restrictions: [] },
      content_sha256: SHA("2"),
    },
    ACTORS.comp
  ).aggregate_id;

  const frog = registry.registerDataset(
    {
      id: "ds-frog-2018",
      lab: "发育生物学实验室",
      tissue: "囊胚期胚胎",
      species: "Xenopus tropicalis",
      consent: { basis: "broad", secondary_use: true },
      quality_control: { status: "flagged", checks: ["batch_effect_noted"], notes: "两批次混样" },
      access: { tier: "open", restrictions: [] },
      content_sha256: SHA("3"),
    },
    ACTORS.comp
  ).aggregate_id;

  const human = registry.registerDataset(
    {
      id: "ds-human-controlled",
      lab: "人类细胞图谱合作组",
      tissue: "外周血单个核细胞",
      species: "Homo sapiens",
      human_raw_data: true,
      consent: { basis: "explicit", secondary_use: false, documents: ["ICFR-HCA-2019"] },
      quality_control: { status: "passed", checks: ["doublet_removal", "ambient_rna"] },
      access: { tier: "restricted", restrictions: ["禁止再识别", "仅限授权项目", "不得流出受控环境"] },
      content_sha256: SHA("4"),
    },
    ACTORS.marine
  ).aggregate_id;

  const vocab2018 = registry.freezeVocabulary(
    {
      id: "vocab-paper-2018",
      name: "paper-gene-table",
      version: "2018-03",
      content_sha256: SHA("5"),
      source_uri: "s3://registry/vocab/paper-2018.tsv",
      entry_count: 21042,
    },
    ACTORS.marine
  ).aggregate_id;

  const ortho2018 = registry.freezeOrthologSet(
    {
      id: "ortho-paper-2018",
      name: "paper-ortholog-map",
      version: "2018-03",
      content_sha256: SHA("6"),
      species_covered: ["Amphimedon queenslandica", "Caenorhabditis elegans", "Xenopus tropicalis", "Homo sapiens"],
      group_count: 8811,
    },
    ACTORS.marine
  ).aggregate_id;

  const ortho2026 = registry.freezeOrthologSet(
    {
      id: "ortho-latest-2026",
      name: "paper-ortholog-map",
      version: "2026-09",
      content_sha256: SHA("7"),
      species_covered: ["Amphimedon queenslandica", "Caenorhabditis elegans", "Xenopus tropicalis", "Homo sapiens"],
      group_count: 9407,
    },
    ACTORS.comp
  ).aggregate_id;

  return { sponge, worm, frog, human, vocab2018, ortho2018, ortho2026 };
}

export const trainingSpec = (weights = "pending") => ({
  config_sha256: SHA("8"),
  code_sha256: SHA("9"),
  weights_sha256: weights,
  shard_count: 4,
});
