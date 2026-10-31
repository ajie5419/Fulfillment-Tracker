import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/services/issues/board', () => ({ getBoard: vi.fn() }))
import { getBoard } from '../../server/services/issues/board'
import { getPanorama } from '../../server/services/issues/panorama'

type Row = Awaited<ReturnType<typeof getBoard>>['rows'][number]
const row = (status: string, color: Row['color'], projectManagerId: string | null = 'pm', productLine: string | null = '起重机'): Row => ({
  status, color, projectManagerId, projectManagerName: projectManagerId ? '王经理' : null, productLine,
} as Row)
const setRows = (rows: Row[]) => vi.mocked(getBoard).mockResolvedValue({ rows } as Awaited<ReturnType<typeof getBoard>>)

beforeEach(() => { vi.resetAllMocks() })

describe('项目全景', () => {
  it('直接复用 getBoard 分类，并将 actor 可见范围和同一时钟传入含已完工的查询', async () => {
    setRows([row('IN_PROGRESS', 'GREEN'), row('IN_PROGRESS', 'YELLOW'), row('IN_PROGRESS', 'RED'), row('OPEN', 'RED'), row('COMPLETED', 'RED'), row('CANCELLED', 'RED'), row('PAUSED', 'GREEN')])
    const now = new Date('2026-10-28T04:00:00Z')
    const result = await getPanorama(['WO'], now)
    expect(getBoard).toHaveBeenCalledExactlyOnceWith(['WO'], now, { withClosed: true })
    expect(result.counts).toEqual({ inProgress: 3, normal: 1, abnormal: 2, completed: 1, notStarted: 1, unaccepted: null, unacceptedAvailable: false })
    expect(result.byManager).toEqual([{ projectManagerId: 'pm', projectManagerName: '王经理', inProgress: 3, abnormal: 2 }])
    expect(result.byProductLine).toEqual([{ productLine: '起重机', inProgress: 3, abnormal: 2 }])
  })

  it('按经理 ID 分组，重名不合并，缺失归未指定；产品线独立统计并稳定排序', async () => {
    setRows([
      row('IN_PROGRESS', 'RED', 'pm2', 'B'), row('IN_PROGRESS', 'GREEN', 'pm', 'A'), row('IN_PROGRESS', 'YELLOW', 'pm', 'B'),
      row('IN_PROGRESS', 'GREEN', null, null), row('COMPLETED', 'RED', 'completed-pm', 'C'), row('OPEN', 'YELLOW', 'pm2', 'B'),
    ])
    const result = await getPanorama(undefined)
    expect(result.byManager).toEqual([
      { projectManagerId: 'pm', projectManagerName: '王经理', inProgress: 2, abnormal: 1 },
      { projectManagerId: 'pm2', projectManagerName: '王经理', inProgress: 1, abnormal: 1 },
      { projectManagerId: null, projectManagerName: '未指定项目经理', inProgress: 1, abnormal: 0 },
      { projectManagerId: 'completed-pm', projectManagerName: '王经理', inProgress: 0, abnormal: 0 },
    ])
    expect(result.byProductLine).toEqual([
      { productLine: 'B', inProgress: 2, abnormal: 2 }, { productLine: null, inProgress: 1, abnormal: 0 },
      { productLine: 'A', inProgress: 1, abnormal: 0 }, { productLine: 'C', inProgress: 0, abnormal: 0 },
    ])
    expect(result.counts.normal + result.counts.abnormal).toBe(result.counts.inProgress)
    for (const groups of [result.byManager, result.byProductLine]) {
      expect(groups.reduce((sum, group) => sum + group.inProgress, 0)).toBe(result.counts.inProgress)
      expect(groups.reduce((sum, group) => sum + group.abnormal, 0)).toBe(result.counts.abnormal)
    }
  })

  it('空可见范围不会放宽，空数据仍保留未验收不可用标识', async () => {
    setRows([])
    const result = await getPanorama([])
    expect(vi.mocked(getBoard).mock.calls[0]![0]).toEqual([])
    expect(result).toEqual({ counts: { inProgress: 0, normal: 0, abnormal: 0, completed: 0, notStarted: 0, unaccepted: null, unacceptedAvailable: false }, byManager: [], byProductLine: [] })
  })
})
