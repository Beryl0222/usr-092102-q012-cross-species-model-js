import {
  ACCESS_SCOPES,
  ACCESS_TIERS,
  AGGREGATE_TYPES,
  ANNOTATION_TARGETS,
  CONSENT_BASES,
  EMBEDDING_STATUSES,
  EVENT_AGGREGATE,
  EVENT_TYPES,
  QC_STATUSES,
  VALIDATION_LEVELS,
  domainEventFields,
} from "./domain.js";

const SHA256 = /^[0-9a-f]{64}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function requireFields(errors, prefix, obj, fields) {
  for (const f of fields) if (!(f in obj)) errors.push(`${prefix}缺少字段：${f}`);
}

function checkString(errors, path, value, { nonEmpty = false, enumValues = null, pattern = null } = {}) {
  if (typeof value !== "string") {
    errors.push(`${path}必须是字符串`);
    return;
  }
  if (nonEmpty && value.length === 0) errors.push(`${path}不得为空`);
  if (enumValues && !enumValues.includes(value)) errors.push(`${path}取值非法：${value}（允许 ${enumValues.join(" / ")}）`);
  if (pattern && !pattern.test(value)) errors.push(`${path}不符合格式：${value}`);
}

/**
 * 校验一条领域事件。
 * 与 contracts/domain.schema.json 的条件分支保持等价（无第三方依赖，便于离线运行）。
 * @returns {string[]} 错误信息列表，空数组表示通过。
 */
