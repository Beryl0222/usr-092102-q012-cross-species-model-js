# 跨物种细胞模型登记与溯源

研究所规定：**所有跨物种分析先登记再引用**。本仓库在统一的领域事件信封之上实现
登记、冻结、训练、主张、验证、模型卡与图表溯源，确保任何一幅图都能回答三个问题：

1. 它用了哪份数据、哪一版基因词表与同源组、哪份配置/代码/权重（校验值锁定，可一字节不差复现）；
2. 图上的相似性处在什么验证等级——探索线索、计算复现、独立实验室复现，还是后续实验验证；
3. 数据撤回或注释升级后，哪些运行与结论受影响，历史在哪里复查。

## 背景：被复现失败逼出来的制度

论文把海绵、线虫、青蛙和人类细胞投到同一嵌入空间；复现人员拿不到当时的基因词表，
只能用最新版同源映射重跑，差异究竟来自数据、注释还是模型权重无从区分，而合作方已把
**模型相似性写成了经过验证的生物学事实**。本仓库用不可变事件日志把这三者分开。

## 制度要求 → 机制映射

| 制度要求 | 机制 |
| --- | --- |
| 跨物种分析先登记再引用 | `ANALYSIS_REGISTERED`；运行必须挂接已登记分析，否则 `UNREGISTERED_ANALYSIS` |
| 数据集注明实验室、组织、物种、样本同意、质控、访问限制 | `DATASET_REGISTERED` 载荷必填并校验；人类受试者数据不得标 `public` |
| 基因词表与同源组单独冻结 | `VOCABULARY_FROZEN` / `ORTHOLOGY_FROZEN` 为不同聚合，各自带 sha256；同源组必须声明覆盖的词表，跨源/跨版本拼装被拒（`ORTHOLOGY_VOCAB_MISMATCH`、`ANNOTATION_SUPERSEDED`） |
| 训练配置、代码、权重用校验值锁定 | 运行登记锁定 `training_config`/`code` 校验值，完成时回填 `weights`/`embedding` 校验值；嵌入发布校验值必须与运行锁定值一致 |
| 嵌入结果、推断主张、后续实验验证不混为同一状态 | 三个独立聚合：`embedding_output` / `biological_claim`（新主张一律 `exploratory`）/ `CLAIM_VALIDATED` 逐级提升，禁止跳级 |
| 多实验室保密期内竞争结果允许并存 | 每条运行可带 `embargo`；`listRuns` 对未授权方返回脱敏占位，审查视角（`auditor`）可见全部 |
| 人类原始数据不得流向无授权项目 | `ACCESS_AUTHORIZED` 按项目授权（可过期）；`registerRun` 对非公开数据强制校验，拒绝码 `ACCESS_DENIED` |
| 来源撤回/注释升级只标记受影响运行和结论 | `SOURCE_WITHDRAWN` / `ANNOTATION_UPGRADED` 只追加标记事件，自动计算受影响 run/claim/figure；日志不删不改 |
| 已发表历史仍可复查 | 所有事件 append-only；受标记的旧图表仍可打开，溯源包自带警示；但受影响运行不得再发布**新**产物 |
| 长训练分片恢复，重复回调不产生第二个运行 | `SHARD_PROGRESSED` 按分片与检查点推进，恢复须指向已知检查点；`RUN_REGISTERED`/`SHARD_PROGRESSED` 强制 `idempotency_key`，重放返回原事件 |
| 点开图表即取得词表、数据、配置与验证等级 | `FIGURE_PUBLISHED` 载荷内嵌完整溯源校验值；`figureProvenance()` 返回结构化溯源包 |
| 足以复现并判断适用边界的模型卡 | `MODEL_CARD_PUBLISHED` + `src/modelCard.js` 输出 Markdown / JSON 模型卡 |

## 事件与聚合

全部流程承接 `contracts/domain.schema.json` 的同一信封（`event_id`、`event_type`、
`aggregate_type`、`aggregate_id`、`occurred_at`、`version`、`summary`、`payload`，
可选 `idempotency_key`、`causation_id`、`correlation_id`、`producer`）。

