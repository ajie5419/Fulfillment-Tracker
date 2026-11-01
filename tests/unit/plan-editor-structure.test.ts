import dayjs from 'dayjs'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientRequest } from '../../app/utils/transport'
import * as planStatus from '../../app/utils/plan-status'
import * as businessDepts from '../../shared/business-depts'
import * as mobileTodo from '../../shared/mobile-todo'
import * as planValidation from '../../shared/plan-validation'
import { flushVue, mountScript } from '../helpers/vue-script'

/**
 * PlanEditor 结构拆分特征化测试：编译真实 SFC 的 script，固定 props / 路由 / 接口输入，
 * 断言对外状态、请求（路径 / 方法 / 请求体 / 顺序）、提示、弹窗与 changed 事件。
 * 拆分前后同一份断言必须通过（拆出的 usePlan* composable 以全局自动导入的方式提供给 SFC）。
 */
const composableModules = import.meta.glob('../../app/composables/usePlan*.ts', { eager: true }) as Record<string, Record<string, unknown>>

const node = (over: Record<string, unknown>) => ({
  id: 'x', seq: 1, code: '1.1', name: '节点', dept: 'DESIGN', deptText: '设计部', note: null, parentId: null, childCount: 0, phase: null,
  startDate: null, planDate: '2026-11-05', customDeps: false, preds: [], pushedBy: null, affects: [], slackDays: null, critical: false,
  baselineDate: null, expectedDate: '2026-11-05', actualDate: null, done: false, doneBy: null, manualDoneByName: null, delayDays: 0, driver: 'self',
  selfExpectedDate: '2026-11-05', selfDelayDays: 0, source: false, upstream: false, confirmStatus: null, confirmText: null, confirmedByName: null,
  confirmedAt: null, rejectReason: null, taskCount: 0, doneCount: 0, overdueCount: 0, lateCount: 0, alertLevel: null, confirmAlertLevel: null,
  tasks: [], unsplit: false, splitAlertLevel: null, canSplit: false, canConfirm: false, canComplete: false, ...over,
})
const NODES = [
  node({ id: 'n1', seq: 1, code: '1.1', name: '图纸下发', phase: '设计', startDate: '2026-11-01', planDate: '2026-11-05', done: true, expectedDate: '2026-11-05', confirmStatus: 'CONFIRMED' }),
  node({ id: 'n2', seq: 2, code: '1.2', name: '工艺评审', phase: '设计', planDate: '2026-11-10', expectedDate: '2026-11-12', delayDays: 2, childCount: 2, dept: 'PROJECT' }),
  node({ id: 'n3', seq: 1, code: '1.2.1', name: '评审A', phase: '设计', parentId: 'n2', planDate: '2026-11-09', expectedDate: '2026-11-12', delayDays: 2, confirmStatus: 'PENDING' }),
  node({ id: 'n4', seq: 2, code: '1.2.2', name: '评审B', phase: '设计', parentId: 'n2', planDate: '2026-11-10', done: true, confirmStatus: 'CONFIRMED' }),
  node({ id: 'n5', seq: 3, code: '2.1', name: '下料', phase: '采购', planDate: '2026-11-20', expectedDate: '2026-11-20', confirmStatus: 'PENDING', customDeps: true, preds: [{ id: 'n1', seq: 1, code: '1.1', name: '图纸下发' }] }),
  node({ id: 'n6', seq: 4, code: '3.1', name: '装配', phase: null, planDate: '2026-11-30', expectedDate: '2026-11-30' }),
]
const planView = (over: Record<string, unknown> = {}) => ({
  workOrder: { workOrderNumber: 'WO1', projectName: 'P', customerName: 'C', deliveryDate: '2026-12-01', projectManagerName: 'PM' },
  plan: { status: 'DRAFT', templateName: null, publishedAt: null, publishedByName: null }, expectedDelivery: '2026-12-01', deliveryDelayDays: 0,
  delayedNodes: 0, sourceNodes: 0, planAlertLevel: null, unlinked: { drawing: 0, purchase: 0, step: 0, assembly: 0, total: 0 }, network: false,
  dangling: [], lastNodeId: 'n6', phases: ['设计', '采购'], canEdit: true, canCreate: { drawing: true, purchase: true, route: true, kitting: true },
  nodes: NODES, changeLogs: [], ...over,
})

type Call = { url: string; method: string; body: unknown; query: unknown }
let calls: Call[]
let toasts: [string, string][]
let modals: Record<string, any>[]
let route: { query: Record<string, string | undefined> }
let plan: ReturnType<typeof planView>
let scrolls: unknown[]
let failNext: string | null

