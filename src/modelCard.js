/**
 * 模型卡与图表溯源包渲染。
 *
 * 模型卡回答两件事：
 *   1. 如何一字节不差地复现（词表/同源组/数据/配置/代码/权重/嵌入校验值）；
 *   2. 适用边界在哪里（物种、组织、访问限制、验证等级、撤回/升级标记）。
 *
 * 输入是 EventRegistry.modelCardData() / figureProvenance() 的结构化结果，
 * 渲染器本身无副作用，可同时输出机器可读 JSON 与人类可读 Markdown。
 */

const LEVEL_LABELS = Object.freeze({
  exploratory: "探索线索（exploratory）",
  computational_replication: "计算复现（computational_replication）",
  independent_replication: "独立实验室复现（independent_replication）",
  experimental_validation: "实验验证（experimental_validation）",
});

const LEVEL_RANK = Object.freeze({
  exploratory: 0,
  computational_replication: 1,
  independent_replication: 2,
  experimental_validation: 3,
});

const CONSENT_LABELS = Object.freeze({
  unrestricted_research: "不受限研究用途",
  controlled_access: "受控访问",
  population_restricted: "仅限声明群体研究",
  no_secondary_use: "禁止二次使用",
  unknown: "同意状态不明",
});

const ACCESS_LABELS = Object.freeze({
  public: "公开",
  embargoed: "保密期内",
  controlled: "受控访问",
  restricted: "禁止跨项目流动",
});

function short(value, n = 12) {
  return typeof value === "string" ? `${value.slice(0, n)}…` : value;
}

function checksumLine(label, checksum) {
  return `- ${label}：\`${checksum.algorithm}:${checksum.value}\``;
}

function markerBanner(markers) {
  const lines = [];
  for (const marker of markers ?? []) {
    if (marker.kind === "source_withdrawn") {
      lines.push(
        `> ⚠️ **来源撤回标记**：训练数据 ${marker.dataset_id} 已于 ${marker.at} 撤回（${marker.reason}）。` +
          "本模型卡与已发表历史保留备查，但该结果不得作为新结论依据，应以重跑结果为准。"
      );
    }
    if (marker.kind === "annotation_upgraded") {
      lines.push(
        `> ⚠️ **注释升级标记**：所用词表/同源组已有新版本 ${marker.new_ref.aggregate_id}` +
          `（${marker.at}，原因：${marker.reason}）。与新版映射重跑的差异应首先归因于注释，而非模型权重。`
      );
    }
  }
  return lines.length > 0 ? `${lines.join("\n>\n")}\n\n` : "";
}

/**
 * 机器可读模型卡。相比 registry.modelCardData 的原始投影，
 * 这里补充复现配方与边界判定字段，供审查流水线直接消费。
 */
