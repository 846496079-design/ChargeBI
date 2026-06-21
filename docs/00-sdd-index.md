# SDD 文档索引

## SDD 约定

本项目采用 SDD（Spec-Driven Development，规格驱动开发）推进。

核心原则：

1. 所有重要想法、范围变化、策略变化必须记录到 `.md` 文档。
2. 所有代码实现必须能追溯到对应的产品规格、数据规格或技术规格。
3. Demo 产品本身与作品集讲解文档分离：产品界面只呈现 ChargeBI，作品集页面负责解释设计过程。
4. 每次进入实现前，先更新或确认相关规格文档。
5. 若后续代码行为与文档不一致，以最新决策日志和规格文档为准，并同步修正文档。
6. 用户反馈的一个具体问题必须视为一类问题的代表；修复时先抽象问题类别和根因，再做系统性方案、回归用例和文档记录，避免头疼医头、脚疼医脚。
7. 每次修复必须检查是否会破坏既有链路，尤其是意图识别、复杂任务编排、表格、图表和多轮上下文之间的一一对应关系。

## 文档结构

| 文档 | 用途 | 状态 |
|---|---|---|
| [01-product-overview.md](./01-product-overview.md) | 产品定位、MVP 范围、用户和核心体验 | v1.0 |
| [02-decision-log.md](./02-decision-log.md) | 记录关键决策、想法变化、策略变化 | 持续更新 |
| [03-data-design-and-sample-questions.md](./03-data-design-and-sample-questions.md) | 数据库设计、指标词典、样例问题、多轮追问 | v1.0 |
| [04-prototype-and-interaction.md](./04-prototype-and-interaction.md) | 页面原型结构、交互流程、状态设计 | v1.0 |
| [05-prd.md](./05-prd.md) | 完整产品需求文档 | v1.0 |
| [06-technical-implementation.md](./06-technical-implementation.md) | 技术实现方案、架构、AI 链路、部署策略 | v1.0 |
| [07-portfolio-page-copy.md](./07-portfolio-page-copy.md) | 个人网站作品集详情页文案 | v1.0 |
| [08-interview-script.md](./08-interview-script.md) | 面试讲解稿 | v1.0 |
| [09-demo-video-script.md](./09-demo-video-script.md) | 演示视频脚本 | v1.0 |
| [10-implementation-log.md](./10-implementation-log.md) | 代码实现记录与策略变化 | 持续更新 |
| [11-demo-implementation.md](./11-demo-implementation.md) | 初版 Web Demo 实现说明 | v1.0 |

## 后续计划

接下来按以下顺序继续输出文档：

初版 SDD 文档已完成。后续文档根据代码迭代持续更新。
