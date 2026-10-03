# 图表溯源：图3 四物种细胞共嵌入空间（海绵/线虫/蛙/人）

- 图表 ID：fig-0013（发布事件 `evt-000024`）
- **验证等级：独立实验室复现（independent_replication）**

> ⚠️ **注释升级标记**：所用词表/同源组已有新版本 vocab-0016（2026-09-15T08:00:00.000Z，原因：Ensembl 112→115 基因模型更新：海绵/爪蟾基因结构修订约 4%）。与新版映射重跑的差异应首先归因于注释，而非模型权重。
>
> ⚠️ **注释升级标记**：所用词表/同源组已有新版本 orthology-0017（2026-09-15T08:00:00.000Z，原因：Compara 112→115 同源关系重算：旧图差异应先归因注释版本）。与新版映射重跑的差异应首先归因于注释，而非模型权重。
>
> ⚠️ **来源撤回标记**：训练数据 dataset-0002 已于 2026-09-15T08:00:00.000Z 撤回（提供方 2026-09 复核撤回部分样本授权）。本模型卡与已发表历史保留备查，但该结果不得作为新结论依据，应以重跑结果为准。
- 预登记分析：四门类物种细胞嵌入空间对应关系研究（进化发育生物学联合实验室）
  - 计划物种：Amphimedon queenslandica、Caenorhabditis elegans、Xenopus tropicalis、Homo sapiens
  - 声明用途：跨物种细胞类型相似性假设生成，不用于临床或同源性断言

## 数据（实验室 / 物种 / 组织 / 同意 / 质控 / 访问）
- dataset-0002：Ludwig 海洋生物学站 / Amphimedon queenslandica / 幼虫全细胞；同意 不受限研究用途；质控 通过；访问 公开；`sha256:c24498a41595f5ca7f5291edb5c1aff4a67b08515a098c9d5530d74637fdc5ad`
  - ⚠️ 来源已撤回：提供方 2026-09 复核撤回部分样本授权
- dataset-0003：MRC 线虫库 / Caenorhabditis elegans / L2 幼虫全细胞；同意 不受限研究用途；质控 通过；访问 公开；`sha256:1c5ef29b66f489fc5c4d48d8f2e5aaa42fe6ad4c30bcc146edb733bd437a8719`
- dataset-0004：图宾根发育基因组学组 / Xenopus tropicalis / 尾芽期胚胎；同意 不受限研究用途；质控 通过；访问 公开；`sha256:0ffb3a466cd3c4117cf24257ddfceccee0f049e7f40475d73e7dc794a978f65c`
- dataset-0005：人类细胞图谱合作中心 / Homo sapiens / 外周血与脑（多组织汇总）；同意 受控访问；质控 通过；访问 受控访问；`sha256:f2df45199b29ceb7fe74d3c2c204f3494390c19c0982d8e0522a91a93a9fd235`

## 词表与同源组（冻结版本）
- 词表 vocab-0006：Ensembl 四物种基因词表 2024-03（Ensembl 112）
  `sha256:e0f5f66e9e27243ca31cf2f55f71c113f331ad9fc6e6d108d4d50ee35a991ba1`
  - ⚠️ 已被 vocab-0016 取代
- 同源组 orthology-0007：四物种同源组（一爪一妻映射） 2024-03-compara（Ensembl Compara release 112）
  `sha256:2031e80424253e3c5e7eb1ba5e467664cb618f219a0f6815d648592e9147ab28`
  - ⚠️ 已被 orthology-0017 取代

## 配置 / 代码 / 权重 / 嵌入
- 配置：`sha256:779f259bd79b1ef071b7a74c66afa2ec9cb4ae6c267bacd6b9b3fbb3704cb004`
- 代码：git+https://git.example.institute/cross-species/cell-embed @ `a1b2c2d9`（`sha256:8d8093c3a64d601470f46df23a21b915a8ceaf61e4b9386a79f670b0a40026ae`）
- 权重：`sha256:a4d45286552da9da0e7d9290078220b9a0bdbae3b5b83c8d99f8fdbb2dbef5d6`
- 嵌入：`sha256:44f8c61c43c2c80c09f2a7bcc575cd1219532d1178aebbe2c94a4d14fcbd7422`

## 关联主张
- claim-0011 [独立实验室复现（independent_replication）] 海绵领细胞与人类小胶质样细胞在共嵌入空间相邻，提示免疫效应样细胞的深谱系对应可能
  - ⚠️ annotation_upgraded：Ensembl 112→115 基因模型更新：海绵/爪蟾基因结构修订约 4%
  - ⚠️ annotation_upgraded：Compara 112→115 同源关系重算：旧图差异应先归因注释版本
  - ⚠️ source_withdrawn：提供方 2026-09 复核撤回部分样本授权
