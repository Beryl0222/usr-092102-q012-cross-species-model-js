/**
 * 模型卡构建（读侧派生）。
 * 输入 project() 得到的完整概览与 runId，输出足以复现并判断适用边界的模型卡：
 *  - reproducibility：数据/词表/同源组/配置/代码/权重/分片检查点的标识与校验值；
 *  - validation_summary：把探索线索、推断主张、已验证事实严格分列；
 *  - applicability：物种/组织范围、已知限制、来源撤回或注释升级带来的适用边界。
 * 模型卡也会作为 MODEL_CARD_PUBLISHED 事件快照持久化，但任何时候都能由事件流重新算出。
 */

const VALIDATION_ORDER = ["in_silico_reproduction", "independent_dataset", "wetlab_independent", "wetlab_preregistered"];

export class RegistryLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryLookupError";
  }
}

function refDataset(ov, id) {
  const d = ov.datasets.get(id);
  if (!d) throw new RegistryLookupError(`数据集不存在：${id}`);
  return {
    id,
    lab: d.lab,
    tissue: d.tissue,
    species: d.species,
    access_tier: d.access.tier,
    consent_basis: d.consent.basis,
    qc_status: d.quality_control.status,
    content_sha256: d.content_sha256 ?? null,
    withdrawn: d.withdrawn,
    superseded_by: d.superseded_by,
  };
}

function refFrozen(ov, kind, id) {
  const map = kind === "vocabulary" ? ov.vocabularies : ov.orthologSets;
  const label = kind === "vocabulary" ? "基因词表" : "同源组";
  const v = map.get(id);
  if (!v) throw new RegistryLookupError(`${label}不存在：${id}`);
  return {
    id,
    name: v.name,
    version: v.version,
    content_sha256: v.content_sha256,
    frozen_at: v.frozen_at,
    withdrawn: v.withdrawn,
    superseded_by: v.superseded_by,
  };
}

/**
 * @param {object} ov project() 结果
 * @param {string} runId
 * @param {{species_scope?: string[], tissue_scope?: string[], known_limits?: string[]}} [applicability]
 */
