import { randomUUID } from "node:crypto";

import { project } from "./projections.js";
import { buildModelCard } from "./model-card.js";

export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

/**
 * 登记应用服务。所有跨物种分析先登记再引用：
 * 数据集、基因词表、同源组、训练配置/代码/权重都在此以事件信封落账。
 */
export class Registry {
  /**
   * @param {import("./store/event-store.js").EventStore} store
   */
  constructor(store) {
    this.store = store;
  }

  _overview() {
    return project(this.store.allEvents());
  }

  _append(input, opts) {
    return this.store.append(input, opts).event;
  }

  // ---------- 数据集 ----------

  registerDataset(input, actor) {
    const id = input.id ?? `dataset-${randomUUID()}`;
    return this._append({
      event_type: "DATASET_REGISTERED",
      aggregate_type: "dataset_release",
      aggregate_id: id,
      correlation_id: input.correlation_id,
      actor,
      summary: input.summary ?? `登记数据集：${input.species} / ${input.tissue}（${input.lab}）`,
      payload: {
        lab: input.lab,
        tissue: input.tissue,
        species: input.species,
        human_raw_data: input.human_raw_data ?? false,
        consent: input.consent,
        quality_control: input.quality_control,
        access: input.access,
        source_uri: input.source_uri,
        content_sha256: input.content_sha256,
      },
    });
  }

  // ---------- 词表与同源组：分别冻结 ----------

  freezeVocabulary(input, actor) {
    const id = input.id ?? `vocab-${randomUUID()}`;
    return this._append({
      event_type: "VOCABULARY_FROZEN",
      aggregate_type: "gene_vocabulary",
      aggregate_id: id,
      actor,
      summary: `冻结基因词表 ${input.name}@${input.version}（sha256 ${input.content_sha256.slice(0, 12)}…）`,
      payload: {
        name: input.name,
        version: input.version,
        content_sha256: input.content_sha256,
        source_uri: input.source_uri,
        entry_count: input.entry_count,
      },
    });
  }

  freezeOrthologSet(input, actor) {
    const id = input.id ?? `ortho-${randomUUID()}`;
    return this._append({
      event_type: "ORTHOLOG_FROZEN",
      aggregate_type: "ortholog_set",
      aggregate_id: id,
      actor,
      summary: `冻结同源映射 ${input.name}@${input.version}（sha256 ${input.content_sha256.slice(0, 12)}…）`,
      payload: {
        name: input.name,
        version: input.version,
        content_sha256: input.content_sha256,
        source_uri: input.source_uri,
        species_covered: input.species_covered,
        group_count: input.group_count,
      },
    });
  }

  // ---------- 访问授权：人类原始数据闸门 ----------

  grantAccess(input, actor) {
    const ov = this._overview();
    const dataset = ov.datasets.get(input.dataset_id);
    if (!dataset) throw new RegistryError("DATASET_NOT_FOUND", `数据集不存在：${input.dataset_id}`);

    // 人类原始数据不得流向无授权项目：raw 授权必须显式登记且由受控方批准。
    if (dataset.human_raw_data && input.scope === "raw") {
      if (!input.granted_by) throw new RegistryError("AUTHORIZATION_REQUIRED", "人类原始数据的 raw 访问必须记录批准方");
      if (dataset.access.tier === "restricted" && !input.embargo_until && !input.expires_at) {
        throw new RegistryError("AUTHORIZATION_BOUNDARY_REQUIRED", "受限层人类原始数据授权必须给出 expires_at 或 embargo_until 边界");
      }
    }
    // 撤回数据集不再发放任何授权。
    if (dataset.withdrawn) throw new RegistryError("SOURCE_WITHDRAWN", `数据集 ${input.dataset_id} 已撤回，不能发放新授权`);

    const id = input.id ?? `grant-${randomUUID()}`;
    return this._append({
      event_type: "ACCESS_GRANTED",
      aggregate_type: "access_grant",
      aggregate_id: id,
      actor,
      summary: `项目 ${input.project_id} 获得 ${input.dataset_id} 的 ${input.scope} 访问`,
      payload: {
        dataset_id: input.dataset_id,
        project_id: input.project_id,
        scope: input.scope,
        granted_by: input.granted_by,
        expires_at: input.expires_at,
        embargo_until: input.embargo_until,
      },
    });
  }

