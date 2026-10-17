# 项目履约系统（Fulfillment Tracker）

外协交接闭环：外协返厂报检（QMS）→ 下工序待办 → 停滞预警 → 异常升级。
设计依据：项目文件 `履约流程/系统方案设计.md`、`履约流程/技术选型与MVP范围.md`。

技术栈：Nuxt 3（Nitro 服务端）+ Prisma 6 + MySQL 8；电脑端 Ant Design Vue，手机端（`/m`）Vant。Node 22，pnpm。

## 本地启动

```bash
pnpm install
cp .env.example .env                          # 按注释填写
docker compose -f docker-compose.local.yml up -d   # 本地 MySQL；或复用 QMS 本地 MySQL，见下
pnpm db:migrate                               # 建表
pnpm cert:local                               # mkcert 生成 https://localhost 证书（身份桥只接受 https 回调）
pnpm dev                                      # https://localhost:3100
```

复用 QMS 本地 MySQL 容器时，以 root 执行一次 `docker/mysql-init.sql`，`.env` 的端口按容器实际映射填写（例如 3307）：

```bash
container exec -i <QMS MySQL 容器名> sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < docker/mysql-init.sql
```

登录走 QMS 身份桥（接口见 `server/services/auth/identity-bridge.ts` 顶部注释，依据 QMS `apps/backend/modules/identity-bridge`）。QMS 本地还没跑起来时，可以先用模拟身份桥：

```bash
node scripts/mock-identity-bridge.mjs         # 监听 4100，授权页上选择以哪个演示用户（u-001 ~ u-006）登录，也可带 ?as=u-003；同一端口还有模拟的 QMS 同步接口
# .env 中改为：
# NUXT_QMS_API_BASE="http://localhost:4100"
# NUXT_QMS_AUTHORIZE_URL="http://localhost:4100/identity/authorize"
# NUXT_QMS_CLIENT_SECRET="local-dev-secret-local-dev-secret-0"
```

## QMS 数据同步（R2）

`sync-qms` 每 5 分钟按游标（`sync_cursor`）增量拉取 QMS 的工单、外协单位、厂内外协班组（`teams`，与外协单位同存 `qms_supplier`，kind = TEAM）、工序、部门、用户、报检，写入 `qms_*` 只读副本，然后对新报检做返厂匹配（只看工件登记之后提交的报检；多工单报检任一工单命中即候选）、QMS 不合格转异常（`inspectionResult = FAIL` 或关联了 QMS 问题单）。接口契约：`GET /api/integration/fulfillment/<resource>`，认证用身份桥同一组客户端凭据（`server/services/sync/client.ts` 顶部注释）。

- 每页写入与推进游标在同一事务里，中断后下一轮续跑，不重复、不丢；单次运行每类最多 200 页
- 某类失败记在 `sync_cursor.lastError`、连续失败次数 +1；连续 3 次给管理员发一条置顶的"我的提醒"（同一轮故障只发一次）
- 看板显示"QMS 最后同步"（各类资源里最旧的那类），有报错时显示错误；设置页"QMS 同步状态"列出每类的游标、最近错误、连续失败次数
- `NUXT_QMS_SYNC_ENABLED=0`，或 QMS 地址、客户端凭据为空时任务跳过不报错
- 本地联调：`node scripts/mock-identity-bridge.mjs` 同时提供同步接口，数据来自 `scripts/fixtures/mock-qms.json`（可用 `MOCK_QMS_FIXTURE` 换文件）；演示工具页"立即同步一次"可手动触发

## 演示数据（R3，不连 QMS 时）

`.env` 加 `NUXT_DEV_TOOLS=1` 后重启，电脑端菜单出现"演示工具"：

- 写入演示数据：2 个工单、5 个外协厂、5 道工序、5 个用户（u-001 测试外协专员、u-002 测试生产经理（生产部负责人）、u-003 测试项目经理、u-004 测试项目部负责人、u-005 测试分管领导）、通知对象、工单项目经理（u-003）、默认阈值，以及示例工件"主梁结构件"（组焊 → 涂装 → 装配）。ID 都带 `DEMO-` 前缀，可重复点
- 模拟 QMS 返厂报检：可"按在途步骤填写"出一条能对上的报检，或"改成对不上的"，提交后立即匹配
- 预警扫描（R4）："立即扫描"、"快进 3 天 / 5 天扫描"用 当前时间 + N 天 跑一轮，演示 Q12：返厂后不安排涂装，第 3 天 W2 黄、第 5 天红；换 u-005 登录可看到红色提醒
- 清除演示数据：只删 `DEMO-` 数据和引用它们的工件、步骤、流转记录、待办、待确认记录、预警和提醒，并清掉演示的通知对象、工单项目经理，阈值恢复默认（停工日不动）；同步来的真实数据不动
- 配置了 QMS 同步时，写入演示数据不写演示用户（u-001 等与 QMS 用户同一批 ID，以 QMS 为准），其余 `DEMO-` 数据与真实数据共存

