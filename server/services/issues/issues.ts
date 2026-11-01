/**
 * 异常闭环（方案 5.2）：上报、受理、改派、填处理结果、确认关闭、退回、备注，以及列表和详情。
 *
 *   待受理 OPEN ──受理（可同时改责任人/要求解决日）──→ 处理中 ACCEPTED ──填处理结果──→ 待确认 RESOLVED ──确认关闭──→ 已关闭 CLOSED
 *                                                         ↑                                   │
 *                                                         └──────────────退回─────────────────┘
 *
 * 只有四个状态，不做会签、不做审批。每次状态变化、改派、备注都写 issue_log。
 * 状态迁移用 updateMany where {id, status: 期望状态} 做乐观并发：影响 0 行即"状态已变化，请刷新"，与写日志同一事务。
 * 谁能做什么集中在 issuePermissions 一个函数里。
 */

export type { Actor, IssuePermissions, NewIssueInput, SystemIssueInput, AssignInput, IssueFilter } from './types'
export type { IssueRow } from './queries'
export { isSourceKeyConflict, issueTransaction } from './transaction'
export { defaultResponsible, myDepartmentIds } from './responsibility'
export { issuePermissions } from './calculation'
export { MAX_PHOTOS, createIssue, createSystemIssue, acceptIssue, reassignIssue, resolveIssue, rejectIssue, closeIssue, addIssueNote } from './commands'
export { listIssues, getIssue, openIssuesOfSteps, issueOptions } from './queries'
