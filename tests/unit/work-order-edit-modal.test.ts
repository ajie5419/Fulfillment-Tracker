// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import * as status from '../../shared/status'
import * as workOrderForm from '../../shared/work-order-form'
import * as workOrderSave from '../../shared/work-order-save'
import { loadComponent } from '../helpers/vue-component'
import { mountScript, flushVue } from '../helpers/vue-script'

const cleanups: (() => void)[] = []
const message = { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }
const fetchApi = vi.fn()
const me = Vue.ref({ id: 'u-admin', name: '管理员', isAdmin: true, can: { workOrder: true }, limited: false })

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of ['ref', 'reactive', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) {
    vi.stubGlobal(name, Vue[name])
  }
  vi.stubGlobal('useRequestFetch', () => fetchApi)
  vi.stubGlobal('$fetch', fetchApi)
  vi.stubGlobal('message', message)
  vi.stubGlobal('apiError', (e: unknown) => {
    if (typeof e === 'string') return e
    if (e && typeof e === 'object') {
      const data = (e as { data?: { message?: string } }).data
      if (data?.message) return data.message
      const msg = (e as { message?: string }).message
      if (msg) return msg
    }
    return '操作失败'
  })
  vi.stubGlobal('useFetch', async (url: string) => {
    if (url === '/api/work-orders/divisions') {
      return { data: Vue.ref([{ id: 'd-1', name: '事业部1', parentName: null }]), error: Vue.ref(null), refresh: vi.fn() }
    }
    return { data: Vue.ref([]), error: Vue.ref(null), refresh: vi.fn() }
  })
  vi.stubGlobal('useMaster', async () => ({
    data: Vue.ref({ users: [{ id: 'u-1', name: '张三', department: '项目部', businessDept: 'PROJECT' }] }),
    error: Vue.ref(null),
    refresh: vi.fn(),
  }))
  vi.stubGlobal('useMe', async () => ({ data: me }))
  vi.stubGlobal('Modal', { confirm: vi.fn().mockImplementation(({ onOk }) => onOk()) })
  me.value = { id: 'u-admin', name: '管理员', isAdmin: true, can: { workOrder: true }, limited: false }
  fetchApi.mockReset().mockResolvedValue([])
})

afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

const modules = {
  '#shared/status': status,
  '#shared/work-order-form': workOrderForm,
  '#shared/work-order-save': workOrderSave,
}

