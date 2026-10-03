/**
 * 读模型投影：把追加式事件日志折叠成可查询的当前状态。
 * 纯函数，不改变事件；任何时候都可用 EventStore.allEvents() 完整重放重建。
 *
 * 关键语义：
 * - SOURCE_WITHDRAWN / ANNOTATION_UPGRADED 只在受影响的运行/嵌入/主张/图表上
 *   追加 impact_flags 标记，绝不删除或改写历史；
 * - 保密期（embargo）内的运行对其它项目不可见，但同一项目内可见——竞争结果并存；
 * - 嵌入结果、推断主张、实验验证在 claim.status / validation_level 上严格分列。
 */

function blankOverview() {
  return {
    datasets: new Map(),
    vocabularies: new Map(),
    orthologSets: new Map(),
    grants: [],
    runs: new Map(),
    embeddings: new Map(),
    claims: new Map(),
    figures: new Map(),
    modelCards: new Map(),
    notices: [], // 撤回/升级标记事件，按时间顺序
  };
}

function apply(ov, e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "DATASET_REGISTERED":
      ov.datasets.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        registered_at: e.occurred_at,
        withdrawn: false,
        withdrawn_reason: null,
        superseded_by: null,
        annotations: [], // {kind, reason, new_version_id, at, event_id}
      });
      break;

    case "VOCABULARY_FROZEN":
      ov.vocabularies.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        frozen_at: e.occurred_at,
        withdrawn: false,
        superseded_by: null,
        annotations: [],
      });
      break;

    case "ORTHOLOG_FROZEN":
      ov.orthologSets.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        frozen_at: e.occurred_at,
        withdrawn: false,
        superseded_by: null,
        annotations: [],
      });
      break;

    case "ACCESS_GRANTED":
      ov.grants.push({ id: e.aggregate_id, ...p, granted_at: e.occurred_at });
      break;

    case "RUN_REGISTERED":
      ov.runs.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        registered_at: e.occurred_at,
        status: "registered",
        checkpoints: new Map(), // shard_index -> 最新检查点
        shards_completed: new Set(),
        metrics: null,
        failure_reason: null,
        final_weights_sha256: p.training?.weights_sha256 ?? null,
        impact_flags: [],
      });
      break;

    case "CHECKPOINT_RECORDED": {
      const run = ov.runs.get(e.aggregate_id);
      if (run) {
        run.checkpoints.set(p.shard_index, {
          shard_index: p.shard_index,
          checkpoint_sha256: p.checkpoint_sha256,
          metrics: p.metrics ?? null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
      }
      break;
    }

    case "RUN_COMPLETED": {
      const run = ov.runs.get(e.aggregate_id);
      if (run) {
        run.status = "completed";
        run.metrics = p.metrics ?? run.metrics;
        run.final_weights_sha256 = p.final_weights_sha256;
        run.completed_at = e.occurred_at;
      }
      break;
    }

    case "RUN_FAILED": {
      const run = ov.runs.get(e.aggregate_id);
      if (run) {
        run.status = "failed";
        run.failure_reason = p.reason ?? null;
        run.final_weights_sha256 = p.final_weights_sha256;
      }
      break;
    }

    case "EMBEDDING_PUBLISHED":
      ov.embeddings.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        published_at: e.occurred_at,
        impact_flags: [],
      });
      break;

    case "CLAIM_RECORDED":
      ov.claims.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        recorded_at: e.occurred_at,
        validation_level: null,
        validation_evidence: [],
        impact_flags: [],
      });
      break;

    case "CLAIM_VALIDATED": {
      const claim = ov.claims.get(e.aggregate_id);
      if (claim) {
        claim.status = "validated";
        claim.validation_level = p.validation_level;
        claim.validation_evidence = [...(claim.validation_evidence ?? []), ...p.evidence];
        claim.validated_at = e.occurred_at;
        claim.validated_by = p.validated_by ?? null;
      }
      break;
    }

    case "CLAIM_DEMOTED": {
      const claim = ov.claims.get(e.aggregate_id);
      if (claim) {
        claim.status = p.to_status;
        claim.demotions = [...(claim.demotions ?? []), { to_status: p.to_status, reason: p.reason, at: e.occurred_at }];
        if (p.to_status !== "validated") claim.validation_level = null;
      }
      break;
    }

    case "SOURCE_WITHDRAWN":
    case "ANNOTATION_UPGRADED": {
      const kind = e.event_type === "SOURCE_WITHDRAWN" ? "withdrawn" : "upgraded";
      const note = { kind, target_type: p.target_type, target_id: p.target_id, reason: p.reason, new_version_id: p.new_version_id ?? null, at: e.occurred_at, event_id: e.event_id, affected_run_ids: p.affected_run_ids ?? [] };
      ov.notices.push(note);

      const targetMap = { dataset_release: ov.datasets, gene_vocabulary: ov.vocabularies, ortholog_set: ov.orthologSets }[p.target_type];
      const target = targetMap?.get(p.target_id);
      if (target) {
        target.annotations.push(note);
        if (kind === "withdrawn") {
          target.withdrawn = true;
          target.withdrawn_reason = p.reason;
        } else {
          target.superseded_by = p.new_version_id ?? target.superseded_by;
        }
      }
      // 对下游对象的影响标记统一在 reconcileImpact() 按血缘计算，
      // 与事件到达顺序无关（标记之后才发布的图表/嵌入同样会被补上）。
      break;
    }

    case "FIGURE_PUBLISHED":
      ov.figures.set(e.aggregate_id, {
        id: e.aggregate_id,
        ...p,
        published_at: e.occurred_at,
        impact_flags: [],
      });
      break;

    case "MODEL_CARD_PUBLISHED":
      ov.modelCards.set(e.aggregate_id, { id: e.aggregate_id, ...p, published_at: e.occurred_at });
      break;
  }
  return ov;
}

