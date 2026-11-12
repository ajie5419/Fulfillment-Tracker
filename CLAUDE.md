# 项目履约（Fulfillment-Tracker）

## 项目接手入口

先读 [AGENTS.md](AGENTS.md)，再读 [ft-project-guide](.agents/skills/ft-project-guide/SKILL.md)，按任务定位功能、架构、API 和验证入口。已加载时不重复读取；不假定客户端已自动加载另一入口。现行规则以 AGENTS 及其引用文档为准，下方旧摘要不得覆盖现行规则。

## 前端页面

页面风格已定稿（电脑端和手机端），**新增或修改任何页面都按 [docs/前端设计规范.md](docs/前端设计规范.md) 做**：
优先用 `app/components/ui/` 里的通用组件（`UiSectionCard`、`UiStatCard`、`UiListItem`、`UiColumnChart`、`UiDonut`、`UiStatusTag`、`UiFilterButton`、`UiFilterChips`、`UiHelpTip`、`UiRefreshButton` 等），
颜色只用 `app/assets/base.css` 的 `--ft-*` 变量，不在页面里新增十六进制颜色。手机端 `/m`（vant）按规范第 6 节。

## 代码质量约定

- 状态码、状态文字等领域字典只许在 `shared/` 有一份定义；其他层引用或做视觉适配，不得复制。
- 业务阈值、数量、大小限制必须使用有名字的常量或共享策略，不许裸字面量散落。
- 数据加载失败必须有错误态，不许把失败显示成空数据。
- 前端不许 import 服务端实现（`import type` 除外）；同一业务规则不许前后端各写一份。
- 新文件超过 800 行需先拆分或说明理由。
- 质量门禁计数只许降不许涨；整改使计数下降后，运行 `pnpm quality:baseline` 更新基线并随 PR 提交。
