/**
 * 发放签收 + 设计变更通知（R9）：发放单（图纸 / 设计变更 / 工艺文件）登记"发给谁"，每个接收人一条签收记录 + 一条签收待办；
 * 接收人在手机或电脑上签收，或拒收并写原因（拒收通知发放人）。超时没签收由 W5 预警（scan.ts）。
 *
 * 设计变更关联的工件：
 *   已在加工 / 在外协的工序 → 给生产经理（生产部负责人）和外协专员发"确认变更影响"待办；
 *   还没开工的工序 → 标"等变更"（route_step.holdReleaseId），W2/W3 不计时；
 *   确认变更影响（任一收到待办的人、发放人或管理员点确认）后解除；没有在加工的工序（没发确认待办）时，接收人全部签收即自动解除。
 *
 * 不做审批、不做会签：发放人发出即生效；发错了由发放人或管理员作废（未签收的一并作废）。
 * 状态变化都在一个事务里，先锁发放单行（FOR UPDATE），同一发放单上的签收、作废、确认串行执行。
 *
 * 从设计任务一键发放（R11，drawingTaskId）：建单和作废都改用 READ COMMITTED，并按设计任务的顺序加锁
 * （先工件 → 设计任务 → 发放单），然后重算任务状态、重新评估"可以开工"（drawings.ts settleTask）。
 *
 * 设计变更涉及已下发的料单（工艺模块 10-27）：同一事务里把料单改成"修改中"并提醒工艺部负责人（process/process.ts markRevisingByChange）。
 *
 * 图纸发放单附 BOM 表（bom）：同一事务里按图号建工件（bom/excel.ts applyTechBom），新建的和 BOM 里已有的工件都关联到发放单，
 * 从设计任务发放时也挂到该设计任务。用 READ COMMITTED，加锁顺序 先工单行 → 该工单全部工件（按 ID）→ 设计任务 → 发放单。
 */

export type { Actor, NewReleaseInput, ChangeImpact, ReleaseFilter, ReleaseProgress } from './types'
export { resolveRecipients } from './recipients'
export { unroutedPartsLink, createRelease, signReceipt, rejectReceipt, voidRelease, confirmChange } from './commands'
export { releaseStats, listReleases, isReleaseParty, assertCanViewRelease, getRelease, listMyReceipts, describeReleaseTodos } from './queries'