关闭时 `/api/dev/*` 一律 404。生产不要开。

## BOM 导入与路线模板（R8）

- **从 QMS BOM 导入**（工件与工序链页）：服务端实时调 QMS `GET /api/integration/fulfillment/work-orders/<工单号>/bom`（复用 `NUXT_QMS_API_BASE` 与客户端凭据，不受 `NUXT_QMS_SYNC_ENABLED` 影响；浏览器不直连 QMS），勾选后整批一个事务导入：每个 BOM 行建一个工件（名称、图号、数量、QMS 零件 ID → 报检按它匹配），必经工序按顺序建步骤，方式默认"自制"、不带负责人，页面标"待补充"。
- 重复导入按 BOM 行 ID（`part.qmsBomId`，同工单唯一）跳过，绝不修改已有工件；QMS 里没有工序 ID、或履约工序副本里还没有的工序跳过并提示（步骤只存工序 ID）。需要 QMS 先升级出 BOM 接口，否则提示"QMS 还没有 BOM 接口"。
- **路线模板**（菜单"路线模板"）：工序 + 方式 + 默认外协厂 + 默认工期；管理员维护，可从工件"另存为模板"。没有工序的工件可"套用模板"（复制步骤，负责人默认操作人；填了开工日才按默认工期推算要求完成日）。改模板不影响已套用的工件。
- 演示：写入演示数据后，`DEMO-WO-002` 的 BOM 导入读演示 BOM（不连 QMS），另带一个演示模板；清除演示数据一并删掉（含引用演示工序的模板）。本地模拟 QMS（`scripts/mock-identity-bridge.mjs`）的 `QMS-WO-2026-001` 也有 BOM。

## 检查

| 命令 | 内容 |
|---|---|
| `pnpm typecheck` | 页面与服务端类型检查 |
| `pnpm test` | 核心单元测试 |
| `pnpm build && TEST_DATABASE_URL=mysql://…/fulfillment_test pnpm test:integration` | 集成测试：登录走通与设置页权限（真实构建产物 + 模拟身份桥）、外协主链路和预警（服务层直连 MySQL）。测试库必须是专用库，测试会清空其中的业务表 |

## 部署（与 QMS 同机）

```bash
docker compose build
docker compose run --rm fulfillment prisma migrate deploy   # 上线前人工执行
docker compose up -d
```

容器加入 QMS 的 `qms-network`，经 `http://qms-backend:3000` 调用身份桥；端口只绑 `127.0.0.1:3100`，由 443 入口（IP 证书）反向代理。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 履约库连接串。生产账号只授予 `fulfillment` 库权限 |
| `NUXT_QMS_API_BASE` | QMS 后端地址（服务端调用）。生产 `http://qms-backend:3000` |
| `NUXT_QMS_AUTHORIZE_URL` | QMS 授权页完整地址（浏览器跳转）。本地 `http://localhost:5666/identity/authorize`，生产 `http://<IP>/#/identity/authorize` |
| `NUXT_QMS_CLIENT_ID` / `NUXT_QMS_CLIENT_SECRET` | 与 QMS 的 `QMS_IDENTITY_CLIENT_ID` / `QMS_IDENTITY_CLIENT_SECRET` 一致，密钥 ≥32 位 |
| `NUXT_QMS_CALLBACK_URL` | 回调地址，必须 https、不带 `?` `#`，与 QMS 的 `QMS_IDENTITY_CALLBACK` 完全一致 |
| `DEV_HTTPS_KEY` / `DEV_HTTPS_CERT` | 仅本地开发：mkcert 证书路径 |
| `NUXT_DEV_TOOLS` | 仅本地开发：`1` 开启演示数据和模拟报检，默认关闭 |
| `NUXT_QMS_SYNC_ENABLED` | QMS 数据同步开关，默认开启；`0` 关闭（复用 `NUXT_QMS_API_BASE` 与客户端凭据） |
| `NUXT_ADMIN_USER_IDS` | 管理员（设置页：阈值、停工日、通知对象、工单项目经理），逗号分隔的 QMS 用户 ID；演示时用 `u-001` |

QMS 同步 `sync-qms` 每 5 分钟（`server/tasks/sync-qms.ts`）、预警扫描 `scan-rules` 每 15 分钟由 Nitro scheduledTasks 执行（`server/tasks/scan-rules.ts`），`pnpm dev` 和构建产物都会跑；用 `job_lock` 表上的租约锁防重叠（进程崩溃后租约到期自动失效：扫描 10 分钟、同步 15 分钟）。

缺少必填项时服务启动即报错退出。