beforeEach(() => {
  calls = []; toasts = []; modals = []; scrolls = []; failNext = null
  plan = planView()
  route = Vue.reactive({ query: {} as Record<string, string | undefined> })
  for (const name of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'nextTick'] as const) vi.stubGlobal(name, Vue[name])
  for (const mod of Object.values(composableModules)) for (const [key, value] of Object.entries(mod)) if (/^use[A-Z]/.test(key)) vi.stubGlobal(key, value)
  vi.stubGlobal('clientRequest', clientRequest)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useFetch', async () => ({ data: Vue.ref([{ id: 't1', name: '模板一', nodes: [] }, { id: 't2', name: '模板二', nodes: [] }]) }))
  vi.stubGlobal('apiError', (e: unknown) => (e instanceof Error ? e.message : String(e)))
  vi.stubGlobal('message', Object.fromEntries(['success', 'error', 'warning'].map((k) => [k, (text: string) => toasts.push([k, text])])))
  vi.stubGlobal('Modal', { confirm: (opts: Record<string, any>) => modals.push(opts) })
  vi.stubGlobal('document', { querySelector: (selector: string) => ({ scrollIntoView: (opts: unknown) => scrolls.push([selector, opts]) }) })
  vi.stubGlobal('$fetch', async (url: string, opts: { method?: string; body?: unknown; query?: unknown } = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body, query: opts.query })
    if (failNext === url) throw new Error('boom')
    if (url === '/api/plan') return plan
    if (url === '/api/plan/generate') return { created: 3 }
    if (url === '/api/plan/publish') return { todos: 2, deptsWithoutHead: ['采购部'] }
    if (url.startsWith('/api/plan/nodes') && opts.method === 'PATCH') return { reconfirm: true }
    return {}
  })
})
afterEach(() => vi.unstubAllGlobals())

const open = (props: Record<string, unknown> = { wo: 'WO1' }) =>
  mountScript('app/components/PlanEditor.vue', props, { dayjs: { default: dayjs }, '~/utils/plan-status': planStatus, '#shared/business-depts': businessDepts, '#shared/mobile-todo': mobileTodo, '#shared/plan-validation': planValidation })
const planCalls = () => calls.filter((c) => c.url !== '/api/plan')

describe('PlanEditor 加载与阶段汇总', () => {
  it('挂载即加载，阶段分组 / 汇总行 / 表格行 / 折叠候选逐字段固定', async () => {
    const v = await open()
    expect(calls).toEqual([{ url: '/api/plan', method: 'GET', body: undefined, query: { workOrderNumber: 'WO1' } }])
    expect(v.state.loading).toBe(false)
    expect(v.state.loadError).toBeNull()
    expect(v.state.published).toBe(false)
    expect(v.state.hasPhase).toBe(true)
    expect(v.state.phaseGroups.map((g: any) => g.row)).toEqual([
      { id: 'phase:n1', isPhase: true, phase: '设计', code: '1', count: 2, done: 1, start: '2026-11-01', end: '2026-11-10', expected: '2026-11-12', late: true, leaves: 3, accepted: 2, pending: 1 },
      { id: 'phase:n5', isPhase: true, phase: '采购', code: '2', count: 1, done: 0, start: '2026-11-20', end: '2026-11-20', expected: '2026-11-20', late: false, leaves: 1, accepted: 0, pending: 1 },
      { id: 'phase:n6', isPhase: true, phase: '未分阶段', code: '3', count: 1, done: 0, start: '2026-11-30', end: '2026-11-30', expected: '2026-11-30', late: false, leaves: 1, accepted: 0, pending: 0 },
    ])
    expect(v.state.phaseGroups.map((g: any) => g.nodes.map((n: any) => n.id))).toEqual([['n1', 'n2', 'n3', 'n4'], ['n5'], ['n6']])
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['phase:n1', 'n1', 'n2', 'n3', 'n4', 'phase:n5', 'n5', 'phase:n6', 'n6'])
    expect(v.state.collapsibleIds).toEqual(['phase:n1', 'phase:n5', 'phase:n6', 'n2'])
    expect(v.state.allOpen).toBe(true)
    expect(v.state.today).toBe(mobileTodo.factoryDay(new Date()))
    v.unmount()
  })

  it('没有任何节点带阶段时不分组，节点 = 1 级、子节点 = 2 级，折叠只针对汇总行', async () => {
    plan = planView({ nodes: NODES.map((n) => ({ ...n, phase: null })) })
    const v = await open()
    expect(v.state.hasPhase).toBe(false)
    expect(v.state.phaseGroups).toEqual([])
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    expect(v.state.collapsibleIds).toEqual(['n2'])
    v.state.toggleAll()
    expect(v.state.collapsed).toEqual(['n2'])
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['n1', 'n2', 'n5', 'n6'])
    v.state.toggleAll()
    expect(v.state.collapsed).toEqual([])
    v.unmount()
  })

  it('折叠 / 全部展开 / 只看阶段 / 定位展开', async () => {
    const v = await open()
    v.state.toggleCollapse('phase:n1')
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['phase:n1', 'phase:n5', 'n5', 'phase:n6', 'n6'])
    v.state.toggleCollapse('phase:n1')
    v.state.toggleCollapse('n2')
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['phase:n1', 'n1', 'n2', 'phase:n5', 'n5', 'phase:n6', 'n6'])
    v.state.toggleCollapse('n2')
    v.state.toggleAll()
    expect(v.state.collapsed).toEqual(['phase:n1', 'phase:n5', 'phase:n6'])
    expect(v.state.allOpen).toBe(false)
    expect(v.state.tableRows.map((r: any) => r.id)).toEqual(['phase:n1', 'phase:n5', 'phase:n6'])
    v.state.reveal('n5')
    expect(v.state.collapsed).toEqual(['phase:n1', 'phase:n6'])
    v.state.toggleCollapse('n2')
    v.state.reveal('n3')
    expect(v.state.collapsed).toEqual(['phase:n6'])
    v.state.toggleAll()
    expect(v.state.collapsed).toEqual([])
    v.unmount()
  })

  it('加载失败显示错误并清空数据；wo 清空不请求', async () => {
    failNext = '/api/plan'
    const v = await open()
    expect(v.state.data).toBeNull()
    expect(v.state.loadError).toBe('boom')
    expect(v.state.loading).toBe(false)
    failNext = null
    await v.state.load()
    expect(v.state.loadError).toBeNull()
    expect(v.state.data.nodes).toHaveLength(6)
    v.props.wo = ''
    await flushVue()
    expect(v.state.data).toBeNull()
    expect(calls.filter((c) => c.url === '/api/plan')).toHaveLength(2)
    v.props.wo = 'WO2'
    await flushVue()
    expect(calls.at(-1)).toEqual({ url: '/api/plan', method: 'GET', body: undefined, query: { workOrderNumber: 'WO2' } })
    v.unmount()
  })
})

