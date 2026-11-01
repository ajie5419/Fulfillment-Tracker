import type { IssueCategory } from '@prisma/client'
import { prisma } from '../../utils/prisma'
import { deptIdsResolvingTo, loadDeptIndex, representativeDeptId, resolveDeptName } from '../auth/departments'
import { DEFAULT_DEPT_NAME } from './constants'
import type { Db } from './types'

// ───────────── 责任部门与负责人 ─────────────

/** 部门负责人（notify_role 的 DEPT_HEAD，按业务部门名称对应），取第一个 */
export async function deptHeadOf(db: Db, deptName: string | null | undefined) {
  if (!deptName) return null
  const head = await db.notifyRole.findFirst({ where: { role: 'DEPT_HEAD', department: deptName }, orderBy: { id: 'asc' }, select: { userId: true } })
  return head?.userId ?? null
}

/**
 * 按分类默认的责任部门和默认责任人（该部门负责人，没有则为空）。
 * 责任部门：名称正好是该业务部门的 QMS 部门；没有时取设置页"部门对照"里对到它的部门（departments.representativeDeptId）
 */
export async function defaultResponsible(db: Db, category: IssueCategory) {
  const name = DEFAULT_DEPT_NAME[category]
  return { deptId: representativeDeptId(name, await loadDeptIndex()), userId: await deptHeadOf(db, name) }
}

/**
 * "本部门"筛选：我担任负责人的部门 + 我自己所在的部门，都按业务部门换算（departments.ts）后，
 * 换算结果相同的全部 QMS 部门 ID（班组、科室对到大部门的也算），与部门负责人、预警升级的口径一致。
 */
export async function myDepartmentIds(userId: string): Promise<string[]> {
  const [roles, user, index] = await Promise.all([
    prisma.notifyRole.findMany({ where: { userId, role: 'DEPT_HEAD' }, select: { department: true } }),
    prisma.qmsUser.findUnique({ where: { id: userId }, select: { departmentId: true } }),
    loadDeptIndex(),
  ])
  const own = resolveDeptName(user?.departmentId, index)
  const names = [...new Set([...roles.map((r) => r.department), own].filter((x): x is string => !!x))]
  const ids = names.flatMap((n) => deptIdsResolvingTo(n, index))
  return [...new Set([...ids, ...(user?.departmentId ? [user.departmentId] : [])])]
}
