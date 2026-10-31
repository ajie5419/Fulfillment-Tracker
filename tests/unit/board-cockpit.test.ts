import { describe, expect, it } from 'vitest'
import { computed, reactive } from 'vue'
import type { NodeState } from '../../shared/status'
import { cockpitMetrics, mergeCockpitItems, redWorkOrderStages, resolveBoardView, type CockpitIssue, type CockpitRedWorkOrder, type CockpitStagnation } from '../../shared/board-cockpit'

describe('项目总览权限与 URL 落点', () => {
  it.each([
    [true, undefined, 'cockpit'], [true, 'cockpit', 'cockpit'], [true, 'board', 'board'],
    [true, 'unknown', 'cockpit'], [true, ['board', 'cockpit'], 'cockpit'],
    [false, undefined, 'board'], [false, 'cockpit', 'board'], [false, 'board', 'board'], [false, 'unknown', 'board'],
  ])('overview=%s, view=%s → %s', (permission, query, expected) => {
    expect(resolveBoardView(permission as boolean, query)).toBe(expected)
  })
  it('同页深链、返回、权限变化直接改变落点', () => {
    const route = reactive({ view: undefined as unknown, canOverview: true })
    const view = computed(() => resolveBoardView(route.canOverview, route.view))
    expect(view.value).toBe('cockpit')
    route.view = 'board'
    expect(view.value).toBe('board')
    route.view = 'cockpit'
    expect(view.value).toBe('cockpit')
    route.canOverview = false
    expect(view.value).toBe('board')
  })
})

describe('驾驶舱数字映射', () => {
  const overview = { summary: { red: 7, overdueIssues: 12 }, stages: [{ key: 'drawing', count: 88 }, { key: 'shortage', count: 9 }] }
  it('只取既有字段，红色和超期来自 overview；未签收来自 releases.pending；缺料按 stage key 取', () => {
    expect(cockpitMetrics(overview, { pending: 5 }, { redCount: 23 }).map((m) => [m.key, m.value, m.to])).toEqual([
      ['red', 7, '/board?view=board&color=RED'], ['overdue', 12, '/risks?tab=issues&overdue=1&dept=0'],
      ['unsigned', 5, '/releases?progress=PENDING'], ['shortage', 9, '/purchases?view=shortage'],
      ['stagnation', 23, '/monitoring?level=RED'],
    ])
  })
  it('不把截断 Top 10 的长度当成停滞红线总数，展示五项', () => {
    const monitoring = { redCount: 23, top: Array(10).fill({ level: 'RED' }) }
    expect(cockpitMetrics(overview, { pending: 5 }, monitoring)).toHaveLength(5)
    expect(cockpitMetrics(overview, null, monitoring)[4]!.value).toBe(23)
  })
  it('接口失败 / 尚未加载显示破折号；已有的零值仍显示零', () => {
    expect(cockpitMetrics(null, undefined).map((m) => m.value)).toEqual(['—', '—', '—', '—', '—'])
    expect(cockpitMetrics({ summary: { red: 0, overdueIssues: 0 }, stages: [{ key: 'shortage', count: 0 }] }, { pending: 0 }, { redCount: 0 }).map((m) => m.value)).toEqual([0, 0, 0, 0, 0])
  })
  it('一处来源失败不会把其余来源抹成零，缺失缺料 stage 也不伪装成零', () => {
    expect(cockpitMetrics(null, { pending: 3 }).map((m) => m.value)).toEqual(['—', '—', 3, '—', '—'])
    expect(cockpitMetrics({ ...overview, stages: [] }, null).map((m) => m.value)).toEqual([7, 12, '—', '—', '—'])
  })
})

const wo = (no: string): CockpitRedWorkOrder => ({ workOrderNumber: no, projectName: '测试项目', projectManagerName: '张经理', reason: '红色预警 2 项；缺料 3 项' })
const issue = (id: string, days: number): CockpitIssue => ({
  id, issueNo: `YC-${id}`, description: '图纸未确认', workOrderNumber: 'WO-1', responsibleDeptName: '技术部', responsibleUserName: '李工', overdue: true, overdueDays: days,
})
const stagnation = (id: string, days: number): CockpitStagnation => ({
  entityType: 'step', id, name: '主梁 · 组焊', workOrderNumber: 'WO-1', statusText: '待开工', days, level: 'RED', deptNames: ['生产部'], owners: [{ name: '王工' }], link: `/parts?wo=WO-1&part=p&step=${id}`,
})
const merge = (extra: Partial<Parameters<typeof mergeCockpitItems>[0]> = {}) => mergeCockpitItems({ redWorkOrders: [], issues: [], stagnation: [], ...extra })