```
analysis_registration
dataset_release ──< access_grant
gene_vocabulary ──< orthology_set
                         │
model_run ───────────────┤  注册锁定 数据集/词表/同源组/配置/代码；分片推进；完成锁定权重/嵌入
  └─ embedding_output
       └─ biological_claim   exploratory → computational_replication
                            → independent_replication → experimental_validation
model_card / figure         发布即冻结溯源；标记（撤回/升级）只追加
```

`version` 在每个聚合上从 1 单调递增；事件只追加。内存登记处可通过
`EventRegistry.replay(events)` 从日志完整重建——这也是长训练跨进程恢复的底座。

## 目录

- `contracts/domain.schema.json`：统一事件信封、15 种事件、10 种聚合与各载荷 JSON Schema（含 if/then 分支）。
- `src/domain.js`：JS 侧事件/聚合/验证等级/访问分级词表（测试保证与 schema 不漂移）。
- `src/validator.js`：无状态信封与载荷结构校验。
- `src/registry.js`：事件溯源登记处，强制全部策略规则（授权、幂等、分片、等级提升、标记、可见性）。
- `src/modelCard.js`：模型卡（Markdown/JSON）与图表溯源包渲染。
- `examples/cross-species-figure.js`：四物种端到端场景（29 项策略断言）。
- `data/sample.json`：一条受控人类数据集登记样例。
- `tests/`：契约一致性、校验器、登记处策略、模型卡、示例冒烟测试。

## 使用

```bash
npm test       # 全部测试（含示例冒烟）
npm run example  # 运行四物种端到端场景，产物写入 examples/output/（已 gitignore）
```

示例覆盖：四物种数据登记与人类受控授权 → 词表/同源组分别冻结 → 3 分片训练
（含崩溃恢复、重复回调去重）→ 嵌入/主张/验证三态分离 → 模型卡与图3发布 →
竞争实验室保密结果并存 → 复现方用 Ensembl/Compara 115 重跑与跨版本拼装拦截 →
注释升级与海绵数据撤回后的标记、历史复查与日志重建。

### 最小代码脉络

```js
const registry = new EventRegistry();
const analysis = registry.registerAnalysis({ /* 标题/实验室/计划物种/用途 */ });
const dataset  = registry.registerDataset({ lab, species, tissue, sample_consent,
  human_subject, access_tier, quality_control, checksum });
const vocab    = registry.freezeVocabulary({ name, vocab_version, source_release, checksum });
const ortho    = registry.freezeOrthology({ mapping_version, source, vocabulary_refs: [vocabRef], checksum });
// 非 public 数据须先 registry.authorizeAccess({ project_id, dataset_refs, granted_by })
const run      = registry.registerRun({ idempotencyKey, analysis_ref, project_id,
  dataset_refs, vocabulary_ref, orthology_ref, training_config, code, shard_total });
registry.progressShard(run.aggregate_id, { idempotencyKey, shard_index, state, checkpoint_checksum });
registry.completeRun(run.aggregate_id, { weights, embedding_checksum });
const emb      = registry.publishEmbedding(run.aggregate_id, { checksum });
const claim    = registry.recordClaim({ embedding_ref: emb.aggregate_id, statement, recorded_by }); // exploratory
registry.validateClaim(claim.aggregate_id, { new_level, method, validated_by, evidence });         // 逐级提升
registry.publishFigure({ run_ref, embedding_ref, claim_refs, title });
const packet   = registry.figureProvenance(figureId, viewer);  // 点开图表即得溯源
```

## 验证等级语义（防止“相似性=事实”）

- `exploratory`：模型相似性只是探索线索，**不得**表述为经过验证的生物学事实。
- `computational_replication`：独立数据/留出批次上的计算复现。
- `independent_replication`：独立实验室重复（`validated_by.independent` 必须为 `true`）。
- `experimental_validation`：后续实验验证（必须提供 `experiment_ref`）。

图表的验证等级取其所引主张的**最低**等级；模型卡取该嵌入下主张的最高等级，并显式
声明 `is_verified_biological_fact` 与适用边界（物种、组织、最严访问分级、撤回/升级状态）。
