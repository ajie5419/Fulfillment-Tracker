---
name: ft-project-guide
description: 接手、解释、开发或排查项目履约系统 Fulfillment-Tracker 时使用，按任务定位业务流程、Nuxt 架构、API、权限、共享规则和验证入口。适用于本仓库及其工作副本；不用于无关项目，也不把咨询或审查转换为修改授权。
---

# 履约项目接手与开发导航

## 确认项目与任务

本 Skill 随 Fulfillment-Tracker 仓库维护。相对链接以本文件为起点；执行命令以**用户当前工作副本根目录**为起点，不以全局安装链接所在目录为起点。

1. 确认仓库、分支和已有改动。结合 `package.json`、`server/services/`、`prisma/schema.prisma` 核实项目身份，不只看目录名。不在项目内时使用用户指定路径；多个副本无法区分时先明确目标。
2. 读取当前副本的 [AGENTS.md](../../../AGENTS.md)。已加载则不重复读取，不在 AGENTS 与本 Skill 之间递归跳转；保护无关改动。
3. 只读取本任务需要的下述资料。介绍、调查、审查保持只读；实施请求才修改。Skill 本身不授权启动服务、清库、部署或推送。
4. 文档与代码冲突时，分别说明规范要求、实际实现和未验证行为。历史方案、旧提交的验收记录不能直接当作当前事实。

## 项目与架构

项目履约系统覆盖工单、计划、设计出图、工艺、采购及付款、生产与外协流转、齐套、发放签收、异常预警和个人待办。QMS 提供身份与部分业务数据；它们是独立应用，不能混用内部 API 契约。

| 范围 | 实现与入口 |
| --- | --- |
| 框架 | Nuxt + Nitro；版本及包管理器以 [package.json](../../../package.json) 和锁文件为准 |
| 电脑端 | `app/pages/`、`app/components/`；Ant Design Vue 与公共 UI 组件 |
| 手机端 | `app/pages/m/`；Vant，业务状态与电脑端共用 |
| 后端 | `server/api/` 文件路由、`server/schemas/` 输入校验、`server/services/` 业务服务 |
| 数据 | MySQL；[Prisma schema](../../../prisma/schema.prisma)、`prisma/migrations/` |
| 共享规则 | `shared/`：部门编码、状态、数量、上传限制、预警等 |
| 客户端契约 | [client-api.ts](../../../app/types/client-api.ts)、[transport.ts](../../../app/utils/transport.ts) |
| 外部对接 | `server/services/auth/` 身份桥，`server/services/sync/` 增量同步 |

介绍功能先查 [README](../../../README.md)，再定位当前实现。没有找到实现的功能只能称为方案或待办，不能根据菜单或历史计划宣称完成。

## 按任务读取

| 任务 | 文档 | 实现入口 |
| --- | --- | --- |
| 接手、解释功能 | README、[系统方案设计](../../../docs/系统方案设计.md)、[维护性治理](../../../docs/系统维护性治理.md) | `app/pages/`、`server/services/`、Prisma schema |
| 页面与交互 | [前端设计规范](../../../docs/前端设计规范.md)、[页面文件对照](../../../docs/前端页面文件对照.md) | `app/components/ui/`、`app/assets/base.css`、`app/pages/m/` |
| 业务 API | 下方 API 说明、相邻路由和测试 | `server/utils/api.ts`、`server/schemas/`、相应 service |
| 登录与权限 | 当前鉴权实现、维护性治理 | `server/utils/auth.ts`、`server/services/auth/permissions.ts`、`server/services/auth/` |
| 计划日期与发布 | [总计划设计](../../../docs/总计划设计.md)、[生产日历方案](../../../docs/生产日历方案.md) | `server/services/plan/`、`server/services/calendar/` |
| 设计、工艺和开工联动 | 维护性治理中的入口、事务与迁移约束 | `server/services/drawings/`、`server/services/process/requirements.ts`、`shared/` |
| 采购、付款、齐套 | README 对应功能、共享业务规则 | `server/services/purchases/`、`server/services/kitting/` |
| 生产、返厂、预警、待办 | README 对应功能、相邻行为测试 | `server/services/flow/`、`server/services/alerts/`、`server/services/jobs/` |
| QMS 联调 | [接口约定](../../../docs/接口约定.md)、[同步客户端](../../../server/services/sync/client.ts) | `server/services/auth/identity-bridge.ts`、`server/services/sync/`、`server/services/workorder/` |
| 演示或单工单沙盒 | [独立演示环境](../../../docs/独立演示环境.md)、[单工单沙盒](../../../docs/single-order-sandbox.md) | `scripts/demo.mjs`、`scripts/sandbox.mjs` |
| 数据升级与发布准备 | [发版手册](../../../docs/发版手册.md)、维护性治理 | migrations、`.github/workflows/`、升级测试 |

