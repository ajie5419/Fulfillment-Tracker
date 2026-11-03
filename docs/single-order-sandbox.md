# 独立单工单测试环境

此环境仅用于合成数据测试，不是 QMS 联调、自动流程或生产安全验收。

## 当前入口

- 唯一电脑入口：`https://192.168.18.103:3110/`；手机同一 Wi-Fi 使用同源 `/m`。
- 旧履约 `localhost:3100` 已停用；真实 QMS 5320/5666 和 MySQL 3307 未停用、未切换配置。
- 当前库：`127.0.0.1:3307/fulfillment_sandbox_1793684774922`。
- 授权页仅提供 `【独立测试】项目经理`（`sandbox-pm`），不需要真实 QMS 用户或密码。
- 唯一工单：`SANDBOX-ONLY-001`；客户、项目、工件均为合成数据。
- 页面顶部和标题明确显示测试环境以及 QMS 写回、自动任务禁用状态。
- 使用专用自签名证书，30 天有效。本次接口测试显式信任该证书，未关闭 TLS 校验；浏览器/手机需自行信任该测试证书。未安装系统根证书或更改系统信任设置。
- 局域网地址改变时停止服务、重新签发证书并同步专用配置中的 host、authorize URL、callback URL；不得只改浏览器访问地址。

## 重启与复核

在项目主目录执行：

```bash
cd .worktrees/single-order-sandbox
node scripts/sandbox.mjs start
```

不要重复启动。启动前检查 3110、4110、4111 端口；占用时拒绝启动，不复用旧服务。需要后台运行时：

```bash
nohup node scripts/sandbox.mjs start > logs/sandbox-runtime.log 2>&1 &
node scripts/verify-sandbox.mjs
node scripts/sandbox.mjs counts
```

`.env.sandbox` 为 0600 忽略文件，不提交、不打印。启动器将专用配置显式传入子进程，并使用 `nuxt dev --dotenv .env.sandbox`；工作树不复制主目录 `.env`，不 symlink 依赖。客户端按 host-only Secure Cookie 登录，认证状态 Cookie 仍限定 `/auth/`，回调和电脑/手机页面保持同一 HTTPS host。原 localhost Cookie 不会发往专用局域网 IP。

## 在新的独立 worktree 首次创建

```bash
pnpm install --frozen-lockfile
SANDBOX_HOST=192.168.18.103 node scripts/sandbox.mjs init
```

初始化器依赖本机 `container` CLI、`qms-container-mysql` 内已存在的 root 环境凭据及 OpenSSL，不读取或显示管理员密码。它只读原库计数，然后选择不存在的带时间戳库名，创建独立账号；该账号仅对新库临时取得迁移权限，迁移后撤销 DDL 权限，运行期仅保留新库 SELECT/INSERT/UPDATE/DELETE。精确 host/port/database guard 通过后才运行迁移和合成事务；已存在 `.env.sandbox` 或非空库时拒绝 seed，无清空、重置、删除库入口。失败后保留新库便于人工检查，不自动删除任何资源。

不导入原业务数据、真实用户或原 mock 的多用户列表；仅创建 1 工单、1 用户、1 部门、1 工序定义、1 工件、1 工序路线。工单交期为初始化当天之后 30 天，初始待办为 0。重启不重新 seed。

## QMS 隔离与明确限制

- 身份桥 `127.0.0.1:4111` 和受控入口 `127.0.0.1:4110` 只监听 loopback。手机授权页经同源 `/auth/sandbox-authorize` 转发，不要求手机访问电脑的 loopback。
- `NUXT_QMS_API_BASE` 仅指向 4110。授权、exchange、identity、revoke 仅由现有 mock 身份桥处理，保留 PKCE、客户端凭据、CSRF、一次性授权码和真实数据库 session 创建流程。
- 4110 只允许身份协议；新建、修改、取消、客户列表、业务读取、同步等其他请求一律返回契约内 400 `SANDBOX_WRITE_DISABLED`，中文提示“独立单工单测试：QMS 业务写回与同步已禁用，未执行任何远端操作”。不伪造成功，不调用真实 QMS，也不修改生产安全校验。
- 既有 mock 同步 fixture 包含多工单，不在本环境加载。同步开关关闭，sandbox 配置下 `scheduledTasks` 为空，开发演示接口关闭。因此不能用此环境验收自动同步、自动预警或真实 QMS 写回。
- 仅测试本地业务操作；不可用本环境验证新增/修改/取消 QMS 工单成功路径。测试账号是合成管理员/项目经理，不能用来验收完整角色矩阵。

## 已执行验证

- 原履约库只读计数前后均为 286 工单、46 用户；这不是“外部进程绝对零变更”的证明。本次没有向原库或 QMS 库发出写命令。
- 新账号读取原履约库和 QMS 库均被 MySQL 拒绝；授权清单只有新库 DML，没有全局业务权限或 DDL 权限。
- `node scripts/verify-sandbox.mjs`：完整安全授权登录成功；缺少来源 Cookie 和回调重放被拒绝；Cookie 为 Secure、host-only；数据库会话用户与 fixture 对齐。
- `/api/work-orders?closed=1` 和 `/api/board?closed=1` 各恰好 1 条；`/api/todos` 正常。实际取消 API 显示写回禁用提示，工单仍为 IN_PROGRESS；stub 新建/修改/取消/同步均明确拒绝。
- 电脑 `/`、手机 `/m` HTML 返回成功且有测试标识；尚未进行浏览器视觉、真实手机、跨设备证书信任或 Wi-Fi 连通性验收。
- `pnpm typecheck`、`pnpm quality:check`、`rtk vitest run tests/unit` 通过（1205 项单测）。

日志仅写入 worktree 的 `logs/`；启动器对子进程日志中的授权 code/state 脱敏。验收脚本只输出状态与计数，不输出密码、令牌、会话或授权参数。