export function buildModelCard(ov, runId, applicability = {}) {
  const run = ov.runs.get(runId);
  if (!run) throw new RegistryLookupError(`运行不存在：${runId}`);

  const datasets = run.dataset_ids.map((id) => refDataset(ov, id));
  const vocabulary = refFrozen(ov, "vocabulary", run.vocabulary_id);
  const ortholog_set = refFrozen(ov, "ortholog_set", run.ortholog_set_id);

  const checkpoints = [...run.checkpoints.values()]
    .sort((a, b) => a.shard_index - b.shard_index)
    .map((c) => ({ shard_index: c.shard_index, checkpoint_sha256: c.checkpoint_sha256, metrics: c.metrics }));

  const relatedEmbeddings = [...ov.embeddings.values()].filter((e) => e.run_id === runId).map((e) => ({
    id: e.id,
    status: e.status,
    artifact_sha256: e.artifact_sha256,
    flagged: e.impact_flags.length > 0,
  }));

  const relatedClaims = [...ov.claims.values()].filter((c) => c.run_id === runId);
  const byStatus = (s) => relatedClaims.filter((c) => c.status === s);
  const validation_tiers = VALIDATION_ORDER.map((level) => ({
    level,
    claims: byStatus("validated").filter((c) => c.validation_level === level).map((c) => c.id),
  })).filter((t) => t.claims.length > 0);

  // 适用边界：自动收集 + 调用方补充。
  const known_limits = new Set(applicability.known_limits ?? []);
  if (validation_tiers.length === 0) {
    known_limits.add("本运行的全部主张均未通过实验验证；嵌入空间中的相似性只是计算线索，不得表述为生物学事实。");
  } else if (validation_tiers.every((t) => t.level === "in_silico_reproduction")) {
    known_limits.add("最高验证等级仅为计算复现（in_silico_reproduction）；跨物种相似性尚未经独立数据集或湿实验确认。");
  }
  for (const f of run.impact_flags) {
    if (f.kind === "withdrawn") known_limits.add(`来源 ${f.target_id} 已撤回（${f.reason}）；该运行结果仅可作为历史复查，不得用于新结论。`);
    if (f.kind === "upgraded")
      known_limits.add(`来源 ${f.target_id} 的注释已升级（新版本 ${f.new_version_id ?? "未知"}）；旧结果需用冻结词表 ${run.vocabulary_id} 语境解释。`);
  }
  if (datasets.some((d) => d.withdrawn)) known_limits.add("训练数据中包含已撤回数据集。");

  const speciesScope = applicability.species_scope ?? [...new Set(datasets.map((d) => d.species).concat(run.expected_species ?? []))];
  const tissueScope = applicability.tissue_scope ?? [...new Set(datasets.map((d) => d.tissue))];
  if (known_limits.size === 0) known_limits.add("无额外限制；仍须按引用的验证等级表述主张。");

  return {
    run_id: runId,
    generated_from_event_stream: true,
    run_status: run.status,
    reproducibility: {
      datasets,
      vocabulary,
      ortholog_set,
      config_sha256: run.training.config_sha256,
      code_sha256: run.training.code_sha256,
      initial_weights_sha256: run.training.weights_sha256,
      final_weights_sha256: run.final_weights_sha256,
      shard_count: run.training.shard_count,
      checkpoints,
      resumable: checkpoints.length > 0,
      resume_from_run: run.training.resume_from_run ?? null,
    },
    outputs: { embeddings: relatedEmbeddings },
    validation_summary: {
      exploratory_hints: byStatus("exploratory_hint").map((c) => ({ id: c.id, statement: c.statement })),
      proposed_claims: byStatus("proposed").map((c) => ({ id: c.id, statement: c.statement })),
      validated: byStatus("validated").map((c) => ({
        id: c.id,
        statement: c.statement,
        validation_level: c.validation_level,
        evidence: c.validation_evidence,
      })),
      refuted: byStatus("refuted").map((c) => c.id),
      withdrawn: byStatus("withdrawn").map((c) => c.id),
      validation_tiers,
      highest_level: validation_tiers.at(-1)?.level ?? null,
    },
    applicability: {
      species_scope: speciesScope,
      tissue_scope: tissueScope,
      known_limits: [...known_limits],
    },
    embargo_until: run.embargo_until,
    impact_flags: run.impact_flags,
  };
}

/**
 * 图表溯源包：点开图表即可取回它使用的词表、数据、配置与验证等级。
 */
export function resolveFigure(ov, figureId) {
  const fig = ov.figures.get(figureId);
  if (!fig) throw new RegistryLookupError(`图表不存在：${figureId}`);
  return {
    figure_id: fig.id,
    published_at: fig.published_at,
    datasets: fig.dataset_ids.map((id) => refDataset(ov, id)),
    vocabulary: refFrozen(ov, "vocabulary", fig.vocabulary_id),
    ortholog_set: refFrozen(ov, "ortholog", fig.ortholog_set_id),
    runs: fig.run_ids.map((rid) => {
      const r = ov.runs.get(rid);
      return {
        id: rid,
        project_id: r?.project_id,
        config_sha256: r?.training.config_sha256,
        code_sha256: r?.training.code_sha256,
        final_weights_sha256: r?.final_weights_sha256,
        status: r?.status,
        embargo_until: r?.embargo_until,
        impact_flags: r?.impact_flags ?? [],
      };
    }),
    embeddings: (fig.embedding_ids ?? []).map((id) => ov.embeddings.get(id)).filter(Boolean,
    ).map((e) => ({ id: e.id, status: e.status, artifact_sha256: e.artifact_sha256, flagged: e.impact_flags.length > 0 })),    claims: fig.claim_ids.map((cid) => {
      const c = ov.claims.get(cid);
      if (!c) throw new RegistryLookupError(`主张不存在：${cid}`);
      return {
        id: c.id,
        statement: c.statement,
        status: c.status,
        validation_level: c.validation_level,
        evidence: c.validation_evidence,
        impact_flags: c.impact_flags,
      };
    }),
    impact_flags: fig.impact_flags,
  };
}
