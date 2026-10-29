// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { flushPromises, mount } from '@vue/test-utils'
import * as Vue from 'vue'
import { defineComponent, h, nextTick, reactive } from 'vue'
import Antd, { ConfigProvider, DatePicker, Modal } from 'ant-design-vue'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import * as purchasePlans from '../../shared/purchase-plans'
import { loadComponent } from '../helpers/vue-component'
import { flushVue } from '../helpers/vue-script'

const cleanups: (() => void)[] = []
const zhCN = createRequire(import.meta.url)('ant-design-vue/lib/locale/zh_CN').default
beforeEach(() => {
  dayjs.locale('zh-cn')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  for (const key of ['ref', 'computed', 'reactive', 'watch', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) vi.stubGlobal(key, Vue[key])
  vi.stubGlobal('useWorkOrders', async () => ({ data: Vue.ref([{ workOrderNumber: 'WO' }]) }))
  vi.stubGlobal('useMaster', async () => ({ data: Vue.ref({ suppliers: [], users: [] }) }))
  vi.stubGlobal('useMe', async () => ({ data: Vue.ref({ can: { purchasePlan: true } }) }))
  vi.stubGlobal('useRoute', () => ({ params: { id: 'plan' }, query: {} }))
  vi.stubGlobal('useFetch', async (url: unknown) => ({ data: Vue.ref(typeof url === 'string' ? [] : { id: 'plan', workOrderNumber: 'WO', status: 'DRAFT', items: [], progress: { total: 0, converted: 0, arrived: 0 } }), error: Vue.ref(null), pending: Vue.ref(false), refresh: vi.fn() }))
  vi.stubGlobal('message', { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() })
  vi.stubGlobal('dayText', (value?: string) => value?.slice(0, 10) ?? '')
  vi.stubGlobal('dayAfter', () => '2026-10-29')
  vi.stubGlobal('apiError', (error: Error) => error.message)
  vi.stubGlobal('purchaseSend', vi.fn().mockResolvedValue({ id: 'line' }))
  vi.stubGlobal('drawingSend', vi.fn().mockResolvedValue({ id: 'task' }))
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ id: 'item' }))
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it.each(['blur', 'enter', 'save'])('原组件对照：手打后 %s 的实际模型值', async finish => {
  const form = reactive({ needDate: undefined as string | undefined })
  const save = vi.fn()
  const wrapper = mount(defineComponent({
    setup: () => () => h(ConfigProvider, { locale: zhCN }, { default: () => h(Modal, { open: true, onOk: () => save(form.needDate) }, {
      default: () => h(DatePicker as Vue.Component, { value: form.needDate, valueFormat: 'YYYY-MM-DD', 'onUpdate:value': (value: string) => { form.needDate = value } }),
    }) }),
  }), { attachTo: document.body })
  cleanups.push(() => wrapper.unmount())
  await nextTick()
  const input = document.querySelector<HTMLInputElement>('.ant-picker input')!
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  input.focus()
  await nextTick()
  input.value = '2026-11-05'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  if (finish === 'enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  else if (finish === 'save') await clickSave()
  else input.blur()
  await nextTick()
  // Locked 4.2.6: outside mousedown discards the draft before blur can submit it.
  expect(form.needDate).toBe(finish === 'save' ? undefined : '2026-11-05')
  if (finish === 'save') expect(save).toHaveBeenCalledWith(undefined)
})

type ModalTarget = readonly [label: string, file: string, props: Record<string, unknown>, formName: string, field: string, index: number]
const targets = [
  ['采购计划需求日', 'app/pages/purchase-plans/[id].vue', {}, 'itemForm', 'needDate', 0],
  ['采购需求日', 'app/components/PurchaseEditModal.vue', { open: true, line: null, workOrderNumber: 'WO' }, 'form', 'needDate', 0],
  ['采购承诺日', 'app/components/PurchaseEditModal.vue', { open: true, line: null, workOrderNumber: 'WO' }, 'form', 'promisedDate', 1],
  ['采购到货日', 'app/components/PurchaseEditModal.vue', { open: true, line: null, workOrderNumber: 'WO' }, 'form', 'arrivedDate', 2],
  ['设计计划日', 'app/components/DrawingEditModal.vue', { open: true, task: null, workOrderNumber: 'WO' }, 'form', 'planDate', 0],
  ['客户确认计划日', 'app/components/DrawingEditModal.vue', { open: true, task: null, workOrderNumber: 'WO' }, 'form', 'customerPlanDate', 1],
] as const

async function actualModal(target: ModalTarget) {
  const [, file, props, formName, field, index] = target
  const component = loadComponent(file, { '#shared/purchase-plans': purchasePlans })
  const setup = component.setup!
  let state: any
  component.setup = function (props, context) {
    const capture = (value: any) => { state = Vue.proxyRefs(value); return value }
    const result = setup(props, context)
    return result instanceof Promise ? result.then(capture) : capture(result)
  }
  const wrapper = mount(defineComponent({ setup: () => () => h(ConfigProvider, { locale: zhCN }, { default: () => h(Vue.Suspense, null, { default: () => h(component, props) }) }) }), {
    attachTo: document.body,
    global: { plugins: [Antd], components: { UiDatePicker: loadComponent('app/components/ui/DatePicker.vue') }, stubs: { AAutoComplete: { inheritAttrs: false, render: () => null }, PlanNodeSelect: true, NuxtLink: true, UiStatCard: true, UiSectionCard: true, UiListItem: true, UiRefreshButton: true, UiStatusTag: true } },
  })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  await flushVue()
  if (formName === 'itemForm') state.editItem()
  else Object.assign(state.form, { materialName: '减速机', componentName: '总图', needDate: '2026-11-01', planDate: '2026-11-01', needsCustomerConfirm: true })
  state[formName][field] = undefined
  await flushVue()
  const input = document.querySelectorAll<HTMLInputElement>('.ant-modal .ant-picker input')[index]!
  expect(input).toBeTruthy()
  return { state, form: state[formName], field, input }
}

async function typeDate(input: HTMLInputElement, text: string) {
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  input.focus()
  await flushVue()
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushVue()
}

async function clickSave() {
  const button = document.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')!
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  // Browsers flush microtasks between mousedown and its default focus/blur action.
  await flushVue()
  button.focus()
  await flushVue()
  button.click()
  await flushPromises()
  await flushVue()
}

it.each(targets)('%s 手打后直接保存提交最新日期', async (...target) => {
  const { form, field, input } = await actualModal(target)
  await typeDate(input, '2026-11-05')
  await clickSave()
  expect(form[field]).toBe('2026-11-05')
  expectSubmitted(target[1], field, '2026-11-05')
})

function expectSubmitted(file: string, field: string, value: string) {
  if (file.includes('purchase-plans')) expect($fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: expect.objectContaining({ [field]: value }) }))
  else expect(file.includes('PurchaseEdit') ? purchaseSend : drawingSend).toHaveBeenCalledWith(expect.any(String), 'POST', expect.objectContaining({ [field]: value }))
}

