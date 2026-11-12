---
name: ft-frontend
description: 开发、重构、优化或审查项目履约系统 Fulfillment-Tracker 的电脑端（app/pages/、app/components/）与手机端（app/pages/m/）前端界面时使用。涵盖 Statsnap 极简视觉规范、去 AI 味布局纪律、公共 UI 组件映射、高密度业务视图模式（树表、甘特图、紧凑子列表、阶段看板）、请求错误态与 URL 状态同步防坑清单。
---

# 履约系统前端开发与 UI 规范（ft-frontend）

## 一、适用范围与权威依据

本 Skill 用于指导 Fulfillment-Tracker 电脑端（Ant Design Vue）与手机端 `/m`（Vant）的页面开发、布局重构与 UI 审查。

1. **权威文件**：
   - 视觉与组件规范：[docs/前端设计规范.md](../../../docs/前端设计规范.md)
   - 页面与路由索引：[docs/前端页面文件对照.md](../../../docs/前端页面文件对照.md)
   - 全局样式与设计 Token：[app/assets/base.css](../../../app/assets/base.css)、[app/assets/mobile.css](../../../app/assets/mobile.css)、[shared/theme.ts](../../../shared/theme.ts)、[shared/status.ts](../../../shared/status.ts)
   - 工程总则：[AGENTS.md](../../../AGENTS.md)
2. **只读与提交原则**：
   - 当用户仅询问方案、要求审查或索取效果预览图时，保持业务代码只读（可在临时目录生成 HTML 渲染示例图供确认）。
   - 实施修改并通过验证后，按 [AGENTS.md](../../../AGENTS.md) 约定自动执行本地 `git commit`。

---

## 二、视觉基线与「去 AI 味」硬性纪律

全站采用 **Statsnap 极简高密度工业工作台**风格：纯白画布与单层白卡、浅灰托盘与表头、`1px` 中性灰细边框、克制的状态色。编写或重构任何组件时，严格遵守以下反 AI 模板化（Anti-AI-Slop）铁律：

1. **零硬编码色值**
   - 页面和组件 `<style>` 中**严禁新增任何十六进制颜色（`#xxxxxx`）或裸 `rgb()`**。
   - 表面、文字、边框、状态色一律引用 [app/assets/base.css](../../../app/assets/base.css) 中的 `--ft-*` 与 `--card-*` 变量。
2. **严禁卡片左侧粗色条**
   - **禁止**在卡片或列表项左侧加 `border-left: 3px/4px solid ...` 预警色条。
   - 所有卡片统一为单层纯白底（`var(--ft-card-bg)`）+ `1px solid var(--ft-border)` 细边框。
3. **严禁单张卡片内堆砌彩色胶囊底块**
   - 工单号使用原生 `<WoLink :no="..." />` 链接，不套高饱和度背景块。
   - 常规流程属性（如未超期的“需客户确认 11-11”、关联件数）用次要灰字（`var(--ft-text-2)` / `var(--ft-text-3)`），不滥用黄色/橙色背景胶囊。
   - 临期与逾期提醒优先合并进排期文字行，用深一档状态文字色（`var(--ft-risk-text)`、`var(--ft-late-text)`、`var(--ft-done-text)`）表达（对比度 ≥ 4.5:1），且永远带明确文字，不靠纯色块表达状态。
4. **严禁表格操作列形成「实心蓝柱子」**
   - 分区右上角新建/主操作按钮使用 `.ft-btn-ink`（深墨黑底 `#282828`）。
   - 表格行内与看板卡片内的流转按钮优先使用默认白底细框 `<a-button size="small">`，去掉花哨的 `→` 箭头；操作列容器必须设置 `white-space: nowrap` 单行右对齐。
5. **严禁套娃阴影与列头彩虹圆点**
   - 顶层 `UiSectionCard` 内部嵌套的子卡片、工单分组框、看板分栏只用 `1px` 细边框，不叠加外阴影。
   - 看板列头、分组标题保持干净的粗体文字 + 中性灰计数胶囊，不加五颜六色的装饰圆点。
6. **数字等宽对齐**
   - 凡涉及日期、工期、金额、数量、百分比、编号的容器，一律声明 `font-variant-numeric: tabular-nums`。

---

## 三、公共 UI 组件优先映射表

动笔写页面前先查 [`app/components/ui/`](../../../app/components/ui) 与 [`app/components/m/`](../../../app/components/m)，**有现成组件绝不手写 DOM 结构**：