describe('WorkOrderEditModal 状态分支与结构测试', () => {
  it('生成并保持稳定的 idempotencyKey，关闭重开后重新生成', async () => {
    const { state, props } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    const firstKey = state.idempotencyKey
    expect(firstKey).toBeTruthy()
    expect(typeof firstKey).toBe('string')

    // 同一编辑会话多次检查，key 保持不变
    await flushVue()
    expect(state.idempotencyKey).toBe(firstKey)

    // 关闭弹窗
    props.open = false
    await flushVue()

    // 重新打开弹窗，key 重新生成
    props.open = true
    await flushVue()
    const secondKey = state.idempotencyKey
    expect(secondKey).toBeTruthy()
    expect(secondKey).not.toBe(firstKey)
  })

  it('普通保存成功（200 且无 recovery）：保持原样提示与 emit done（新建与编辑）', async () => {
    // 新建普通成功
    const create = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    create.state.form.workOrderNumber = 'WO-SUCCESS-CREATE'
    create.state.form.customerNameId = 'c-1'
    create.state.form.quantity = 10
    create.state.form.deliveryDate = '2026-12-01'

    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-SUCCESS-CREATE',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
    })

    await create.state.submit()
    await flushVue()

    expect(message.success).toHaveBeenCalledWith('工单已建好，已写入 QMS')
    expect(create.events).toEqual([['WO-SUCCESS-CREATE']])
    expect(create.state.pendingRecovery).toBeNull()

    // 编辑普通成功
    const existingWo = {
      workOrderNumber: 'WO-SUCCESS-EDIT',
      customerName: '客户',
      projectName: null,
      division: null,
      quantity: 5,
      deliveryDate: '2026-11-20',
      status: 'OPEN',
      edit: {
        customerNameId: 'c-old',
        divisionId: null,
        version: 1,
        projectManagerId: null,
        productLine: null,
        isPilot: false,
      },
    }
    const edit = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: existingWo }, modules)
    cleanups.push(() => {})

    edit.state.form.quantity = 6
    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-SUCCESS-EDIT',
      status: 'OPEN',
      version: 2,
      updatedAt: new Date().toISOString(),
    })

    await edit.state.submit()
    await flushVue()

    expect(message.success).toHaveBeenCalledWith('已保存，QMS 工单已同步修改')
    expect(edit.events).toEqual([['WO-SUCCESS-EDIT']])
    expect(edit.state.pendingRecovery).toBeNull()
  })

  it('202 + recovery（新建）：不弹成功提示、不 emit done、展示待恢复警告与 operationId，saving 复位', async () => {
    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    state.form.workOrderNumber = 'WO-TEST-202'
    state.form.customerNameId = 'c-1'
    state.form.quantity = 10
    state.form.deliveryDate = '2026-12-01'

    const recoveryMsg = 'QMS 已保存成功，本地扩展信息待恢复；请勿重复新建，请管理员重试恢复'
    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-TEST-202',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
      recovery: {
        status: 'PENDING',
        operationId: 'op-recovery-202',
        message: recoveryMsg,
      },
    })

    await state.submit()
    await flushVue()

    expect(fetchApi).toHaveBeenCalledWith('/api/work-orders', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        idempotencyKey: state.idempotencyKey,
        workOrderNumber: 'WO-TEST-202',
      }),
    }))

    expect(message.success).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)

    expect(state.saving).toBe(false)
    expect(state.pendingRecovery).toEqual({
      operationId: 'op-recovery-202',
      message: recoveryMsg,
    })
  })

  it('202 + recovery（编辑）：PUT body 带 idempotencyKey 与 version，不 emit done，展示待恢复警告', async () => {
    const existingWo = {
      workOrderNumber: 'WO-EDIT-202',
      customerName: '现有客户',
      projectName: '老项目',
      division: '事业部1',
      quantity: 5,
      deliveryDate: '2026-11-20',
      status: 'OPEN',
      edit: {
        customerNameId: 'c-old',
        divisionId: 'd-1',
        version: 3,
        projectManagerId: 'u-1',
        productLine: 'Line1',
        isPilot: false,
      },
    }

    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: existingWo }, modules)
    cleanups.push(() => {})

    state.form.quantity = 8

    const recoveryMsg = 'QMS 已保存成功，本地扩展信息待恢复；请勿重复新建，请管理员重试恢复'
    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-EDIT-202',
      status: 'OPEN',
      version: 4,
      updatedAt: new Date().toISOString(),
      recovery: {
        status: 'PENDING',
        operationId: 'op-edit-202',
        message: recoveryMsg,
      },
    })

    await state.submit()
    await flushVue()

    expect(fetchApi).toHaveBeenCalledWith('/api/work-orders/WO-EDIT-202', expect.objectContaining({
      method: 'PUT',
      body: expect.objectContaining({
        version: 3,
        quantity: 8,
        idempotencyKey: state.idempotencyKey,
      }),
    }))

    expect(message.success).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
    expect(state.saving).toBe(false)
    expect(state.pendingRecovery).toEqual({
      operationId: 'op-edit-202',
      message: recoveryMsg,
    })
  })

  it('409 且带 operationId：渲染与 202 同款警告区，不走普通错误提示', async () => {
    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    state.form.workOrderNumber = 'WO-CONFLICT'
    state.form.customerNameId = 'c-1'
    state.form.quantity = 10
    state.form.deliveryDate = '2026-12-01'

    const conflictErr = {
      statusCode: 409,
      data: {
        statusCode: 409,
        message: '该工单存在待恢复保存，请管理员先恢复后再提交新操作',
        data: {
          code: 'CONFLICT',
          operationId: 'op-conflict-409',
        },
      },
    }
    fetchApi.mockRejectedValueOnce(conflictErr)

    await state.submit()
    await flushVue()

    expect(events).toHaveLength(0)
    expect(message.error).not.toHaveBeenCalled()
    expect(state.submitError).toBeNull()
    expect(state.saving).toBe(false)
    expect(state.pendingRecovery).toEqual({
      operationId: 'op-conflict-409',
      message: '该工单存在待恢复保存，请管理员先恢复后再提交新操作',
    })
  })

  it('普通 409（无 operationId 的版本冲突）与普通错误：保持原样 submitError + message.error', async () => {
    const existingWo = {
      workOrderNumber: 'WO-VER-CONFLICT',
      customerName: '现有客户',
      projectName: null,
      division: null,
      quantity: 5,
      deliveryDate: '2026-11-20',
      status: 'OPEN',
      edit: {
        customerNameId: 'c-old',
        divisionId: null,
        version: 2,
        projectManagerId: null,
        productLine: null,
        isPilot: false,
      },
    }

    const { state } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: existingWo }, modules)
    cleanups.push(() => {})

    state.form.quantity = 9
    fetchApi.mockRejectedValueOnce({
      statusCode: 409,
      data: {
        message: '工单已被别人修改，请刷新后再改',
        code: 'CONFLICT',
      },
    })

    await state.submit()
    await flushVue()

    expect(state.pendingRecovery).toBeNull()
    expect(state.submitError).toBe('工单已被别人修改，请刷新后再改')
    expect(message.error).toHaveBeenCalledWith('工单已被别人修改，请刷新后再改')
  })

  it('管理员重试成功（200）：弹普通成功提示，emit done，清除警告区', async () => {
    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    state.pendingRecovery = {
      operationId: 'op-retry-1',
      message: '待恢复保存',
    }

    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-RECOVERED',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
    })

    await state.retryRecovery()
    await flushVue()

    expect(fetchApi).toHaveBeenCalledWith('/api/settings/work-order-saves/op-retry-1/retry', expect.objectContaining({
      method: 'POST',
    }))
    expect(message.success).toHaveBeenCalledWith('工单已建好，已写入 QMS')
    expect(events).toEqual([['WO-RECOVERED']])
    expect(state.pendingRecovery).toBeNull()
    expect(state.retrying).toBe(false)
  })

  it('管理员重试仍返回 202：保持警告区并更新 operationId/message，不 emit done', async () => {
    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    state.pendingRecovery = {
      operationId: 'op-retry-initial',
      message: '首次待恢复',
    }

    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-RETRY-202',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
      recovery: {
        status: 'PENDING',
        operationId: 'op-retry-updated',
        message: '重试后仍待恢复',
      },
    })

    await state.retryRecovery()
    await flushVue()

    expect(events).toHaveLength(0)
    expect(message.success).not.toHaveBeenCalled()
    expect(state.pendingRecovery).toEqual({
      operationId: 'op-retry-updated',
      message: '重试后仍待恢复',
    })
    expect(state.retrying).toBe(false)
  })

  it('管理员重试失败：把错误放在 submitError（警告区下方），保持 pendingRecovery，不 emit done', async () => {
    const { state, events } = await mountScript('app/components/WorkOrderEditModal.vue', { open: true, workOrder: null }, modules)
    cleanups.push(() => {})

    state.pendingRecovery = {
      operationId: 'op-retry-fail',
      message: '待恢复保存',
    }

    fetchApi.mockRejectedValueOnce(new Error('QMS 连不上，请稍后再试'))

    await state.retryRecovery()
    await flushVue()

    expect(events).toHaveLength(0)
    expect(state.submitError).toBe('QMS 连不上，请稍后再试')
    expect(message.error).toHaveBeenCalledWith('QMS 连不上，请稍后再试')
    expect(state.pendingRecovery).toEqual({
      operationId: 'op-retry-fail',
      message: '待恢复保存',
    })
    expect(state.retrying).toBe(false)
  })

  it('渲染测试：非管理员只展示警告与 operationId 及文案「请管理员重试恢复」，不渲染重试按钮', async () => {
    me.value = { id: 'u-user', name: '普通用户', isAdmin: false, can: { workOrder: true }, limited: false }

    const alertStub = Vue.defineComponent({
      props: ['type', 'message'],
      setup: (props, { slots }) => () => Vue.h('div', { class: `ant-alert ant-alert-${props.type}` }, [
        Vue.h('div', { class: 'ant-alert-message' }, props.message),
        Vue.h('div', { class: 'ant-alert-description' }, slots.description?.()),
      ]),
    })
    const modalStub = Vue.defineComponent({
      props: ['open'],
      setup: (props, { slots }) => () => props.open ? Vue.h('div', { class: 'ant-modal' }, slots.default?.()) : null,
    })
    const buttonStub = Vue.defineComponent({
      props: ['loading', 'disabled'],
      setup: (props, { slots }) => () => Vue.h('button', { class: 'ant-btn', disabled: props.disabled }, slots.default?.()),
    })

    const component = loadComponent('app/components/WorkOrderEditModal.vue', modules)
    const origSetup = component.setup!
    let capturedState: any = null
    component.setup = (props, ctx) => {
      const res = origSetup(props, ctx)
      return res instanceof Promise ? res.then((v) => { capturedState = v; return v }) : (capturedState = res, res)
    }

    const root = Vue.defineComponent({
      setup: () => () => Vue.h(Vue.Suspense, null, {
        default: () => Vue.h(component, { open: true, workOrder: null }),
      }),
    })

    const wrapper = mount(root, {
      global: {
        stubs: {
          AModal: modalStub,
          AAlert: alertStub,
          AButton: buttonStub,
          AForm: true,
          AFormItem: true,
          AInput: true,
          AInputNumber: true,
          ASelect: true,
          ASegmented: true,
          ASwitch: true,
          UiDatePicker: true,
        },
      },
    })
    cleanups.push(() => wrapper.unmount())
    await flushPromises()

    // 触发 202
    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-NON-ADMIN',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
      recovery: {
        status: 'PENDING',
        operationId: 'op-non-admin-123',
        message: 'QMS 已保存成功，本地扩展信息待恢复；请勿重复新建，请管理员重试恢复',
      },
    })

    capturedState.form.workOrderNumber = 'WO-NON-ADMIN'
    capturedState.form.customerNameId = 'c-1'
    capturedState.form.quantity = 1
    capturedState.form.deliveryDate = '2026-12-01'

    await capturedState.submit()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('QMS 已保存成功，本地扩展信息待恢复')
    expect(text).toContain('本地待恢复的扩展信息：项目经理、产品线、是否试点三项')
    expect(text).toContain('op-non-admin-123')
    expect(wrapper.find('.recovery-admin-tip').exists()).toBe(true)
    expect(wrapper.find('.recovery-admin-tip').text()).toBe('请管理员重试恢复')
    // 非管理员不渲染重试按钮
    expect(wrapper.find('button.ant-btn').exists()).toBe(false)
  })

  it('渲染测试：管理员展示警告、operationId 与「重试恢复」按钮', async () => {
    me.value = { id: 'u-admin', name: '管理员', isAdmin: true, can: { workOrder: true }, limited: false }

    const alertStub = Vue.defineComponent({
      props: ['type', 'message'],
      setup: (props, { slots }) => () => Vue.h('div', { class: `ant-alert ant-alert-${props.type}` }, [
        Vue.h('div', { class: 'ant-alert-message' }, props.message),
        Vue.h('div', { class: 'ant-alert-description' }, slots.description?.()),
      ]),
    })
    const modalStub = Vue.defineComponent({
      props: ['open'],
      setup: (props, { slots }) => () => props.open ? Vue.h('div', { class: 'ant-modal' }, slots.default?.()) : null,
    })
    const buttonStub = Vue.defineComponent({
      props: ['loading', 'disabled'],
      setup: (props, { slots }) => () => Vue.h('button', { class: 'ant-btn' }, slots.default?.()),
    })

    const component = loadComponent('app/components/WorkOrderEditModal.vue', modules)
    const origSetup = component.setup!
    let capturedState: any = null
    component.setup = (props, ctx) => {
      const res = origSetup(props, ctx)
      return res instanceof Promise ? res.then((v) => { capturedState = v; return v }) : (capturedState = res, res)
    }

    const root = Vue.defineComponent({
      setup: () => () => Vue.h(Vue.Suspense, null, {
        default: () => Vue.h(component, { open: true, workOrder: null }),
      }),
    })

    const wrapper = mount(root, {
      global: {
        stubs: {
          AModal: modalStub,
          AAlert: alertStub,
          AButton: buttonStub,
          AForm: true,
          AFormItem: true,
          AInput: true,
          AInputNumber: true,
          ASelect: true,
          ASegmented: true,
          ASwitch: true,
          UiDatePicker: true,
        },
      },
    })
    cleanups.push(() => wrapper.unmount())
    await flushPromises()

    fetchApi.mockResolvedValueOnce({
      workOrderNumber: 'WO-ADMIN',
      status: 'OPEN',
      version: 1,
      updatedAt: new Date().toISOString(),
      recovery: {
        status: 'PENDING',
        operationId: 'op-admin-456',
        message: 'QMS 已保存成功，本地扩展信息待恢复；请勿重复新建，请管理员重试恢复',
      },
    })

    capturedState.form.workOrderNumber = 'WO-ADMIN'
    capturedState.form.customerNameId = 'c-1'
    capturedState.form.quantity = 1
    capturedState.form.deliveryDate = '2026-12-01'

    await capturedState.submit()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('op-admin-456')
    expect(wrapper.find('.recovery-admin-tip').exists()).toBe(false)
    const retryBtn = wrapper.find('button.ant-btn')
    expect(retryBtn.exists()).toBe(true)
    expect(retryBtn.text()).toContain('重试恢复')
  })
})