for (const finish of ['blur', 'enter'] as const) {
  it.each(targets)(`%s 手打合法日期后 ${finish} 并保存`, async (...target) => {
    const { form, field, input } = await actualModal(target)
    await typeDate(input, '2026-11-05')
    if (finish === 'blur') input.blur()
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    await flushVue()
    expect(form[field]).toBe('2026-11-05')
    await clickSave()
    expectSubmitted(target[1], field, '2026-11-05')
  })
}

async function pickDate(input: HTMLInputElement) {
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  input.focus()
  await flushVue()
  const cells = [...document.querySelectorAll<HTMLElement>('.ant-picker-cell-in-view')]
  const cell = cells.find(cell => !cell.classList.contains('ant-picker-cell-disabled') && !cell.classList.contains('ant-picker-cell-selected'))!
  const value = cell.title
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await flushVue()
  cell.click()
  await flushVue()
  return value
}

it.each(targets)('%s 日历点选后保存仍提交选中日期', async (...target) => {
  const { form, field, input } = await actualModal(target)
  const value = await pickDate(input)
  expect(form[field]).toBe(value)
  await clickSave()
  expectSubmitted(target[1], field, value)
})

for (const text of ['2026-02-30', '2026-11-0']) {
  it.each(targets)(`%s 手打 ${text} 后保存恢复原值`, async (...target) => {
    const { form, field, input } = await actualModal(target)
    form[field] = '2026-11-01'
    await flushVue()
    await typeDate(input, '2026-11-05')
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushVue()
    await clickSave()
    expect(form[field]).toBe('2026-11-01')
    expect(input.value).toBe('2026-11-01')
    expectSubmitted(target[1], field, '2026-11-01')
  })
}

