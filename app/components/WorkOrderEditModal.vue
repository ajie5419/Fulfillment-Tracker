<script setup lang="ts">
const requestFetch = useRequestFetch()
/**
 * 新建 / 编辑工单（履约新建工单 10-27：工单由履约维护，保存时实际写入 QMS 工单库）。项目总览"新建工单"、工单详情"编辑工单"共用。
 *   工单号（新建必填，编辑只读）、客户（QMS 客户字典现取，必选）、项目名称、事业部（本地已同步的 QMS 部门，可空）、数量（≥1）、交期、
 *   状态（仅编辑：未开工 / 进行中 / 已完工；取消走详情页"取消工单"）、项目经理、产品线、是否试点（后三项存履约 work_order_ext）。
 * 新建时项目经理默认填当前登录用户；只看自己负责工单的人（me.limited）改成别人或清空时，提交前确认"建好后你将看不到这张工单"。
 * 编辑时只提交改过的字段；只改了项目经理 / 产品线 / 是否试点时后端不调 QMS。保存失败把后端的中文提示原样显示（QMS 连不上、版本冲突等）。
 */
import { WO_STATUS_TEXT } from '#shared/status'
import { defaultProjectManager, losesSightAfterCreate } from '#shared/work-order-form'
import type { WorkOrderSaveResult } from '#shared/work-order-save'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function extractStatusCode(error: unknown): number | undefined {
  const source = asRecord(error)
  const data = asRecord(source?.data)
  const response = asRecord(source?.response)
  const candidates = [source?.statusCode, source?.status, response?.status, data?.statusCode]
  for (const candidate of candidates) {
    if (typeof candidate === 'number') return candidate
  }
  return undefined
}

function extractOperationId(error: unknown): string | undefined {
  const source = asRecord(error)
  const data = asRecord(source?.data)
  const nestedData = asRecord(data?.data)
  const candidate = nestedData?.operationId ?? data?.operationId ?? source?.operationId
  if (typeof candidate === 'string' && candidate) return candidate
  if (source?.cause) return extractOperationId(source.cause)
  return undefined
}

export interface WorkOrderEditing {
  workOrderNumber: string
  customerName: string
  projectName: string | null
  division: string | null
  quantity: number
  /** 'YYYY-MM-DD' */
  deliveryDate: string
  status: string
  edit: {
    customerNameId: string | null
    divisionId: string | null
    version: number | null
    projectManagerId: string | null
    productLine: string | null
    isPilot: boolean
  }
}

const props = defineProps<{ open: boolean; workOrder: WorkOrderEditing | null }>()
const emit = defineEmits<{ close: []; done: [workOrderNumber: string] }>()

const editing = computed(() => !!props.workOrder)
const STATUS_OPTIONS = (['OPEN', 'IN_PROGRESS', 'COMPLETED'] as const).map((v) => ({ value: v, label: WO_STATUS_TEXT[v] }))

const empty = () => ({
  workOrderNumber: '',
  customerNameId: undefined as string | undefined,
  projectName: '',
  divisionId: undefined as string | undefined,
  quantity: 1 as number | undefined,
  deliveryDate: undefined as string | undefined,
  status: 'OPEN' as string,
  projectManagerId: undefined as string | undefined,
  productLine: '',
  isPilot: false,
})
const form = reactive(empty())
const saving = ref(false)
const submitError = ref<string | null>(null)
interface PendingRecovery {
  operationId: string
  message: string
}
const pendingRecovery = ref<PendingRecovery | null>(null)
const retrying = ref(false)
const idempotencyKey = ref('')

// 下拉：客户现取 QMS（打开弹窗时取），事业部取本地部门表，项目经理取 QMS 用户副本
const customers = ref<{ id: string; name: string }[]>([])
const customersError = ref<string | null>(null)
const customersLoading = ref(false)
async function loadCustomers() {
  customersLoading.value = true
  customersError.value = null
  try {
    customers.value = await requestFetch<{ id: string; name: string }[]>('/api/work-orders/customers')
  } catch (e) {
    customersError.value = apiError(e)
  } finally {
    customersLoading.value = false
  }
}
const { data: divisions, error: divisionsError, refresh: refreshDivisions } = await useFetch<{ id: string; name: string; parentName: string | null }[]>('/api/work-orders/divisions', {
  default: () => [],
  immediate: false,
  watch: false,
})
const { data: master, error: masterError, refresh: refreshMaster } = await useMaster()
const { data: me } = await useMe()