| 界面元素 | 必须使用的组件 / 类名 | 关键约定 |
| --- | --- | --- |
| 页面顶部导览头 | `UiPageHero` | 概览型页面主标题 + 实况一句话摘要，右侧 `#actions` 放 `.ft-btn-ink` |
| 顶部统计指标行 | `.ft-stats` + `UiStatCard` | 4 列（或 `.cols-3`），支持 `clickable` 与 `:active` 联动列表筛选；加载/报错时传 `'—'` |
| 主内容分区卡 | `UiSectionCard` | 页面所有区块统一容器；表格贴边时可用 `padding="none"`，内嵌多卡时用 `flat` |
| 状态胶囊标签 | `UiStatusTag` | `tone="late\|risk\|done\|upstream\|none\|primary"`，插槽文字必填 |
| 状态图标 | `UiStatusIcon` | 用形状区分状态，不单靠颜色 |
| 工单分组条 | `UiWoGroupHead` | 按工单分组时的统一灰色顶栏（带工单号、关联节点、进度与项数） |
| 工单 / 节点链接 | `WoLink`、`PlanNodeCell` | 统一跳转链接与节点编号胶囊；Flex 容器内注意 `min-width: 0` |
| 筛选抽屉与标签 | `UiFilterButton`、`UiFilterChips` | 工具栏只放 1~2 个高频下拉，其余收进 `UiFilterButton`，已选条件用 `UiFilterChips` 展示 |
| 字段长说明 | `UiHelpTip` | 表单或标题旁的长篇业务规则说明全部收进气泡，不直接铺在页面上 |
| 刷新按钮 | `UiRefreshButton` | 仅图标按钮，放在 `UiSectionCard` 的 `#extra` |
| 字符串日期选择 | `UiDatePicker` | 绑定 `YYYY-MM-DD` 字符串，避免页面散落 Dayjs 转换样板代码 |
| 图表组件 | `UiRing`、`UiColumnChart`、`UiDonut`、`UiBarList` | 齐套环图、柱图、占比环图、部门横条排行统一复用 |
| 手机端卡片 | `MCard`（`app/components/m/Card.vue`） | 白底细边框，配合 `.m-section`、`.m-row`、`.m-title`、`.m-desc`、`.m-meta` |

---

## 四、高密度业务视图模式库

### 1. 卡片头部与单行工具栏（Toolbar Single-Line Rule）
- 当页面同时存在「主页签切换」（如 `[任务列表 | 设计负荷]`）和「布局切换」（如 `[按工单 | 按阶段看板 | 表格]`）时：
  - `#title` 左侧放标题 + 主页签 `a-segmented`；
  - `#extra` 右侧放布局切换 `a-segmented` + `UiRefreshButton` + `.ft-btn-ink` 主按钮；
  - 下方 `.ft-toolbar` 左侧放生命周期状态分段（带实时计数），右侧放工单/负责人下拉与搜索框，**确保在一行内左右两端对齐排完**，消除折行后的半截留白。

### 2. 树形层级表格（如 [`PlanNodeTable.vue`](../../../app/components/PlanNodeTable.vue)）
- 表格外层套 `border: 1px solid var(--ft-border); border-radius: 10px; overflow: hidden;`，避免内层表格四边裸露。
- 父子层级行通过连续竖向树形引导线（`::before` / `::after`）表达从属关系；无子节点的叶子行不渲染空白占位框。
- 节点编号（`1.1`）与前置节点（`2.1`）统一用浅灰细框微胶囊展示，天然支持按编号自然排序（`localeCompare(..., { numeric: true })`）。

### 3. 主从内嵌分解列表（如 [`dept-plan.vue`](../../../app/pages/dept-plan.vue) + [`PlanNodeWork.vue`](../../../app/components/PlanNodeWork.vue)）
- 在节点列表或分组卡片内部展示子任务时，**禁止每个节点下重复渲染带表头的 `<a-table>`**。
- 改用 `1px` 圆角外框包裹的无表头紧凑行列表（`.task-row`）：
  - 左侧：`[类型微胶囊]` + `[任务名称链接]` + `[简短备注]`
  - 右侧：`[责任人]` + `[计划完成日]` + `[状态胶囊]` + `[行内小按钮]`
  - 新建/分解入口收进父节点头部右侧（`＋ 分解任务`），空状态压缩为单行浅灰提示条。