describe('红色清单合并、排序与深链', () => {
  it('一单命中三类只出一行，主项为红色工单，附加项完整且有独立入口', () => {
    const items = merge({ redWorkOrders: [wo('WO-1')], issues: [issue('i', 100)], stagnation: [stagnation('s', 200)] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'wo:WO-1', kind: 'workOrder', days: 200, workOrder: wo('WO-1') })
    expect(items[0]!.also).toMatchObject([
      { kind: 'issue', label: '超期异常', duration: '已超期 100 天', to: '/risks?tab=issues&overdue=1&dept=0&id=i' },
      { kind: 'stagnation', label: '停滞红线', detail: '工序 · 待开工', duration: '已停 200 天', to: stagnation('s', 200).link },
    ])
  })
  it('先按主类型，再按该单超期 / 停滞 / 拖期最大天数排序，同天数按工单 key', () => {
    const items = merge({
      redWorkOrders: [wo('D'), { ...wo('C'), delayDays: 11 }, wo('B'), wo('A')],
      issues: [{ ...issue('a', 11), workOrderNumber: 'A' }, { ...issue('b', 9), workOrderNumber: 'B' }, { ...issue('e', 100), workOrderNumber: 'E' }],
      stagnation: [{ ...stagnation('b', 20), workOrderNumber: 'B' }, { ...stagnation('e', 200), workOrderNumber: 'E' }, { ...stagnation('f', 300), workOrderNumber: 'F' }],
    })
    expect(items.map((r) => [r.key, r.kind, r.days])).toEqual([
      ['wo:B', 'workOrder', 20], ['wo:A', 'workOrder', 11], ['wo:C', 'workOrder', 11], ['wo:D', 'workOrder', null],
      ['wo:E', 'issue', 200], ['wo:F', 'stagnation', 300],
    ])
    expect(items.find((r) => r.workOrderNumber === 'E')).toMatchObject({ duration: '已超期 100 天', also: [{ kind: 'stagnation', days: 200 }] })
  })
  it('只收 overdue 异常与 RED 停滞，包含 overdueDays = 0 的待受理超时', () => {
    const rows = merge({ issues: [issue('i', 0), { ...issue('closed', 99), overdue: false }], stagnation: [{ ...stagnation('s', 8), level: 'YELLOW' }, { ...stagnation('s2', 1), level: 'GREEN' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'issue', days: null, duration: '待受理超时', also: [] })
  })
  it('分组和排序后按 10 单截断，同单多问题不挤占行数，也不修改输入', () => {
    const input = Array.from({ length: 15 }, (_, n) => ({ ...issue(String(n), n + 1), workOrderNumber: `W-${n}` }))
    const rows = merge({ issues: [...input, ...input.map((i) => ({ ...i, id: `other-${i.id}`, overdueDays: 1 }))] })
    expect(rows.map((r) => r.days)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6])
    expect(new Set(rows.map((r) => r.workOrderNumber)).size).toBe(10)
    expect(rows.every((r) => r.also.length === 1)).toBe(true)
    expect(input[0]!.overdueDays).toBe(1)
    expect(input[0]!.id).toBe('0')
    const mixed = merge({ redWorkOrders: Array.from({ length: 9 }, (_, n) => wo(`R-${n}`)), issues: input, stagnation: [{ ...stagnation('s', 999), workOrderNumber: 'S' }] })
    expect(mixed).toHaveLength(10)
    expect(mixed.map((r) => r.kind)).toEqual([...Array(9).fill('workOrder'), 'issue'])
    expect(mixed[9]!.workOrderNumber).toBe('W-14')
  })
  it('保留 redReason 原文、责任方、三类原有详情链接和服务端时长', () => {
    const rows = merge({ redWorkOrders: [wo('WO /?1')], issues: [{ ...issue('i &1', 4), workOrderNumber: 'WO /?1' }], stagnation: [stagnation('s', 18)] })
    const details = [rows[0]!, ...rows[0]!.also, rows[1]!]
    expect(details.map((r) => [r.to, r.duration, r.responsibility])).toEqual([
      ['/wo/WO%20%2F%3F1', '异常最长已超 4 天', '项目经理 张经理'],
      ['/risks?tab=issues&overdue=1&dept=0&id=i%20%261', '已超期 4 天', '技术部 · 李工'],
      ['/parts?wo=WO-1&part=p&step=s', '已停 18 天', '生产部 · 王工'],
    ])
    expect(rows[0]!.detail).toBe(wo('WO /?1').reason)
  })
  it('责任与时长缺失明确显示缺失，不推定责任人或制造天数', () => {
    const rows = merge({ redWorkOrders: [{ ...wo('W'), projectManagerName: null }], issues: [{ ...issue('i', 2), responsibleDeptName: null, responsibleUserName: null }], stagnation: [{ ...stagnation('s', 14), workOrderNumber: 'S', owners: [], deptNames: [] }] })
    expect(rows[0]).toMatchObject({ days: null, duration: '时长未提供', responsibility: '未设置项目经理' })
    expect(rows.slice(1).map((r) => r.responsibility)).toEqual(['未指定责任方', '未指定责任方'])
  })
  it('同单的多条异常和停滞都保留，主项和顺序不受输入顺序影响', () => {
    const rows = merge({ redWorkOrders: [wo('WO-1')], issues: [issue('long', 11), issue('short', 2)] })
    expect(rows[0]).toMatchObject({ days: 11, duration: '异常最长已超 11 天' })
    expect(rows[0]!.also.map((r) => r.key)).toEqual(['issue:long', 'issue:short'])
    const input = { issues: [issue('short', 2), issue('long', 11)], stagnation: [stagnation('s1', 20), stagnation('s2', 30)] }
    const grouped = merge(input)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({ kind: 'issue', days: 30, title: 'YC-long · 图纸未确认' })
    expect(grouped[0]!.also.map((r) => r.key)).toEqual(['issue:short', 'step:s2', 'step:s1'])
    expect(merge({ issues: [...input.issues].reverse(), stagnation: [...input.stagnation].reverse() })).toEqual(grouped)
    expect(merge({ redWorkOrders: [wo('WO-1')] })[0]).toMatchObject({ days: null, duration: '时长未提供' })
  })
  it('工单排序也使用完整停滞摘要和预计拖期，但文案区分时钟', () => {
    const rows = merge({ redWorkOrders: [{ ...wo('A'), delayDays: 25 }, { ...wo('B'), stagnationRedDays: 30 }, { ...wo('C'), stagnationYellowDays: 8, delayDays: -3 }] })
    expect(rows.map((r) => [r.workOrderNumber, r.days, r.duration])).toEqual([['B', 30, '已停 30 天'], ['A', 25, '预计拖期 25 天'], ['C', 8, '已停 8 天']])
  })
  it('只有异常或只有停滞的工单照常一单一行', () => {
    const rows = merge({ issues: [issue('i', 3)], stagnation: [{ ...stagnation('s', 25), workOrderNumber: 'S' }] })
    expect(rows.map((r) => [r.workOrderNumber, r.kind, r.also])).toEqual([['WO-1', 'issue', []], ['S', 'stagnation', []]])
  })
  it('无数据时得到空清单', () => { expect(merge()).toEqual([]) })
})


describe('红色工单环节归一', () => {
  const node = (name: string, dept: string, seq = 1, state: NodeState = 'SOURCE') => ({ name, dept, seq, state })
  const row = (planNodes: ReturnType<typeof node>[], color = 'RED', closed = false) => ({ planNodes, color, closed })
  it.each([
    ['设计', node('出图', 'TECH')], ['设计', node('工艺编制', 'PROCESS')], ['采购', node('采购', 'PURCHASE')],
    ['齐套', node('总装齐套', 'PRODUCTION')], ['外协', node('外协加工', 'PURCHASE')], ['生产', node('组焊', 'PRODUCTION')],
    ['其他', node('终检', 'QUALITY')],
  ])('%s 来源于最早源头节点，不用业务风险计数猜测环节', (label, n) => {
    expect(redWorkOrderStages([row([n])])).toEqual([{ key: expect.any(String), label, count: 1 }])
  })
  it('一单多卡点只计最早 SOURCE，含缺失归其他；细分和严格等于活动红工单数', () => {
    const rows = [
      row([node('采购', 'PURCHASE', 5), node('出图', 'TECH', 2), node('齐套', 'PRODUCTION', 9)]),
      row([node('外协加工', 'PRODUCTION', 3), node('出图', 'TECH', 1, 'UPSTREAM')]),
      row([]), row([node('组焊', 'PRODUCTION', 1, 'DONE')]),
      row([node('采购', 'PURCHASE')], 'YELLOW'), row([node('出图', 'TECH')], 'RED', true),
    ]
    const stages = redWorkOrderStages(rows)
    expect(stages).toEqual([{ key: 'drawing', label: '设计', count: 1 }, { key: 'outsource', label: '外协', count: 1 }, { key: 'other', label: '其他', count: 2 }])
    expect(stages.reduce((sum, s) => sum + s.count, 0)).toBe(rows.filter((r) => r.color === 'RED' && !r.closed).length)
  })
  it('无红单时不显示零值胶囊', () => { expect(redWorkOrderStages([])).toEqual([]) })
})
