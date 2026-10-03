import {
  AGGREGATE_TYPES,
  EVENT_TYPES,
  VALIDATION_LEVEL_ORDER,
} from "./domain.js";
import { validateEvent } from "./validator.js";

/** 标记可同时落在运行级与产物级，按触发事件去重后展示。 */
function dedupeMarkers(markers) {
  const seen = new Set();
  const out = [];
  for (const marker of markers) {
    if (seen.has(marker.since_event)) continue;
    seen.add(marker.since_event);
    out.push(marker);
  }
  return out;
}

/** 登记处规则违反：错误带 code，便于调用方区分策略拒绝与结构错误。 */
export class RegistryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.details = details;
  }
}

const RUN_PREFIX = "run";
const EMBEDDING_PREFIX = "emb";
const CLAIM_PREFIX = "claim";
const CARD_PREFIX = "card";
const FIGURE_PREFIX = "fig";
const GRANT_PREFIX = "grant";

/**
 * 不可变事件日志上的登记处。
 *
 * 所有制度约束都在这里强制执行：
 * - 先登记分析，再引用数据；数据集必须注明实验室/物种/组织/同意/质控/访问限制
 * - 词表与同源组分别冻结；训练运行钉住确切版本与校验值
 * - 受控（含人类）数据无 ACCESS_AUTHORIZED 不得进入任何运行
 * - 长训练按分片推进：分片可恢复，重复回调经幂等键返回同一事件
 * - 嵌入结果、推断主张、实验验证是三个独立聚合，主张只能逐级提升
 * - 保密期竞争结果可并存，按项目可见性隔离
 * - 来源撤回 / 注释升级只打标记，不删历史；新产物不得继续引用受影响运行
 */
export class EventRegistry {
  #events = [];
  #seq = 0;
  #aggregates = new Map(); // aggregate_id -> { type, version }
  #eventIds = new Set();
  #idem = new Map(); // 幂等键 -> 既有事件

  #analyses = new Map();
  #datasets = new Map();
  #vocabularies = new Map();
  #orthologies = new Map();
  #grants = new Map(); // `${project_id}|${dataset_id}` -> [grant事件...]
  #runs = new Map();
  #embeddings = new Map();
  #claims = new Map();
  #cards = new Map(); // `${runId}|${embeddingId}` -> 卡片事件
  #figures = new Map();

  // runId / claimId / figureId -> 标记列表（撤回、注释升级），只追加
  #runMarkers = new Map();
  #claimMarkers = new Map();
  #figureMarkers = new Map();

  /**
   * @param {object} [opts]
   * @param {() => string} [opts.now] 可注入时钟（ISO-8601）
   * @param {() => string} [opts.idFactory] 可注入聚合 ID 生成器
   */
  constructor({ now, idFactory } = {}) {
    this.#clock = now ?? (() => new Date().toISOString());
    let n = 0;
    this.#newAggregateId =
      idFactory ??
      ((prefix) => {
        n += 1;
        return `${prefix}-${String(n).padStart(4, "0")}`;
      });
  }

  #clock;
  #newAggregateId;

  /* ------------------------------ 日志与投影 ------------------------------ */

  /**
   * 追加一条已成型事件：结构校验 + 版本序号 + 幂等去重 + 关系规则由各命令先行检查。
   * 命令方法构造事件后统一走这里。
   */
  #append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new RegistryError("INVALID_EVENT", errors.join("；"), errors);

    if (this.#eventIds.has(event.event_id)) {
      throw new RegistryError("DUPLICATE_EVENT_ID", `事件 ID 已存在：${event.event_id}`);
    }
    const agg = this.#aggregates.get(event.aggregate_id);
    const expectedVersion = agg ? agg.version + 1 : 1;
    if (event.version !== expectedVersion) {
      throw new RegistryError(
        "VERSION_CONFLICT",
        `聚合 ${event.aggregate_id} 下一版本应为 ${expectedVersion}，收到 ${event.version}`
      );
    }
    if (event.idempotency_key) {
      const scope =
        event.event_type === EVENT_TYPES.RUN_REGISTERED
          ? `${event.event_type}|${event.idempotency_key}`
          : `${event.event_type}|${event.aggregate_id}|${event.idempotency_key}`;
      const existing = this.#idem.get(scope);
      if (existing) return existing; // 重复回调：返回既有事件，不产生第二个运行
      this.#idem.set(scope, event);
    }