describe('PlanEditor 甘特联动 / 定位', () => {
  it('?node= 定位：展开所在阶段与上级、展开行、滚动；路由变化重新加载并定位', async () => {
    route.query.node = 'n3'
    const v = await open()
    expect(v.state.focusNode).toBe('n3')
    expect(v.state.expanded).toEqual(['n3'])
    expect(scrolls).toEqual([['[data-row-key="n3"]', { behavior: 'smooth', block: 'center' }]])
    v.state.collapsed = ['phase:n1', 'n2', 'phase:n5']
    route.query.node = 'n5'
    await flushVue()
    expect(calls.filter((c) => c.url === '/api/plan')).toHaveLength(2)
    expect(v.state.focusNode).toBe('n5')
    expect(v.state.expanded).toEqual(['n5'])
    expect(v.state.collapsed).toEqual(['phase:n1', 'n2'])
    route.query.node = undefined
    await flushVue()
    expect(v.state.focusNode).toBeNull()
    expect(scrolls).toHaveLength(2)
    v.unmount()
  })

  it('从甘特图选节点：切回表格、定位、展开、滚动；展开行里任务变动后重载并通知', async () => {
    const v = await open()
    v.state.view = 'gantt'
    v.state.collapsed = ['phase:n1', 'n2']
    v.state.selectFromGantt('n4')
    expect(v.state.view).toBe('table')
    expect(v.state.focusNode).toBe('n4')
    expect(v.state.expanded).toEqual(['n4'])
    expect(v.state.collapsed).toEqual([])
    await flushVue()
    expect(scrolls).toEqual([['[data-row-key="n4"]', { behavior: 'smooth', block: 'center' }]])
    await v.state.onWorkChanged()
    expect(calls.filter((c) => c.url === '/api/plan')).toHaveLength(2)
    expect(v.events).toEqual([['changed']])
    v.unmount()
  })
})

