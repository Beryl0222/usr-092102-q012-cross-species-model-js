import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

const SHA = "a".repeat(64);
const base = {
  event_id: "e1",
  event_type: "DATASET_REGISTERED",
  aggregate_type: "dataset_release",
  aggregate_id: "d1",
  occurred_at: "2026-09-20T12:00:00+08:00",
  version: 1,
  summary: "x",
  payload: {
    lab: "L",
    tissue: "T",
    species: "S",
    consent: { basis: "explicit", secondary_use: false },
    quality_control: { status: "passed", checks: ["qc1"] },
    access: { tier: "open", restrictions: [] },
    content_sha256: SHA,
  },
};

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("信封必需字段缺失时报错", () => {
  assert.ok(validateEvent({}).length >= 7);
  assert.deepEqual(validateEvent({ ...base, version: 0 }).filter((e) => e.includes("version")), ["version 必须是正整数"]);
});

test("DATASET_REGISTERED 必须给齐实验室/组织/物种/同意/质控/访问", () => {
  const errors = validateEvent({ ...base, payload: { lab: "L" } });
  for (const f of ["tissue", "species", "consent", "quality_control", "access"]) {
    assert.ok(errors.some((e) => e.includes(f)), `应报告缺少 ${f}`);
  }
});

test("词表与同源组分别冻结，校验值必须是 sha256", () => {
  const vocab = {
    ...base,
    event_type: "VOCABULARY_FROZEN",
    aggregate_type: "gene_vocabulary",
    aggregate_id: "v1",
    payload: { name: "genes", version: "2018", content_sha256: SHA },
  };
  assert.deepEqual(validateEvent(vocab), []);
  assert.ok(validateEvent({ ...vocab, payload: { ...vocab.payload, content_sha256: "latest" } }).some((e) => e.includes("sha256")));

  const ortho = {
    ...base,
    event_type: "ORTHOLOG_FROZEN",
    aggregate_type: "ortholog_set",
    aggregate_id: "o1",
    payload: { name: "orth", version: "2018", content_sha256: SHA, species_covered: ["sponge"] },
  };
  assert.deepEqual(validateEvent(ortho), []);
  assert.ok(validateEvent({ ...ortho, payload: { ...ortho.payload, species_covered: [] } }).length > 0);
});

test("训练运行负载必须锁定配置/代码/权重校验值与分片数", () => {
  const run = {
    ...base,
    event_type: "RUN_REGISTERED",
    aggregate_type: "model_run",
    aggregate_id: "r1",
    payload: {
      project_id: "p1",
      dataset_ids: ["d1"],
      vocabulary_id: "v1",
      ortholog_set_id: "o1",
      embargo_until: "2027-01-01T00:00:00Z",
      training: { config_sha256: SHA, code_sha256: SHA, weights_sha256: "pending", shard_count: 4 },
    },
  };
  assert.deepEqual(validateEvent(run), []);
  assert.ok(validateEvent({ ...run, payload: { ...run.payload, training: { ...run.payload.training, shard_count: 0 } } }).some((e) => e.includes("shard_count")));
});

test("主张不能一记录就是 validated，验证必须给等级与证据", () => {
  const claim = {
    ...base,
    event_type: "CLAIM_RECORDED",
    aggregate_type: "biological_claim",
    aggregate_id: "c1",
    payload: { run_id: "r1", statement: "s", status: "exploratory_hint" },
  };
  assert.deepEqual(validateEvent(claim), []);
  assert.ok(validateEvent({ ...claim, payload: { ...claim.payload, status: "validated" } }).some((e) => e.includes("status")));

  const v = {
    ...base,
    event_type: "CLAIM_VALIDATED",
    aggregate_type: "biological_claim",
    aggregate_id: "c1",
    version: 2,
    payload: { validation_level: "wetlab_preregistered", evidence: [] },
  };
  assert.ok(validateEvent(v).some((e) => e.includes("evidence")));
});

test("图表发布必须 provenance=true 并引用词表/同源组/数据/主张", () => {
  const fig = {
    ...base,
    event_type: "FIGURE_PUBLISHED",
    aggregate_type: "figure",
    aggregate_id: "f1",
    payload: {
      run_ids: ["r1"],
      vocabulary_id: "v1",
      ortholog_set_id: "o1",
      dataset_ids: ["d1"],
      claim_ids: ["c1"],
      provenance: true,
    },
  };
  assert.deepEqual(validateEvent(fig), []);
  assert.ok(validateEvent({ ...fig, payload: { ...fig.payload, provenance: false } }).some((e) => e.includes("provenance")));
});

test("撤回/升级事件的 aggregate_type 必须等于 target_type", () => {
  const w = {
    ...base,
    event_type: "SOURCE_WITHDRAWN",
    aggregate_type: "gene_vocabulary",
    aggregate_id: "v1",
    payload: { target_type: "gene_vocabulary", target_id: "v1", reason: "撤稿" },
  };
  assert.deepEqual(validateEvent(w), []);
  assert.ok(validateEvent({ ...w, aggregate_type: "dataset_release" }).some((e) => e.includes("target_type")));
});

test("未知事件类型与时间格式被拒绝", () => {
  assert.ok(validateEvent({ ...base, event_type: "NOPE" }).some((e) => e.includes("event_type")));
  assert.ok(validateEvent({ ...base, occurred_at: "2026/09/20" }).some((e) => e.includes("occurred_at")));
});