`docs/角色与可见范围现状.md` 标注的是历史代码快照，`docs/权限方案-待确认.md` 含提案；不能直接当作现行权限契约。带日期的验收记录仅证明当时的代码与环境。

## API 分为两种契约

### 履约内部 API

先查 [server/utils/api.ts](../../../server/utils/api.ts)。普通业务入口通常用 `defineFlowHandler` 完成登录与可见范围检查，管理员入口用 `defineAdminHandler`；还要核对具体操作在 service 中的授权，登录成功不等于任意写入权限。

输入复用 `parseBody`、`parseQuery`、`routeId` 和相邻 Zod schema；路由调用业务 service。错误沿用 `FlowError` 系列及共享业务码，由全局 API 错误出口统一序列化。页面复用 transport 的错误处理与 `ClientResponse`，不重复手写已治理的响应模型。

成功和失败均遵循 [API 响应规范](../../../docs/API响应规范.md) 的 `{ code, data, message }`。成功 `code: 0`，失败使用稳定业务码和真实 HTTP 4xx／5xx。例如采购计划分页对象位于 `data` 内，服务层仍返回业务数据，handler 统一封装；禁止二次包裹。页面通过 `useApiFetch`／`apiFetch` 或领域请求函数解包，SSR 用 `useApiRequestFetch()` 保留当前会话。文件下载和认证协议按规范例外处理。不能把履约约定强加给外部 QMS。

### QMS 对接 API

`docs/接口约定.md` 专门说明 QMS 工单对接，不是全部履约 API 的总规范。同步客户端使用 QMS 的响应封装及双字段游标。机器凭据通过既有配置与请求头使用，不读取或输出秘密文件。

跨系统改动同时核对 QMS 服务端和履约客户端的认证、字段、乐观锁、软删除、分页游标与兼容性。QMS 同步副本与工单写入入口要区分，写入路径查 `server/services/workorder/`。缺少另一端源码或运行环境时报告验证边界，不声称双端已打通。

## 改动约束

完整规则由 AGENTS 与维护性治理文档维护，本文件不建立第二套规范。

- 跨端、跨模块规则先找 `shared/` 的唯一入口。使用稳定部门、状态和动作编码；显示名称不能决定权限或业务分流。
- `requiresProcess` 变更连同开工条件和工艺待办核对事务边界，不能只改页面开关。
- 复用公共 UI、状态和请求组件；页面修改分别验证桌面和手机。
- 不上调质量基线绕过问题，不借当前任务擅自清理历史债务。
- 接口、共享规则或职责变化时更新对应权威文档；不要把本次运行状态和测试数量固化进 Skill。

## 验证入口

先核对当前 `package.json`、CI 与相邻测试，下表不是每次必须全部执行的清单。

| 改动 | 检查 |
| --- | --- |
| 文档或 Skill | 链接、路径、指令一致性、格式和差异 |
| 业务规则或 API | 相关 `tests/unit/`；按影响运行 `pnpm typecheck`、`pnpm quality:check` |
| 数据库、事务、锁或同步 | 相关 `tests/integration/` 和隔离 MySQL；迁移验证非空旧数据及重复执行 |
| UI | 相关测试、类型／构建，以及已授权环境中的桌面和手机实际操作 |
| 发布前完整检查 | 当前 CI 和发版手册；本地通过不等于已发布 |

命令入口有 `pnpm test`、`pnpm test:integration`、`pnpm typecheck`、`pnpm quality:check`、`pnpm build`；实际定义以 package.json 为准。直接调用 Git、Vitest 时遵守当前环境的 RTK 规则，不把本机工具约定强加给其他客户端。

**集成测试会清表。** 仅使用获授权的可丢弃测试库，先核对测试数据库保护逻辑，不得指向生产库或用户演示库。要求真实数据库验证时使用 `REQUIRE_TEST_DATABASE=1`；跳过不等于通过。不自行读取 `.env` 或打印连接凭据。

介绍、审查不启动服务；实施时能否启动、重启服务或操作数据库，由当前任务授权决定。模拟身份桥不等于真实 QMS 登录验收。

## 交付与跨 AI 使用

报告实际改动、执行的检查、通过／失败及未验证边界；不借用旧验收记录或其他工作副本的结果。

AGENTS、CLAUDE 入口指向同一份 Skill。支持 Skill 的客户端可显式调用 `ft-project-guide`，支持自动发现的客户端也可按描述选择；不支持的 AI 直接读取本文件及任务相关链接。不能假定所有客户端都会自动加载。