### 4. 四阶段看板视图（如 [`DrawingKanbanBoard.vue`](../../../app/components/DrawingKanbanBoard.vue)）
- 四列灰底托盘（`background: var(--ft-fill); border: 1px solid var(--ft-border)`）+ 单层白底细框卡片（`.k-card`）。
- **防溢出与防截断铁律**：
  - `.k-card` 及内部 Flex 容器必须声明 `min-width: 0; overflow: hidden;`；
  - `<PlanNodeCell>` 独占一行展示所属节点，不与其它长标签硬挤同行；
  - 卡片底部左侧采用双行紧凑排版（第一行 `责任人 · 日期`，第二行按需展示 `到期预警 · 需确认日期`），右侧放单个 `<a-button size="small">` 流转按钮，避免窄列下文字越界或关键日期被 `...` 截断。

### 5. 甘特图与多字段编辑弹窗（如 [`PlanGantt.vue`](../../../app/components/PlanGantt.vue)、[`PlanNodeEditModal.vue`](../../../app/components/PlanNodeEditModal.vue)）
- **甘特图**：父节点用深色括号形汇总条（两端向下耳标），子节点用圆角进度条；前置依赖通过全画布 SVG 绘制 Finish-to-Start 折线箭头；鼠标悬停节点时高亮其直接上下游链路并置灰无关行；「今天」与「交期」除竖向虚线外在表头固定醒目胶囊。
- **编辑弹窗**：表单项超过 5 个时，将短字段（负责人、部门、开始日、完成日、周期、前置节点）排成 **2 列紧凑 Grid**，长文本（节点名称、说明）跨双列，长篇业务说明收进 `<UiHelpTip>`，底部左侧放危险删除按钮、右侧放取消/保存。

---

## 五、状态、请求与路由同步防坑清单

1. **请求失败严禁冒充空状态**
   - `useFetch` / `useAsyncData` 带 `default` 时，请求报错后 `data` 仍为默认空数组。
   - 模板必须先判断 `v-if="error && !pending"` 渲染 `<a-result status="error" ...><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>`（手机端用 `<van-empty image="error">`），**绝不能落入 `<a-empty>`**。
   - 顶部 `UiStatCard` 在 `pending || error` 时必须显示 `'—'`，不能显示 `0`。
2. **严禁给 `<a-empty>` 传 `:image="null"`**
   - 当前 Ant Design Vue 版本下传 `:image="null"` 会触发运行时异常导致整块渲染空白；局部紧凑空状态直接写 `<p class="muted">暂无…</p>`。
3. **URL 查询参数双向同步与一次性定位**
   - 页面把筛选条件写回 `route.query` 时，必须同时 `watch(() => route.query, ...)` 反向同步到本地 `filter`，保证点击顶栏提醒或全局搜索同页跳转时列表立即响应。
   - 一次性定位参数（`?id=`、`?part=`、`?step=`、`?edit=`、`comments=1`）统一使用 [`useOneShotQuery.ts`](../../../app/composables/useOneShotQuery.ts) 并传入对应接口的 `{ pending, error }`，定位完成后或用户切换页签时立即从地址栏清除。
4. **SSR 认证透传与类型派生**
   - 页面级 `useAsyncData` 内部调用 `clientRequest` 时，必须传入 `const requestFetch = useRequestFetch()`，严禁在 SSR 期间裸调 `$fetch`。
   - 状态字典与校验常量只从 `#shared/...` 引入；前端接口类型从 `ClientResponse` 派生，不在页面手写重复接口定义。

---

## 六、改动自查与验证步骤

每次完成前端页面或组件修改后，按顺序执行以下核对：

1. **色值扫描**：运行 `git diff -U0 | grep -E '^\+.*#[0-9a-fA-F]{3,8}'`，确认除 `base.css` 变量定义外无新增硬编码色值。
2. **单元测试与门禁**：运行相关单元测试（如 `npx vitest run tests/unit/request-states.test.ts tests/unit/fullflow-frontends.test.ts`）与 `pnpm quality:check`（质量门禁计数只许降不许涨）。
3. **新增子组件桩件同步**：若在业务页面新增了自定义子组件，检查 `tests/unit/request-states.test.ts` 的 `stubs` 列表是否需要同步登记。
4. **双端视口与演示环境验证**：确认 `1440px` 桌面端与 `390px` 手机端不破版、文字不出容器；若本地运行着独立演示服务（`:3101`），需执行 `pnpm build` 后重启演示服务才会生效。
5. **自动提交**：验证通过后立即执行 `git commit` 保存本地提交。
