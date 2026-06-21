# ChargeBI 智能充电运营问数助手

ChargeBI 是一个面向城市充电网络运营的 AI 问数 Copilot Demo。它让业务人员不用写 SQL，也能通过自然语言查询收入、订单、利用率、故障、节假日表现和运营建议。

本项目用于个人网站作品集展示，重点体现 AI 产品经理从场景选择、数据建模、AI 链路设计、交互设计到 vibecoding 落地的完整能力。

## 核心体验

- 左侧 AI 问数工作台：自然语言输入、多轮对话、推荐问题、分析结论、图表、表格、可信解释。
- 右侧地图运营视图：上海都市圈示例充电站点、区域聚合、站点状态、关键指标卡。
- AI 问数链路：问题理解、Schema 匹配、SQL 生成、安全校验、查询执行、结果解释。
- Demo 护栏：只读 SQL、白名单表、敏感信息拦截、超范围问题引导、规则兜底。

## 技术路线

- 前端：Next.js、React、TypeScript、Tailwind CSS
- 数据库：SQLite 示例数据
- 图表：轻量 React 图表组件
- 地图：示例坐标点位和区域聚合
- AI：预留 DeepSeek/Kimi 接入；初版提供规则兜底链路，保证作品集可稳定体验

## SDD 文档

项目采用 SDD（Spec-Driven Development，规格驱动开发）方式推进。所有产品判断、范围变化、数据设计、交互策略、技术策略和代码修改，都必须先或同步落实到 Markdown 文档。

- [SDD 文档索引](./docs/00-sdd-index.md)
- [产品方案总览](./docs/01-product-overview.md)
- [决策日志](./docs/02-decision-log.md)
- [数据库设计与样例问题库](./docs/03-data-design-and-sample-questions.md)
- [页面原型结构与交互流程](./docs/04-prototype-and-interaction.md)
- [PRD](./docs/05-prd.md)
- [技术实现方案](./docs/06-technical-implementation.md)
- [作品集详情页文案](./docs/07-portfolio-page-copy.md)
- [面试讲解稿](./docs/08-interview-script.md)
- [演示视频脚本](./docs/09-demo-video-script.md)
- [实现记录](./docs/10-implementation-log.md)

## 本地运行

初版完成后使用：

```bash
npm install
npm run db:generate
npm run dev
```

访问：

```text
http://localhost:3000
```

## 数据说明

本 Demo 基于公开数据结构与模拟运营数据构建，用于展示 AI 问数产品的核心体验，不代表真实商业运营数据。