  /** 运行前授权检查：项目对用到的每个数据集都要有满足 scope 的有效授权。 */
  _assertAuthorized(ov, datasetIds, projectId, at = new Date()) {
    for (const datasetId of datasetIds) {
      const dataset = ov.datasets.get(datasetId);
      if (!dataset) throw new RegistryError("DATASET_NOT_FOUND", `数据集不存在：${datasetId}`);
      if (dataset.withdrawn) throw new RegistryError("SOURCE_WITHDRAWN", `数据集 ${datasetId} 已撤回，不得用于新运行`);
      if (dataset.access.tier === "open") continue;

      // metadata 级授权永远不足以把数据投入训练；
      // 人类原始数据必须 raw 级；非人类受控数据 derivatives 级即可。
      const grant = ov.grants.find(
        (g) =>
          g.dataset_id === datasetId &&
          g.project_id === projectId &&
          (g.scope === "raw" || (!dataset.human_raw_data && g.scope === "derivatives"))
      );
      if (!grant) {
        throw new RegistryError("ACCESS_DENIED", `项目 ${projectId} 对数据集 ${datasetId} 缺少有效授权`);
      }
      const now = at instanceof Date ? at : new Date(at);
      if (grant.expires_at && new Date(grant.expires_at).getTime() < now.getTime()) {
        throw new RegistryError("ACCESS_EXPIRED", `项目 ${projectId} 对 ${datasetId} 的授权已过期`);
      }
    }
  }

  // ---------- 训练运行：幂等登记 + 分片检查点 ----------

  /**
   * 登记训练运行。重复回调携带同一 idempotency_key 时返回首次事件，绝不产生第二个运行。
   */
  registerRun(input, actor) {
    if (!input.idempotency_key) throw new RegistryError("IDEMPOTENCY_KEY_REQUIRED", "训练运行登记必须携带 idempotency_key");
    const existing = this.store.allEvents().find((e) => e.idempotency_key === input.idempotency_key);
    if (existing) return existing;

    const ov = this._overview();
    for (const id of input.dataset_ids) if (!ov.datasets.has(id)) throw new RegistryError("DATASET_NOT_FOUND", `数据集不存在：${id}`);
    if (!ov.vocabularies.has(input.vocabulary_id)) throw new RegistryError("VOCAB_NOT_FOUND", `基因词表不存在：${input.vocabulary_id}`);
    if (!ov.orthologSets.has(input.ortholog_set_id)) throw new RegistryError("ORTHOLOG_NOT_FOUND", `同源组不存在：${input.ortholog_set_id}`);
    if (ov.vocabularies.get(input.vocabulary_id).withdrawn || ov.orthologSets.get(input.ortholog_set_id).withdrawn) {
      throw new RegistryError("SOURCE_WITHDRAWN", "被撤回的词表/同源组不得用于新运行");
    }
    this._assertAuthorized(ov, input.dataset_ids, input.project_id);

    const runId = input.run_id ?? `run-${randomUUID()}`;
    return this._append(
      {
        event_type: "RUN_REGISTERED",
        aggregate_type: "model_run",
        aggregate_id: runId,
        idempotency_key: input.idempotency_key,
        correlation_id: input.correlation_id,
        actor,
        summary: `项目 ${input.project_id} 登记训练运行（${input.dataset_ids.length} 个数据集，${input.training.shard_count} 分片）`,
        payload: {
          project_id: input.project_id,
          dataset_ids: input.dataset_ids,
          vocabulary_id: input.vocabulary_id,
          ortholog_set_id: input.ortholog_set_id,
          training: input.training,
          embargo_until: input.embargo_until,
          expected_species: input.expected_species,
        },
      },
      { expectedVersion: 0 }
    );
  }