describe('PlanEditor 生成 / 发布', () => {
  it('默认选第一个模板；无节点时直接生成，有节点时先确认', async () => {
    plan = planView({ nodes: [] })
    const v = await open()
    expect(v.state.templateId).toBe('t1')
    v.state.generate()
    await flushVue()
    expect(planCalls()).toEqual([{ url: '/api/plan/generate', method: 'POST', body: { workOrderNumber: 'WO1', templateId: 't1' }, query: undefined }])
    expect(toasts).toEqual([['success', '已生成 3 个节点']])
    expect(v.events).toEqual([['changed']])
    v.unmount()

    calls = []; toasts = []; plan = planView()
    const w = await open()
    w.state.templateId = 't2'
    w.state.generate()
    expect(modals).toHaveLength(1)
    expect(modals[0]).toMatchObject({ title: '按模板重新生成？', content: '现有节点会被替换，挂在上面的部门记录变成未挂' })
    expect(planCalls()).toEqual([])
    await modals[0]!.onOk()
    expect(planCalls()[0]).toEqual({ url: '/api/plan/generate', method: 'POST', body: { workOrderNumber: 'WO1', templateId: 't2' }, query: undefined })
    w.unmount()
  })

  it('未选模板提示；发布走确认并报告无负责人的部门', async () => {
    const v = await open()
    v.state.templateId = undefined
    v.state.generate()
    expect(toasts).toEqual([['warning', '请选择模板']])
    v.state.publish()
    expect(modals[0]!.title).toBe('发布总计划？')
    await modals[0]!.onOk()
    expect(planCalls()).toEqual([{ url: '/api/plan/publish', method: 'POST', body: { workOrderNumber: 'WO1' }, query: undefined }])
    expect(toasts.at(-1)).toEqual(['success', '已发布，发出 2 条接收待办（采购部没有负责人，没人收到）'])
    expect(v.events).toEqual([['changed']])
    v.unmount()
  })

  it('接口失败：提示错误，仍重载并通知 changed', async () => {
    const v = await open()
    failNext = '/api/plan/generate'
    v.state.generate()
    await modals[0]!.onOk()
    expect(toasts.at(-1)).toEqual(['error', 'boom'])
    expect(calls.filter((c) => c.url === '/api/plan')).toHaveLength(2)
    expect(v.events).toEqual([['changed']])
    v.unmount()
  })
})

