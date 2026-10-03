# 跨物种细胞模型登记

一个**事件溯源（event-sourced）**的登记底座：所有跨物种分析——数据集登记、基因词表与同源组冻结、训练运行、嵌入、生物学主张、实验验证、来源撤回/注释升级、图表与模型卡发布——都承接 `contracts/domain.schema.json` 定义的**统一事件信封**落账。事件只追加、不修改；任何当前状态都能由事件流完整重放。

## 要解决的问题

论文把海绵、线虫、青蛙、人类细胞投到同一嵌入空间，但复现者拿不到当年的基因词表，只能用最新同源映射重跑，差异无法归因；合作方又把"模型相似性"写成了"已验证的生物学事实"。本登记处用以下机制对应：

| 要求 | 机制 |
| --- | --- |
| 跨物种分析**先登记再引用** | 运行登记前校验数据集/词表/同源组均存在且未撤回（`Registry.registerRun`） |
| 数据集注明实验室、组织、物种、样本同意、质控、访问限制 | `DATASET_REGISTERED` 负载六要素（schema 条件分支强制） |
| 基因词表与同源组**单独冻结** | `VOCABULARY_FROZEN` 与 `ORTHOLOG_FROZEN` 是两个独立聚合，各自锁定 `content_sha256` |
| 训练配置、代码、模型权重以校验值锁定 | `RUN_REGISTERED.payload.training` 锁 `config/code/weights_sha256`；完成时锁最终权重 |
| 嵌入结果、推断主张、实验验证**不混为同一状态** | 主张状态机：`exploratory_hint → proposed → validated`；记录时**禁止**直接 `validated`，验证另需 `validation_level` + 证据 |
| 保密期内竞争结果允许并存 | 运行带 `embargo_until`；`visibleOverview` 按项目过滤，过期自动公开，全局事件流中两者并存 |
| 人类原始数据不得流向无授权项目 | `ACCESS_GRANTED` + 运行前授权闸门：受控层需有效授权，人类 raw 必须记录批准方与时间边界 |
| 来源撤回/注释升级只标记受影响运行和结论 | `SOURCE_WITHDRAWN` / `ANNOTATION_UPGRADED` 只追加 notice；投影按血缘幂等扇出 `impact_flags`，不删历史 |
| 已发表历史仍可复查 | 追加式 JSONL 事件日志 + 每次投影重放；被撤回词表只阻止**新**运行，不改写旧运行 |
| 长训练分片恢复 | `CHECKPOINT_RECORDED` 按分片记录；`resumePlan` 返回未完成分片，续写而非新建运行 |
| 重复回调不产生第二个运行 | 信封 `idempotency_key` 全局去重；存储层返回首次事件并标记 `duplicate`；检查点按 (运行,分片,校验值) 幂等 |
| 点开任一图表取得词表/数据/配置/验证等级 | `FIGURE_PUBLISHED` 强制 `provenance:true`；`resolveFigure` 给出完整溯源包与受影响警告 |
| 足以复现并判断适用边界的模型卡 | `buildModelCard` / `MODEL_CARD_PUBLISHED`：复现校验值 + 验证分级 + 物种/组织范围 + 自动收集的适用边界 |

**验证等级**（递进）：`in_silico_reproduction`（计算复现）→ `independent_dataset`（独立数据集）→ `wetlab_independent`（独立湿实验）→ `wetlab_preregistered`（预注册湿实验）。模型相似性最高只构成计算复现级；未达实验验证时模型卡自动写入"不得表述为生物学事实"的限制。

## 目录

- `contracts/domain.schema.json`：统一事件信封与 16 类事件的负载条件分支（JSON Schema 2020-12）。
- `src/domain.js`：信封字段与稳定枚举（schema 的运行时镜像）。
- `src/validator.js`：与 schema 等价的零依赖事件校验。
- `src/store/event-store.js`：追加式事件存储（流版本/乐观并发、幂等去重、可选 JSONL 持久化与重放）。
- `src/registry.js`：登记应用服务（授权闸门、幂等训练编排、主张状态机、撤回/升级、图表与模型卡）。
- `src/projections.js`：读模型投影、血缘影响调和、保密期可见性。
- `src/model-card.js`：模型卡与图表溯源包派生。
- `examples/demo.mjs`：论文四物种场景的端到端走查。
- `tests/`：契约、schema 一致性与流程测试（`node --test`，25 项）。
- `data/sample.json`：符合信封的中文业务样例。

## 使用

```bash
npm test          # 全部测试
npm run demo      # 端到端演示（内存事件流）
```

```js
import { EventStore } from "./src/store/event-store.js";
import { Registry } from "./src/registry.js";
import { project } from "./src/projections.js";
import { buildModelCard, resolveFigure } from "./src/model-card.js";

const registry = new Registry(new EventStore("events.jsonl")); // 传文件即持久化、跨进程重放

const ds = registry.registerDataset({ lab, tissue, species, consent, quality_control, access, /* … */ }, actor).aggregate_id;
const vocab = registry.freezeVocabulary({ name, version, content_sha256 }, actor).aggregate_id;
const ortho = registry.freezeOrthologSet({ name, version, content_sha256, species_covered }, actor).aggregate_id;

// 人类受控数据：先授权（批准方 + 到期边界）
registry.grantAccess({ dataset_id: ds, project_id, scope: "raw", granted_by, expires_at }, dacActor);

// 幂等训练登记（同一 idempotency_key 的重复回调不会产生第二个运行）
registry.registerRun({ run_id, idempotency_key, project_id, dataset_ids, vocabulary_id, ortholog_set_id,
                       training: { config_sha256, code_sha256, weights_sha256, shard_count },
                       embargo_until }, actor);
registry.resumePlan(run_id);                 // 长训练：取剩余分片
registry.recordCheckpoint(run_id, { shard_index, shard_count, checkpoint_sha256 }, actor);
registry.completeRun(run_id, { final_weights_sha256, metrics }, actor);

registry.publishEmbedding({ run_id, artifact_sha256, status }, actor);
const claim = registry.recordClaim({ run_id, statement, status: "exploratory_hint" }, actor).aggregate_id;
registry.validateClaim(claim, { validation_level: "wetlab_preregistered", evidence, validated_by }, actor);

// 撤回 / 升级只追加标记；模型卡与图表自动带适用边界与警告
registry.flagSource({ kind: "withdrawn", target_type, target_id, reason }, actor);
buildModelCard(project(registry.store.allEvents()), run_id);
```

## 设计要点

- **信封稳定、负载演进**：`event_id/event_type/aggregate_type/aggregate_id/occurred_at/version/summary/payload` 必填；`idempotency_key/causation_id/correlation_id/actor` 用于去重与全链路追踪。事件只增不改。
- **血缘调和与事件顺序无关**：`project()` 在折叠全部事件后统一计算影响标记，因此即便图表/嵌入发布在撤回事件之后，仍会被正确标记。
- **读模型可随时重建**：模型卡既以 `MODEL_CARD_PUBLISHED` 快照落账，也始终能由事件流重新派生，二者可对账。