  recordCheckpoint(runId, cp, actor) {
    const ov = this._overview();
    const run = ov.runs.get(runId);
    if (!run) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${runId}`);
    if (run.status !== "registered") throw new RegistryError("RUN_NOT_RUNNING", `运行 ${runId} 状态为 ${run.status}，不能再写检查点`);
    if (cp.shard_index >= run.training.shard_count) throw new RegistryError("BAD_SHARD", "分片序号越界");
    // 检查点按 (run, shard) 幂等：重复回调同一校验值不追加第二个事件。
    const prev = run.checkpoints.get(cp.shard_index);
    if (prev && prev.checkpoint_sha256 === cp.checkpoint_sha256) {
      return this.store.readStream("model_run", runId).find((e) => e.event_type === "CHECKPOINT_RECORDED" && e.payload.shard_index === cp.shard_index);
    }
    if (prev && prev.checkpoint_sha256 !== cp.checkpoint_sha256) {
      throw new RegistryError("CHECKPOINT_CONFLICT", `分片 ${cp.shard_index} 已有不同检查点；长训练恢复必须续写而非改写`);
    }
    return this._append({
      event_type: "CHECKPOINT_RECORDED",
      aggregate_type: "model_run",
      aggregate_id: runId,
      causation_id: prev?.event_id,
      actor,
      summary: `运行 ${runId} 分片 ${cp.shard_index}/${run.training.shard_count} 检查点`,
      payload: {
        shard_index: cp.shard_index,
        shard_count: run.training.shard_count,
        checkpoint_sha256: cp.checkpoint_sha256,
        metrics: cp.metrics,
      },
    });
  }

  /** 长训练从检查点恢复：返回尚未完成的分片序号（升序），不新建运行。 */
  resumePlan(runId) {
    const ov = this._overview();
    const run = ov.runs.get(runId);
    if (!run) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${runId}`);
    const done = new Set(run.checkpoints.keys());
    return { run_id: runId, status: run.status, remaining_shards: [...Array(run.training.shard_count).keys()].filter((i) => !done.has(i)) };
  }

  completeRun(runId, { final_weights_sha256, metrics }, actor) {
    const ov = this._overview();
    const run = ov.runs.get(runId);
    if (!run) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${runId}`);
    if (run.status === "completed") {
      return this.store.readStream("model_run", runId).find((e) => e.event_type === "RUN_COMPLETED");
    }
    return this._append({
      event_type: "RUN_COMPLETED",
      aggregate_type: "model_run",
      aggregate_id: runId,
      actor,
      summary: `运行 ${runId} 完成`,
      payload: { final_weights_sha256, metrics },
    });
  }

  failRun(runId, { final_weights_sha256 = "pending", reason }, actor) {
    const ov = this._overview();
    if (!ov.runs.has(runId)) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${runId}`);
    return this._append({
      event_type: "RUN_FAILED",
      aggregate_type: "model_run",
      aggregate_id: runId,
      actor,
      summary: `运行 ${runId} 失败：${reason}`,
      payload: { final_weights_sha256, reason },
    });
  }

  // ---------- 嵌入与主张：三种状态严格分列 ----------

  publishEmbedding(input, actor) {
    const ov = this._overview();
    if (!ov.runs.has(input.run_id)) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${input.run_id}`);
    const id = input.id ?? `emb-${randomUUID()}`;
    return this._append({
      event_type: "EMBEDDING_PUBLISHED",
      aggregate_type: "embedding",
      aggregate_id: id,
      correlation_id: input.correlation_id,
      actor,
      summary: `发布${input.status === "exploratory" ? "探索性" : "冻结"}嵌入 ${id}`,
      payload: {
        run_id: input.run_id,
        artifact_sha256: input.artifact_sha256,
        status: input.status,
        species_covered: input.species_covered,
      },
    });
  }

  /** 记录主张。初始状态只能是探索线索或待验证推断；不能一记录就写成 validated。 */
  recordClaim(input, actor) {
    const ov = this._overview();
    const run = ov.runs.get(input.run_id);
    if (!run) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${input.run_id}`);
    if (!["exploratory_hint", "proposed"].includes(input.status)) {
      throw new RegistryError("ILLEGAL_CLAIM_STATUS", "新主张只能是 exploratory_hint 或 proposed；验证须走 validateClaim");
    }
    const id = input.id ?? `claim-${randomUUID()}`;
    return this._append({
      event_type: "CLAIM_RECORDED",
      aggregate_type: "biological_claim",
      aggregate_id: id,
      correlation_id: input.correlation_id,
      actor,
      summary: `记录${input.status === "exploratory_hint" ? "探索线索" : "推断主张"}：${input.statement.slice(0, 40)}…`,
      payload: {
        run_id: input.run_id,
        embedding_id: input.embedding_id,
        statement: input.statement,
        status: input.status,
      },
    });
  }

  validateClaim(claimId, { validation_level, evidence, validated_by }, actor) {
    const ov = this._overview();
    const claim = ov.claims.get(claimId);
    if (!claim) throw new RegistryError("CLAIM_NOT_FOUND", `主张不存在：${claimId}`);
    if (claim.status === "withdrawn") throw new RegistryError("CLAIM_WITHDRAWN", `主张 ${claimId} 已撤回`);
    return this._append({
      event_type: "CLAIM_VALIDATED",
      aggregate_type: "biological_claim",
      aggregate_id: claimId,
      actor,
      summary: `主张 ${claimId} 达到验证等级 ${validation_level}`,
      payload: { validation_level, evidence, validated_by },
    });
  }

  demoteClaim(claimId, { to_status, reason }, actor) {
    const ov = this._overview();
    if (!ov.claims.has(claimId)) throw new RegistryError("CLAIM_NOT_FOUND", `主张不存在：${claimId}`);
    return this._append({
      event_type: "CLAIM_DEMOTED",
      aggregate_type: "biological_claim",
      aggregate_id: claimId,
      actor,
      summary: `主张 ${claimId} 降级为 ${to_status}：${reason.slice(0, 30)}…`,
      payload: { to_status, reason },
    });
  }

  // ---------- 撤回与注释升级：只标记受影响对象 ----------

  flagSource({ kind, target_type, target_id, reason, new_version_id, affected_run_ids }, actor) {
    const eventType = kind === "withdrawn" ? "SOURCE_WITHDRAWN" : "ANNOTATION_UPGRADED";
    const ov = this._overview();
    const map = { dataset_release: ov.datasets, gene_vocabulary: ov.vocabularies, ortholog_set: ov.orthologSets }[target_type];
    if (!map?.has(target_id)) throw new RegistryError("TARGET_NOT_FOUND", `${target_type} 不存在：${target_id}`);
    return this._append({
      event_type: eventType,
      aggregate_type: target_type,
      aggregate_id: target_id,
      actor,
      summary: `${kind === "withdrawn" ? "撤回" : "注释升级"} ${target_type} ${target_id}：${reason.slice(0, 30)}…`,
      payload: { target_type, target_id, reason, new_version_id, affected_run_ids },
    });
  }

  // ---------- 图表发布：溯源包强制可点开 ----------

  publishFigure(input, actor) {
    const ov = this._overview();
    for (const rid of input.run_ids) if (!ov.runs.has(rid)) throw new RegistryError("RUN_NOT_FOUND", `运行不存在：${rid}`);
    if (!ov.vocabularies.has(input.vocabulary_id)) throw new RegistryError("VOCAB_NOT_FOUND", `词表不存在：${input.vocabulary_id}`);
    if (!ov.orthologSets.has(input.ortholog_set_id)) throw new RegistryError("ORTHOLOG_NOT_FOUND", `同源组不存在：${input.ortholog_set_id}`);
    for (const cid of input.claim_ids) {
      if (!ov.claims.has(cid)) throw new RegistryError("CLAIM_NOT_FOUND", `主张不存在：${cid}`);
    }
    const id = input.id ?? `figure-${randomUUID()}`;
    return this._append({
      event_type: "FIGURE_PUBLISHED",
      aggregate_type: "figure",
      aggregate_id: id,
      correlation_id: input.correlation_id,
      actor,
      summary: `发布图表 ${id}（${input.run_ids.length} 个运行，${input.claim_ids.length} 条主张，溯源齐备）`,
      payload: {
        run_ids: input.run_ids,
        vocabulary_id: input.vocabulary_id,
        ortholog_set_id: input.ortholog_set_id,
        dataset_ids: input.dataset_ids,
        claim_ids: input.claim_ids,
        embedding_ids: input.embedding_ids ?? [],
        provenance: true,
      },
    });
  }

  /** 发布模型卡：从事件流派生内容并快照落账。 */
  publishModelCard(runId, applicability, actor) {
    const card = buildModelCard(this._overview(), runId, applicability);
    return this._append({
      event_type: "MODEL_CARD_PUBLISHED",
      aggregate_type: "model_card",
      aggregate_id: `card-${runId}`,
      actor,
      summary: `发布模型卡 card-${runId}（最高验证等级 ${card.validation_summary.highest_level ?? "无"}）`,
      payload: {
        run_id: runId,
        reproducibility: card.reproducibility,
        validation_summary: card.validation_summary,
        applicability: card.applicability,
      },
    });
  }
}
