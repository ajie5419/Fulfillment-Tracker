import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import * as planStatus from '../../app/utils/plan-status'
import * as phaseGroups from '../../app/composables/usePlanPhaseGroups'
import { mountScript } from '../helpers/vue-script'

/**
 * 节点表的行视图辅助（缩进层级 / 行 class / 子节点汇总 / 文案）特征化：这些函数原在 PlanEditor.vue 里，
 * 拆出 PlanNodeTable.vue 之前先在 PlanEditor 上固定了期望值（见 plan-editor-structure 历史），这里在新组件上继续钉住。
 */
const n = (over: Record<string, unknown>) => ({ id: 'x', parentId: null, childCount: 0, done: false, delayDays: 0, confirmStatus: null, preds: [], affects: [], customDeps: false, pushedBy: null, ...over })
const NODES = [
  n({ id: 'n1', done: true, confirmStatus: 'CONFIRMED' }),
  n({ id: 'n2', childCount: 2, delayDays: 2 }),
  n({ id: 'n3', parentId: 'n2', delayDays: 2, confirmStatus: 'PENDING' }),
  n({ id: 'n4', parentId: 'n2', done: true, confirmStatus: 'CONFIRMED' }),
  n({ id: 'n5', customDeps: true, preds: [{ id: 'n1', seq: 1, code: '1.1', name: '图纸下发' }], affects: [{ seq: 6, code: '3.1', name: '装配' }] }),
]
afterEach(() => vi.unstubAllGlobals())

const open = async (over: Record<string, unknown> = {}) => {
  for (const name of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'nextTick'] as const) vi.stubGlobal(name, Vue[name])
  return mountScript('app/components/PlanNodeTable.vue', { data: { nodes: NODES }, tableRows: [], collapsed: [], hasPhase: true, loading: false, published: false, wo: 'WO1', focusNode: null, expanded: [], ...over }, {
    '~/utils/plan-status': planStatus, '../composables/usePlanPhaseGroups': phaseGroups,
  })
}

describe('PlanNodeTable 行视图辅助', () => {
  it('缩进层级：有阶段 2 / 3 级，没阶段 1 / 2 级', async () => {
    let v = await open()
    expect([NODES[0], NODES[2]].map((x) => v.state.levelOf(x))).toEqual([2, 3])
    v.unmount()
    v = await open({ hasPhase: false })
    expect([NODES[0], NODES[2]].map((x) => v.state.levelOf(x))).toEqual([1, 2])
    v.unmount()
  })

  it('行 class：阶段行 / 聚焦 / 延误 / 子节点 / 汇总行', async () => {
    const v = await open({ focusNode: 'n3' })
    expect(v.state.rowClass({ id: 'phase:n1', isPhase: true })).toBe('phase-row')
    expect(v.state.rowClass(NODES[2])).toBe('focus-row late-row child-row ')
    expect(v.state.rowClass(NODES[1])).toBe(' late-row  summary-row')
    expect(v.state.rowClass(NODES[0])).toBe('   ')
    v.unmount()
  })

  it('折叠判断 / 子节点汇总 / 文案', async () => {
    const v = await open({ collapsed: ['n2'] })
    expect(v.state.isCollapsed('n2')).toBe(true)
    expect(v.state.isCollapsed('n1')).toBe(false)
    expect(v.state.childSummary(NODES[1])).toEqual({ total: 2, accepted: 1, pending: 1 })
    expect(v.state.pushedText({ pushedBy: null })).toBe('受上游影响')
    expect(v.state.pushedText({ pushedBy: { code: '1.1', name: 'A', child: true } })).toBe('受子节点影响（1.1 A）')
    expect(v.state.pushedText({ pushedBy: { code: '1.1', name: 'A', child: false } })).toBe('受 1.1 影响')
    expect(v.state.predsText(NODES[4])).toBe('1.1')
    expect(v.state.predsTitle(NODES[0])).toBe('（默认：上一个节点）')
    expect(v.state.predsTitle(NODES[4])).toBe('1.1 图纸下发')
    expect(v.state.affectsText(NODES[4])).toBe('3.1 装配')
    expect(['RED', 'YELLOW', 'REMIND', null].map((l) => v.state.levelColor(l))).toEqual(['red', 'orange', 'blue', undefined])
    v.unmount()
  })
})
