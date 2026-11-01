/**
 * 履约新建 / 修改 / 取消工单（10-27 zhao 定：工单改由履约维护，实际写入 QMS 工单库；QMS 工单页只留查看 / 导出）。
 * 接口约定见 sync/write-client.ts。流程统一是：
 *   权限（canOperate 'workOrder'：项目部、项目部负责人、管理员）→ 本地能先判断的先判断（工单号不能改、项目经理存在、已取消不能改）
 *   → 调 QMS → QMS 成功后在一个事务里写本地副本 qms_work_order（用 QMS 返回的对象，含 updatedAt、version）和 work_order_ext（项目经理、产品线、是否试点）。
 * QMS 没配置 / 连不上 / 拒绝时直接报错，本地什么都不写（不在本地先存、事后补发）。
 * 修改、取消带编辑者打开页面时看到的 version（由前端提交，乐观锁；不用保存时本地最新的 version，否则两人先后保存时后一个会悄悄覆盖前一个），
 *   QMS 409 → "工单已被别人修改，请刷新后再改"。只取消，不删除。
 * actorUserId = 当前登录用户的 QMS 用户 ID（两边相同），QMS 审计日志记这个人。
 * 只改履约这边的扩展信息（项目经理、产品线、是否试点）时不调 QMS。
 */
import type { PrismaClient } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { OPERATION_DENIED, type RoleContext, canOperate } from '../auth/permissions'
import { FlowError, FlowForbidden, FlowHttpError } from '../flow/errors'
import { type QmsWorkOrderRow, writeWorkOrderCopy } from '../sync/resources'
import { type QmsWorkOrderApi, QmsRejected, type UpdateWorkOrderBody } from '../sync/write-client'
import type { CancelWorkOrderInput, CreateWorkOrderInput, UpdateWorkOrderInput } from '../../schemas/work-order'

export const CONFLICT_TEXT = '工单已被别人修改，请刷新后再改'
export const NO_VERSION_TEXT = '本地还没有同步到这个工单的版本号，请等下一轮 QMS 同步（约 5 分钟）后再改'

/** 用到的表（单测里换成假的） */
export type ManageDb = Pick<PrismaClient, 'qmsWorkOrder' | 'workOrderExt' | 'qmsUser' | '$transaction'>

interface ExtFields {
  projectManagerId?: string | null
  productLine?: string | null
  isPilot?: boolean
}

function assertCan(ctx: RoleContext) {
  if (!canOperate(ctx, 'workOrder')) throw new FlowForbidden(OPERATION_DENIED.workOrder)
}

async function assertManager(db: ManageDb, id: string | null | undefined) {
  if (!id) return
  const u = await db.qmsUser.findFirst({ where: { id, isDeleted: false }, select: { id: true } })
  if (!u) throw new FlowError('项目经理不存在（QMS 里没有这个用户或已删除）')
}

const extOf = (x: ExtFields): ExtFields => {
  const out: ExtFields = {}
  if (x.projectManagerId !== undefined) out.projectManagerId = x.projectManagerId
  if (x.productLine !== undefined) out.productLine = x.productLine
  if (x.isPilot !== undefined) out.isPilot = x.isPilot
  return out
}

/** QMS 成功后：一个事务里写本地副本 + 扩展信息 */
async function saveLocal(db: ManageDb, workOrderNumber: string, row: QmsWorkOrderRow | null, ext: ExtFields) {
  const hasExt = Object.keys(ext).length > 0
  await db.$transaction(async (tx) => {
    if (row) await writeWorkOrderCopy(tx, row)
    if (hasExt) await tx.workOrderExt.upsert({ where: { workOrderNumber }, create: { workOrderNumber, ...ext }, update: ext })
  })
}

const view = (r: Pick<QmsWorkOrderRow, 'workOrderNumber' | 'status' | 'updatedAt'> & { version?: number | null }) => ({
  workOrderNumber: r.workOrderNumber,
  status: r.status,
  version: r.version ?? null,
  updatedAt: r.updatedAt,
})

/** 修改、取消时 QMS 的 409 都是版本冲突（工单号已存在只出现在新建），换成固定文案 */
async function withConflictText<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    if (e instanceof QmsRejected && e.statusCode === 409) throw new QmsRejected(CONFLICT_TEXT, 409, e.code)
    throw e
  }
}