    this.#seq += 1;
    this.#events.push(event);
    this.#eventIds.add(event.event_id);
    this.#aggregates.set(event.aggregate_id, { type: event.aggregate_type, version: event.version });
    this.#project(event);
    return event;
  }

  #build({ type, aggregateType, aggregateId, payload, summary, idempotencyKey, causationId, correlationId, producer }) {
    const agg = this.#aggregates.get(aggregateId);
    return {
      event_id: `evt-${String(this.#seq + 1).padStart(6, "0")}`,
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.#clock(),
      version: agg ? agg.version + 1 : 1,
      summary,
      payload,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(causationId ? { causation_id: causationId } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      ...(producer ? { producer } : {}),
    };
  }

  /** 投影：把事件更新到内存读模型；回放日志时只投影、不再做规则校验。 */
  #project(event) {
    const { event_type: type, aggregate_id: id, payload } = event;
    switch (type) {
      case EVENT_TYPES.ANALYSIS_REGISTERED:
        this.#analyses.set(id, { id, payload, event });
        break;
      case EVENT_TYPES.DATASET_REGISTERED:
        this.#datasets.set(id, { id, payload, withdrawn: null, event });
        break;
      case EVENT_TYPES.VOCABULARY_FROZEN:
        this.#vocabularies.set(id, { id, payload, supersededBy: null, event });
        if (payload.supersedes) this.#markSuperseded(this.#vocabularies, payload.supersedes, id);
        break;
      case EVENT_TYPES.ORTHOLOGY_FROZEN:
        this.#orthologies.set(id, { id, payload, supersededBy: null, event });
        if (payload.supersedes) this.#markSuperseded(this.#orthologies, payload.supersedes, id);
        break;
      case EVENT_TYPES.ACCESS_AUTHORIZED: {
        for (const ref of payload.dataset_refs) {
          const key = `${payload.project_id}|${ref.aggregate_id}`;
          if (!this.#grants.has(key)) this.#grants.set(key, []);
          this.#grants.get(key).push(event);
        }
        break;
      }
      case EVENT_TYPES.RUN_REGISTERED:
        this.#runs.set(id, {
          id,
          payload,
          status: "registered",
          shards: new Map(),
          registeredEvent: event,
          completedEvent: null,
        });
        break;
      case EVENT_TYPES.SHARD_PROGRESSED: {
        const run = this.#requireRun(id);
        const shard = run.shards.get(payload.shard_index) ?? {
          state: null,
          checkpoints: new Set(),
          events: [],
        };
        shard.state = payload.state;
        shard.checkpoints.add(payload.checkpoint_checksum.value);
        shard.events.push(event);
        run.shards.set(payload.shard_index, shard);
        break;
      }
      case EVENT_TYPES.RUN_COMPLETED: {
        const run = this.#requireRun(id);
        run.status = "completed";
        run.completedEvent = event;
        break;
      }
      case EVENT_TYPES.EMBEDDING_PUBLISHED:
        this.#embeddings.set(id, { id, payload, event });
        break;
      case EVENT_TYPES.CLAIM_RECORDED:
        this.#claims.set(id, {
          id,
          payload,
          level: payload.validation_level,
          history: [event],
          event,
        });
        break;
      case EVENT_TYPES.CLAIM_VALIDATED: {
        const claim = this.#requireClaim(id);
        claim.level = payload.new_level;
        claim.history.push(event);
        break;
      }
      case EVENT_TYPES.MODEL_CARD_PUBLISHED:
        this.#cards.set(`${payload.run_ref}|${payload.embedding_ref}`, event);
        break;
      case EVENT_TYPES.FIGURE_PUBLISHED:
        this.#figures.set(id, { id, payload, event });
        break;
      case EVENT_TYPES.ANNOTATION_UPGRADED:
        this.#applyUpgradeMarker(event);
        break;
      case EVENT_TYPES.SOURCE_WITHDRAWN: {
        const dataset = this.#datasets.get(id);
        if (dataset) dataset.withdrawn = { reason: payload.reason, event };
        this.#applyWithdrawalMarker(event);
        break;
      }
      default:
        throw new RegistryError("UNKNOWN_EVENT_TYPE", `未知事件类型：${type}`);
    }
  }

  #markSuperseded(store, oldId, newId) {
    const old = store.get(oldId);
    if (old) old.supersededBy = newId;
  }

  /** 从不可变日志重建登记处（分片训练跨进程恢复时使用）。 */
  static replay(events, opts) {
    const registry = new EventRegistry(opts);
    for (const event of events) {
      const errors = validateEvent(event);
      if (errors.length > 0) {
        throw new RegistryError("INVALID_EVENT", `日志事件 ${event.event_id} 结构不合法：${errors.join("；")}`);
      }
      if (registry.#eventIds.has(event.event_id)) {
        throw new RegistryError("DUPLICATE_EVENT_ID", `日志中事件 ID 重复：${event.event_id}`);
      }
      const agg = registry.#aggregates.get(event.aggregate_id);
      const expectedVersion = agg ? agg.version + 1 : 1;
      if (event.version !== expectedVersion) {
        throw new RegistryError(
          "VERSION_CONFLICT",
          `日志版本不连续：${event.aggregate_id} v${event.version}，期望 v${expectedVersion}`
        );
      }
      registry.#seq += 1;
      registry.#events.push(event);
      registry.#eventIds.add(event.event_id);
      registry.#aggregates.set(event.aggregate_id, {
        type: event.aggregate_type,
        version: event.version,
      });
      if (event.idempotency_key) {
        const scope =
          event.event_type === EVENT_TYPES.RUN_REGISTERED
            ? `${event.event_type}|${event.idempotency_key}`
            : `${event.event_type}|${event.aggregate_id}|${event.idempotency_key}`;
        registry.#idem.set(scope, event);
      }
      registry.#project(event);
    }
    return registry;
  }

  /** 导出不可变事件日志（可落 JSONL）。 */
  exportLog() {
    return this.#events.map((event) => structuredClone(event));
  }

  /* ------------------------------- 命令：登记 ------------------------------ */

  registerAnalysis(input = {}) {
    const id = input.id ?? this.#newAggregateId("analysis");
    if (this.#aggregates.has(id)) throw new RegistryError("DUPLICATE_AGGREGATE", `分析已存在：${id}`);
    const payload = {
      title: input.title,
      lead_lab: input.lead_lab,
      planned_species: input.planned_species,
      intended_use: input.intended_use,
      ...(input.hypotheses ? { hypotheses: input.hypotheses } : {}),
      registered_at: this.#clock(),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.ANALYSIS_REGISTERED,
        aggregateType: AGGREGATE_TYPES.ANALYSIS_REGISTRATION,
        aggregateId: id,
        payload,
        summary: `分析登记：${input.title}（${input.lead_lab}）`,
        producer: input.producer,
      })
    );
  }

  registerDataset(input = {}) {
    const id = input.id ?? this.#newAggregateId("dataset");
    if (this.#aggregates.has(id)) throw new RegistryError("DUPLICATE_AGGREGATE", `数据集已存在：${id}`);
    const payload = {
      lab: input.lab,
      species: input.species,
      tissue: input.tissue,
      sample_consent: input.sample_consent,
      human_subject: input.human_subject,
      access_tier: input.access_tier,
      ...(input.access_restrictions ? { access_restrictions: input.access_restrictions } : {}),
      quality_control: input.quality_control,
      ...(input.source_uri ? { source_uri: input.source_uri } : {}),
      checksum: input.checksum,
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.DATASET_REGISTERED,
        aggregateType: AGGREGATE_TYPES.DATASET_RELEASE,
        aggregateId: id,
        payload,
        summary: `数据集登记：${input.species?.scientific_name ?? ""} ${input.tissue}（${input.lab}）`,
        producer: input.producer,
      })
    );
  }

  freezeVocabulary(input = {}) {
    const id = input.id ?? this.#newAggregateId("vocab");
    if (this.#aggregates.has(id)) throw new RegistryError("DUPLICATE_AGGREGATE", `词表冻结已存在：${id}`);
    const payload = {
      name: input.name,
      vocab_version: input.vocab_version,
      source_release: input.source_release,
      frozen_at: this.#clock(),
      ...(input.species_coverage ? { species_coverage: input.species_coverage } : {}),
      checksum: input.checksum,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.VOCABULARY_FROZEN,
        aggregateType: AGGREGATE_TYPES.GENE_VOCABULARY,
        aggregateId: id,
        payload,
        summary: `基因词表冻结：${input.name} ${input.vocab_version}（${input.source_release}）`,
        producer: input.producer,
      })
    );
  }

  freezeOrthology(input = {}) {
    const id = input.id ?? this.#newAggregateId("orthology");
    if (this.#aggregates.has(id)) throw new RegistryError("DUPLICATE_AGGREGATE", `同源组冻结已存在：${id}`);
    for (const ref of input.vocabulary_refs ?? []) {
      this.#requireExistingRef(ref, AGGREGATE_TYPES.GENE_VOCABULARY, "vocabulary_refs");
    }
    const payload = {
      name: input.name,
      mapping_version: input.mapping_version,
      source: input.source,
      frozen_at: this.#clock(),
      ...(input.mapping_policy ? { mapping_policy: input.mapping_policy } : {}),
      vocabulary_refs: input.vocabulary_refs,
      checksum: input.checksum,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.ORTHOLOGY_FROZEN,
        aggregateType: AGGREGATE_TYPES.ORTHOLOGY_SET,
        aggregateId: id,
        payload,
        summary: `同源映射冻结：${input.name} ${input.mapping_version}（${input.source}）`,
        producer: input.producer,
      })
    );
  }

  authorizeAccess(input = {}) {
    for (const ref of input.dataset_refs ?? []) {
      this.#requireExistingRef(ref, AGGREGATE_TYPES.DATASET_RELEASE, "dataset_refs");
    }
    const id = input.id ?? this.#newAggregateId(GRANT_PREFIX);
    const payload = {
      project_id: input.project_id,
      dataset_refs: input.dataset_refs,
      granted_by: input.granted_by,
      granted_at: this.#clock(),
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.ACCESS_AUTHORIZED,
        aggregateType: AGGREGATE_TYPES.ACCESS_GRANT,
        aggregateId: id,
        payload,
        summary: `访问授权：项目 ${input.project_id} 可访问 ${input.dataset_refs.length} 个数据集`,
        producer: input.producer,
      })
    );
  }

  /* ------------------------------- 命令：训练 ------------------------------ */

  registerRun(input = {}) {
    // 重复提交：相同注册幂等键直接返回既有运行，绝不产生第二个运行。
    if (input.idempotencyKey) {
      const existing = this.#idem.get(`${EVENT_TYPES.RUN_REGISTERED}|${input.idempotencyKey}`);
      if (existing) return existing;
    }
    const id = input.id ?? this.#newAggregateId(RUN_PREFIX);
    if (this.#aggregates.has(id)) throw new RegistryError("DUPLICATE_AGGREGATE", `运行已存在：${id}`);

    if (!this.#analyses.has(input.analysis_ref)) {
      throw new RegistryError("UNREGISTERED_ANALYSIS", `运行必须挂接到已登记分析：${input.analysis_ref}`);
    }
    this.#requireFrozenRef(input.vocabulary_ref, this.#vocabularies, AGGREGATE_TYPES.GENE_VOCABULARY, "基因词表");
    this.#requireFrozenRef(input.orthology_ref, this.#orthologies, AGGREGATE_TYPES.ORTHOLOGY_SET, "同源映射");

    // 同源组必须是针对该版词表构建的：跨版本拼接正是复现差异来源之一。
    const orthology = this.#orthologies.get(input.orthology_ref.aggregate_id);
    const vocabCovered = orthology.payload.vocabulary_refs.some(
      (ref) => ref.aggregate_id === input.vocabulary_ref.aggregate_id
    );
    if (!vocabCovered) {
      throw new RegistryError(
        "ORTHOLOGY_VOCAB_MISMATCH",
        `同源映射 ${input.orthology_ref.aggregate_id} 未覆盖词表 ${input.vocabulary_ref.aggregate_id}，禁止跨版本组合`
      );
    }

    for (const ref of input.dataset_refs ?? []) {
      const dataset = this.#datasets.get(ref.aggregate_id);
      if (!dataset) throw new RegistryError("UNKNOWN_DATASET", `运行引用了未登记数据集：${ref.aggregate_id}`);
      this.#assertRefChecksum(ref, dataset.payload.checksum, "数据集");
      if (dataset.withdrawn) {
        throw new RegistryError(
          "SOURCE_WITHDRAWN_REFUSED",
          `数据集 ${ref.aggregate_id} 已撤回（${dataset.withdrawn.reason}），新运行不得引用；历史运行保留可复查`
        );
      }
      if (dataset.payload.access_tier !== "public") this.#assertAuthorized(input.project_id, ref.aggregate_id);
    }

    const payload = {
      analysis_ref: input.analysis_ref,
      lab: input.lab,
      project_id: input.project_id,
      dataset_refs: input.dataset_refs,
      vocabulary_ref: input.vocabulary_ref,
      orthology_ref: input.orthology_ref,
      training_config: input.training_config,
      code: input.code,
      shard_total: input.shard_total,
      ...(input.embargo ? { embargo: input.embargo } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.RUN_REGISTERED,
        aggregateType: AGGREGATE_TYPES.MODEL_RUN,
        aggregateId: id,
        payload,
        summary: `训练运行登记：${input.lab} / 项目 ${input.project_id}，${input.shard_total} 个分片`,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /**
   * 分片回调。同一 (runId, idempotencyKey) 重放返回原事件；
   * resumes_from_checkpoint 必须指向该分片此前记录过的检查点。
   */
  progressShard(runId, input = {}) {
    const run = this.#requireRun(runId);
    if (run.status === "completed") {
      throw new RegistryError("RUN_ALREADY_COMPLETED", `运行 ${runId} 已完成，不能再写入分片`);
    }
    const key = `${EVENT_TYPES.SHARD_PROGRESSED}|${runId}|${input.idempotencyKey}`;
    const existing = this.#idem.get(key);
    if (existing) return existing; // 重复回调：不产生第二个事件
    if (!input.idempotencyKey) {
      throw new RegistryError("IDEMPOTENCY_REQUIRED", "分片回调必须携带 idempotencyKey");
    }

    const { shard_index: index, state } = input;
    if (!Number.isInteger(index) || index < 0 || index >= run.payload.shard_total) {
      throw new RegistryError("BAD_SHARD_INDEX", `分片序号越界：${index}（共 ${run.payload.shard_total} 片）`);
    }
    const shard = run.shards.get(index);
    if (shard?.state === "completed" && !(state === "completed")) {
      throw new RegistryError("SHARD_ALREADY_COMPLETED", `分片 ${index} 已完成`);
    }
    if (shard?.state === "completed" && state === "completed" && !this.#idem.has(key)) {
      throw new RegistryError(
        "SHARD_DUPLICATE_COMPLETION",
        `分片 ${index} 完成回调重复且使用了新幂等键；请重试时复用原 idempotencyKey`
      );
    }
    if (input.resumes_from_checkpoint) {
      const known = shard?.checkpoints.has(input.resumes_from_checkpoint.value);
      if (!known) {
        throw new RegistryError(
          "UNKNOWN_CHECKPOINT",
          `分片 ${index} 无法从未知检查点恢复：${input.resumes_from_checkpoint.value.slice(0, 12)}…`
        );
      }
    }

    const payload = {
      shard_index: index,
      state,
      checkpoint_checksum: input.checkpoint_checksum,
      ...(input.resumes_from_checkpoint ? { resumes_from_checkpoint: input.resumes_from_checkpoint } : {}),
      ...(input.metrics_snapshot ? { metrics_snapshot: input.metrics_snapshot } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.SHARD_PROGRESSED,
        aggregateType: AGGREGATE_TYPES.MODEL_RUN,
        aggregateId: runId,
        payload,
        summary: `分片 ${index + 1}/${run.payload.shard_total}：${state}（${run.payload.lab}）`,
        idempotencyKey: input.idempotencyKey,
        causationId: run.registeredEvent.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  completeRun(runId, input = {}) {
    const run = this.#requireRun(runId);
    if (run.completedEvent) return run.completedEvent; // 完成回调天然幂等

    for (let i = 0; i < run.payload.shard_total; i += 1) {
      const shard = run.shards.get(i);
      if (!shard || shard.state !== "completed") {
        throw new RegistryError("SHARDS_INCOMPLETE", `运行 ${runId} 尚有分片未完成（首个缺失：${i}），禁止完成`);
      }
    }
    const payload = {
      shard_total: run.payload.shard_total,
      weights: input.weights,
      embedding_checksum: input.embedding_checksum,
      // 配置与代码校验值以登记时锁定的为准，防止训练中途被替换。
      config_checksum: run.payload.training_config.checksum,
      code_checksum: run.payload.code.checksum,
      ...(input.metrics ? { metrics: input.metrics } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.RUN_COMPLETED,
        aggregateType: AGGREGATE_TYPES.MODEL_RUN,
        aggregateId: runId,
        payload,
        summary: `训练完成：${runId}（${run.payload.lab}）`,
        causationId: run.registeredEvent.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /* ----------------------------- 命令：产物与主张 ----------------------------- */

  publishEmbedding(runId, input = {}) {
    const run = this.#requireRun(runId);
    if (run.status !== "completed") {
      throw new RegistryError("RUN_NOT_COMPLETED", `运行 ${runId} 未完成，不能发布嵌入`);
    }
    if (input.checksum.value !== run.completedEvent.payload.embedding_checksum.value) {
      throw new RegistryError(
        "CHECKSUM_MISMATCH",
        "嵌入校验值与 RUN_COMPLETED 锁定值不一致；嵌入结果与训练运行必须一一对应"
      );
    }
    // 同一运行同一嵌入：重复发布幂等返回。
    for (const [embId, emb] of this.#embeddings) {
      if (emb.payload.run_ref === runId && emb.payload.checksum.value === input.checksum.value) {
        return emb.event;
      }
    }
    const id = input.id ?? this.#newAggregateId(EMBEDDING_PREFIX);
    const payload = {
      run_ref: runId,
      checksum: input.checksum,
      ...(input.artifact_uri ? { artifact_uri: input.artifact_uri } : {}),
      ...(input.dimensionality ? { dimensionality: input.dimensionality } : {}),
      ...(input.entities ? { entities: input.entities } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.EMBEDDING_PUBLISHED,
        aggregateType: AGGREGATE_TYPES.EMBEDDING_OUTPUT,
        aggregateId: id,
        payload,
        summary: `嵌入结果发布：${runId} → ${id}`,
        causationId: run.completedEvent.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /**
   * 记录推断主张。无论措辞如何，新主张一律以 exploratory 入库——
   * 模型相似性只是线索，不得直接写成经过验证的生物学事实。
   */
  recordClaim(input = {}) {
    const embedding = this.#embeddings.get(input.embedding_ref);
    if (!embedding) throw new RegistryError("UNKNOWN_EMBEDDING", `嵌入不存在：${input.embedding_ref}`);
    const id = input.id ?? this.#newAggregateId(CLAIM_PREFIX);
    const payload = {
      embedding_ref: input.embedding_ref,
      statement: input.statement,
      validation_level: "exploratory",
      recorded_by: input.recorded_by,
      ...(input.caveats ? { caveats: input.caveats } : {}),
    };
    const run = this.#requireRun(embedding.payload.run_ref);
    return this.#append(
      this.#build({
        type: EVENT_TYPES.CLAIM_RECORDED,
        aggregateType: AGGREGATE_TYPES.BIOLOGICAL_CLAIM,
        aggregateId: id,
        payload,
        summary: `推断主张（探索线索）：${input.statement.slice(0, 60)}`,
        causationId: embedding.event.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /**
   * 提升主张验证等级。只能逐级提升：
   * exploratory → computational_replication → independent_replication → experimental_validation。
   */
  validateClaim(claimId, input = {}) {
    const claim = this.#requireClaim(claimId);
    const fromIdx = VALIDATION_LEVEL_ORDER.indexOf(claim.level);
    const toIdx = VALIDATION_LEVEL_ORDER.indexOf(input.new_level);
    if (toIdx === -1) throw new RegistryError("BAD_LEVEL", `未知验证等级：${input.new_level}`);
    if (toIdx !== fromIdx + 1) {
      throw new RegistryError(
        "LEVEL_SKIPPED",
        `主张只能逐级提升：${claim.level} 不能直接变为 ${input.new_level}`
      );
    }
    if (input.new_level === "independent_replication" && input.validated_by?.independent !== true) {
      throw new RegistryError("NOT_INDEPENDENT", "独立复现等级要求验证实验室独立于原始训练方");
    }
    if (input.new_level === "experimental_validation" && !input.evidence?.experiment_ref) {
      throw new RegistryError("EXPERIMENT_REF_REQUIRED", "实验验证等级必须提供后续实验引用 experiment_ref");
    }
    const payload = {
      new_level: input.new_level,
      method: input.method,
      validated_by: input.validated_by,
      validated_at: this.#clock(),
      evidence: input.evidence,
    };
    const embedding = this.#embeddings.get(claim.payload.embedding_ref);
    const run = this.#requireRun(embedding.payload.run_ref);
    return this.#append(
      this.#build({
        type: EVENT_TYPES.CLAIM_VALIDATED,
        aggregateType: AGGREGATE_TYPES.BIOLOGICAL_CLAIM,
        aggregateId: claimId,
        payload,
        summary: `主张验证等级提升：${claim.level} → ${input.new_level}（${input.method}）`,
        causationId: claim.history[claim.history.length - 1].event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /* ------------------------------ 命令：模型卡与图表 ------------------------------ */

  publishModelCard(input = {}) {
    const run = this.#requireRun(input.run_ref);
    this.#assertRunUsableForNewArtifact(run, "模型卡");
    const embedding = this.#embeddings.get(input.embedding_ref);
    if (!embedding || embedding.payload.run_ref !== input.run_ref) {
      throw new RegistryError("EMBEDDING_RUN_MISMATCH", "嵌入不属于该运行");
    }
    const dedupeKey = `${input.run_ref}|${input.embedding_ref}`;
    if (this.#cards.has(dedupeKey)) return this.#cards.get(dedupeKey);

    const level = this.#cardLevelFor(input.embedding_ref);
    const payload = {
      run_ref: input.run_ref,
      embedding_ref: input.embedding_ref,
      intended_uses: input.intended_uses,
      out_of_scope_uses: input.out_of_scope_uses,
      validation_level: level,
      provenance: this.#provenanceChecksums(run, embedding),
      ...(input.warnings ? { warnings: input.warnings } : {}),
    };
    const id = input.id ?? this.#newAggregateId(CARD_PREFIX);
    return this.#append(
      this.#build({
        type: EVENT_TYPES.MODEL_CARD_PUBLISHED,
        aggregateType: AGGREGATE_TYPES.MODEL_CARD,
        aggregateId: id,
        payload,
        summary: `模型卡发布：${input.run_ref}（验证等级 ${level}）`,
        causationId: embedding.event.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /**
   * 发布图表。图表验证等级取其所引主张中的最低值（保守原则）；
   * 点开图表得到的溯源包在发布时即被校验值冻结。
   */
  publishFigure(input = {}) {
    const run = this.#requireRun(input.run_ref);
    this.#assertRunUsableForNewArtifact(run, "图表");
    const embedding = this.#embeddings.get(input.embedding_ref);
    if (!embedding || embedding.payload.run_ref !== input.run_ref) {
      throw new RegistryError("EMBEDDING_RUN_MISMATCH", "嵌入不属于该运行");
    }
    for (const claimId of input.claim_refs ?? []) {
      const claim = this.#requireClaim(claimId);
      if (claim.payload.embedding_ref !== input.embedding_ref) {
        throw new RegistryError("CLAIM_EMBEDDING_MISMATCH", `主张 ${claimId} 不属于该嵌入，不能并入图表`);
      }
    }
    const level = (input.claim_refs ?? []).reduce(
      (min, claimId) => {
        const idx = VALIDATION_LEVEL_ORDER.indexOf(this.#requireClaim(claimId).level);
        return idx < VALIDATION_LEVEL_ORDER.indexOf(min) ? this.#requireClaim(claimId).level : min;
      },
      "experimental_validation"
    );
    const finalLevel = (input.claim_refs ?? []).length === 0 ? "exploratory" : level;

    const id = input.id ?? this.#newAggregateId(FIGURE_PREFIX);
    const payload = {
      title: input.title,
      run_ref: input.run_ref,
      embedding_ref: input.embedding_ref,
      claim_refs: input.claim_refs ?? [],
      provenance: {
        analysis_ref: run.payload.analysis_ref,
        ...this.#provenanceChecksums(run, embedding),
      },
      validation_level: finalLevel,
      ...(input.artifact_uri ? { artifact_uri: input.artifact_uri } : {}),
    };
    return this.#append(
      this.#build({
        type: EVENT_TYPES.FIGURE_PUBLISHED,
        aggregateType: AGGREGATE_TYPES.FIGURE,
        aggregateId: id,
        payload,
        summary: `图表发布：${input.title}（验证等级 ${finalLevel}）`,
        causationId: embedding.event.event_id,
        correlationId: run.payload.analysis_ref,
        producer: input.producer,
      })
    );
  }

  /* ------------------------------ 命令：撤回与升级 ------------------------------ */

  /**
   * 注释升级：在旧词表/同源组聚合上追加标记，new_ref 指向新冻结版本。
   * 受影响运行/主张/图表自动计算；历史不删除，只标记。
   */
  upgradeAnnotation(oldAggregateId, input = {}) {
    const kind = this.#vocabularies.has(oldAggregateId)
      ? AGGREGATE_TYPES.GENE_VOCABULARY
      : this.#orthologies.has(oldAggregateId)
        ? AGGREGATE_TYPES.ORTHOLOGY_SET
        : null;
    if (!kind) throw new RegistryError("UNKNOWN_ANNOTATION", `未找到词表/同源组：${oldAggregateId}`);

    const store = kind === AGGREGATE_TYPES.GENE_VOCABULARY ? this.#vocabularies : this.#orthologies;
    const next = store.get(input.new_ref.aggregate_id);
    if (!next) throw new RegistryError("UNKNOWN_NEW_REF", `升级目标未冻结：${input.new_ref.aggregate_id}`);
    this.#assertRefChecksum(input.new_ref, next.payload.checksum, kind === "gene_vocabulary" ? "词表" : "同源组");

    const autoAffected = this.#affectedByAnnotation(oldAggregateId);
    const affected = this.#mergeAffected(autoAffected, input.affected);
    const payload = {
      new_ref: input.new_ref,
      reason: input.reason,
      affected,
    };
    const event = this.#build({
      type: EVENT_TYPES.ANNOTATION_UPGRADED,
      aggregateType: kind,
      aggregateId: oldAggregateId,
      payload,
      summary: `注释升级：${oldAggregateId} → ${input.new_ref.aggregate_id}（${input.reason}）`,
      producer: input.producer,
    });
    const appended = this.#append(event);
    // 标记旧版本已被取代（若冻结时未通过 supersedes 声明）。
    const old = store.get(oldAggregateId);
    if (!old.supersededBy) old.supersededBy = input.new_ref.aggregate_id;
    return appended;
  }

  /**
   * 来源撤回：标记受影响运行与结论；已发表事件全部保留可复查。
   */
  withdrawSource(datasetId, input = {}) {
    const dataset = this.#datasets.get(datasetId);
    if (!dataset) throw new RegistryError("UNKNOWN_DATASET", `数据集不存在：${datasetId}`);
    const autoAffected = this.#affectedByDataset(datasetId);
    const affected = this.#mergeAffected(autoAffected, input.affected, {
      retained_history_note:
        "受影响运行与结论仅被标记，事件日志与已发表历史完整保留，可随时复查复跑。",
    });
    return this.#append(
      this.#build({
        type: EVENT_TYPES.SOURCE_WITHDRAWN,
        aggregateType: AGGREGATE_TYPES.DATASET_RELEASE,
        aggregateId: datasetId,
        payload: { reason: input.reason, affected },
        summary: `来源撤回：${datasetId}（${input.reason}）；受影响运行 ${affected.affected_run_refs.length} 个、主张 ${affected.affected_claim_refs.length} 条`,
        producer: input.producer,
      })
    );
  }

  /* ------------------------------ 标记的实际投影 ------------------------------ */

  #addMarker(map, key, marker) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(marker);
  }

  #applyUpgradeMarker(event) {
    const marker = {
      kind: "annotation_upgraded",
      reason: event.payload.reason,
      new_ref: event.payload.new_ref,
      since_event: event.event_id,
      at: event.occurred_at,
    };
    const { affected_run_refs: runs, affected_claim_refs: claims, affected_figure_refs: figures } =
      event.payload.affected;
    runs.forEach((runId) => this.#addMarker(this.#runMarkers, runId, marker));
    claims.forEach((claimId) => this.#addMarker(this.#claimMarkers, claimId, marker));
    figures.forEach((figId) => this.#addMarker(this.#figureMarkers, figId, marker));
  }

  #applyWithdrawalMarker(event) {
    const marker = {
      kind: "source_withdrawn",
      dataset_id: event.aggregate_id,
      reason: event.payload.reason,
      since_event: event.event_id,
      at: event.occurred_at,
    };
    const { affected_run_refs: runs, affected_claim_refs: claims, affected_figure_refs: figures } =
      event.payload.affected;
    runs.forEach((runId) => this.#addMarker(this.#runMarkers, runId, marker));
    claims.forEach((claimId) => this.#addMarker(this.#claimMarkers, claimId, marker));
    figures.forEach((figId) => this.#addMarker(this.#figureMarkers, figId, marker));
  }

  #chainForRun(runId) {
    const embeddingIds = [...this.#embeddings.values()]
      .filter((emb) => emb.payload.run_ref === runId)
      .map((emb) => emb.id);
    const claimIds = [...this.#claims.values()]
      .filter((claim) => embeddingIds.includes(claim.payload.embedding_ref))
      .map((claim) => claim.id);
    const figureIds = [...this.#figures.values()]
      .filter((fig) => fig.payload.run_ref === runId).map((fig) => fig.id);
    return { embeddingIds, claimIds, figureIds };
  }

  #affectedByDataset(datasetId) {
    const runIds = [...this.#runs.values()]
      .filter((run) => run.payload.dataset_refs.some((ref) => ref.aggregate_id === datasetId))
      .map((run) => run.id);
    return this.#affectRuns(runIds);
  }

  #affectedByAnnotation(annotationId) {
    const runIds = [...this.#runs.values()]
      .filter(
        (run) =>
          run.payload.vocabulary_ref.aggregate_id === annotationId ||
          run.payload.orthology_ref.aggregate_id === annotationId
      )
      .map((run) => run.id);
    return this.#affectRuns(runIds);
  }

  #affectRuns(runIds) {
    const claimIds = [];
    const figureIds = [];
    for (const runId of runIds) {
      const chain = this.#chainForRun(runId);
      claimIds.push(...chain.claimIds);
      figureIds.push(...chain.figureIds);
    }
    return {
      affected_run_refs: [...new Set(runIds)],
      affected_claim_refs: [...new Set(claimIds)],
      affected_figure_refs: [...new Set(figureIds)],
    };
  }

  #mergeAffected(auto, manual = {}, extra = {}) {
    return {
      affected_run_refs: [...new Set([...(auto.affected_run_refs ?? []), ...(manual.affected_run_refs ?? [])])],
      affected_claim_refs: [...new Set([...(auto.affected_claim_refs ?? []), ...(manual.affected_claim_refs ?? [])])],
      affected_figure_refs: [
        ...new Set([...(auto.affected_figure_refs ?? []), ...(manual.affected_figure_refs ?? [])]),
      ],
      ...(manual.retained_history_note ? { retained_history_note: manual.retained_history_note } : {}),
      ...extra,
    };
  }

  /* --------------------------------- 查询 --------------------------------- */

  events({ aggregateId } = {}) {
    const log = aggregateId ? this.#events.filter((e) => e.aggregate_id === aggregateId) : this.#events;
    return log.map((event) => structuredClone(event));
  }

  getRun(runId, viewer) {
    const run = this.#requireRun(runId);
    this.#assertVisible(run, viewer);
    return structuredClone({
      id: run.id,
      status: run.status,
      payload: run.payload,
      registered_at: run.registeredEvent.occurred_at,
      completed_at: run.completedEvent?.occurred_at ?? null,
      markers: this.#runMarkers.get(runId) ?? [],
    });
  }

  /** 保密期内的竞争结果允许并存：按项目列出，未授权方只见占位。 */
  listRuns(viewer) {
    return [...this.#runs.values()].map((run) => {
      const visible = this.#canSee(run, viewer);
      if (visible) {
        return {
          run_id: run.id,
          lab: run.payload.lab,
          project_id: run.payload.project_id,
          status: run.status,
          embargoed: Boolean(run.payload.embargo),
          markers: (this.#runMarkers.get(run.id) ?? []).map((m) => m.kind),
        };
      }
      return { run_id: run.id, status: "redacted", embargoed: true, note: "保密期内其他实验室的竞争结果，元数据暂不公开" };
    });
  }

  getClaim(claimId) {
    const claim = this.#requireClaim(claimId);
    return structuredClone({
      id: claim.id,
      statement: claim.payload.statement,
      level: claim.level,
      recorded_by: claim.payload.recorded_by,
      embedding_ref: claim.payload.embedding_ref,
      caveats: claim.payload.caveats ?? [],
      history: claim.history.map((e) => ({
        event_id: e.event_id,
          type: e.event_type,
          at: e.occurred_at,
          ...(e.event_type === "CLAIM_VALIDATED"
            ? {
                from_to: [
                  VALIDATION_LEVEL_ORDER[VALIDATION_LEVEL_ORDER.indexOf(e.payload.new_level) - 1],
                  e.payload.new_level,
                ],
                method: e.payload.method,
                independent: e.payload.validated_by.independent,
                evidence: e.payload.evidence,
              }
            : {}),
      })),
      markers: this.#claimMarkers.get(claimId) ?? [],
    });
  }

  /**
   * 图表点开即得的溯源包：分析、数据、词表、同源组、配置、代码、
   * 权重、嵌入的校验值与验证等级，以及撤回/升级警示。
   */
  figureProvenance(figureId, viewer) {
    const figure = this.#figures.get(figureId);
    if (!figure) throw new RegistryError("UNKNOWN_FIGURE", `图表不存在：${figureId}`);
    const run = this.#requireRun(figure.payload.run_ref);
    this.#assertVisible(run, viewer);

    const embedding = this.#embeddings.get(figure.payload.embedding_ref);
    const datasets = figure.payload.provenance.dataset_refs.map((ref) => {
      const d = this.#datasets.get(ref.aggregate_id);
      return {
        dataset_id: ref.aggregate_id,
        lab: d.payload.lab,
        species: d.payload.species,
        tissue: d.payload.tissue,
        sample_consent: d.payload.sample_consent,
        human_subject: d.payload.human_subject,
        access_tier: d.payload.access_tier,
        access_restrictions: d.payload.access_restrictions ?? [],
        quality_control: d.payload.quality_control,
        checksum: d.payload.checksum,
        ...(d.withdrawn ? { withdrawn: { reason: d.withdrawn.reason, at: d.withdrawn.event.occurred_at } } : {}),
      };
    });
    const vocab = this.#vocabularies.get(figure.payload.provenance.vocabulary_ref.aggregate_id);
    const orthology = this.#orthologies.get(figure.payload.provenance.orthology_ref.aggregate_id);

    return structuredClone({
      figure_id: figureId,
      title: figure.payload.title,
      validation_level: figure.payload.validation_level,
      analysis: this.#analyses.get(figure.payload.provenance.analysis_ref)?.payload ?? null,
      datasets,
      vocabulary: {
        vocabulary_id: vocab.id,
        name: vocab.payload.name,
        version: vocab.payload.vocab_version,
        source_release: vocab.payload.source_release,
        checksum: vocab.payload.checksum,
        ...(vocab.supersededBy ? { superseded_by: vocab.supersededBy } : {}),
      },
      orthology: {
        orthology_id: orthology.id,
        name: orthology.payload.name,
        mapping_version: orthology.payload.mapping_version,
        source: orthology.payload.source,
        checksum: orthology.payload.checksum,
        ...(orthology.supersededBy ? { superseded_by: orthology.supersededBy } : {}),
      },
      config_checksum: figure.payload.provenance.config_checksum,
      code: run.payload.code,
      weights_checksum: figure.payload.provenance.weights_checksum,
      embedding_checksum: figure.payload.provenance.embedding_checksum,
      claims: figure.payload.claim_refs.map((claimId) => this.getClaim(claimId)),
      markers: dedupeMarkers([
        ...(this.#runMarkers.get(run.id) ?? []),
        ...(this.#figureMarkers.get(figureId) ?? []),
      ]),
      published_event: figure.event.event_id,
    });
  }

  /** 模型卡数据（交给 modelCard.js 渲染）。 */
  modelCardData(cardOrRunId, viewer) {
    const cardEvent =
      this.#events.find(
        (e) =>
          e.event_type === EVENT_TYPES.MODEL_CARD_PUBLISHED &&
          (e.aggregate_id === cardOrRunId || e.payload.run_ref === cardOrRunId)
      ) ?? null;
    if (!cardEvent) throw new RegistryError("UNKNOWN_CARD", `模型卡不存在：${cardOrRunId}`);
    const run = this.#requireRun(cardEvent.payload.run_ref);
    this.#assertVisible(run, viewer);
    const embedding = this.#embeddings.get(cardEvent.payload.embedding_ref);
    const datasets = cardEvent.payload.provenance.dataset_refs.map((ref) => {
      const d = this.#datasets.get(ref.aggregate_id);
      return {
        dataset_id: ref.aggregate_id,
        lab: d.payload.lab,
        species: d.payload.species,
        tissue: d.payload.tissue,
        sample_consent: d.payload.sample_consent,
        human_subject: d.payload.human_subject,
        access_tier: d.payload.access_tier,
        access_restrictions: d.payload.access_restrictions ?? [],
        quality_control: d.payload.quality_control,
        checksum: d.payload.checksum,
        ...(d.withdrawn ? { withdrawn: { reason: d.withdrawn.reason } } : {}),
      };
    });
    const vocab = this.#vocabularies.get(cardEvent.payload.provenance.vocabulary_ref.aggregate_id);
    const orthology = this.#orthologies.get(cardEvent.payload.provenance.orthology_ref.aggregate_id);
    const claims = [...this.#claims.values()]
      .filter((c) => c.payload.embedding_ref === cardEvent.payload.embedding_ref)
      .map((c) => this.getClaim(c.id));
    return structuredClone({
      card_id: cardEvent.aggregate_id,
      run: this.getRun(cardEvent.payload.run_ref, viewer),
      validation_level: cardEvent.payload.validation_level,
      intended_uses: cardEvent.payload.intended_uses,
      out_of_scope_uses: cardEvent.payload.out_of_scope_uses,
      warnings: cardEvent.payload.warnings ?? [],
      datasets,
      vocabulary: {
        vocabulary_id: vocab.id,
        name: vocab.payload.name,
        version: vocab.payload.vocab_version,
        source_release: vocab.payload.source_release,
        checksum: vocab.payload.checksum,
        ...(vocab.supersededBy ? { superseded_by: vocab.supersededBy } : {}),
      },
      orthology: {
        orthology_id: orthology.id,
        name: orthology.payload.name,
        mapping_version: orthology.payload.mapping_version,
        source: orthology.payload.source,
        checksum: orthology.payload.checksum,
        ...(orthology.supersededBy ? { superseded_by: orthology.supersededBy } : {}),
      },
      config_checksum: cardEvent.payload.provenance.config_checksum,
      code: run.payload.code,
      weights_checksum: cardEvent.payload.provenance.weights_checksum,
      embedding: {
        embedding_id: embedding.id,
        checksum: embedding.payload.checksum,
        dimensionality: embedding.payload.dimensionality ?? null,
      },
      claims,
      markers: this.#runMarkers.get(run.id) ?? [],
      published_at: cardEvent.occurred_at,
      published_event: cardEvent.event_id,
    });
  }

  /* --------------------------------- 内部规则 --------------------------------- */

  #requireRun(runId) {
    const run = this.#runs.get(runId);
    if (!run) throw new RegistryError("UNKNOWN_RUN", `运行不存在：${runId}`);
    return run;
  }

  #requireClaim(claimId) {
    const claim = this.#claims.get(claimId);
    if (!claim) throw new RegistryError("UNKNOWN_CLAIM", `主张不存在：${claimId}`);
    return claim;
  }

  #requireExistingRef(ref, expectedType, label) {
    if (!ref || typeof ref.aggregate_id !== "string") {
      throw new RegistryError("BAD_REF", `${label}：引用必须包含 aggregate_id`);
    }
    const agg = this.#aggregates.get(ref.aggregate_id);
    if (!agg) throw new RegistryError("UNKNOWN_REF", `${label} 引用了不存在的对象：${ref.aggregate_id}`);
    if (agg.type !== expectedType) {
      throw new RegistryError("BAD_REF_TYPE", `${label}：${ref.aggregate_id} 是 ${agg.type}，期望 ${expectedType}`);
    }
    return agg;
  }

  #requireFrozenRef(ref, store, aggregateType, label) {
    this.#requireExistingRef(ref, aggregateType, label);
    const frozen = store.get(ref.aggregate_id);
    this.#assertRefChecksum(ref, frozen.payload.checksum, label);
    if (frozen.supersededBy) {
      throw new RegistryError(
        "ANNOTATION_SUPERSEDED",
        `${label} ${ref.aggregate_id} 已被 ${frozen.supersededBy} 取代；新运行必须引用当前冻结版本（复现历史请用当时版本另建运行并注明复现目的）`
      );
    }
  }

  #assertRefChecksum(ref, expectedChecksum, label) {
    if (ref.checksum && ref.checksum.value !== expectedChecksum.value) {
      throw new RegistryError(
        "CHECKSUM_MISMATCH",
        `${label} ${ref.aggregate_id} 引用校验值与冻结值不一致——请确认引用的是不是当时版本`
      );
    }
  }

  #assertAuthorized(projectId, datasetId) {
    const grants = this.#grants.get(`${projectId}|${datasetId}`) ?? [];
    const now = this.#clock();
    const valid = grants
      .filter((e) => e.occurred_at <= now)
      .filter((e) => !e.payload.expires_at || e.payload.expires_at > now)
      .filter((e) => e.payload.dataset_refs.some((ref) => ref.aggregate_id === datasetId));
    if (valid.length === 0) {
      throw new RegistryError(
        "ACCESS_DENIED",
        `项目 ${projectId} 未获得数据集 ${datasetId} 的有效授权；受控/人类原始数据不得流向无授权项目`
      );
    }
  }

  #canSee(run, viewer) {
    if (!viewer) return !run.payload.embargo;
    if (viewer.auditor) return true; // 研究所审查视角可看全部
    if (!run.payload.embargo) return true;
    const project = viewer.project;
    return (
      project === run.payload.embargo.owner_project ||
      (run.payload.embargo.visible_to_projects ?? []).includes(project)
    );
  }

  #assertVisible(run, viewer) {
    if (!this.#canSee(run, viewer)) {
      throw new RegistryError(
        "EMBARGOED",
        `运行 ${run.id} 处于保密期，仅 ${run.payload.embargo.owner_project} 及授权项目可见`
      );
    }
  }

  #assertRunUsableForNewArtifact(run, artifactLabel) {
    const markers = this.#runMarkers.get(run.id) ?? [];
    if (markers.length > 0) {
      const withdrawn = markers.find((m) => m.kind === "source_withdrawn");
      const upgraded = markers.find((m) => m.kind === "annotation_upgraded");
      if (withdrawn) {
        throw new RegistryError(
          "RUN_SOURCE_WITHDRAWN",
          `${artifactLabel} 引用的运行 ${run.id} 已因来源撤回被标记（${withdrawn.reason}）；历史产物保留复查，但不得据此发布新产物`
        );
      }
      if (upgraded) {
        throw new RegistryError(
          "RUN_ANNOTATION_UPGRADED",
          `${artifactLabel} 引用的运行 ${run.id} 使用的注释已升级至 ${upgraded.new_ref.aggregate_id}；请用新冻结版本重跑后再发布`
        );
      }
    }
  }

  #provenanceChecksums(run, embedding) {
    return {
      dataset_refs: run.payload.dataset_refs,
      vocabulary_ref: run.payload.vocabulary_ref,
      orthology_ref: run.payload.orthology_ref,
      config_checksum: run.payload.training_config.checksum,
      code_checksum: run.payload.code.checksum,
      weights_checksum: run.completedEvent.payload.weights.checksum,
      embedding_checksum: embedding.payload.checksum,
    };
  }

  #cardLevelFor(embeddingId) {
    const levels = [...this.#claims.values()]
      .filter((claim) => claim.payload.embedding_ref === embeddingId)
      .map((claim) => claim.level);
    if (levels.length === 0) return "exploratory";
    return levels.reduce((max, level) => {
      const i = VALIDATION_LEVEL_ORDER.indexOf(level);
      const j = VALIDATION_LEVEL_ORDER.indexOf(max);
      return i > j ? level : max;
    }, "exploratory");
  }
}
