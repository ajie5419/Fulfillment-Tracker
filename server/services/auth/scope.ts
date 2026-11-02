import type { Prisma } from '@prisma/client'
import { prisma } from '../../utils/prisma'

/**
 * 数据可见范围：all = 全部工单；否则只能看 workOrders 里的工单（项目经理只看自己负责的）。
 * 每个请求只算一次（缓存在 event.context.scope），单对象检查和列表过滤都用它。
 */
export type Scope = { all: true } | { all: false; workOrders: Set<string> }
type ScopeDb = Pick<Prisma.TransactionClient, 'notifyRole' | 'workOrderExt'>

function scopeOf(privileged: boolean, managed: string[]): Scope {
  return privileged || !managed.length ? { all: true } : { all: false, workOrders: new Set(managed) }
}

/** 两次批量查询，规则与 resolveScope 相同；事务调用方传同一客户端。 */
export async function resolveScopes(userIds: readonly string[], adminIds: readonly string[] = [], db: ScopeDb = prisma): Promise<Map<string, Scope>> {
  const ids = [...new Set(userIds)]
  const admins = new Set(adminIds)
  const ordinary = ids.filter((id) => !admins.has(id))
  const [roles, managed] = ordinary.length ? await Promise.all([
    db.notifyRole.findMany({ where: { userId: { in: ordinary } }, select: { userId: true } }),
    db.workOrderExt.findMany({ where: { projectManagerId: { in: ordinary } }, select: { projectManagerId: true, workOrderNumber: true } }),
  ]) : [[], []]
  const privileged = new Set([...adminIds, ...roles.map((r) => r.userId)])
  const byManager = new Map<string, string[]>()
  for (const row of managed) {
    if (!row.projectManagerId) continue
    const wos = byManager.get(row.projectManagerId) ?? []
    wos.push(row.workOrderNumber)
    byManager.set(row.projectManagerId, wos)
  }
  return new Map(ids.map((id) => [id, scopeOf(privileged.has(id), byManager.get(id) ?? [])]))
}

// ───────────── 数据可见性（技术选型 6.4 节 canSee(user, workOrder)，方案 7.3）─────────────
//
// 这里是唯一入口，接口和服务的列表过滤都从这里拿可见范围：
//   管理员、分管领导、项目部负责人、外协专员、部门负责人（notify_role 里有任何角色）→ 全部工单；
//   不是任何工单项目经理的普通用户（一线、生产经理）→ 全部工单（方案 7.3"第一期不细分"）；
//   只有"是至少一个工单的项目经理、且没有上述任何角色、不是管理员"时，只能看自己负责的工单。
// 部门负责人"看本部门"不做硬限制，做成异常列表的默认筛选（可切换全部）。

/** 按用户算可见范围（不依赖请求，后台任务如每日汇总也用它） */
/** db：在事务里调用时传事务客户端（同一连接、看得到本事务未提交的写入） */
export async function resolveScope(userId: string, admin: boolean, db: ScopeDb = prisma): Promise<Scope> {
  if (admin) return { all: true }
  const [role, managed] = await Promise.all([
    db.notifyRole.findFirst({ where: { userId }, select: { id: true } }),
    db.workOrderExt.findMany({ where: { projectManagerId: userId }, select: { workOrderNumber: true } }),
  ])
  return scopeOf(!!role, managed.map((m) => m.workOrderNumber))
}

/** 单个工单是否可见。workOrderNumber 为 null 表示"不针对具体工单"（只要求登录） */
export function canSee(scope: Scope, workOrderNumber: string | null): boolean {
  if (scope.all || workOrderNumber === null) return true
  return scope.workOrders.has(workOrderNumber)
}

/** 列表查询用：全部可见时返回 undefined（不加条件），否则返回可见工单号 */
export function scopeWorkOrders(scope: Scope): string[] | undefined {
  return scope.all ? undefined : [...scope.workOrders]
}