watch(
  () => props.open,
  (open) => {
    if (!open) return
    submitError.value = null
    pendingRecovery.value = null
    idempotencyKey.value = crypto.randomUUID()
    const w = props.workOrder
    Object.assign(
      form,
      w
        ? {
            workOrderNumber: w.workOrderNumber,
            customerNameId: w.edit.customerNameId ?? undefined,
            projectName: w.projectName ?? '',
            divisionId: w.edit.divisionId ?? undefined,
            quantity: w.quantity,
            deliveryDate: w.deliveryDate,
            status: w.status,
            projectManagerId: w.edit.projectManagerId ?? undefined,
            productLine: w.edit.productLine ?? '',
            isPilot: w.edit.isPilot,
          }
        : { ...empty(), projectManagerId: defaultProjectManager(me.value) },
    )
    void loadCustomers()
    void refreshDivisions()
  },
  { immediate: true },
)

const customerOptions = computed(() => customers.value.map((c) => ({ value: c.id, label: c.name })))
const divisionOptions = computed(() => divisions.value.map((d) => ({ value: d.id, label: d.parentName ? `${d.name}（${d.parentName}）` : d.name })))
/** 项目部的人排前面 */
const pmOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === 'PROJECT') - Number(a.businessDept === 'PROJECT'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)
/** 编辑时客户 ID 还没同步到（旧 QMS）：提示当前客户名，不选就不改 */
const customerHint = computed(() => (editing.value && !props.workOrder?.edit.customerNameId ? `当前客户：${props.workOrder?.customerName}（不选则不改）` : ''))
const noVersion = computed(() => editing.value && props.workOrder?.edit.version == null)
/** 要写进 QMS 的字段（其余三项只存履约，改它们不需要版本号） */
const QMS_FIELDS = ['customerNameId', 'projectName', 'divisionId', 'quantity', 'deliveryDate', 'status']

/** 编辑时只提交改过的字段 */
function changedBody(w: WorkOrderEditing) {
  const body: Record<string, unknown> = {}
  const put = (k: string, now: unknown, was: unknown) => {
    if (now !== was) body[k] = now
  }
  if (form.customerNameId) put('customerNameId', form.customerNameId, w.edit.customerNameId)
  put('projectName', form.projectName.trim() || null, w.projectName || null)
  put('divisionId', form.divisionId ?? null, w.edit.divisionId)
  put('quantity', form.quantity, w.quantity)
  put('deliveryDate', form.deliveryDate, w.deliveryDate)
  put('status', form.status, w.status)
  put('projectManagerId', form.projectManagerId ?? null, w.edit.projectManagerId)
  put('productLine', form.productLine.trim() || null, w.edit.productLine || null)
  put('isPilot', form.isPilot, w.edit.isPilot)
  return body
}

