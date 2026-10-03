/**
 * 领域事件信封字段约定。
 *
 * 所有跨物种分析流程（登记、冻结、训练、嵌入、主张、验证、模型卡、
 * 图表、撤回、注释升级）都写入同一种不可变事件信封，由登记处统一
 * 编号、追加，禁止就地修改。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id        全局唯一事件 ID
 * @property {string} event_type      见 EVENT_TYPES
 * @property {string} aggregate_type  见 AGGREGATE_TYPES
 * @property {string} aggregate_id    聚合身份（同一聚合上 version 单调递增）
 * @property {string} occurred_at     ISO-8601 时间
 * @property {number} version         该聚合上的事件序号，从 1 开始
 * @property {string} summary         人类可读摘要
 * @property {object} payload         事件载荷（结构随 event_type，见 schema $defs）
 * @property {string} [idempotency_key] 回调幂等键，重复回调不产生第二个运行
 * @property {string} [causation_id]  直接触发本事件的事件 ID
 * @property {string} [correlation_id] 同一分析端到端链路的关联 ID
 * @property {{name: string, version: string}} [producer] 事件产生方
 */

export const domainEventFields = Object.freeze([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "payload",
]);

export const optionalEventFields = Object.freeze([
  "idempotency_key",
  "causation_id",
  "correlation_id",
  "producer",
]);

/**
 * 事件类型 → 合法聚合类型 的映射；ANNOTATION_UPGRADED 可作用于
 * 词表或同源组两种聚合。
 */
export const EVENT_TYPES = Object.freeze({
  ANALYSIS_REGISTERED: "ANALYSIS_REGISTERED",
  DATASET_REGISTERED: "DATASET_REGISTERED",
  VOCABULARY_FROZEN: "VOCABULARY_FROZEN",
  ORTHOLOGY_FROZEN: "ORTHOLOGY_FROZEN",
  ACCESS_AUTHORIZED: "ACCESS_AUTHORIZED",
  RUN_REGISTERED: "RUN_REGISTERED",
  SHARD_PROGRESSED: "SHARD_PROGRESSED",
  RUN_COMPLETED: "RUN_COMPLETED",
  EMBEDDING_PUBLISHED: "EMBEDDING_PUBLISHED",
  CLAIM_RECORDED: "CLAIM_RECORDED",
  CLAIM_VALIDATED: "CLAIM_VALIDATED",
  MODEL_CARD_PUBLISHED: "MODEL_CARD_PUBLISHED",
  FIGURE_PUBLISHED: "FIGURE_PUBLISHED",
  ANNOTATION_UPGRADED: "ANNOTATION_UPGRADED",
  SOURCE_WITHDRAWN: "SOURCE_WITHDRAWN",
});

export const AGGREGATE_TYPES = Object.freeze({
  ANALYSIS_REGISTRATION: "analysis_registration",
  DATASET_RELEASE: "dataset_release",
  GENE_VOCABULARY: "gene_vocabulary",
  ORTHOLOGY_SET: "orthology_set",
  ACCESS_GRANT: "access_grant",
  MODEL_RUN: "model_run",
  EMBEDDING_OUTPUT: "embedding_output",
  BIOLOGICAL_CLAIM: "biological_claim",
  MODEL_CARD: "model_card",
  FIGURE: "figure",
});

/** event_type → 允许的 aggregate_type（与 schema allOf 保持一致）。 */
export const EVENT_AGGREGATE_RULES = Object.freeze({
  ANALYSIS_REGISTERED: ["analysis_registration"],
  DATASET_REGISTERED: ["dataset_release"],
  VOCABULARY_FROZEN: ["gene_vocabulary"],
  ORTHOLOGY_FROZEN: ["orthology_set"],
  ACCESS_AUTHORIZED: ["access_grant"],
  RUN_REGISTERED: ["model_run"],
  SHARD_PROGRESSED: ["model_run"],
  RUN_COMPLETED: ["model_run"],
  EMBEDDING_PUBLISHED: ["embedding_output"],
  CLAIM_RECORDED: ["biological_claim"],
  CLAIM_VALIDATED: ["biological_claim"],
  MODEL_CARD_PUBLISHED: ["model_card"],
  FIGURE_PUBLISHED: ["figure"],
  ANNOTATION_UPGRADED: ["gene_vocabulary", "orthology_set"],
  SOURCE_WITHDRAWN: ["dataset_release"],
});

/**
 * 主张生命周期：嵌入结果、推断主张、实验验证是三种不同状态。
 * 只能按顺序提升，不允许跳跃，更不允许把模型相似性直接记成已验证事实。
 */
export const VALIDATION_LEVELS = Object.freeze({
  EXPLORATORY: "exploratory",
  COMPUTATIONAL_REPLICATION: "computational_replication",
  INDEPENDENT_REPLICATION: "independent_replication",
  EXPERIMENTAL_VALIDATION: "experimental_validation",
});

export const VALIDATION_LEVEL_ORDER = Object.freeze([
  "exploratory",
  "computational_replication",
  "independent_replication",
  "experimental_validation",
]);

/**
 * 访问分级。人类原始数据为 controlled/restricted：无 ACCESS_AUTHORIZED
 * 授权的项目不得在 RUN_REGISTERED 中引用，也不得跨项目流动。
 */
export const ACCESS_TIERS = Object.freeze({
  PUBLIC: "public",
  EMBARGOED: "embargoed",
  // 保密期内的竞争结果：允许并存，仅 owner/授权项目可见。
  CONTROLLED: "controlled",
  RESTRICTED: "restricted",
});

export const CONSENT_TERMS = Object.freeze([
  "unrestricted_research",
  "controlled_access",
  "population_restricted",
  "no_secondary_use",
  "unknown",
]);

export const SHARD_STATES = Object.freeze(["started", "checkpoint", "completed"]);

/** 重复回调必须携带幂等键的事件。 */
export const IDEMPOTENCY_REQUIRED_EVENTS = Object.freeze([
  "RUN_REGISTERED",
  "SHARD_PROGRESSED",
]);

/**
 * 状态标记（不删除历史）：撤回与注释升级只在受影响聚合上置标记，
 * 已发表事件仍保留在日志中可复查。
 */
export const MARKER_EVENTS = Object.freeze(["SOURCE_WITHDRAWN", "ANNOTATION_UPGRADED"]);
