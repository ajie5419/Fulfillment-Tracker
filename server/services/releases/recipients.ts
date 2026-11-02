import { prisma } from '../../utils/prisma'
import { FlowError } from '../flow/errors'
import { loadDeptIndex, resolveDeptName } from '../auth/departments'
import { departmentNames } from '../flow/names'
import { MAX_RECIPIENTS, type RecipientGroup, groupLabel, resolveGroup } from './constants'
import { uniq } from './calculation'

// ───────────── 接收人 ─────────────

/**
 * 按人 + 按"部门 + 角色"展开成接收人（去重）。按人选的必须在职；按部门/角色展开时不含发放人自己、跳过不在职的。
 * 某个"部门 + 角色"一个人都没有时报错，免得发放人以为发出去了。
 */
export async function resolveRecipients(userIds: string[], groups: RecipientGroup[], issuerId: string): Promise<string[]> {
  const out = new Set<string>()
  const picked = uniq(userIds)
  if (picked.length) {
    const found = await prisma.qmsUser.findMany({ where: { id: { in: picked }, isDeleted: false, status: 'ACTIVE' }, select: { id: true } })
    if (found.length !== picked.length) throw new FlowError('有接收人不存在或已停用，请重新选择')
    for (const u of found) out.add(u.id)
  }
  if (groups.length) {
    const [users, roles] = await Promise.all([
      prisma.qmsUser.findMany({ where: { isDeleted: false, status: 'ACTIVE' }, select: { id: true, departmentId: true } }),
      prisma.notifyRole.findMany({ select: { role: true, userId: true, department: true } }),
    ])
    const [depts, index] = await Promise.all([departmentNames(users.map((u) => u.departmentId)), loadDeptIndex()])
    const ctx = {
      users: users.map((u) => ({
        id: u.id,
        deptName: (u.departmentId && depts.get(u.departmentId)) || null,
        businessDeptName: resolveDeptName(u.departmentId, index),
      })),
      roles,
    }
    for (const g of groups) {
      if (!g.department?.trim() && !g.role) throw new FlowError('按部门/角色选人时，部门和角色至少选一个')
      const ids = resolveGroup(g, ctx).filter((id) => id !== issuerId)
      if (!ids.length) throw new FlowError(`按"${groupLabel(g)}"没有找到接收人（不含你自己）`)
      for (const id of ids) out.add(id)
    }
  }
  if (!out.size) throw new FlowError('请选择接收人')
  if (out.size > MAX_RECIPIENTS) throw new FlowError(`接收人太多（${out.size} 人），一次最多 ${MAX_RECIPIENTS} 人`)
  return [...out]
}