/** 本地副本：不存在或已删除 → 404 */
async function loadLocal(db: ManageDb, workOrderNumber: string) {
  const wo = await db.qmsWorkOrder.findUnique({ where: { workOrderNumber } })
  if (!wo || wo.isDeleted) throw new FlowHttpError('工单不存在', 404, 'NOT_FOUND')
  return wo
}

/** 编辑者看到的版本号；页面上没有（本地还没同步到新版 QMS 的版本号）时提示等同步 */
function requireVersion(v: number | null | undefined): number {
  if (v === null || v === undefined) throw new FlowError(NO_VERSION_TEXT)
  return v
}

export async function createWorkOrder(ctx: RoleContext, input: CreateWorkOrderInput, qms: QmsWorkOrderApi, db: ManageDb = prisma) {
  assertCan(ctx)
  await assertManager(db, input.projectManagerId)
  const row = await qms.createWorkOrder({
    workOrderNumber: input.workOrderNumber,
    customerNameId: input.customerNameId,
    projectName: input.projectName ?? null,
    divisionId: input.divisionId ?? null,
    quantity: input.quantity,
    deliveryDate: input.deliveryDate,
    actorUserId: ctx.userId,
  })
  // 新建时扩展信息整行写（没填的也落一行，是否试点默认否）
  await saveLocal(db, row.workOrderNumber, row, {
    projectManagerId: input.projectManagerId ?? null,
    productLine: input.productLine ?? null,
    isPilot: input.isPilot ?? false,
  })
  return view(row)
}

export async function updateWorkOrder(ctx: RoleContext, workOrderNumber: string, input: UpdateWorkOrderInput, qms: QmsWorkOrderApi, db: ManageDb = prisma) {
  assertCan(ctx)
  if (input.workOrderNumber !== undefined && input.workOrderNumber !== workOrderNumber) throw new FlowError('工单号不能修改')
  const local = await loadLocal(db, workOrderNumber)
  if (local.status === 'CANCELLED') throw new FlowError('已取消的工单不能修改')
  await assertManager(db, input.projectManagerId)

  const fields: Omit<UpdateWorkOrderBody, 'version' | 'actorUserId'> = {}
  if (input.customerNameId !== undefined) fields.customerNameId = input.customerNameId
  if (input.projectName !== undefined) fields.projectName = input.projectName
  if (input.divisionId !== undefined) fields.divisionId = input.divisionId
  if (input.quantity !== undefined) fields.quantity = input.quantity
  if (input.deliveryDate !== undefined) fields.deliveryDate = input.deliveryDate
  if (input.status !== undefined) fields.status = input.status

  let row: QmsWorkOrderRow | null = null
  if (Object.keys(fields).length) {
    const version = requireVersion(input.version)
    row = await withConflictText(qms.updateWorkOrder(workOrderNumber, { version, actorUserId: ctx.userId, ...fields }))
  }
  await saveLocal(db, workOrderNumber, row, extOf(input))
  return view(row ?? local)
}

export async function cancelWorkOrder(ctx: RoleContext, workOrderNumber: string, input: CancelWorkOrderInput, qms: QmsWorkOrderApi, db: ManageDb = prisma) {
  assertCan(ctx)
  await loadLocal(db, workOrderNumber)
  const version = requireVersion(input.version)
  const row = await withConflictText(qms.cancelWorkOrder(workOrderNumber, { version, actorUserId: ctx.userId }))
  await saveLocal(db, workOrderNumber, row, {})
  return view(row)
}

/** 客户下拉：现取 QMS 字典（启用、未删除，QMS 按名称排好） */
export async function listCustomers(ctx: RoleContext, qms: QmsWorkOrderApi) {
  assertCan(ctx)
  return qms.listCustomers()
}

/** 事业部下拉：本地已同步的 QMS 部门（未删除），带上级名称便于区分同名部门 */
export async function listDivisions(ctx: RoleContext, db: Pick<PrismaClient, 'qmsDepartment'> = prisma) {
  assertCan(ctx)
  const rows = await db.qmsDepartment.findMany({ where: { isDeleted: false }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true, name: true, parentId: true } })
  const names = new Map(rows.map((r) => [r.id, r.name]))
  return rows.map((r) => ({ id: r.id, name: r.name, parentName: names.get(r.parentId) ?? null }))
}
