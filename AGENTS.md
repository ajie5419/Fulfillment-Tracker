# 项目履约（Fulfillment-Tracker）

## 项目接手入口

首次接手本项目或需要定位功能、架构、API、验证方式时，读取 [ft-project-guide](.agents/skills/ft-project-guide/SKILL.md)，再按任务读取相关文档；已加载时不重复读取。Skill 负责导航，下方规范及其引用文档仍是规则来源。仅解释或审查时保持只读。

## 前端页面

页面风格已定稿（电脑端和手机端），**新增、修改或优化任何页面都按 [docs/前端设计规范.md](docs/前端设计规范.md) 及前端技能 [ft-frontend](.agents/skills/ft-frontend/SKILL.md) 做**：
优先用 `app/components/ui/` 里的通用组件（`UiSectionCard`、`UiStatCard`、`UiListItem`、`UiColumnChart`、`UiDonut`、`UiStatusTag`、`UiFilterButton`、`UiFilterChips`、`UiHelpTip`、`UiRefreshButton` 等），
颜色只用 `app/assets/base.css` 的 `--ft-*` 变量，不在页面里新增十六进制颜色。手机端 `/m`（vant）按规范第 6 节。

## 代码质量约定

- 状态码、状态文字等领域字典只许在 `shared/` 有一份定义；其他层引用或做视觉适配，不得复制。
- 业务阈值、数量、大小限制必须使用有名字的常量或共享策略，不许裸字面量散落。
- 数据加载失败必须有错误态，不许把失败显示成空数据。
- 前端不许 import 服务端实现（`import type` 除外）；同一业务规则不许前后端各写一份。
- 新文件超过 800 行需先拆分或说明理由。
- 质量门禁计数只许降不许涨；整改使计数下降后，运行 `pnpm quality:baseline` 更新基线并随 PR 提交。
- 每次完成代码修改并验证通过后，自动执行本地 Git 提交（`git commit`），无需等待用户额外提醒。
- 部门、角色、状态、待办动作使用稳定编码；显示名称只用于展示。外部旧名称只允许在边界映射，改显示名不能改变权限或流程。
- 节点是否需要工艺处理只读 `requiresProcess`；修改该属性、删除节点、替换模板、改挂设计任务时，必须在同一事务内同步工件开工条件和工艺提醒。
- 前端响应类型从 `ClientResponse` 派生；字段校验和限制放在 `shared/`，提示文字从相同规则生成，桌面和手机端使用相同业务状态。
- 内部 JSON API 遵守 [API 响应规范](docs/API响应规范.md)：统一 `{ code, data, message }`；路由通过统一 handler，前端通过 `useApiFetch`／`apiFetch` 或领域请求函数，禁止绕过封装与解包。文件下载和认证协议按规范列明例外。
- 变更上述规则需补行为回归及适用的质量门禁；不得通过提高基线或删除失败断言放行。集成测试在 CI 中缺少数据库必须失败。
- 维护入口、历史数据升级及验收要求见 [docs/系统维护性治理.md](docs/系统维护性治理.md)。
- 日志与业务审计遵守 [日志与审计规范](docs/日志与审计规范.md)：日志仅输出结构化白名单字段；审计与业务修改使用同一事务，禁止输出凭据或完整请求。
- 演示验收后的生产交付遵守 [首次生产部署](docs/首次生产部署.md)：新增配置同步维护生产模板和预检；演示数据不迁入生产，部署演练与真实 QMS/邮件验收分别记录。
