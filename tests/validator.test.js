import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { sha, ref } from "./fixtures.js";

function envelope(overrides = {}) {
  return {
    event_id: "evt-1",
    event_type: "DATASET_REGISTERED",
    aggregate_type: "dataset_release",
    aggregate_id: "dataset-1",
    occurred_at: "2026-09-15T08:00:00.000Z",
    version: 1,
    summary: "测试事件",
    payload: {},
    ...overrides,
  };
}

test("信封缺字段逐个报错", () => {
  const errors = validateEvent({ event_id: "x" });
  for (const field of ["event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"]) {
    assert.ok(errors.some((e) => e.includes(field)), `应报告缺少 ${field}`);
  }
});

test("未知信封字段被拒绝", () => {
  const errors = validateEvent(envelope({ rogue_field: 1 }));
  assert.ok(errors.some((e) => e.includes("rogue_field")));
});

test("version 必须为正整数", () => {
  assert.ok(validateEvent(envelope({ version: 0 })).some((e) => e.includes("version")));
  assert.ok(validateEvent(envelope({ version: 1.5 })).some((e) => e.includes("version")));
});

test("事件类型与聚合类型不匹配被拒绝", () => {
  const errors = validateEvent(
    envelope({ event_type: "VOCABULARY_FROZEN", aggregate_type: "dataset_release" })
  );
  assert.ok(errors.some((e) => e.includes("不能作用于聚合")));
});

test("训练注册与分片回调强制幂等键", () => {
  const runEvent = envelope({
    event_type: "RUN_REGISTERED",
    aggregate_type: "model_run",
    payload: {},
  });
  assert.ok(validateEvent(runEvent).some((e) => e.includes("idempotency_key")));

  const shardEvent = envelope({
    event_type: "SHARD_PROGRESSED",
    aggregate_type: "model_run",
    payload: {},
  });
  assert.ok(validateEvent(shardEvent).some((e) => e.includes("idempotency_key")));
});

test("DATASET_REGISTERED 载荷全字段校验", () => {
  const valid = envelope({
    payload: {
      lab: "L",
      species: { scientific_name: "Homo sapiens" },
      tissue: "血",
      sample_consent: "controlled_access",
      human_subject: true,
      access_tier: "controlled",
      quality_control: { passed: true, checks: ["qc"] },
      checksum: sha("d"),
    },
  });
  assert.deepEqual(validateEvent(valid), []);

  const missing = envelope({ payload: { lab: "L" } });
  const errors = validateEvent(missing);
  for (const key of ["species", "tissue", "sample_consent", "human_subject", "access_tier", "quality_control", "checksum"]) {
    assert.ok(errors.some((e) => e.includes(key)), `应报告缺少 ${key}`);
  }
});

test("人类受试者数据不得登记为公开", () => {
  const errors = validateEvent(
    envelope({
      payload: {
        lab: "L",
        species: { scientific_name: "Homo sapiens" },
        tissue: "血",
        sample_consent: "controlled_access",
        human_subject: true,
        access_tier: "public",
        quality_control: { passed: true, checks: [] },
        checksum: sha("d"),
      },
    })
  );
  assert.ok(errors.some((e) => e.includes("人类原始数据")));
});

test("非法校验值格式被拒绝", () => {
  const errors = validateEvent(
    envelope({
      payload: {
        lab: "L",
        species: { scientific_name: "A" },
        tissue: "t",
        sample_consent: "unrestricted_research",
        human_subject: false,
        access_tier: "public",
        quality_control: { passed: true, checks: [] },
        checksum: { algorithm: "sha256", value: "not-a-hash" },
      },
    })
  );
  assert.ok(errors.some((e) => e.includes("sha256")));
});

test("CLAIM_RECORDED 只能以 exploratory 入库", () => {
  const base = {
    event_type: "CLAIM_RECORDED",
    aggregate_type: "biological_claim",
  };
  const ok = validateEvent(
    envelope({ ...base, payload: { embedding_ref: "emb-1", statement: "s", validation_level: "exploratory", recorded_by: "lab" } })
  );
  assert.deepEqual(ok, []);
  const bad = validateEvent(
    envelope({ ...base, payload: { embedding_ref: "emb-1", statement: "s", validation_level: "experimental_validation", recorded_by: "lab" } })
  );
  assert.ok(bad.some((e) => e.includes("exploratory")));
});

test("CLAIM_VALIDATED 不允许停留在 exploratory", () => {
  const errors = validateEvent(
    envelope({
      event_type: "CLAIM_VALIDATED",
      aggregate_type: "biological_claim",
      payload: {
        new_level: "exploratory",
        method: "m",
        validated_by: { lab: "l", independent: true },
        validated_at: "2026-09-15T08:00:00Z",
        evidence: { description: "e" },
      },
    })
  );
  assert.ok(errors.some((e) => e.includes("exploratory 以上")));
});

test("FIGURE_PUBLISHED 载荷必须内嵌完整溯源校验值", () => {
  const errors = validateEvent(
    envelope({
      event_type: "FIGURE_PUBLISHED",
      aggregate_type: "figure",
      payload: {
        title: "图1",
        run_ref: "run-1",
        embedding_ref: "emb-1",
        claim_refs: [],
        provenance: {},
        validation_level: "exploratory",
      },
    })
  );
  for (const key of ["analysis_ref", "dataset_refs", "vocabulary_ref", "orthology_ref", "config_checksum", "code_checksum", "weights_checksum", "embedding_checksum"]) {
    assert.ok(errors.some((e) => e.includes(key)), `应报告溯源缺少 ${key}`);
  }
});

test("载荷未知字段被拒绝", () => {
  const errors = validateEvent(
    envelope({
      payload: {
        lab: "L",
        species: { scientific_name: "A" },
        tissue: "t",
        sample_consent: "unknown",
        human_subject: false,
        access_tier: "public",
        quality_control: { passed: false, checks: [] },
        checksum: sha("d"),
        surprise: 42,
      },
    })
  );
  assert.ok(errors.some((e) => e.includes("surprise")));
});

test("同源组引用必须是引用数组", () => {
  const errors = validateEvent(
    envelope({
      event_type: "ORTHOLOGY_FROZEN",
      aggregate_type: "orthology_set",
      payload: {
        name: "o",
        mapping_version: "v1",
        source: "compara",
        frozen_at: "2026-09-15T08:00:00Z",
        checksum: sha("o"),
        vocabulary_refs: [ref("gene_vocabulary", "vocab-1")],
      },
    })
  );
  assert.deepEqual(errors, []);
  const bad = validateEvent(
    envelope({
      event_type: "ORTHOLOGY_FROZEN",
      aggregate_type: "orthology_set",
      payload: {
        name: "o",
        mapping_version: "v1",
        source: "compara",
        frozen_at: "2026-09-15T08:00:00Z",
        checksum: sha("o"),
        vocabulary_refs: [],
      },
    })
  );
  assert.ok(bad.some((e) => e.includes("vocabulary_refs")));
});