const otherTargets = [
  ['工单交期', 'app/components/WorkOrderEditModal.vue', 'form.deliveryDate'],
  ['外协承诺返回日', 'app/components/SendStepModal.vue', 'promisedReturnDate'],
  ['付款申请日', 'app/components/PaymentCreateModal.vue', 'form.requestDate'],
  ['工件套模板开工日', 'app/components/PartTemplateModal.vue', 'form.startDate'],
  ['批量套模板开工日', 'app/components/RouteBatchModal.vue', 'form.startDate'],
  ['批量工序应开工日', 'app/components/RouteBatchModal.vue', 'form.planStartDate'],
  ['批量工序要求完成日', 'app/components/RouteBatchModal.vue', 'form.dueDate'],
  ['装配需求日', 'app/components/KittingNodeModal.vue', 'form.needDate'],
  ['异常上报要求解决日', 'app/components/IssueReportModal.vue', 'form.dueDate'],
  ['异常受理要求解决日', 'app/components/IssueDrawer.vue', 'form.dueDate'],
  ['设计完成/客户确认日期', 'app/pages/drawings.vue', 'actDate'],
  ['采购确认到货日期', 'app/pages/purchases.vue', 'arrival.arrivedDate'],
] as const

async function otherModal(target: readonly [label: string, file: string, binding: string]) {
  const [, file, binding] = target
  // Keep each production picker declaration (including allow-clear / disabled-date),
  // and isolate unrelated page I/O behind the same real modal used above.
  const tag = readFileSync(file, 'utf8').match(/<(?:a-date-picker|UiDatePicker)\b[^>]*\/>/g)!.find(tag => tag.includes(`v-model:value="${binding}"`))!
  expect(tag).toBeTruthy()
  const state = reactive<any>({ form: {}, arrival: {}, actDate: undefined, promisedReturnDate: undefined, editing: false, pastDay: () => false })
  const keys = binding.split('.')
  const form = keys.length === 1 ? state : state[keys[0]!]
  const field = keys.at(-1)!
  form[field] = '2026-11-01'
  const save = vi.fn()
  const wrapper = mount(defineComponent({
    template: `<a-config-provider :locale="locale"><a-modal :open="true" @ok="save">${tag}</a-modal></a-config-provider>`,
    setup: () => ({ ...Vue.toRefs(state), locale: zhCN, save: () => save(form[field]) }),
  }), { attachTo: document.body, global: { plugins: [Antd], components: { UiDatePicker: loadComponent('app/components/ui/DatePicker.vue') } } })
  cleanups.push(() => wrapper.unmount())
  await flushVue()
  const input = document.querySelector<HTMLInputElement>('.ant-modal .ant-picker input')!
  return { form, field, input, save }
}

it.each(otherTargets)('%s 同挂载手打后保存写入模型', async (...target) => {
  const { form, field, input, save } = await otherModal(target)
  await typeDate(input, '2026-11-05')
  await clickSave()
  expect(form[field]).toBe('2026-11-05')
  expect(save).toHaveBeenCalledWith('2026-11-05')
})

it.each(otherTargets)('%s 同挂载日历点选后保存写入模型', async (...target) => {
  const { form, field, input, save } = await otherModal(target)
  const value = await pickDate(input)
  await clickSave()
  expect(form[field]).toBe(value)
  expect(save).toHaveBeenCalledWith(value)
})

async function sharedModal(options: { value?: string; disabledDate?: (date: dayjs.Dayjs) => boolean; allowClear?: boolean } = {}) {
  const form = reactive({ needDate: options.value as string | null | undefined })
  const save = vi.fn()
  const component = loadComponent('app/components/ui/DatePicker.vue')
  const wrapper = mount(defineComponent({
    setup: () => () => h(ConfigProvider, { locale: zhCN }, { default: () => h(Modal, { open: true, onOk: () => save(form.needDate) }, {
      default: () => h(component, { value: form.needDate, disabledDate: options.disabledDate, allowClear: options.allowClear, 'onUpdate:value': (value: string | null) => { form.needDate = value } }),
    }) }),
  }), { attachTo: document.body, global: { plugins: [Antd] } })
  cleanups.push(() => wrapper.unmount())
  await flushVue()
  return { form, input: document.querySelector<HTMLInputElement>('.ant-picker input')!, save }
}

