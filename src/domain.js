/**
 * 领域事件信封字段约定与稳定枚举。
 * 单一事实来源为 contracts/domain.schema.json；本文件镜像其枚举，
 * 供运行时代码引用，避免散落字符串。
 *
 * @typedef {Object} DomainEvent
 * @property {string} event_id
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string} occurred_at
 * @property {number} version
 * @property {string} summary
 * @property {object} payload
 * @property {string} [idempotency_key]
 * @property {string} [causation_id]
 * @property {string} [correlation_id]
 * @property {{agent: string, lab?: string}} [actor]
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

export const EVENT_TYPES = Object.freeze([
  "DATASET_REGISTERED",
  "VOCABULARY_FROZEN",
  "ORTHOLOG_FROZEN",
  "ACCESS_GRANTED",
  "RUN_REGISTERED",
  "CHECKPOINT_RECORDED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "EMBEDDING_PUBLISHED",
  "CLAIM_RECORDED",
  "CLAIM_VALIDATED",
  "CLAIM_DEMOTED",
  "SOURCE_WITHDRAWN",
  "ANNOTATION_UPGRADED",
  "FIGURE_PUBLISHED",
  "MODEL_CARD_PUBLISHED",
]);

export const AGGREGATE_TYPES = Object.freeze([
  "dataset_release",
  "gene_vocabulary",
  "ortholog_set",
  "access_grant",
  "model_run",
  "embedding",
  "biological_claim",
  "figure",
  "model_card",
]);

/** 事件类型 -> 其所属聚合类型。撤回/升级为跨域标记事件，aggregate_type 取被标记对象本身。 */
export const EVENT_AGGREGATE = Object.freeze({
  DATASET_REGISTERED: "dataset_release",
  VOCABULARY_FROZEN: "gene_vocabulary",
  ORTHOLOG_FROZEN: "ortholog_set",
  ACCESS_GRANTED: "access_grant",
  RUN_REGISTERED: "model_run",
  CHECKPOINT_RECORDED: "model_run",
  RUN_COMPLETED: "model_run",
  RUN_FAILED: "model_run",
  EMBEDDING_PUBLISHED: "embedding",
  CLAIM_RECORDED: "biological_claim",
  CLAIM_VALIDATED: "biological_claim",
  CLAIM_DEMOTED: "biological_claim",
  SOURCE_WITHDRAWN: null, // aggregate_type = payload.target_type
  ANNOTATION_UPGRADED: null,
  FIGURE_PUBLISHED: "figure",
  MODEL_CARD_PUBLISHED: "model_card",
});

/** 主张生命周期：嵌入结果、推断主张、实验验证不得混为同一状态。 */
export const CLAIM_STATUSES = Object.freeze([
  "exploratory_hint", // 探索线索
  "proposed", // 推断主张
  "validated", // 已在某一等级验证
  "refuted", // 被否证
  "withdrawn", // 撤回
]);

/** 验证等级，逐级增强；模型相似性本身只构成 in_silico 级。 */
export const VALIDATION_LEVELS = Object.freeze([
  "in_silico_reproduction", // 计算复现
  "independent_dataset", // 独立数据集
  "wetlab_independent", // 独立湿实验
  "wetlab_preregistered", // 预注册湿实验
]);

export const CONSENT_BASES = Object.freeze(["explicit", "broad", "tiered", "unknown"]);
export const QC_STATUSES = Object.freeze(["passed", "flagged", "failed"]);
export const ACCESS_TIERS = Object.freeze(["open", "controlled", "restricted"]);
export const ACCESS_SCOPES = Object.freeze(["metadata", "derivatives", "raw"]);
export const EMBEDDING_STATUSES = Object.freeze(["exploratory", "frozen"]);
export const ANNOTATION_TARGETS = Object.freeze(["dataset_release", "gene_vocabulary", "ortholog_set"]);
