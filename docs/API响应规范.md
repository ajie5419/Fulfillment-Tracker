# 履约内部 API 响应规范

本规范适用于履约系统 `/api/**`。服务端、桌面、手机端和测试采用同一契约，不同时保留旧裸数据响应。QMS 是独立服务，其接口仍以双方对接契约为准。

## 成功

HTTP 2xx；JSON 顶层固定三个字段：

```json
{
  "code": 0,
  "data": { "rows": [], "total": 0, "page": 1, "pageSize": 20 },
  "message": "ok"
}
```

- `code` 固定为数字 `0`；`data` 为接口的业务数据；`message` 固定为 `ok`，页面自行提供适合操作的成功提示。
- 对象、数组、布尔值和空结果均经过相同封装。无返回值统一为 `data: null`，JSON 操作不使用无正文的 204。
- 分页字段属于 `data`；已有接口的统计、分组、批量逐项结果均保留。此次统一外壳不把选项数组等非分页接口擅自改成分页。
- HTTP 202 保留“已受理但未完成”的含义。例如工单远端已保存、本地待恢复，页面仍须检查 `data.recovery`。`code: 0` 不代表异步工作已经完成。
- 批量操作的外层成功表示请求已处理；逐项失败仍由 `data.results`、成功／失败计数表达，不能只检查外层状态。

## 失败

使用真实 HTTP 4xx／5xx，不以 HTTP 200 表示失败。顶层仍固定三个字段：

```json
{
  "code": "CONFLICT",
  "data": { "operationId": "pending-operation" },
  "message": "该工单存在待恢复保存，请管理员先恢复后再提交新操作"
}
```

- `code` 为稳定业务错误码，供程序判断；`message` 供人阅读，不按中文提示判断业务分支。
- `data` 为安全的业务补充信息，没有时为 `null`。例如冲突时保留恢复操作 ID。
- 未登录、权限不足、参数错误、缺失路由以及服务异常走同一出口；不会返回开发错误页或堆栈。
- 5xx 和未处理异常不向客户端输出数据库、上游诊断、堆栈或原始错误数据，显示“服务暂时不可用，请稍后重试”。

| HTTP | 默认业务码 |
| --- | --- |
| 400、422 | `VALIDATION` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 502、503、504 | `UNAVAILABLE` |
| 其他 5xx | `INTERNAL` |
| 其他 4xx | `REQUEST_FAILED` |

共享类型与错误码分别位于 `shared/api-response.ts`、`shared/errors.ts`；内部领域错误仍可省略码，由 HTTP 边界补齐。服务层可以抛 `FlowError`／`FlowHttpError`，无需手动构造响应外壳。

## 服务端与客户端入口

- 普通业务路由用 `defineFlowHandler`，管理员路由用 `defineAdminHandler`；二者均经过 `defineApiHandler` 统一封装。已有特殊鉴权入口（如当前用户、提醒）直接用 `defineApiHandler`，原有权限检查不能省略。
- 全局失败出口为 `server/api-error.ts`，在 `nuxt.config.ts` 注册，覆盖路由执行前的中间件错误。非 API 页面错误继续交给框架处理。
- 页面读取用 `useApiFetch`，直接请求用 `apiFetch`；已有领域函数继续经过 `clientRequest`。调用方得到的是解包后的业务数据，不手写 `.data.data`。
- SSR 需要当前会话时用 `useApiRequestFetch()`，不得把某个请求的 Cookie 或 fetch 实例缓存到全局。
- `useApiFetch` 为 GET 页面查询入口，保留 Nuxt 的响应式参数、请求状态、取消和默认值机制；写操作通过 `apiFetch` 或领域函数发起。
- 响应类型由实际后端路由派生；`ClientResponse` 表示解包后的业务数据，`ApiSuccess<T>` 表示网络上的完整成功响应。
- 旧裸响应、缺少字段或错误外壳出现在成功通道时，客户端明确报错，不静默兼容旧格式。HTTP 失败和请求取消继续走错误通道。

## 明确的协议例外

`/api/files/:id`、`/api/purchases/template` 的成功响应是文件字节，保留 MIME、下载头和缓存策略，通过 `defineFileHandler` 执行相同业务鉴权；失败仍返回统一 JSON。

`/auth/**` 是浏览器登录／退出协议，不属于 `/api/**`。跳转、Cookie 和退出行为保持原协议；外部 QMS 请求不能经过履约解包器。

## 验证与变更

`pnpm quality:check` 阻止普通 API 绕过统一响应入口，也阻止页面绕过公共解包层。新增文件下载必须明确登记例外并补测试。

`tests/unit/api-response.test.ts` 使用实际 H3 序列化验证外壳、错误、HTTP 202、下载及客户端解包；HTTP 集成测试通过 `tests/helpers/api-response.ts` 先断言外壳再校验业务内容。跨页面修改还须运行单元测试、类型检查及构建。真实数据库、浏览器和部署验收须分别报告，不用单元测试结果替代。