export function validateEvent(record) {
  const errors = [];
  if (!isObject(record)) return ["事件必须是对象"];

  requireFields(errors, "", record, domainEventFields);

  if ("event_id" in record) checkString(errors, "event_id", record.event_id, { nonEmpty: true });
  if ("event_type" in record) checkString(errors, "event_type", record.event_type, { enumValues: EVENT_TYPES });
  if ("aggregate_type" in record) checkString(errors, "aggregate_type", record.aggregate_type, { enumValues: AGGREGATE_TYPES });
  if ("aggregate_id" in record) checkString(errors, "aggregate_id", record.aggregate_id, { nonEmpty: true });
  if ("occurred_at" in record) checkString(errors, "occurred_at", record.occurred_at, { pattern: DATE_TIME });
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("summary" in record) checkString(errors, "summary", record.summary, { nonEmpty: true });
  if ("idempotency_key" in record) checkString(errors, "idempotency_key", record.idempotency_key, { nonEmpty: true });
  if ("actor" in record) {
    if (!isObject(record.actor) || typeof record.actor.agent !== "string" || record.actor.agent.length === 0) {
      errors.push("actor.agent 必须是非空字符串");
    }
  }

  if (!isObject(record.payload)) {
    errors.push("payload 必须是对象");
    return errors;
  }

  const p = record.payload;
  const P = "payload.";
  const sha = (field, allowPending = false) => {
    if (field in p) checkString(errors, P + field, p[field], { pattern: allowPending ? null : SHA256 });
    if (allowPending && field in p && p[field] !== "pending" && !SHA256.test(p[field])) {
      errors.push(`${P + field}必须是 64 位十六进制校验值或 "pending"`);
    }
  };

  switch (record.event_type) {
    case "DATASET_REGISTERED": {
      if (record.aggregate_type !== "dataset_release") errors.push("DATASET_REGISTERED 的 aggregate_type 必须是 dataset_release");
      requireFields(errors, P, p, ["lab", "tissue", "species", "consent", "quality_control", "access"]);
      for (const f of ["lab", "tissue", "species"]) if (f in p) checkString(errors, P + f, p[f], { nonEmpty: true });
      if (isObject(p.consent)) {
        requireFields(errors, P + "consent.", p.consent, ["basis", "secondary_use"]);
        if ("basis" in p.consent) checkString(errors, P + "consent.basis", p.consent.basis, { enumValues: CONSENT_BASES });
        if ("secondary_use" in p.consent && typeof p.consent.secondary_use !== "boolean") errors.push(P + "consent.secondary_use 必须是布尔值");
      } else if ("consent" in p) errors.push(P + "consent 必须是对象");
      if (isObject(p.quality_control)) {
        requireFields(errors, P + "quality_control.", p.quality_control, ["status", "checks"]);
        if ("status" in p.quality_control) checkString(errors, P + "quality_control.status", p.quality_control.status, { enumValues: QC_STATUSES });
        if ("checks" in p.quality_control && !Array.isArray(p.quality_control.checks)) errors.push(P + "quality_control.checks 必须是数组");
      } else if ("quality_control" in p) errors.push(P + "quality_control 必须是对象");
      if (isObject(p.access)) {
        requireFields(errors, P + "access.", p.access, ["tier", "restrictions"]);
        if ("tier" in p.access) checkString(errors, P + "access.tier", p.access.tier, { enumValues: ACCESS_TIERS });
        if ("restrictions" in p.access && !Array.isArray(p.access.restrictions)) errors.push(P + "access.restrictions 必须是数组");
      } else if ("access" in p) errors.push(P + "access 必须是对象");
      if ("human_raw_data" in p && typeof p.human_raw_data !== "boolean") errors.push(P + "human_raw_data 必须是布尔值");
      if ("content_sha256" in p) sha("content_sha256");
      break;
    }
    case "VOCABULARY_FROZEN":
    case "ORTHOLOG_FROZEN": {
      const want = record.event_type === "VOCABULARY_FROZEN" ? "gene_vocabulary" : "ortholog_set";
      if (record.aggregate_type !== want) errors.push(`${record.event_type} 的 aggregate_type 必须是 ${want}`);
      requireFields(errors, P, p, ["name", "version", "content_sha256"]);
      for (const f of ["name", "version"]) if (f in p) checkString(errors, P + f, p[f], { nonEmpty: true });
      if ("content_sha256" in p) sha("content_sha256");
      if (record.event_type === "ORTHOLOG_FROZEN") {
        requireFields(errors, P, p, ["species_covered"]);
        if ("species_covered" in p && (!Array.isArray(p.species_covered) || p.species_covered.length === 0)) {
          errors.push(P + "species_covered 必须是非空数组");
        }
      }
      break;
    }
    case "ACCESS_GRANTED": {
      if (record.aggregate_type !== "access_grant") errors.push("ACCESS_GRANTED 的 aggregate_type 必须是 access_grant");
      requireFields(errors, P, p, ["dataset_id", "project_id", "scope", "granted_by"]);
      for (const f of ["dataset_id", "project_id", "granted_by"]) if (f in p) checkString(errors, P + f, p[f], { nonEmpty: true });
      if ("scope" in p) checkString(errors, P + "scope", p.scope, { enumValues: ACCESS_SCOPES });
      break;
    }
    case "RUN_REGISTERED": {
      if (record.aggregate_type !== "model_run") errors.push("RUN_REGISTERED 的 aggregate_type 必须是 model_run");
      requireFields(errors, P, p, ["project_id", "dataset_ids", "vocabulary_id", "ortholog_set_id", "training", "embargo_until"]);
      if ("dataset_ids" in p && (!Array.isArray(p.dataset_ids) || p.dataset_ids.length === 0)) errors.push(P + "dataset_ids 必须是非空数组");
      if ("embargo_until" in p) checkString(errors, P + "embargo_until", p.embargo_until, { pattern: DATE_TIME });
      if (isObject(p.training)) {
        requireFields(errors, P + "training.", p.training, ["config_sha256", "code_sha256", "weights_sha256", "shard_count"]);
        for (const f of ["config_sha256", "code_sha256"]) if (f in p.training) checkString(errors, P + `training.${f}`, p.training[f], { pattern: SHA256 });
        if ("weights_sha256" in p.training && p.training.weights_sha256 !== "pending" && !SHA256.test(p.training.weights_sha256)) {
          errors.push(P + 'training.weights_sha256 必须是校验值或 "pending"');
        }
        if ("shard_count" in p.training && (!Number.isInteger(p.training.shard_count) || p.training.shard_count < 1)) {
          errors.push(P + "training.shard_count 必须是 ≥1 的整数");
        }
      } else if ("training" in p) errors.push(P + "training 必须是对象");
      break;
    }
    case "CHECKPOINT_RECORDED": {
      if (record.aggregate_type !== "model_run") errors.push("CHECKPOINT_RECORDED 的 aggregate_type 必须是 model_run");
      requireFields(errors, P, p, ["shard_index", "shard_count", "checkpoint_sha256"]);
      if ("shard_index" in p && (!Number.isInteger(p.shard_index) || p.shard_index < 0)) errors.push(P + "shard_index 必须是 ≥0 的整数");
      if ("shard_count" in p && (!Number.isInteger(p.shard_count) || p.shard_count < 1)) errors.push(P + "shard_count 必须是 ≥1 的整数");
      if (Number.isInteger(p.shard_index) && Number.isInteger(p.shard_count) && p.shard_index >= p.shard_count) {
        errors.push(P + "shard_index 必须小于 shard_count");
      }
      if ("checkpoint_sha256" in p) sha("checkpoint_sha256");
      break;
    }
    case "RUN_COMPLETED":
    case "RUN_FAILED": {
      if (record.aggregate_type !== "model_run") errors.push(`${record.event_type} 的 aggregate_type 必须是 model_run`);
      requireFields(errors, P, p, ["final_weights_sha256"]);
      if ("final_weights_sha256" in p) checkString(errors, P + "final_weights_sha256", p.final_weights_sha256, { nonEmpty: true });
      break;
    }
    case "EMBEDDING_PUBLISHED": {
      if (record.aggregate_type !== "embedding") errors.push("EMBEDDING_PUBLISHED 的 aggregate_type 必须是 embedding");
      requireFields(errors, P, p, ["run_id", "artifact_sha256", "status"]);
      if ("run_id" in p) checkString(errors, P + "run_id", p.run_id, { nonEmpty: true });
      if ("artifact_sha256" in p) sha("artifact_sha256");
      if ("status" in p) checkString(errors, P + "status", p.status, { enumValues: EMBEDDING_STATUSES });
      break;
    }
    case "CLAIM_RECORDED": {
      if (record.aggregate_type !== "biological_claim") errors.push("CLAIM_RECORDED 的 aggregate_type 必须是 biological_claim");
      requireFields(errors, P, p, ["run_id", "statement", "status"]);
      if ("run_id" in p) checkString(errors, P + "run_id", p.run_id, { nonEmpty: true });
      if ("statement" in p) checkString(errors, P + "statement", p.statement, { nonEmpty: true });
      if ("status" in p) checkString(errors, P + "status", p.status, { enumValues: ["exploratory_hint", "proposed"] });
      break;
    }
    case "CLAIM_VALIDATED": {
      if (record.aggregate_type !== "biological_claim") errors.push("CLAIM_VALIDATED 的 aggregate_type 必须是 biological_claim");
      requireFields(errors, P, p, ["validation_level", "evidence"]);
      if ("validation_level" in p) checkString(errors, P + "validation_level", p.validation_level, { enumValues: VALIDATION_LEVELS });
      if ("evidence" in p && (!Array.isArray(p.evidence) || p.evidence.length === 0)) errors.push(P + "evidence 必须是非空数组");
      break;
    }
    case "CLAIM_DEMOTED": {
      if (record.aggregate_type !== "biological_claim") errors.push("CLAIM_DEMOTED 的 aggregate_type 必须是 biological_claim");
      requireFields(errors, P, p, ["to_status", "reason"]);
      if ("to_status" in p) checkString(errors, P + "to_status", p.to_status, { enumValues: ["exploratory_hint", "proposed", "refuted"] });
      if ("reason" in p) checkString(errors, P + "reason", p.reason, { nonEmpty: true });
      break;
    }
    case "SOURCE_WITHDRAWN":
    case "ANNOTATION_UPGRADED": {
      requireFields(errors, P, p, ["target_type", "target_id", "reason"]);
      if ("target_type" in p) checkString(errors, P + "target_type", p.target_type, { enumValues: ANNOTATION_TARGETS });
      if ("target_id" in p) checkString(errors, P + "target_id", p.target_id, { nonEmpty: true });
      if ("reason" in p) checkString(errors, P + "reason", p.reason, { nonEmpty: true });
      if (record.aggregate_type !== p.target_type) {
        errors.push(`${record.event_type} 的 aggregate_type 必须等于 payload.target_type（${p.target_type}）`);
      }
      break;
    }
    case "FIGURE_PUBLISHED": {
      if (record.aggregate_type !== "figure") errors.push("FIGURE_PUBLISHED 的 aggregate_type 必须是 figure");
      requireFields(errors, P, p, ["run_ids", "vocabulary_id", "ortholog_set_id", "dataset_ids", "claim_ids", "provenance"]);
      if (p.provenance !== true) errors.push(P + "provenance 必须为 true：图表发布即承诺可溯源");
      for (const f of ["run_ids", "dataset_ids", "claim_ids"]) if (f in p && !Array.isArray(p[f])) errors.push(P + f + " 必须是数组");
      break;
    }
    case "MODEL_CARD_PUBLISHED": {
      if (record.aggregate_type !== "model_card") errors.push("MODEL_CARD_PUBLISHED 的 aggregate_type 必须是 model_card");
      requireFields(errors, P, p, ["run_id", "reproducibility", "validation_summary", "applicability"]);
      if (isObject(p.applicability)) {
        requireFields(errors, P + "applicability.", p.applicability, ["species_scope", "known_limits"]);
        if ("known_limits" in p.applicability && (!Array.isArray(p.applicability.known_limits) || p.applicability.known_limits.length === 0)) {
          errors.push(P + "applicability.known_limits 必须是非空数组");
        }
      } else if ("applicability" in p) errors.push(P + "applicability 必须是对象");
      break;
    }
    default:
      // event_type 非法已在上面记录
  }

  // 聚合类型与事件类型的静态归属一致性（撤回/升级除外，已单独校验）
  const expected = EVENT_AGGREGATE[record.event_type];
  if (expected && record.aggregate_type && record.aggregate_type !== expected) {
    if (!errors.some((e) => e.includes("aggregate_type 必须"))) {
      errors.push(`${record.event_type} 的 aggregate_type 必须是 ${expected}`);
    }
  }

  return errors;
}