export function modelCardAsJson(data) {
  const reproduction = {
    recipe: [
      `按 code.repository@${data.code.commit}（${data.code.checksum.algorithm}:${data.code.checksum.value}）取得训练代码`,
      `取得词表 ${data.vocabulary.name} ${data.vocabulary.version}（${data.vocabulary.source_release}，校验值 ${data.vocabulary.checksum.value}）`,
      `取得同源映射 ${data.orthology.name} ${data.orthology.mapping_version}（${data.orthology.source}，校验值 ${data.orthology.checksum.value}）`,
      "按下表数据集校验值获取数据；受控数据需凭项目授权访问，人类原始数据不得跨项目流动",
      `以配置校验值 ${data.config_checksum.value} 锁定训练配置，以权重校验值 ${data.weights_checksum.value} 校验产物`,
      "长训练按分片检查点恢复；分片回调必须复用同一幂等键",
    ],
    code: data.code,
    config_checksum: data.config_checksum,
    weights_checksum: data.weights_checksum,
    embedding: data.embedding,
  };

  const scope = {
    species: [...new Set(data.datasets.map((d) => d.species.scientific_name))],
    tissues: [...new Set(data.datasets.map((d) => d.tissue))],
    labs: [...new Set(data.datasets.map((d) => d.lab))],
    human_subject_data: data.datasets.some((d) => d.human_subject),
    most_restrictive_access: data.datasets.reduce(
      (max, d) => (["public", "embargoed", "controlled", "restricted"].indexOf(d.access_tier) >
        ["public", "embargoed", "controlled", "restricted"].indexOf(max)
        ? d.access_tier
        : max),
      "public"
    ),
    contains_withdrawn_data: data.datasets.some((d) => d.withdrawn),
    annotation_superseded: Boolean(data.vocabulary.superseded_by || data.orthology.superseded_by),
  };

  return {
    schema: "cross-species-model-card/1.0",
    card_id: data.card_id,
    run_id: data.run.id,
    published_at: data.published_at,
    published_event: data.published_event,
    validation_level: data.validation_level,
    validation: {
      label: LEVEL_LABELS[data.validation_level],
      is_verified_biological_fact: LEVEL_RANK[data.validation_level] >= LEVEL_RANK.experimental_validation,
      note:
        data.validation_level === "exploratory"
          ? "模型相似性仅为探索线索，不得在合作文件或论文中表述为经过验证的生物学事实。"
          : "验证等级只覆盖所列证据；未覆盖的物种/组织外推仍按探索线索处理。",
    },
    intended_uses: data.intended_uses,
    out_of_scope_uses: data.out_of_scope_uses,
    scope,
    datasets: data.datasets,
    vocabulary: data.vocabulary,
    orthology: data.orthology,
    reproduction,
    claims: data.claims.map((claim) => ({
      claim_id: claim.id,
      statement: claim.statement,
      level: claim.level,
      recorded_by: claim.recorded_by,
      caveats: claim.caveats,
      history: claim.history,
      ...(claim.markers.length > 0 ? { markers: claim.markers } : {}),
    })),
    ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
    ...(data.markers.length > 0 ? { markers: data.markers } : {}),
  };
}