/** 只看自己负责工单的人把项目经理改成别人或清空：建好后看不到，先确认 */
function confirmLoseSight() {
  return new Promise<boolean>((resolve) =>
    Modal.confirm({
      title: '建好后你将看不到这张工单',
      content: '你只能看自己负责的工单。项目经理不是你时，建好后这张工单不会出现在你的列表里，也打不开详情。确定这样建吗？',
      okText: '仍然新建',
      cancelText: '回去改',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  )
}

async function submit() {
  submitError.value = null
  if (!editing.value && !form.workOrderNumber.trim()) return message.warning('请填写工单号')
  if (!editing.value && !form.customerNameId) return message.warning('请选择客户')
  if (!form.quantity || form.quantity < 1 || !Number.isInteger(form.quantity)) return message.warning('数量要是不小于 1 的整数')
  if (!form.deliveryDate) return message.warning('请选择交期')
  saving.value = true
  try {
    const w = props.workOrder
    if (w) {
      const body = changedBody(w)
      if (!Object.keys(body).length) {
        message.info('没有改动')
        emit('close')
        return
      }
      if (Object.keys(body).some((k) => QMS_FIELDS.includes(k))) {
        if (noVersion.value) {
          submitError.value = '本地还没有同步到这个工单的版本号，暂时只能改项目经理、产品线、是否试点'
          return
        }
        // 乐观锁：带打开弹窗时看到的版本号，别人在这期间改过 QMS 返回 409
        body.version = w.edit.version
      }
      body.idempotencyKey = idempotencyKey.value
      const r = await $fetch<WorkOrderSaveResult>(`/api/work-orders/${encodeURIComponent(w.workOrderNumber)}`, { method: 'PUT', body })
      if (r.recovery?.status === 'PENDING') {
        pendingRecovery.value = {
          operationId: r.recovery.operationId,
          message: r.recovery.message,
        }
        return
      }
      pendingRecovery.value = null
      message.success('已保存，QMS 工单已同步修改')
      emit('done', w.workOrderNumber)
    } else {
      if (losesSightAfterCreate(me.value, form.projectManagerId) && !(await confirmLoseSight())) return
      const r = await $fetch<WorkOrderSaveResult>('/api/work-orders', {
        method: 'POST',
        body: {
          idempotencyKey: idempotencyKey.value,
          workOrderNumber: form.workOrderNumber.trim(),
          customerNameId: form.customerNameId,
          projectName: form.projectName.trim() || null,
          divisionId: form.divisionId ?? null,
          quantity: form.quantity,
          deliveryDate: form.deliveryDate,
          projectManagerId: form.projectManagerId ?? null,
          productLine: form.productLine.trim() || null,
          isPilot: form.isPilot,
        },
      })
      if (r.recovery?.status === 'PENDING') {
        pendingRecovery.value = {
          operationId: r.recovery.operationId,
          message: r.recovery.message,
        }
        return
      }
      pendingRecovery.value = null
      message.success('工单已建好，已写入 QMS')
      emit('done', r.workOrderNumber)
    }
  } catch (e) {
    const status = extractStatusCode(e)
    const opId = extractOperationId(e)
    if (status === 409 && opId) {
      pendingRecovery.value = {
        operationId: opId,
        message: apiError(e),
      }
    } else {
      if (status !== undefined) {
        idempotencyKey.value = crypto.randomUUID()
      }
      // 不吞错误：弹窗里留一条，同时弹提示
      submitError.value = apiError(e)
      message.error(submitError.value)
    }
  } finally {
    saving.value = false
  }
}

async function retryRecovery() {
  if (!pendingRecovery.value) return
  retrying.value = true
  submitError.value = null
  try {
    const opId = pendingRecovery.value.operationId
    const res = await $fetch<WorkOrderSaveResult>(`/api/settings/work-order-saves/${encodeURIComponent(opId)}/retry`, {
      method: 'POST',
    })
    if (res.recovery?.status === 'PENDING') {
      pendingRecovery.value = {
        operationId: res.recovery.operationId,
        message: res.recovery.message,
      }
      return
    }
    pendingRecovery.value = null
    const no = res.workOrderNumber || props.workOrder?.workOrderNumber || form.workOrderNumber.trim()
    if (editing.value) {
      message.success('已保存，QMS 工单已同步修改')
    } else {
      message.success('工单已建好，已写入 QMS')
    }
    emit('done', no)
  } catch (e) {
    submitError.value = apiError(e)
    message.error(submitError.value)
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="editing ? `编辑工单 ${workOrder?.workOrderNumber}` : '新建工单'"
    ok-text="保存"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: retrying }"
    width="640px"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="hint">保存后直接写入 QMS 工单库，QMS 里看到的就是这里填的。</p>
    <a-alert v-if="noVersion" type="warning" show-icon class="alert" message="本地还没有同步到这个工单的版本号，暂时只能改项目经理、产品线、是否试点" description="新版 QMS 上线后下一轮同步（约 5 分钟）会补上版本号，到时刷新页面就能改其他字段。" />
    <a-alert
      v-if="pendingRecovery"
      type="warning"
      show-icon
      class="alert"
      :message="pendingRecovery.message"
    >
      <template #description>
        <div class="recovery-desc">
          <div>本地待恢复的扩展信息：项目经理、产品线、是否试点三项。</div>
          <div class="recovery-op">操作编号：<span class="op-id">{{ pendingRecovery.operationId }}</span></div>
          <div class="recovery-action">
            <a-button
              v-if="me?.isAdmin"
              size="small"
              type="primary"
              :loading="retrying"
              :disabled="saving"
              @click="retryRecovery"
            >
              重试恢复
            </a-button>
            <span v-else class="recovery-admin-tip">请管理员重试恢复</span>
          </div>
        </div>
      </template>
    </a-alert>
    <a-alert v-if="submitError" type="error" show-icon class="alert" :message="submitError" />
    <a-form layout="horizontal" :label-col="{ span: 5 }" :wrapper-col="{ span: 18 }">
      <a-form-item label="工单号" :required="!editing">
        <a-input v-model:value="form.workOrderNumber" :disabled="editing" :maxlength="64" placeholder="与合同 / ERP 一致，建好后不能改" />
      </a-form-item>
      <a-form-item label="客户" :required="!editing">
        <a-select
          v-model:value="form.customerNameId"
          show-search
          option-filter-prop="label"
          :loading="customersLoading"
          :options="customerOptions"
          placeholder="选 QMS 客户字典里的客户"
          :not-found-content="customersLoading ? '加载中…' : '没有客户'"
        />
        <div v-if="customersError" class="field-error">客户列表加载失败：{{ customersError }} <a @click="loadCustomers">重试</a></div>
        <div v-else-if="customerHint" class="muted">{{ customerHint }}</div>
      </a-form-item>
      <a-form-item label="项目名称"><a-input v-model:value="form.projectName" :maxlength="191" /></a-form-item>
      <a-form-item label="事业部">
        <a-select v-model:value="form.divisionId" allow-clear show-search option-filter-prop="label" :options="divisionOptions" placeholder="可空" />
        <div v-if="divisionsError" class="field-error">事业部列表加载失败：{{ apiError(divisionsError) }} <a @click="refreshDivisions()">重试</a></div>
        <div v-else-if="editing && workOrder?.division && !workOrder.edit.divisionId" class="muted">当前事业部：{{ workOrder.division }}</div>
      </a-form-item>
      <a-form-item label="数量" required>
        <a-input-number v-model:value="form.quantity" :min="1" :max="1000000" :precision="0" style="width: 140px" />
      </a-form-item>
      <a-form-item label="交期" required><UiDatePicker v-model:value="form.deliveryDate" /></a-form-item>
      <a-form-item v-if="editing" label="状态">
        <a-segmented v-model:value="form.status" :options="STATUS_OPTIONS" />
      </a-form-item>
      <a-form-item label="项目经理">
        <a-select v-model:value="form.projectManagerId" allow-clear show-search option-filter-prop="label" :options="pmOptions" placeholder="可空，之后也能改" />
        <div v-if="masterError" class="field-error">人员列表加载失败：{{ apiError(masterError) }} <a @click="refreshMaster()">重试</a></div>
      </a-form-item>
      <a-form-item label="产品线"><a-input v-model:value="form.productLine" :maxlength="191" placeholder="可空" /></a-form-item>
      <a-form-item label="是否试点"><a-switch v-model:checked="form.isPilot" checked-children="是" un-checked-children="否" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.hint { margin: 0 0 12px; font-size: 13px; color: var(--ft-text-2); }
.alert { margin-bottom: 12px; }
.muted { font-size: 12px; color: var(--ft-text-2); margin-top: 4px; }
.field-error { font-size: 12px; color: var(--ft-late-text); margin-top: 4px; }
.recovery-desc { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; font-size: 13px; }
.recovery-op { font-size: 12px; color: var(--ft-text-2); }
.op-id { user-select: all; font-family: monospace; }
.recovery-action { margin-top: 2px; }
.recovery-admin-tip { font-size: 12px; color: var(--ft-text-2); }
</style>
