/** 持久化本地保存意图。记录行锁串行同幂等标识，pendingWorkOrder 唯一键串行同工单的新意图。 */
import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient, WorkOrderLocalSave } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../utils/prisma'
import { createWorkOrderBody, updateWorkOrderBody } from '../../schemas/work-order'
import { WORK_ORDER_SAVE_STATES, type WorkOrderSaveResult } from '../../../shared/work-order-save'
import { FlowError, FlowHttpError } from '../flow/errors'
import { qmsWorkOrderSchema, type QmsWorkOrderRow, writeWorkOrderCopy } from '../sync/resources'
import { REQUEST_TIMEOUT_MS } from '../sync/client'
import { QmsRejected, type CreateWorkOrderBody, type UpdateWorkOrderBody, type QmsWorkOrderApi } from '../sync/write-client'

const [PENDING, DONE, FAILED] = WORK_ORDER_SAVE_STATES
const RECOVERY_TRANSACTION_TIMEOUT_MS = REQUEST_TIMEOUT_MS * 4
const PENDING_MESSAGE = 'QMS 已保存成功，本地扩展信息待恢复；请勿重复新建，请管理员重试恢复'
export const CONFLICT_TEXT = '工单已被别人修改，请刷新后再改'
export type RecoveryDb = Pick<PrismaClient, 'qmsWorkOrder' | 'workOrderExt' | 'workOrderLocalSave' | '$transaction'>
export interface ExtFields { projectManagerId?: string | null; productLine?: string | null; isPilot?: boolean }
const extSchema = createWorkOrderBody.pick({ projectManagerId: true, productLine: true, isPilot: true })
const createRequest = createWorkOrderBody.pick({ workOrderNumber: true, customerNameId: true, projectName: true, divisionId: true, quantity: true, deliveryDate: true }).extend({ actorUserId: z.string() })
const updateRequest = updateWorkOrderBody.pick({ customerNameId: true, projectName: true, divisionId: true, quantity: true, deliveryDate: true, status: true }).extend({ actorUserId: z.string(), version: z.number().int() })
const remoteErrorSchema = z.object({ message: z.string(), statusCode: z.number(), code: z.string().nullable() })
const flatJson = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
const json = (value: object): Prisma.InputJsonObject => flatJson.parse(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)))
const canonical = (value: object) => JSON.stringify(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
const rowJson = (row: QmsWorkOrderRow) => json({ ...row, deliveryDate: row.deliveryDate.toISOString(), updatedAt: row.updatedAt.toISOString() })
const view = (row: QmsWorkOrderRow): WorkOrderSaveResult => ({ workOrderNumber: row.workOrderNumber, status: row.status, version: row.version ?? null, updatedAt: row.updatedAt })
const pending = (row: QmsWorkOrderRow, operationId: string): WorkOrderSaveResult => ({ ...view(row), recovery: { status: PENDING, operationId, message: PENDING_MESSAGE } })
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function pendingWorkOrderConflict(operationId: string) {
  return new FlowHttpError('该工单存在待恢复保存，请管理员先恢复后再提交新操作', 409, 'CONFLICT', { operationId })
}

/** 只提交本地副本和扩展字段；失败整体回滚。恢复状态由外层持久化，不能随这个事务回滚。 */
export async function saveWorkOrderLocal(db: RecoveryDb, workOrderNumber: string, row: QmsWorkOrderRow | null, ext: ExtFields) {
  await db.$transaction(async (tx) => {
    if (row) await writeWorkOrderCopy(tx, row)
    if (Object.keys(ext).length) await tx.workOrderExt.upsert({ where: { workOrderNumber }, create: { workOrderNumber, ...ext }, update: ext })
  })
}

interface SaveIntent {
  idempotencyKey?: string
  workOrderNumber: string
  actorId: string
  operation: 'create' | 'update'
  request: CreateWorkOrderBody | UpdateWorkOrderBody
  ext: ExtFields
}

export async function saveWithRecovery(intent: SaveIntent, qms: QmsWorkOrderApi, db: RecoveryDb = prisma): Promise<WorkOrderSaveResult> {
  const operationId = intent.idempotencyKey ?? randomUUID()
  const requestPayload = json(intent.request)
  const extPayload = json(intent.ext)
  // 必须在远端调用之前、独立事务中提交，进程中断也不能丢失扩展输入。
  const created = await db.workOrderLocalSave.createMany({ data: [{ operationId, workOrderNumber: intent.workOrderNumber, operation: intent.operation,
    actorId: intent.actorId, requestPayload, extPayload, status: PENDING, pendingWorkOrder: intent.workOrderNumber }], skipDuplicates: true })
  const record = await db.workOrderLocalSave.findUnique({ where: { operationId } })
  if (!record) {
    const existing = await db.workOrderLocalSave.findUnique({ where: { pendingWorkOrder: intent.workOrderNumber } })
    if (existing) throw pendingWorkOrderConflict(existing.operationId)
    // 唯一槽在插入冲突后已被另一请求释放，重新争取槽位。
    return saveWithRecovery(intent, qms, db)
  }
  if (record.workOrderNumber !== intent.workOrderNumber || record.operation !== intent.operation || record.actorId !== intent.actorId
    || canonical(flatJson.parse(record.requestPayload)) !== canonical(requestPayload) || canonical(flatJson.parse(record.extPayload)) !== canonical(extPayload)) {
    throw new FlowHttpError('幂等标识已用于不同的工单、用户或输入，请为新操作使用新的标识', 409, 'CONFLICT',
      record.status === PENDING && record.workOrderNumber === intent.workOrderNumber ? { operationId } : undefined)
  }
  return executeSave(operationId, qms, db, created.count > 0)
}

/** 未确认远端结果时，只能按工单号核对并匹配本次输入；不能将别人的同号工单当成本次成功。 */
function matchesRequest(record: WorkOrderLocalSave, remote: QmsWorkOrderRow): boolean {
  const request = flatJson.parse(record.requestPayload)
  const values = rowJson(remote)
  return Object.entries(request).every(([key, value]) => key === 'actorUserId' || key === 'version'
    || (key === 'deliveryDate' ? remote.deliveryDate.toISOString().slice(0, 10) === value : values[key] === value))
}

async function performRemote(record: WorkOrderLocalSave, qms: QmsWorkOrderApi, retry: boolean): Promise<QmsWorkOrderRow> {
  const known = record.remoteResult ? qmsWorkOrderSchema.parse(record.remoteResult) : null
  if (retry) {
    const remote = await qms.findWorkOrder(record.workOrderNumber)
    if (known) {
      if (!remote || remote.isDeleted) throw new FlowError('QMS 工单当前不存在，保留待恢复输入，请管理员核对')
      return remote
    }
    if (remote && !remote.isDeleted && matchesRequest(record, remote)) {
      const request = record.operation === 'update' ? updateRequest.parse(record.requestPayload) : null
      if (!request || (remote.version != null && remote.version > request.version)) return remote
    }
    if (record.operation === 'create' && remote) throw new FlowHttpError('无法确认 QMS 同号工单是本次创建，保留待恢复输入，请管理员核对', 409)
    if (record.operation === 'update') {
      const request = updateRequest.parse(record.requestPayload)
      if (!remote || remote.isDeleted || remote.version !== request.version) throw new FlowHttpError('无法确认 QMS 修改结果，保留待恢复输入，请管理员核对', 409)
    }
  }
  if (record.operation === 'create') return qms.createWorkOrder(createRequest.parse(record.requestPayload))
  try {
    return await qms.updateWorkOrder(record.workOrderNumber, updateRequest.parse(record.requestPayload))
  } catch (error) {
    if (error instanceof QmsRejected && error.statusCode === 409) throw new QmsRejected(CONFLICT_TEXT, 409, error.code)
    throw error
  }
}

/** 管理员重试入口；只接受 PENDING，先核对 QMS，成功补完本地后标 DONE。 */
export async function retryWorkOrderSave(operationId: string, qms: QmsWorkOrderApi, db: RecoveryDb = prisma): Promise<WorkOrderSaveResult> {
  return executeSave(operationId, qms, db, false, true)
}

async function executeSave(operationId: string, qms: QmsWorkOrderApi, db: RecoveryDb, fresh: boolean, retryOnly = false): Promise<WorkOrderSaveResult> {
  // 独立提交尝试标记：QMS 成功后外层事务回滚 / 进程崩溃也不能重新冒充首次调用。
  // 条件更新还会等待同记录的处理锁，DONE 的重放不增加次数。
  if (fresh || retryOnly) await db.workOrderLocalSave.updateMany({ where: { operationId, status: PENDING }, data: { attempts: { increment: 1 } } })
  let confirmed: QmsWorkOrderRow | null = null
  try {
    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT operationId FROM work_order_local_save WHERE operationId = ${operationId} FOR UPDATE`
      const record = await tx.workOrderLocalSave.findUnique({ where: { operationId } })
      if (!record) throw new FlowHttpError('待恢复保存不存在', 404)
      if (retryOnly && record.status !== PENDING) {
        throw new FlowHttpError(record.status === FAILED || record.remoteError ? '该保存已失败，不能重试恢复，请重新保存工单' : '该保存已完成，不能重试恢复', 409, 'CONFLICT')
      }
      if (record.status === DONE || record.status === FAILED) {
        if (record.remoteError) {
          const error = remoteErrorSchema.parse(record.remoteError)
          return { error: new QmsRejected(error.message, error.statusCode, error.code) }
        }
        return { result: view(qmsWorkOrderSchema.parse(record.remoteResult)) }
      }
      if (!fresh && !retryOnly) throw pendingWorkOrderConflict(operationId)
      const retry = !fresh || record.attempts > 1
      if (record.remoteResult) confirmed = qmsWorkOrderSchema.parse(record.remoteResult)
      try {
        confirmed = await performRemote(record, qms, retry)
        await tx.workOrderLocalSave.update({ where: { operationId }, data: { remoteResult: rowJson(confirmed) } })
        // 独立本地事务：失败不会把外层恢复记录与 QMS 结果一起回滚。
        await saveWorkOrderLocal(db, record.workOrderNumber, confirmed, extSchema.parse(record.extPayload))
        await tx.workOrderLocalSave.update({ where: { operationId }, data: { status: DONE, pendingWorkOrder: null, lastError: null, completedAt: new Date() } })
        return { result: view(confirmed) }
      } catch (error) {
        // 只有已确认远端成功才保留 PENDING；远端失败（含网络错误）保留 FAILED 审计行并释放唯一槽。
        await tx.workOrderLocalSave.update({ where: { operationId }, data: { lastError: errorText(error), ...(!confirmed ? {
          status: FAILED, pendingWorkOrder: null, completedAt: new Date(), remoteError: json({ message: errorText(error),
            statusCode: error instanceof FlowHttpError ? error.statusCode : 500, code: error instanceof FlowError ? error.code ?? null : null }),
        } : {}) } })
        if (confirmed) return { result: pending(confirmed, operationId) }
        return { error }
      }
    }, { timeout: RECOVERY_TRANSACTION_TIMEOUT_MS })
    if ('error' in outcome) throw outcome.error
    return outcome.result
  } catch (error) {
    // 远端成功后即使恢复状态写入也遇到数据库故障，原 PENDING 仍已持久化；不得鼓励用户再次创建。
    if (confirmed) return pending(confirmed, operationId)
    throw error
  }
}
