import { prisma } from '../../../utils/prisma'
import { loadNames } from '../../flow/names'
import { KITTING_DEPT, judgeW8, w8Summary } from '../../kitting/constants'
import { NODE_LINKS, dueWindowWhere, incompleteWhere, loadKitCounts } from '../../kitting/kitting'
import { alertKey, type Thresholds } from '../rules'
import type { Target } from '../types'

/**
 * W8 装配节点未齐套（R12）：清单不为空、齐套率 < 100%、已进入预警窗口（需求日前 N 天，含已过）的节点，判定见 kitting/constants.ts judgeW8
 * （前 5 天黄，前 1 天、当天或已过红；按自然日）。数据库里先按"未齐套 + 窗口"筛选，齐套率一批两次查询算完。
 * 责任人：节点负责人，没指定时是生产经理（生产部负责人）；责任部门是生产部（黄色起通知生产部负责人、工单项目经理，红色再加项目部负责人、分管领导）。
 * 只看 QMS 里还在（未删除）的工单。不转异常；齐套率到 100% 后对象消失，本轮扫描自动消除。
 */
export async function collectW8(now: Date, t: Thresholds): Promise<Target[]> {
  const nodes = await prisma.assemblyNode.findMany({ where: { AND: [incompleteWhere(), dueWindowWhere(now, t.W8)] }, include: NODE_LINKS })
  if (!nodes.length) return []
  const [wos, heads, kits, names] = await Promise.all([
    prisma.qmsWorkOrder.findMany({ where: { workOrderNumber: { in: [...new Set(nodes.map((n) => n.workOrderNumber))] }, isDeleted: false }, select: { workOrderNumber: true } }),
    prisma.notifyRole.findMany({ where: { role: 'DEPT_HEAD', department: KITTING_DEPT }, select: { userId: true } }),
    loadKitCounts(nodes),
    loadNames({ user: nodes.map((n) => n.ownerId) }),
  ])
  const live = new Set(wos.map((w) => w.workOrderNumber))
  const headIds = [...new Set(heads.map((h) => h.userId))]
  const out: Target[] = []
  for (const n of nodes) {
    if (!live.has(n.workOrderNumber)) continue
    const kit = kits.get(n.id)!
    const r = judgeW8({ ...kit, needDate: n.needDate, now }, t.W8)
    if (!r.level) continue
    const owner = n.ownerId ? (names.user.get(n.ownerId) ?? n.ownerId) : '生产经理'
    out.push({
      rule: 'W8',
      refType: 'node',
      refId: n.id,
      key: alertKey('W8', 'node', n.id),
      workOrderNumber: n.workOrderNumber,
      ownerIds: n.ownerId ? [n.ownerId] : headIds,
      deptNames: [KITTING_DEPT],
      startAt: n.needDate,
      level: r.level,
      subject: `装配节点 ${n.name}`,
      summary: w8Summary(r, n, kit, owner),
    })
  }
  return out
}