/**
 * 撤回/升级血缘调和：根据全部 notices 与当前血缘，幂等地给运行/嵌入/主张/图表
 * 追加 impact_flags。标记只增不改，且不依赖事件到达顺序。
 * 受影响集合 = 通知显式给出的 affected_run_ids ∪ 血缘引用该来源的运行。
 */
function reconcileImpact(ov) {
  const flagsForRun = new Map(); // runId -> notes[]
  for (const notice of ov.notices) {
    const affected = new Set(notice.affected_run_ids);
    for (const runId of ov.runs.keys()) {
      const run = ov.runs.get(runId);
      const uses =
        (notice.target_type === "dataset_release" && run.dataset_ids.includes(notice.target_id)) ||
        (notice.target_type === "gene_vocabulary" && run.vocabulary_id === notice.target_id) ||
        (notice.target_type === "ortholog_set" && run.ortholog_set_id === notice.target_id);
      if (uses) affected.add(runId);
    }
    for (const runId of affected) {
      if (!ov.runs.has(runId)) continue;
      const list = flagsForRun.get(runId) ?? [];
      if (!list.some((n) => n.event_id === notice.event_id)) list.push(notice);
      flagsForRun.set(runId, list);
    }
  }

  const addFlags = (obj, notes) => {
    for (const n of notes) if (!obj.impact_flags.some((f) => f.event_id === n.event_id)) obj.impact_flags.push(n);
  };

  for (const [runId, run] of ov.runs) {
    addFlags(run, flagsForRun.get(runId) ?? []);
    for (const emb of ov.embeddings.values()) if (emb.run_id === runId) addFlags(emb, run.impact_flags);
    for (const claim of ov.claims.values()) if (claim.run_id === runId) addFlags(claim, run.impact_flags);
    for (const fig of ov.figures.values()) if (fig.run_ids.includes(runId)) addFlags(fig, run.impact_flags);
  }
}

/** 从事件数组重放出完整读模型。 */
export function project(events) {
  const ov = blankOverview();
  for (const e of events) apply(ov, e);
  reconcileImpact(ov);
  return ov;
}

/**
 * 保密期可见性：运行在 embargo_until 之前仅同项目可见；之后公开可见。
 * 竞争实验室在同一登记处提交的互不通气结果因此可以并存。
 */
export function isRunVisibleTo(run, viewer, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  if (new Date(run.embargo_until).getTime() <= at.getTime()) return true;
  return viewer?.project_id === run.project_id;
}

export function visibleOverview(ov, viewer, now = new Date()) {
  const visibleRunIds = new Set([...ov.runs.values()].filter((r) => isRunVisibleTo(r, viewer, now)).map((r) => r.id));
  return {
    ...ov,
    runs: new Map([...ov.runs].filter(([id]) => visibleRunIds.has(id))),
    embeddings: new Map([...ov.embeddings].filter(([, e]) => visibleRunIds.has(e.run_id))),
    claims: new Map([...ov.claims].filter(([, c]) => visibleRunIds.has(c.run_id))),
    figures: new Map(
      [...ov.figures].filter(([, f]) => f.run_ids.every((rid) => visibleRunIds.has(rid)))
    ),
    _visible_run_ids: visibleRunIds,
  };
}
