# 登录来源不符：排查证据与修复边界

## 2026-11-03 本地实测

- 原服务监听保持不变：履约 3100、QMS API 5320、QMS Web 5666。
- 对真实履约 HTTPS 登录入口发起全新请求，授权 origin 为 `http://localhost:5666`，路径 `/identity/authorize`；固定回调为 `https://localhost:3100/auth/callback`，与被测入口主机一致。
- 履约登录 cookie 名为 `ft_login_state`，值长度 43，属性为 `Path=/auth/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`，无 Domain。登录入口创建，回调删除；退出只删除 `ft_session`。桌面与手机共用此服务端链路。
- QMS 源码只通过 cookie 工具创建/删除 `jwt`，不是 `ft_login_state`。授权页校验返回 callback 的 redirectUri 和 state，然后 `location.replace`。未发现 QMS 同名 cookie 写入点。
- 使用内存 tough-cookie jar 吸收真实登录响应：首次 cookie 与授权 state 匹配；cookie 不发给 `/identity/authorize`，不发给其他 hostname。cookies 不按端口隔离，但路径与 Secure 属性仍参与匹配。
- jar 中模拟 QMS 的 `jwt` 写入，不改变履约 state。该值为无效合成值，不发往真实服务，不创建会话。
- 第二次真实登录响应覆盖第一次 `ft_login_state`：jar 与旧 state 不匹配，与新 state 匹配。因而重复登录/多个标签页可以产生同样的来源不符，但尚无用户现场证据证明本次发生了覆盖。
- 对真实服务发送无参数 `/auth/callback`，返回 400，仍发出删除 `ft_login_state` 的响应。jar 吸收后待完成登录 cookie 消失，证明无效回调能够破坏另一笔待完成登录。

## 最小修复

将 cookie 删除从读取 query 后移到 code/state 形状及浏览器 state 匹配校验后。缺参、缺 cookie、错误 state、旧标签页或拒绝回调继续失败，但不删除另一笔有效登录的 cookie。匹配回调仍删除 cookie、执行服务端一次性消费、PKCE 和身份核查；未削弱任何认证校验。

回归测试覆盖无效/旧回调不删除、不消费；当前匹配回调仍删除并拒绝已过期/消费过的尝试；旧回调之后当前尝试仍可进入一次性消费。

本修复不提供多个同时待完成登录的支持，不会使旧 state 与新 cookie 自动匹配。

## 验证与限制

- Node 22，独立 worktree、独立 node_modules，仅在隔离目录 prepare/generate/typecheck，不覆盖运行服务的 `.nuxt`。
- `vitest run tests/unit/auth-callback-state.test.ts tests/unit/identity-bridge.test.ts tests/unit/auth-scope.test.ts`：21/21 通过。
- `nuxt typecheck`：通过。
- 未使用用户密码、旧 code/state 或既有会话；未运行真实用户登录后的 token 交换，未把上述证据当作用户本次故障根因的充分证明。
- HTTPS 检查脚本仅为本地诊断客户端允许读取本地证书响应；没有修改浏览器、服务端 TLS、Secure 或 SameSite 配置。

## 若用户现场仍失败，最小观察

用户仅需重现一次；在其浏览器 Network 保留日志，由本地观察者记录以下脱敏结果，不导出 HAR、不复制任何 query/cookie 值：

1. 登录入口、QMS 授权页、最终 callback 的 protocol/hostname/port/path，去掉整个 query。
2. 一次重现中 `/auth/login` 请求数量；是否在等待 QMS 登录期间又发生第二次。
3. 登录响应是否含 `ft_login_state`，浏览器是否存储或标记 blocked（仅记录原因与属性）。
4. 回调**请求**是否携带此名称的 cookie；与该次授权 state 仅在本地比较，输出存在布尔、长度和匹配布尔。不能只看失败后 Storage，因为旧实现已经删除 cookie。
5. 正式 callback 之前是否有额外 callback 响应删除该名称的 cookie。

这些信息足以区分未存储/未发送、主机变化、重复入口覆盖和提前删除；没有这些证据，不将证书、密码或用户操作作为结论。