/** 人类可读模型卡（Markdown）。 */
export function modelCardAsMarkdown(data) {
  const json = modelCardAsJson(data);
  const lines = [];
  lines.push(`# 模型卡：跨物种细胞嵌入运行 ${data.run.id}`);
  lines.push("");
  lines.push(`- 卡片 ID：${data.card_id}（发布事件 \`${data.published_event}\`，${data.published_at}）`);
  lines.push(`- 运行状态：${data.run.status}`);
  lines.push(`- **总体验证等级：${LEVEL_LABELS[data.validation_level]}**`);
  lines.push("");
  lines.push(markerBanner(data.markers).trimEnd());

  if (data.validation_level === "exploratory") {
    lines.push(
      "> 🔎 **本模型输出属于探索线索**：任何跨物种细胞相似性都尚未经过独立复现或实验验证，" +
        "不得引用为“经过验证的生物学事实”。"
    );
    lines.push("");
  }
  if (data.warnings.length > 0) {
    lines.push("## 使用警示");
    data.warnings.forEach((w) => lines.push(`- ${w}`));
    lines.push("");
  }

  lines.push("## 适用与不适用");
  lines.push("适用：");
  data.intended_uses.forEach((u) => lines.push(`- ${u}`));
  lines.push("不适用 / 禁止外推：");
  data.out_of_scope_uses.forEach((u) => lines.push(`- ${u}`));
  lines.push("");
  lines.push("### 适用边界判定");
  lines.push(`- 覆盖物种：${json.scope.species.join("、") || "（无）"}`);
  lines.push(`- 覆盖组织：${json.scope.tissues.join("、") || "（无）"}`);
  lines.push(`- 数据提供实验室：${json.scope.labs.join("、")}`);
  lines.push(`- 含人类受试者数据：${json.scope.human_subject_data ? "是（受控，按授权使用）" : "否"}`);
  lines.push(`- 最严访问分级：${ACCESS_LABELS[json.scope.most_restrictive_access]}`);
  lines.push(
    `- 含已撤回数据：${json.scope.contains_withdrawn_data ? "是——结果仅供历史复查" : "否"}`
  );
  lines.push(
    `- 注释已被新版本取代：${json.scope.annotation_superseded ? "是——与新结果对比时须区分注释差异" : "否"}`
  );
  lines.push("");

  lines.push("## 数据登记");
  data.datasets.forEach((d, i) => {
    lines.push(
      `${i + 1}. **${d.dataset_id}** — ${d.species.scientific_name}${d.species.common_name ? `（${d.species.common_name}）` : ""} / ${d.tissue}`
    );
    lines.push(`   - 实验室：${d.lab}`);
    lines.push(`   - 样本同意：${CONSENT_LABELS[d.sample_consent] ?? d.sample_consent}`);
    lines.push(`   - 人类受试者：${d.human_subject ? "是" : "否"}`);
    lines.push(`   - 访问分级：${ACCESS_LABELS[d.access_tier] ?? d.access_tier}`);
    if (d.access_restrictions?.length) lines.push(`   - 访问限制：${d.access_restrictions.join("；")}`);
    lines.push(
      `   - 质控：${d.quality_control.passed ? "通过" : "未通过"}（${(d.quality_control.checks ?? []).join("、") || "无记录"}）${d.quality_control.notes ? `；${d.quality_control.notes}` : ""}`
    );
    lines.push(`   - 数据校验值：\`sha256:${d.checksum.value}\``);
    if (d.withdrawn) lines.push(`   - ⚠️ 已撤回：${d.withdrawn.reason}`);
  });
  lines.push("");

  lines.push("## 冻结的基因词表与同源组（单独冻结，互不混用）");
  lines.push(
    `- 词表：${data.vocabulary.name} ${data.vocabulary.version}，上游发布 ${data.vocabulary.source_release}（ID ${data.vocabulary.vocabulary_id}）`
  );
  lines.push(`  \`sha256:${data.vocabulary.checksum.value}\``);
  if (data.vocabulary.superseded_by) lines.push(`  - ⚠️ 已被 ${data.vocabulary.superseded_by} 取代`);
  lines.push(
    `- 同源组：${data.orthology.name} ${data.orthology.mapping_version}，来源 ${data.orthology.source}（ID ${data.orthology.orthology_id}）`
  );
  lines.push(`  \`sha256:${data.orthology.checksum.value}\``);
  if (data.orthology.superseded_by) lines.push(`  - ⚠️ 已被 ${data.orthology.superseded_by} 取代`);
  lines.push("");
  lines.push(
    "> 复现提示：使用“最新版同源映射”重跑与本运行不一致时，先比对两组冻结校验值；" +
      "差异来自数据、注释还是模型权重，可由本节锁定值逐项排查。"
  );
  lines.push("");

  lines.push("## 复现锁定值");
  lines.push(checksumLine("训练配置", data.config_checksum));
  lines.push(`- 代码：${data.code.repository} @ \`${data.code.commit}\``);
  lines.push(checksumLine("代码归档", data.code.checksum));
  lines.push(checksumLine("模型权重", data.weights_checksum));
  lines.push(
    `- 嵌入产物：${data.embedding.embedding_id}（维度 ${data.embedding.dimensionality ?? "未记录"}）`
  );
  lines.push(checksumLine("嵌入结果", data.embedding.checksum));
  lines.push("");
  lines.push("### 复现步骤");
  json.reproduction.recipe.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");

  lines.push("## 主张与验证轨迹");
  if (data.claims.length === 0) {
    lines.push("- （尚未登记任何主张；嵌入本身不构成生物学结论）");
  }
  data.claims.forEach((claim) => {
    lines.push(`- **${claim.id}** [${LEVEL_LABELS[claim.level]}] ${claim.statement}`);
    lines.push(`  - 记录人：${claim.recorded_by}`);
    if (claim.caveats?.length) lines.push(`  - 保留意见：${claim.caveats.join("；")}`);
    claim.history
      .filter((h) => h.type === "CLAIM_VALIDATED")
      .forEach((h) => {
        lines.push(
          `  - 验证：${LEVEL_LABELS[h.from_to[0]]} → ${LEVEL_LABELS[h.from_to[1]]}，` +
            `方法 ${h.method}，独立实验室：${h.independent ? "是" : "否"}，证据 \`${short(h.evidence.checksum?.value ?? "", 16)}\``
        );
      });
    (claim.markers ?? []).forEach((m) => {
      lines.push(`  - ⚠️ 标记：${m.kind}（${m.reason}）`);
    });
  });
  lines.push("");

  lines.push("---");
  lines.push(
    `本卡片由登记事件 \`${data.published_event}\` 生成；所有上游对象均可凭 aggregate_id 与校验值在事件日志中复查。`
  );
  return lines.join("\n");
}

