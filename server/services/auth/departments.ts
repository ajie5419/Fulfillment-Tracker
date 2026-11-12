/**
 * Resolve QMS departments to stable business identities in one place.
 * The nearest explicit mapping wins; historical aliases apply only when unmapped.
 * Unknown external names remain intact to preserve legacy scope and notifications.
 * Permissions and notifications compare identities; display labels are separate.
 */
import type { BusinessDept } from '@prisma/client'
import { BUSINESS_DEPT_NAME as SHARED_BUSINESS_DEPT_NAME, departmentLabel, isBusinessDeptCode, legacyBusinessDeptCode, type BusinessDeptCode } from '../../../shared/business-depts'
import { prisma } from '../../utils/prisma'

export type { BusinessDept }

/** 业务部门显示名：唯一来源在 shared/business-depts.ts（前端也用），这里转出给服务端 */
export const BUSINESS_DEPT_NAME: Readonly<Record<BusinessDept, string>> = SHARED_BUSINESS_DEPT_NAME

// 编译期校验：shared 里的编码与 prisma enum BusinessDept 完全一致（任一边增删都会在这里报错）
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _sameCodes: Same<BusinessDept, BusinessDeptCode> = true
void _sameCodes

export const BUSINESS_DEPTS = Object.keys(BUSINESS_DEPT_NAME) as BusinessDept[]
export const BUSINESS_DEPT_NAMES = Object.values(BUSINESS_DEPT_NAME)

/** 向上找上级时最多走几层（防止数据成环或层级异常时死循环） */
export const MAX_DEPT_DEPTH = 10

export interface DeptNode {
  name: string
  parentId: string | null
  /** QMS 已删除（历史数据仍能换算，但不再作为默认责任部门） */
  isDeleted?: boolean
}

/** 换算用的部门树 + 对照表（部门表不大，一次全读） */
export interface DeptIndex {
  depts: Map<string, DeptNode>
  mapping: Map<string, BusinessDept>
}

/**
 * Resolve a department label for display only. Identity comparisons must use
 * resolveDeptIdentity so renaming a business department cannot alter access.
 */
export function resolveDeptName(deptId: string | null | undefined, index: DeptIndex): string | null {
  const identity = resolveDeptIdentity(deptId, index)
  return identity ? departmentLabel(identity) : null
}

/** Resolve stable business codes; preserve unmapped external department names for legacy access. */
export function resolveDeptIdentity(deptId: string | null | undefined, index: DeptIndex): string | null {
  if (!deptId) return null
  const seen = new Set<string>()
  let cur: string | null = deptId
  for (let depth = 0; cur && depth <= MAX_DEPT_DEPTH && !seen.has(cur); depth++) {
    seen.add(cur)
    const mapped = index.mapping.get(cur)
    if (mapped) return mapped
    cur = index.depts.get(cur)?.parentId ?? null
  }
  const name = index.depts.get(deptId)?.name
  return legacyBusinessDeptCode(name) ?? name ?? null
}

/** Return a recognized business code, or null for unmapped external departments. */
export function resolveBusinessDept(deptId: string | null | undefined, index: DeptIndex): BusinessDept | null {
  const identity = resolveDeptIdentity(deptId, index)
  return isBusinessDeptCode(identity) ? identity : null
}

/** Find all QMS department IDs sharing a stable or preserved legacy identity. */
export function deptIdsResolvingTo(identity: string, index: DeptIndex): string[] {
  return [...index.depts.keys()].filter((id) => resolveDeptIdentity(id, index) === identity)
}

/**
 * Select an active QMS department ID for an issue's responsible department.
 * Prefer matching historical aliases to preserve existing assignments, then
 * explicit mappings ordered by shallowest hierarchy and smallest ID.
 */
export function representativeDeptId(identity: string, index: DeptIndex): string | null {
  const alive = [...index.depts.entries()].filter(([, d]) => !d.isDeleted)
  const sameName = alive.filter(([id, d]) => (legacyBusinessDeptCode(d.name) ?? d.name) === identity && resolveDeptIdentity(id, index) === identity).map(([id]) => id).sort()
  if (sameName.length) return sameName[0]!
  const biz = isBusinessDeptCode(identity) ? identity : null
  if (!biz) return null
  const depth = (id: string) => {
    let n = 0
    for (let cur = index.depts.get(id)?.parentId ?? null; cur && index.depts.has(cur) && n < MAX_DEPT_DEPTH; cur = index.depts.get(cur)?.parentId ?? null) n++
    return n
  }
  const mapped = alive.filter(([id]) => index.mapping.get(id) === biz).map(([id]) => id)
  mapped.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
  return mapped[0] ?? null
}

/** 读部门树和对照表。含已删除的部门：历史异常上的责任部门仍能换算 */
export async function loadDeptIndex(): Promise<DeptIndex> {
  const [depts, mapping] = await Promise.all([
    prisma.qmsDepartment.findMany({ select: { id: true, name: true, parentId: true, isDeleted: true } }),
    prisma.deptMapping.findMany(),
  ])
  return {
    depts: new Map(depts.map((d) => [d.id, { name: d.name, parentId: d.parentId || null, isDeleted: d.isDeleted }])),
    mapping: new Map(mapping.map((m) => [m.qmsDepartmentId, m.businessDept])),
  }
}

/** Batch display-label lookup; authorization must use resolveDeptIdentities. */
export async function resolveDeptNames(deptIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(deptIds.filter((x): x is string => !!x))]
  if (!ids.length) return new Map()
  const idx = index ?? (await loadDeptIndex())
  const out = new Map<string, string>()
  for (const id of ids) {
    const name = resolveDeptName(id, idx)
    if (name) out.set(id, name)
  }
  return out
}

/** Batch display labels by user; omit users without a resolvable department. */
export async function userDeptNames(userIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))]
  if (!ids.length) return new Map()
  const [users, idx] = await Promise.all([
    prisma.qmsUser.findMany({ where: { id: { in: ids } }, select: { id: true, departmentId: true } }),
    index ? Promise.resolve(index) : loadDeptIndex(),
  ])
  const out = new Map<string, string>()
  for (const u of users) {
    const name = resolveDeptName(u.departmentId, idx)
    if (name) out.set(u.id, name)
  }
  return out
}

/** 一个用户的业务部门（没有对上的为 null，算"其他"） */
export async function userBusinessDept(userId: string): Promise<BusinessDept | null> {
  const identity = (await userDeptIdentities([userId])).get(userId)
  return isBusinessDeptCode(identity) ? identity : null
}

export async function resolveDeptIdentities(deptIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(deptIds.filter((id): id is string => !!id))]
  if (!ids.length) return new Map()
  const idx = index ?? await loadDeptIndex()
  return new Map(ids.flatMap(id => {
    const identity = resolveDeptIdentity(id, idx)
    return identity ? [[id, identity] as const] : []
  }))
}

export async function userDeptIdentities(userIds: (string | null | undefined)[], index?: DeptIndex): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))]
  if (!ids.length) return new Map()
  const [users, idx] = await Promise.all([
    prisma.qmsUser.findMany({ where: { id: { in: ids } }, select: { id: true, departmentId: true } }),
    index ?? loadDeptIndex(),
  ])
  return new Map(users.flatMap(user => {
    const identity = resolveDeptIdentity(user.departmentId, idx)
    return identity ? [[user.id, identity] as const] : []
  }))
}
