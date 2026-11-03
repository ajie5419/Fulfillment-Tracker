/** GET /api/panorama；数量均在当前 actor 可见、未删除的工单范围内。 */
export interface PanoramaData {
  counts: {
    inProgress: number
    normal: number
    abnormal: number
    completed: number
    /** OPEN：未开工，不能用来推算未验收。 */
    notStarted: number
    unaccepted: null
    unacceptedAvailable: false
  }
  /** 分组含可见的在制、未开工、已完工工单；仅在制工单计入分组数字。 */
  byManager: {
    projectManagerId: string | null
    projectManagerName: string
    inProgress: number
    abnormal: number
  }[]
  /** null 表示未指定产品线。 */
  byProductLine: {
    productLine: string | null
    inProgress: number
    abnormal: number
  }[]
}

export interface PanoramaRow {
  status: string
  color: string
  projectManagerId: string | null
  projectManagerName: string | null
  productLine: string | null
}

export type PanoramaMetric = 'inProgress' | 'normal' | 'abnormal' | 'completed' | 'notStarted'
export const PANORAMA_METRICS = [
  { value: 'inProgress', label: '在制工单' },
  { value: 'normal', label: '正常在制工单' },
  { value: 'abnormal', label: '有风险在制工单' },
  { value: 'completed', label: '已完工工单' },
  { value: 'notStarted', label: '未开工工单' },
] as const

function panoramaCategory(row: PanoramaRow): Exclude<PanoramaMetric, 'inProgress'> | null {
  if (row.status === 'COMPLETED') return 'completed'
  if (row.status === 'OPEN') return 'notStarted'
  if (row.status === 'IN_PROGRESS') return row.color === 'GREEN' ? 'normal' : 'abnormal'
  return null
}

export function filterPanoramaRows<T extends PanoramaRow>(rows: T[], query: Record<string, unknown>): T[] {
  const metric = PANORAMA_METRICS.some(item => item.value === query.metric) ? query.metric : 'inProgress'
  return rows.filter(row => {
    if (typeof query.manager === 'string' && (row.projectManagerId ?? '') !== query.manager) return false
    if (typeof query.productLine === 'string' && (row.productLine ?? '') !== query.productLine) return false
    const category = panoramaCategory(row)
    return metric === 'inProgress' ? category === 'normal' || category === 'abnormal' : category === metric
  })
}

export function aggregatePanorama(rows: PanoramaRow[]): PanoramaData {
  const counts: PanoramaData['counts'] = { inProgress: 0, normal: 0, abnormal: 0, completed: 0, notStarted: 0, unaccepted: null, unacceptedAvailable: false }
  const managers = new Map<string | null, PanoramaData['byManager'][number]>()
  const productLines = new Map<string | null, PanoramaData['byProductLine'][number]>()
  for (const row of rows) {
    const category = panoramaCategory(row)
    if (!category) continue
    counts[category]++
    const manager = managers.get(row.projectManagerId) ?? {
      projectManagerId: row.projectManagerId, projectManagerName: row.projectManagerName ?? '未指定项目经理', inProgress: 0, abnormal: 0,
    }
    const line = productLines.get(row.productLine) ?? { productLine: row.productLine, inProgress: 0, abnormal: 0 }
    if (category === 'normal' || category === 'abnormal') {
      counts.inProgress++
      manager.inProgress++
      line.inProgress++
      if (category === 'abnormal') {
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

export function panoramaDestination(mobile: boolean, query: Record<string, unknown>, hash = '') {
  return { path: mobile ? '/m/board' : '/board', query: { ...query, view: 'panorama' }, hash }
}
