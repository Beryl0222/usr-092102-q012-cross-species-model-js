import {
  ACCESS_TIERS,
  AGGREGATE_TYPES,
  CONSENT_TERMS,
  EVENT_AGGREGATE_RULES,
  EVENT_TYPES,
  IDEMPOTENCY_REQUIRED_EVENTS,
  SHARD_STATES,
  VALIDATION_LEVEL_ORDER,
  domainEventFields,
  optionalEventFields,
} from "./domain.js";

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function fail(errors, path, condition, message) {
  if (!condition) errors.push(`${path}：${message}`);
}

function requireKeys(errors, path, obj, keys) {
  for (const key of keys) {
    if (!(key in obj)) errors.push(`${path}：缺少字段 ${key}`);
  }
}

function checkChecksum(errors, path, value) {
  if (!isObject(value)) {
    errors.push(`${path}：必须是校验值对象 {algorithm, value}`);
    return;
  }
  fail(errors, path, value.algorithm === "sha256", "algorithm 必须为 sha256");
  fail(
    errors,
    path,
    typeof value.value === "string" && SHA256_RE.test(value.value),
    "value 必须是 64 位小写十六进制 sha256 摘要"
  );
  for (const key of Object.keys(value)) {
    if (!["algorithm", "value"].includes(key)) errors.push(`${path}：不允许的字段 ${key}`);
  }
}

function checkRef(errors, path, value) {
  if (!isObject(value)) {
    errors.push(`${path}：必须是引用对象 {aggregate_type, aggregate_id}`);
    return;
  }
  requireKeys(errors, path, value, ["aggregate_type", "aggregate_id"]);
  fail(errors, path, typeof value.aggregate_id === "string" && value.aggregate_id.length > 0, "aggregate_id 不能为空");
  if ("version" in value) {
    fail(errors, path, Number.isInteger(value.version) && value.version >= 1, "version 必须为正整数");
  }
  if ("checksum" in value) checkChecksum(errors, `${path}.checksum`, value.checksum);
}

function checkStringArray(errors, path, value, { minItems = 0 } = {}) {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string" && x.length > 0)) {
    errors.push(`${path}：必须是非空字符串数组`);
    return;
  }
  if (value.length < minItems) errors.push(`${path}：至少包含 ${minItems} 项`);
}

