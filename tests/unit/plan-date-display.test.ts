// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { loadComponent } from '../helpers/vue-component'
import * as schedule from '../../shared/plan-schedule'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { h, nextTick, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { boardGroup, boardRiskSections, nodeState } from '../../shared/status'

const source = (path: string) => readFileSync(resolve(path), 'utf8')

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
    expect(mobile).toContain("data.expectedDelivery ?? '待核实'")
    expect(source('app/components/PlanEditor.vue')).toContain('blocksPublish')
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
  })
})