describe('PlanEditor 节点编辑表单与保存', () => {
  it('新增：默认值沿用最后一个节点的阶段；选项 / 默认前置文案', async () => {
    const v = await open()
    v.state.openEdit(null)
    expect(v.state.editOpen).toBe(true)
    expect(v.state.editing).toBeNull()
    expect({ ...v.state.form }).toEqual({ name: '', dept: 'PROJECT', phase: '', startDate: undefined, planDate: undefined, seq: undefined, parentId: undefined, depMode: 'default', preds: [], note: '', reason: '' })
    expect(v.state.predOptions.map((o: any) => o.value)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    expect(v.state.parentOptions).toEqual([1, 2, 5, 6].map((i) => ({ value: NODES[i - 1]!.id, label: `${NODES[i - 1]!.code} ${NODES[i - 1]!.name}` })).filter((o) => o.value !== 'n3'))
    expect(v.state.phaseOptions).toEqual([{ value: '设计' }, { value: '采购' }])
    expect(v.state.defaultPredText).toBe('3.1 装配（排在最后时）')
    expect(v.state.isSummary).toBe(false)
    expect(v.state.needReason).toBe(false)
    v.unmount()
  })

  it('编辑 / 加子节点：回填字段、上级、汇总行、前置选项排除自己与上级', async () => {
    const v = await open()
    v.state.openEdit(NODES[4])
    expect(v.state.form.depMode).toBe('custom')
    expect(v.state.form.preds).toEqual(['n1'])
    expect(v.state.form.planDate.format('YYYY-MM-DD')).toBe('2026-11-20')
    expect(v.state.form.phase).toBe('采购')
    expect(v.state.defaultPredText).toBe('1.2 工艺评审')
    expect(v.state.predOptions.map((o: any) => o.value)).not.toContain('n5')
    v.state.openEdit(null, NODES[1])
    expect(v.state.form).toMatchObject({ dept: 'PROJECT', parentId: 'n2', phase: '' })
    expect(v.state.form.planDate.format('YYYY-MM-DD')).toBe('2026-11-10')
    expect(v.state.formParent.id).toBe('n2')
    expect(v.state.defaultPredText).toBe('没有前置（可以和同一上级下的其他子节点同时开始）')
    expect(v.state.predOptions.map((o: any) => o.value)).not.toContain('n2')
    v.state.openEdit(NODES[1])
    expect(v.state.isSummary).toBe(true)
    v.unmount()
  })

  it('保存校验：名称 / 计划日 / 开始晚于完成 / 已发布缺原因', async () => {
    const v = await open()
    v.state.openEdit(null)
    await v.state.saveNode()
    v.state.form.name = '新节点'
    await v.state.saveNode()
    v.state.form.planDate = dayjs('2026-11-10')
    v.state.form.startDate = dayjs('2026-11-11')
    expect(v.state.startLate).toBe(true)
    await v.state.saveNode()
    expect(toasts).toEqual([['warning', '请填写节点名称'], ['warning', '请选择计划日期'], ['warning', '计划开始日不能晚于计划完成日']])
    expect(calls).toHaveLength(1)
    v.unmount()

    toasts = []; plan = planView({ plan: { status: 'PUBLISHED', templateName: null, publishedAt: null, publishedByName: null } })
    const w = await open()
    expect(w.state.published).toBe(true)
    w.state.openEdit(null)
    w.state.form.name = '新节点'; w.state.form.planDate = dayjs('2026-11-10')
    expect(w.state.needReason).toBe(true)
    await w.state.saveNode()
    expect(toasts).toEqual([['warning', '总计划已发布，请写调整原因']])
    w.unmount()
  })

  it('新增保存：POST 请求体、关闭弹窗、changed；编辑保存：PATCH、重新接收提示', async () => {
    const v = await open()
    v.state.openEdit(null)
    Object.assign(v.state.form, { name: '新节点', dept: 'PROCUREMENT', phase: '采购', seq: 3, note: '备注', depMode: 'custom', preds: ['n1'], startDate: dayjs('2026-11-02'), planDate: dayjs('2026-11-10') })
    await v.state.saveNode()
    expect(planCalls()).toEqual([{ url: '/api/plan/nodes', method: 'POST', query: undefined, body: { workOrderNumber: 'WO1', name: '新节点', dept: 'PROCUREMENT', phase: '采购', startDate: '2026-11-02', planDate: '2026-11-10', seq: 3, parentId: null, preds: ['n1'], note: '备注', reason: null } }])
    expect(toasts.at(-1)).toEqual(['success', '已保存'])
    expect(v.state.editOpen).toBe(false)
    expect(v.events).toEqual([['changed']])

    v.state.openEdit(NODES[0])
    await v.state.saveNode()
    expect(planCalls().at(-1)).toEqual({ url: '/api/plan/nodes/n1', method: 'PATCH', query: undefined, body: { name: '图纸下发', dept: 'DESIGN', phase: '设计', startDate: '2026-11-01', planDate: '2026-11-05', seq: 1, parentId: null, preds: null, note: null, reason: null } })
    expect(toasts.at(-1)).toEqual(['success', '已保存，已重新请责任部门接收'])
    expect(v.events).toHaveLength(2)
    v.unmount()
  })

  it('保存失败：弹窗保持打开', async () => {
    const v = await open()
    v.state.openEdit(NODES[0])
    failNext = '/api/plan/nodes/n1'
    await v.state.saveNode()
    expect(toasts.at(-1)).toEqual(['error', 'boom'])
    expect(v.state.editOpen).toBe(true)
    v.unmount()
  })
})

describe('PlanEditor 删除确认', () => {
  it('未发布：确认框 + DELETE 空请求体', async () => {
    const v = await open()
    v.state.askDelete(NODES[5])
    expect(modals[0]).toMatchObject({ title: '删除节点"装配"？', content: '挂在上面的部门记录变成未挂', okType: 'danger' })
    expect(v.state.reasonOpen).toBe(false)
    await modals[0]!.onOk()
    expect(planCalls()).toEqual([{ url: '/api/plan/nodes/n6', method: 'DELETE', body: {}, query: undefined }])
    expect(toasts.at(-1)).toEqual(['success', '已删除'])
    expect(v.events).toEqual([['changed']])
    v.unmount()
  })

  it('已发布：弹出原因框，空原因提示，提交带 reason 后关闭', async () => {
    plan = planView({ plan: { status: 'PUBLISHED', templateName: null, publishedAt: null, publishedByName: null } })
    const v = await open()
    v.state.reasonText = '旧文本'
    v.state.askDelete(NODES[5])
    expect(modals).toEqual([])
    expect(v.state.reasonOpen).toBe(true)
    expect(v.state.reasonFor.id).toBe('n6')
    expect(v.state.reasonText).toBe('')
    await v.state.submitReason()
    expect(toasts).toEqual([['warning', '请写删除原因']])
    v.state.reasonText = '客户取消'
    await v.state.submitReason()
    expect(planCalls()).toEqual([{ url: '/api/plan/nodes/n6', method: 'DELETE', body: { reason: '客户取消' }, query: undefined }])
    expect(v.state.reasonOpen).toBe(false)
    expect(v.events).toEqual([['changed']])
    v.unmount()
  })
})