it.each(['blur', 'enter', 'save'])('残缺输入经 %s 恢复原值，后续合法日期仍可回车提交', async finish => {
  const { form, input } = await sharedModal({ value: '2026-11-01' })
  await typeDate(input, '2026-11-05')
  input.value = '2026-11-0'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushVue()
  if (finish === 'blur') input.blur()
  else if (finish === 'enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  else await clickSave()
  await flushVue()
  expect(form.needDate).toBe('2026-11-01')
  expect(input.value).toBe('2026-11-01')
  await typeDate(input, '2026-11-06')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  await flushVue()
  expect(form.needDate).toBe('2026-11-06')
})

it('Escape 放弃手打值并关闭面板，之后仍可日历点选', async () => {
  const { form, input } = await sharedModal({ value: '2026-11-01' })
  await typeDate(input, '2026-11-05')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }))
  await flushVue()
  expect(form.needDate).toBe('2026-11-01')
  expect(input.value).toBe('2026-11-01')
  const value = await pickDate(input)
  expect(form.needDate).toBe(value)
})

it('禁选日期手打也不能提交，合法日期仍可保存', async () => {
  const { form, input, save } = await sharedModal({ value: '2026-11-01', disabledDate: date => date.format('YYYY-MM-DD') === '2026-11-05' })
  await typeDate(input, '2026-11-05')
  await clickSave()
  expect(form.needDate).toBe('2026-11-01')
  expect(input.value).toBe('2026-11-01')
  await typeDate(input, '2026-11-06')
  await clickSave()
  expect(save).toHaveBeenLastCalledWith('2026-11-06')
})

it('清空按钮仍写入空值并关闭面板', async () => {
  const { form, input } = await sharedModal({ value: '2026-11-01' })
  await typeDate(input, '2026-11-05')
  const clear = document.querySelector<HTMLElement>('.ant-picker-clear')!
  clear.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  clear.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  await flushVue()
  expect(form.needDate).toBeNull()
  expect(input.value).toBe('')
})

it('allow-clear=false 继续隐藏清空按钮', async () => {
  await sharedModal({ value: '2026-11-01', allowClear: false })
  expect(document.querySelector('.ant-picker-clear')).toBeNull()
})

it('采购计划编辑明细手打日期提交 PATCH', async () => {
  const { state } = await actualModal(targets[0])
  state.editItem({ id: 'item', materialName: '减速机', quantity: 1, needDate: '2026-11-01', sortOrder: 0 })
  await flushVue()
  const input = document.querySelector<HTMLInputElement>('.ant-modal .ant-picker input')!
  await typeDate(input, '2026-11-05')
  await clickSave()
  expect($fetch).toHaveBeenCalledWith('/api/purchase-plans/plan/items/item', expect.objectContaining({ method: 'PATCH', body: expect.objectContaining({ needDate: '2026-11-05' }) }))
})

it.each(['blur', 'enter', 'save'])('初始空值输入残缺日期后 %s 恢复为空', async finish => {
  const { form, input } = await sharedModal()
  await typeDate(input, '2026-11-05')
  input.value = '2026-11-0'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushVue()
  if (finish === 'blur') input.blur()
  else if (finish === 'enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  else await clickSave()
  await flushVue()
  expect(form.needDate).toBeUndefined()
  expect(input.value).toBe('')
})

it('非法手打值不妨碍直接点选日历', async () => {
  const { form, input } = await sharedModal({ value: '2026-11-01' })
  await typeDate(input, '2026-02-30')
  const value = await pickDate(input)
  expect(form.needDate).toBe(value)
  expect(input.value).toBe(value)
})

it.each(['2026-1-5', '2026/11/05', '2026-11-05 extra', ''])('严格日期格式：%s 恢复原值', async text => {
  const { form, input } = await sharedModal({ value: '2026-11-01' })
  await typeDate(input, text)
  await clickSave()
  expect(form.needDate).toBe('2026-11-01')
  expect(input.value).toBe('2026-11-01')
})