/** 图表点开即得的溯源包（Markdown 摘要）。 */
export function figureProvenanceAsMarkdown(packet) {
  const lines = [];
  lines.push(`# 图表溯源：${packet.title}`);
  lines.push("");
  lines.push(`- 图表 ID：${packet.figure_id}（发布事件 \`${packet.published_event}\`）`);
  lines.push(`- **验证等级：${LEVEL_LABELS[packet.validation_level]}**`);
  lines.push("");
  lines.push(markerBanner(packet.markers).trimEnd());

  if (packet.analysis) {
    lines.push(`- 预登记分析：${packet.analysis.title}（${packet.analysis.lead_lab}）`);
    lines.push(`  - 计划物种：${packet.analysis.planned_species.join("、")}`);
    lines.push(`  - 声明用途：${packet.analysis.intended_use}`);
  }
  lines.push("");
  lines.push("## 数据（实验室 / 物种 / 组织 / 同意 / 质控 / 访问）");
  packet.datasets.forEach((d) => {
    lines.push(
      `- ${d.dataset_id}：${d.lab} / ${d.species.scientific_name} / ${d.tissue}；` +
        `同意 ${CONSENT_LABELS[d.sample_consent] ?? d.sample_consent}；` +
        `质控 ${d.quality_control.passed ? "通过" : "未通过"}；` +
        `访问 ${ACCESS_LABELS[d.access_tier] ?? d.access_tier}；\`sha256:${d.checksum.value}\``
    );
    if (d.withdrawn) lines.push(`  - ⚠️ 来源已撤回：${d.withdrawn.reason}`);
  });
  lines.push("");
  lines.push("## 词表与同源组（冻结版本）");
  lines.push(
    `- 词表 ${packet.vocabulary.vocabulary_id}：${packet.vocabulary.name} ${packet.vocabulary.version}（${packet.vocabulary.source_release}）`
  );
  lines.push(`  \`sha256:${packet.vocabulary.checksum.value}\``);
  if (packet.vocabulary.superseded_by) lines.push(`  - ⚠️ 已被 ${packet.vocabulary.superseded_by} 取代`);
  lines.push(
    `- 同源组 ${packet.orthology.orthology_id}：${packet.orthology.name} ${packet.orthology.mapping_version}（${packet.orthology.source}）`
  );
  lines.push(`  \`sha256:${packet.orthology.checksum.value}\``);
  if (packet.orthology.superseded_by) lines.push(`  - ⚠️ 已被 ${packet.orthology.superseded_by} 取代`);
  lines.push("");
  lines.push("## 配置 / 代码 / 权重 / 嵌入");
  lines.push(`- 配置：\`sha256:${packet.config_checksum.value}\``);
  lines.push(`- 代码：${packet.code.repository} @ \`${packet.code.commit}\`（\`sha256:${packet.code.checksum.value}\`）`);;
  lines.push(`- 权重：\`sha256:${packet.weights_checksum.value}\``);
  lines.push(`- 嵌入：\`sha256:${packet.embedding_checksum.value}\``);
  lines.push("");
  lines.push("## 关联主张");
  if (packet.claims.length === 0) lines.push("- （无；图表读数仅为探索线索）");
  packet.claims.forEach((c) => {
    lines.push(`- ${c.id} [${LEVEL_LABELS[c.level]}] ${c.statement}`);
    if (c.markers.length) {
      c.markers.forEach((m) => lines.push(`  - ⚠️ ${m.kind}：${m.reason}`));
    }
  });
  return lines.join("\n");
}
