import type { PanoramaData } from '../../../shared/panorama'
import { getBoard } from './board'

/** 与 /api/board 同一可见范围、同一分类代码路径；另取已完工行用于状态计数。 */
export async function getPanorama(visibleWorkOrders: string[] | undefined, now = new Date()): Promise<PanoramaData> {
  const board = await getBoard(visibleWorkOrders, now, { withClosed: true })
  const counts: PanoramaData['counts'] = { inProgress: 0, normal: 0, abnormal: 0, completed: 0, notStarted: 0, unaccepted: null, unacceptedAvailable: false }
  const managers = new Map<string | null, PanoramaData['byManager'][number]>()
  const productLines = new Map<string | null, PanoramaData['byProductLine'][number]>()
  for (const row of board.rows) {
    if (!['IN_PROGRESS', 'OPEN', 'COMPLETED'].includes(row.status)) continue
    const manager = managers.get(row.projectManagerId) ?? {
      projectManagerId: row.projectManagerId, projectManagerName: row.projectManagerName ?? '未指定项目经理', inProgress: 0, abnormal: 0,
    }
    const line = productLines.get(row.productLine) ?? { productLine: row.productLine, inProgress: 0, abnormal: 0 }
    if (row.status === 'COMPLETED') counts.completed++
    else if (row.status === 'OPEN') counts.notStarted++
    else {
      counts.inProgress++
      manager.inProgress++
      line.inProgress++
      if (row.color === 'GREEN') counts.normal++
      else {
        counts.abnormal++
        manager.abnormal++
        line.abnormal++
      }
    }
    managers.set(row.projectManagerId, manager)
    productLines.set(row.productLine, line)
  }
  const byCount = (a: { inProgress: number; abnormal: number }, b: { inProgress: number; abnormal: number }) => b.inProgress - a.inProgress || b.abnormal - a.abnormal
  return {
    counts,
    byManager: [...managers.values()].sort((a, b) => byCount(a, b) || a.projectManagerName.localeCompare(b.projectManagerName, 'zh-CN') || (a.projectManagerId ?? '').localeCompare(b.projectManagerId ?? '')),
    byProductLine: [...productLines.values()].sort((a, b) => byCount(a, b) || (a.productLine ?? '').localeCompare(b.productLine ?? '', 'zh-CN')),
  }
}