function checkRefArray(errors, path, value, { minItems = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path}：必须是引用数组`);
    return;
  }
  if (value.length < minItems) errors.push(`${path}：至少包含 ${minItems} 项`);
  value.forEach((item, i) => checkRef(errors, `${path}[${i}]`, item));
}

function checkDateTime(errors, path, value, required = false) {
  if (value === undefined) {
    if (required) errors.push(`${path}：缺少 ISO-8601 时间`);
    return;
  }
  fail(errors, path, typeof value === "string" && ISO_DATE_RE.test(value), "必须是 ISO-8601 date-time");
}

function checkQc(errors, path, value) {
  if (!isObject(value)) {
    errors.push(`${path}：必须是质控对象 {passed, checks}`);
    return;
  }
  requireKeys(errors, path, value, ["passed", "checks"]);
  fail(errors, path, typeof value.passed === "boolean", "passed 必须是布尔值");
  checkStringArray(errors, `${path}.checks`, value.checks ?? null);
}

function checkAccessTier(errors, path, value) {
  fail(errors, path, Object.values(ACCESS_TIERS).includes(value), `必须是访问分级之一（${Object.values(ACCESS_TIERS).join("/")}）`);
}

function checkEmbargo(errors, path, value) {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push(`${path}：必须是保密对象 {owner_project, ...}`);
    return;
  }
  requireKeys(errors, path, value, ["owner_project"]);
  fail(errors, path, typeof value.owner_project === "string" && value.owner_project.length > 0, "owner_project 不能为空");
  if ("visible_to_projects" in value) checkStringArray(errors, `${path}.visible_to_projects`, value.visible_to_projects);
  if ("embargo_until" in value) checkDateTime(errors, `${path}.embargo_until`, value.embargo_until);
}

function checkAffected(errors, path, value) {
  if (!isObject(value)) {
    errors.push(`${path}：必须是受影响引用对象`);
    return;
  }
  requireKeys(errors, path, value, ["affected_run_refs", "affected_claim_refs"]);
  checkStringArray(errors, `${path}.affected_run_refs`, value.affected_run_refs ?? null);
  checkStringArray(errors, `${path}.affected_claim_refs`, value.affected_claim_refs ?? null);
  if ("affected_figure_refs" in value) {
    checkStringArray(errors, `${path}.affected_figure_refs`, value.affected_figure_refs ?? null);
  }
}

/* ----------------------------- 各事件载荷 ----------------------------- */

function checkPayload(errors, eventType, payload) {
  if (!isObject(payload)) {
    errors.push("payload：必须是对象");
    return;
  }
  const p = `payload`;
  switch (eventType) {
    case "ANALYSIS_REGISTERED": {
      requireKeys(errors, p, payload, ["title", "lead_lab", "planned_species", "intended_use", "registered_at"]);
      checkStringArray(errors, `${p}.planned_species`, payload.planned_species, { minItems: 1 });
      checkDateTime(errors, `${p}.registered_at`, payload.registered_at);
      break;
    }
    case "DATASET_REGISTERED": {
      requireKeys(errors, p, payload, [
        "lab", "species", "tissue", "sample_consent", "human_subject",
        "access_tier", "quality_control", "checksum",
      ]);
      if (isObject(payload.species)) {
        requireKeys(errors, `${p}.species`, payload.species, ["scientific_name"]);
      } else errors.push(`${p}.species：必须是物种对象`);
      fail(errors, `${p}.sample_consent`, CONSENT_TERMS.includes(payload.sample_consent), "必须使用受控同意词表");
      fail(errors, `${p}.human_subject`, typeof payload.human_subject === "boolean", "必须声明是否人类受试者数据");
      checkAccessTier(errors, `${p}.access_tier`, payload.access_tier);
      if ("access_restrictions" in payload) checkStringArray(errors, `${p}.access_restrictions`, payload.access_restrictions);
      checkQc(errors, `${p}.quality_control`, payload.quality_control);
      checkChecksum(errors, `${p}.checksum`, payload.checksum);
      // 制度约束：人类受试者数据不得标为公开。
      if (payload.human_subject === true && payload.access_tier === "public") {
        errors.push(`${p}：人类原始数据不得登记为 public 访问分级`);
      }
      break;
    }
    case "VOCABULARY_FROZEN": {
      requireKeys(errors, p, payload, ["name", "vocab_version", "source_release", "frozen_at", "checksum"]);
      checkDateTime(errors, `${p}.frozen_at`, payload.frozen_at);
      checkChecksum(errors, `${p}.checksum`, payload.checksum);
      if ("species_coverage" in payload) checkStringArray(errors, `${p}.species_coverage`, payload.species_coverage);
      break;
    }
    case "ORTHOLOGY_FROZEN": {
      requireKeys(errors, p, payload, ["name", "mapping_version", "source", "frozen_at", "checksum", "vocabulary_refs"]);
      checkDateTime(errors, `${p}.frozen_at`, payload.frozen_at);
      checkChecksum(errors, `${p}.checksum`, payload.checksum);
      checkRefArray(errors, `${p}.vocabulary_refs`, payload.vocabulary_refs, { minItems: 1 });
      break;
    }
    case "ACCESS_AUTHORIZED": {
      requireKeys(errors, p, payload, ["project_id", "dataset_refs", "granted_by", "granted_at"]);
      checkRefArray(errors, `${p}.dataset_refs`, payload.dataset_refs, { minItems: 1 });
      checkDateTime(errors, `${p}.granted_at`, payload.granted_at);
      if ("expires_at" in payload) checkDateTime(errors, `${p}.expires_at`, payload.expires_at);
      break;
    }
    case "RUN_REGISTERED": {
      requireKeys(errors, p, payload, [
        "analysis_ref", "lab", "project_id", "dataset_refs",
        "vocabulary_ref", "orthology_ref", "training_config", "code", "shard_total",
      ]);
      checkRefArray(errors, `${p}.dataset_refs`, payload.dataset_refs, { minItems: 1 });
      checkRef(errors, `${p}.vocabulary_ref`, payload.vocabulary_ref);
      checkRef(errors, `${p}.orthology_ref`, payload.orthology_ref);
      if (isObject(payload.training_config)) checkChecksum(errors, `${p}.training_config.checksum`, payload.training_config.checksum);
      else errors.push(`${p}.training_config：必须是对象`);
      if (isObject(payload.code)) {
        requireKeys(errors, `${p}.code`, payload.code, ["repository", "commit", "checksum"]);
        checkChecksum(errors, `${p}.code.checksum`, payload.code.checksum);
      } else errors.push(`${p}.code：必须是对象`);
      fail(errors, `${p}.shard_total`, Number.isInteger(payload.shard_total) && payload.shard_total >= 1, "分片总数必须为 >=1 的整数");
      checkEmbargo(errors, `${p}.embargo`, payload.embargo);
      break;
    }
    case "SHARD_PROGRESSED": {
      requireKeys(errors, p, payload, ["shard_index", "state", "checkpoint_checksum"]);
      fail(errors, `${p}.shard_index`, Number.isInteger(payload.shard_index) && payload.shard_index >= 0, "shard_index 必须为 >=0 的整数");
      fail(errors, `${p}.state`, SHARD_STATES.includes(payload.state), `state 必须为 ${SHARD_STATES.join("/")}`);
      checkChecksum(errors, `${p}.checkpoint_checksum`, payload.checkpoint_checksum);
      if ("resumes_from_checkpoint" in payload) {
        checkChecksum(errors, `${p}.resumes_from_checkpoint`, payload.resumes_from_checkpoint);
      }
      break;
    }
    case "RUN_COMPLETED": {
      requireKeys(errors, p, payload, ["shard_total", "weights", "embedding_checksum", "config_checksum", "code_checksum"]);
      if (isObject(payload.weights)) checkChecksum(errors, `${p}.weights.checksum`, payload.weights.checksum);
      else errors.push(`${p}.weights：必须是对象`);
      ["embedding_checksum", "config_checksum", "code_checksum"].forEach((k) =>
        checkChecksum(errors, `${p}.${k}`, payload[k])
      );
      break;
    }
    case "EMBEDDING_PUBLISHED": {
      requireKeys(errors, p, payload, ["run_ref", "checksum"]);
      checkChecksum(errors, `${p}.checksum`, payload.checksum);
      break;
    }
    case "CLAIM_RECORDED": {
      requireKeys(errors, p, payload, ["embedding_ref", "statement", "validation_level", "recorded_by"]);
      fail(
        errors,
        `${p}.validation_level`,
        payload.validation_level === VALIDATION_LEVEL_ORDER[0],
        "新登记主张只能标记为 exploratory；模型相似性不得直接记为已验证事实"
      );
      if ("caveats" in payload) checkStringArray(errors, `${p}.caveats`, payload.caveats);
      break;
    }
    case "CLAIM_VALIDATED": {
      requireKeys(errors, p, payload, ["new_level", "method", "validated_by", "validated_at", "evidence"]);
      fail(
        errors,
        `${p}.new_level`,
        VALIDATION_LEVEL_ORDER.includes(payload.new_level) && payload.new_level !== "exploratory",
        "验证事件必须把主张提升到 exploratory 以上的等级"
      );
      checkDateTime(errors, `${p}.validated_at`, payload.validated_at);
      if (isObject(payload.validated_by)) {
        requireKeys(errors, `${p}.validated_by`, payload.validated_by, ["lab", "independent"]);
        fail(errors, `${p}.validated_by.independent`, typeof payload.validated_by.independent === "boolean", "必须声明验证实验室是否独立");
      } else errors.push(`${p}.validated_by：必须是对象`);
      if (isObject(payload.evidence)) {
        requireKeys(errors, `${p}.evidence`, payload.evidence, ["description"]);
        if ("checksum" in payload.evidence) checkChecksum(errors, `${p}.evidence.checksum`, payload.evidence.checksum);
      } else errors.push(`${p}.evidence：必须是对象`);
      break;
    }
    case "MODEL_CARD_PUBLISHED": {
      requireKeys(errors, p, payload, [
        "run_ref", "embedding_ref", "intended_uses", "out_of_scope_uses",
        "validation_level", "provenance",
      ]);
      checkStringArray(errors, `${p}.intended_uses`, payload.intended_uses, { minItems: 1 });
      checkStringArray(errors, `${p}.out_of_scope_uses`, payload.out_of_scope_uses, { minItems: 1 });
      fail(errors, `${p}.validation_level`, VALIDATION_LEVEL_ORDER.includes(payload.validation_level), "必须使用受控验证等级词表");
      checkProvenance(errors, payload.provenance, { requireAnalysis: false });
      break;
    }
    case "FIGURE_PUBLISHED": {
      requireKeys(errors, p, payload, ["title", "run_ref", "embedding_ref", "claim_refs", "provenance", "validation_level"]);
      checkStringArray(errors, `${p}.claim_refs`, payload.claim_refs);
      fail(errors, `${p}.validation_level`, VALIDATION_LEVEL_ORDER.includes(payload.validation_level), "必须使用受控验证等级词表");
      checkProvenance(errors, payload.provenance, { requireAnalysis: true });
      break;
    }
    case "ANNOTATION_UPGRADED": {
      requireKeys(errors, p, payload, ["new_ref", "reason"]);
      checkRef(errors, `${p}.new_ref`, payload.new_ref);
      if ("affected" in payload) checkAffected(errors, `${p}.affected`, payload.affected);
      break;
    }
    case "SOURCE_WITHDRAWN": {
      requireKeys(errors, p, payload, ["reason", "affected"]);
      checkAffected(errors, `${p}.affected`, payload.affected);
      break;
    }
    default:
      errors.push(`payload：未知事件类型 ${eventType}`);
  }

  // 未知字段防护：载荷结构必须与 schema $defs 对齐。
  const allowed = PAYLOAD_KEYS[eventType];
  if (allowed) {
    for (const key of Object.keys(payload)) {
      if (!allowed.includes(key)) errors.push(`${p}：不允许的字段 ${key}`);
    }
  }
}

function checkProvenance(errors, value, { requireAnalysis }) {
  const path = "payload.provenance";
  if (!isObject(value)) {
    errors.push(`${path}：必须是溯源对象`);
    return;
  }
  const required = [
    ...(requireAnalysis ? ["analysis_ref"] : []),
    "dataset_refs", "vocabulary_ref", "orthology_ref",
    "config_checksum", "code_checksum", "weights_checksum", "embedding_checksum",
  ];
  requireKeys(errors, path, value, required);
  checkRefArray(errors, `${path}.dataset_refs`, value.dataset_refs, { minItems: 1 });
  checkRef(errors, `${path}.vocabulary_ref`, value.vocabulary_ref);
  checkRef(errors, `${path}.orthology_ref`, value.orthology_ref);
  ["config_checksum", "code_checksum", "weights_checksum", "embedding_checksum"].forEach((k) =>
    checkChecksum(errors, `${path}.${k}`, value[k])
  );
}

const PAYLOAD_KEYS = Object.freeze({
  ANALYSIS_REGISTERED: ["title", "lead_lab", "planned_species", "intended_use", "hypotheses", "registered_at"],
  DATASET_REGISTERED: [
    "lab", "species", "tissue", "sample_consent", "human_subject",
    "access_tier", "access_restrictions", "quality_control", "source_uri", "checksum",
  ],
  VOCABULARY_FROZEN: ["name", "vocab_version", "source_release", "frozen_at", "species_coverage", "checksum", "supersedes"],
  ORTHOLOGY_FROZEN: ["name", "mapping_version", "source", "frozen_at", "mapping_policy", "vocabulary_refs", "checksum", "supersedes"],
  ACCESS_AUTHORIZED: ["project_id", "dataset_refs", "granted_by", "granted_at", "expires_at"],
  RUN_REGISTERED: [
    "analysis_ref", "lab", "project_id", "dataset_refs", "vocabulary_ref",
    "orthology_ref", "training_config", "code", "shard_total", "embargo",
  ],
  SHARD_PROGRESSED: ["shard_index", "state", "checkpoint_checksum", "resumes_from_checkpoint", "metrics_snapshot"],
  RUN_COMPLETED: ["shard_total", "weights", "embedding_checksum", "config_checksum", "code_checksum", "metrics"],
  EMBEDDING_PUBLISHED: ["run_ref", "checksum", "artifact_uri", "dimensionality", "entities"],
  CLAIM_RECORDED: ["embedding_ref", "statement", "validation_level", "recorded_by", "caveats"],
  CLAIM_VALIDATED: ["new_level", "method", "validated_by", "validated_at", "evidence"],
  MODEL_CARD_PUBLISHED: ["run_ref", "embedding_ref", "intended_uses", "out_of_scope_uses", "validation_level", "provenance", "warnings"],
  FIGURE_PUBLISHED: ["title", "run_ref", "embedding_ref", "claim_refs", "provenance", "validation_level", "artifact_uri"],
  ANNOTATION_UPGRADED: ["new_ref", "reason", "affected"],
  SOURCE_WITHDRAWN: ["reason", "affected"],
});

/**
 * 无状态结构校验：检查信封与载荷形状。跨事件的生命周期规则
 * （版本序号、授权、分片连续、验证等级提升、撤回标记）由登记处负责。
 *
 * @param {object} record
 * @returns {string[]} 错误信息数组；空数组表示通过
 */
export function validateEvent(record) {
  const errors = [];
  if (!isObject(record)) return ["事件必须是对象"];

  for (const name of domainEventFields) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  for (const name of Object.keys(record)) {
    if (![...domainEventFields, ...optionalEventFields].includes(name)) {
      errors.push(`不允许的信封字段：${name}`);
    }
  }
  if (errors.some((e) => e.startsWith("缺少字段"))) return errors;

  fail(errors, "event_id", typeof record.event_id === "string" && record.event_id.length > 0, "event_id 不能为空");
  fail(errors, "aggregate_id", typeof record.aggregate_id === "string" && record.aggregate_id.length > 0, "aggregate_id 不能为空");
  fail(errors, "summary", typeof record.summary === "string" && record.summary.length > 0, "summary 不能为空");
  fail(errors, "version", Number.isInteger(record.version) && record.version >= 1, "version 必须是正整数");
  checkDateTime(errors, "occurred_at", record.occurred_at, true);

  if (!Object.values(EVENT_TYPES).includes(record.event_type)) {
    errors.push(`event_type：不在受控枚举中（${record.event_type}）`);
  }
  if (!Object.values(AGGREGATE_TYPES).includes(record.aggregate_type)) {
    errors.push(`aggregate_type：不在受控枚举中（${record.aggregate_type}）`);
  }
  const allowedAggregates = EVENT_AGGREGATE_RULES[record.event_type];
  if (allowedAggregates && !allowedAggregates.includes(record.aggregate_type)) {
    errors.push(`event_type ${record.event_type} 不能作用于聚合 ${record.aggregate_type}`);
  }

  if (IDEMPOTENCY_REQUIRED_EVENTS.includes(record.event_type) && !record.idempotency_key) {
    errors.push(`${record.event_type}：训练注册与分片回调必须携带 idempotency_key`);
  }
  if ("idempotency_key" in record) {
    fail(errors, "idempotency_key", typeof record.idempotency_key === "string" && record.idempotency_key.length > 0, "idempotency_key 不能为空");
  }
  if ("producer" in record && !isObject(record.producer)) {
    errors.push("producer：必须是 {name, version} 对象");
  }

  if (Object.values(EVENT_TYPES).includes(record.event_type)) {
    checkPayload(errors, record.event_type, record.payload);
  }
  return errors;
}
