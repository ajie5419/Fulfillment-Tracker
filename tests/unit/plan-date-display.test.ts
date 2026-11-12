// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { loadComponent } from '../helpers/vue-component'
import * as schedule from '../../shared/plan-schedule'
import * as plan from '../../shared/plan'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computed, h, nextTick, reactive, ref, Suspense } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardGroup, boardRiskSections, nodeState } from '../../shared/status'

const source = (path: string) => readFileSync(resolve(path), 'utf8')
afterEach(() => vi.unstubAllGlobals())

describe('日期冲突双端展示与权限契约', () => {
  it('双端共用真实提示组件渲染具体冲突，清除冲突后不显示警报', async () => {
    const component = loadComponent('app/components/PlanDateConflicts.vue', { '#shared/plan-schedule': schedule })
    const props = reactive<{ conflicts: schedule.PlanDateConflict[] }>({ conflicts: [{ code: 'FS_ORDER', nodeId: 'B', nodeName: '图纸', message: '图纸开始早于开工通知完成', blocksPublish: true }] })
    const wrapper = mount({ render: () => h(component, props) })
    expect(wrapper.get('[role="alert"]').text()).toContain('图纸开始早于开工通知完成')
    expect(wrapper.text()).toContain('阻止发布')
    expect(wrapper.text()).toContain('草稿可保存')
    props.conflicts = []
    await nextTick()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('PC 与手机共用明确冲突提示，手机保留错误态与参考日期标记', () => {
    for (const path of ['app/components/PlanSummaryPanel.vue', 'app/pages/m/plan.vue', 'app/pages/m/dept-plan.vue']) {
      expect(source(path)).toContain('<PlanDateConflicts')
    }
    const banner = source('app/components/PlanDateConflicts.vue')
    expect(banner).toContain('role="alert"')
    expect(banner).toContain('草稿可保存')
    expect(banner).toContain('预计交期、拖期结论和余量暂不作为有效结论')
    const mobile = source('app/pages/m/plan.vue')
    expect(mobile).toContain('v-else-if="error"')
    expect(mobile).toContain('（参考）')
    expect(source('app/components/PlanEditor.vue')).toContain('blocksPublish')
  })

  it.each([
    { name: '无冲突草稿', status: 'DRAFT', conflict: false, expectedStatus: '草稿', expectedDelivery: '发布后计算', reference: false },
    { name: '未编制', status: null, conflict: false, expectedStatus: '未编制', expectedDelivery: '—', reference: false },
    { name: '有冲突草稿', status: 'DRAFT', conflict: true, expectedStatus: '草稿', expectedDelivery: '待核实', reference: false },
    { name: '有冲突已发布计划', status: 'PUBLISHED', conflict: true, expectedStatus: '已发布', expectedDelivery: '待核实', reference: true },
    { name: '正常已发布计划', status: 'PUBLISHED', conflict: false, expectedStatus: '已发布', expectedDelivery: '2026-12-10', reference: true },
  ] as const)('手机真实页面正确显示$name、合同信息和日期', async ({ status, conflict, expectedStatus, expectedDelivery, reference }) => {
    const conflicts: schedule.PlanDateConflict[] = conflict
      ? [{ code: 'FS_ORDER', nodeId: 'drawing', nodeName: '图纸', message: '图纸开始早于开工通知完成', blocksPublish: true }]
      : []
    const data = {
      workOrder: { workOrderNumber: 'WO-MOBILE', projectName: '计划核查项目', effectiveTime: '2026-10-01', deliveryDate: '2026-12-12' },
      plan: status ? { status } : null,
      dateConflicts: conflicts,
      expectedDelivery: status === 'PUBLISHED' && !conflict ? '2026-12-10' : null,
      nodes: status ? [{
        id: 'drawing', code: '2.1', name: '图纸', dateConflict: conflict,
        startDate: '2026-11-02', planDate: '2026-11-10',
        expectedStartDate: '2026-11-03', expectedDate: '2026-11-11', actualDate: null, slackDays: null,
      }] : [],
    }
    vi.stubGlobal('definePageMeta', vi.fn())
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useRoute', () => ({ query: { wo: 'WO-MOBILE' } }))
    const fetchPlan = vi.fn(async () => ({ data: ref(data), pending: ref(false), error: ref(null), refresh: vi.fn() }))
    vi.stubGlobal('useFetch', fetchPlan)
    const component = loadComponent('app/pages/m/plan.vue', { '#shared/plan': plan })
    const banner = loadComponent('app/components/PlanDateConflicts.vue', { '#shared/plan-schedule': schedule })
    const wrapper = mount({ render: () => h(Suspense, null, { default: () => h(component) }) }, {
      global: {
        components: { PlanDateConflicts: banner },
        stubs: { MCard: { template: '<section class="m-card"><slot /></section>' }, VanNavBar: true, VanLoading: true, VanEmpty: true, VanButton: true },
      },
    })
    try {
      await flushPromises()
      expect(fetchPlan).toHaveBeenCalledWith('/api/plan', expect.any(Object))
      expect(wrapper.get('.m-section').text()).toContain('WO-MOBILE')
      expect(wrapper.get('.m-card .m-title').text()).toBe(expectedStatus)
      expect(wrapper.text()).toContain('合同生效日期 2026-10-01')
      expect(wrapper.text()).toContain('合同交期 2026-12-12')
      expect(wrapper.text()).toContain(`预计交期 ${expectedDelivery}`)
      expect(wrapper.text().includes('（参考）')).toBe(reference)
      expect(wrapper.find('[role="alert"]').exists()).toBe(conflict)
      if (conflict) expect(wrapper.get('[role="alert"]').text()).toContain('图纸开始早于开工通知完成')
      else expect(wrapper.text()).not.toContain('待核实')
      if (status) expect(wrapper.text()).toContain('计划开始 2026-11-02 · 完成 2026-11-10')
      if (reference) expect(wrapper.text()).toContain('预计开始 2026-11-03 · 完成 2026-11-11（参考）')
    } finally { wrapper.unmount() }
  })

  it('发布 API 仍强制可见性和操作权限，不依赖前端按钮', () => {
    const api = source('server/api/plan/publish.post.ts')
    expect(api.indexOf('await assertCanSee')).toBeLessThan(api.indexOf('return publishPlan'))
    expect(api).toContain("await assertCanOperate(event, 'plan', { workOrderNumber })")
  })

  it('冲突不能被正常色或风险筛选吞掉', () => {
    const row = { hasPlan: true, delayDays: null, delayedPlanNodes: 0, color: 'GREEN' as const, dateConflicts: [{}], redAlerts: 0, yellowAlerts: 0, openIssues: 0, shortage: 0, incompleteNodes: 0 }
    expect(boardGroup(row)).toBe('RISK')
    expect(boardRiskSections([row]).RISK).toEqual([row])
    expect(nodeState({ done: false, source: false, upstream: false, dateConflict: true })).toBe('REVIEW')
    expect(nodeState({ done: true, source: false, upstream: false, dateConflict: true })).toBe('DONE')
  })
})
