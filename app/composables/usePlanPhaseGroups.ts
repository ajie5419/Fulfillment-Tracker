import { computed, ref, type Ref } from 'vue'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanData } from './usePlanData'

// 10-23 按 MS Project 大纲分级：阶段行 = 1 级（灰底粗体，可折叠），节点 = 2 级，子节点 = 3 级；汇总行（有子节点）也可折叠
export interface PhaseRow {
  id: string
  isPhase: true
  phase: string
  code: string
  count: number
  done: number
  start: string
  end: string
  /** 组内最晚的预计完成日；late = 组内有延误节点 */
  expected: string | null
  late: boolean
  /** 组内末级节点（要部门接收的）：总数、已接收、待接收 */
  leaves: number
  accepted: number
  pending: number
}
export type TableRow = PlanNodeRow | PhaseRow
export const isPhaseRow = (r: TableRow): r is PhaseRow => 'isPhase' in r

/** 节点表的阶段分组、折叠状态和可见行（PlanEditor 拆分）。 */
export function usePlanPhaseGroups(data: Ref<PlanData | null>) {
  const hasPhase = computed(() => (data.value?.nodes ?? []).some((n) => n.phase))
  /** 按阶段连续分组（节点已按大纲顺序排好，子节点跟着上级） */
  const phaseGroups = computed(() => {
    const nodes = data.value?.nodes ?? []
    if (!hasPhase.value) return []
    const runs: PlanNodeRow[][] = []
    for (const [i, n] of nodes.entries()) {
      if (i === 0 || (n.phase ?? null) !== (nodes[i - 1]!.phase ?? null)) runs.push([])
      runs.at(-1)!.push(n)
    }
    return runs.map((group) => {
      const first = group[0]!
      const leaves = group.filter((m) => !m.childCount)
      const open = group.filter((m) => !m.done)
      const row: PhaseRow = {
        id: `phase:${first.id}`,
        isPhase: true,
        phase: first.phase ?? '未分阶段',
        code: first.code.split('.')[0]!,
        count: group.filter((m) => !m.parentId).length,
        done: group.filter((m) => !m.parentId && m.done).length,
        start: group.map((m) => m.startDate ?? m.planDate).sort()[0]!,
        end: group.map((m) => m.planDate).sort().at(-1)!,
        expected: open.length ? open.map((m) => m.expectedDate).sort().at(-1)! : null,
        late: open.some((m) => m.delayDays > 0),
        leaves: leaves.length,
        accepted: leaves.filter((m) => m.confirmStatus === 'CONFIRMED').length,
        pending: leaves.filter((m) => m.confirmStatus === 'PENDING').length,
      }
      return { row, nodes: group }
    })
  })
  /** 收起的阶段行 / 汇总行 */
  const collapsed = ref<string[]>([])
  const isCollapsed = (id: string) => collapsed.value.includes(id)
  function toggleCollapse(id: string) {
    collapsed.value = isCollapsed(id) ? collapsed.value.filter((x) => x !== id) : [...collapsed.value, id]
  }
  const collapsibleIds = computed(() => [...phaseGroups.value.map((g) => g.row.id), ...(data.value?.nodes ?? []).filter((n) => n.childCount).map((n) => n.id)])
  const allOpen = computed(() => !collapsed.value.length)
  /** 全部展开 / 只看 1 级（收起全部阶段；没用阶段时收起全部汇总行） */
  function toggleAll() {
    collapsed.value = allOpen.value ? (phaseGroups.value.length ? phaseGroups.value.map((g) => g.row.id) : collapsibleIds.value) : []
  }
  /** 定位某个节点：展开它所在的阶段和上级 */
  function reveal(id: string) {
    const n = data.value?.nodes.find((x) => x.id === id)
    const g = phaseGroups.value.find((x) => x.nodes.some((m) => m.id === id))
    collapsed.value = collapsed.value.filter((x) => x !== g?.row.id && x !== n?.parentId)
  }
  const tableRows = computed<TableRow[]>(() => {
    const nodes = data.value?.nodes ?? []
    const visible = (n: PlanNodeRow) => !(n.parentId && isCollapsed(n.parentId))
    if (!phaseGroups.value.length) return nodes.filter(visible)
    return phaseGroups.value.flatMap((g) => [g.row, ...(isCollapsed(g.row.id) ? [] : g.nodes.filter(visible))])
  })

  return { hasPhase, phaseGroups, collapsed, isCollapsed, toggleCollapse, collapsibleIds, allOpen, toggleAll, reveal, tableRows }
}
