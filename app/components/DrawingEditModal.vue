<script setup lang="ts">
import { isPlanStartLate } from '#shared/plan-validation'
/**
 * Edit task assignment, planned dates and optional links. Completion, customer
 * confirmation and cancellation are separate list actions; saving never changes cancellation.
 * presetNode：从工单详情"总计划"页签的节点"分解"打开时传入，新建时预选所属节点，日期默认取节点计划日。
 */
const props = defineProps<{ open: boolean; task: DrawingRow | null; workOrderNumber?: string; presetNode?: { id: string; planDate: string } | null }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders, error: ordersError, refresh: refreshOrders } = await useWorkOrders()
const { data: master, error: masterError, refresh: refreshMaster } = await useMaster()

const empty = () => ({
  workOrderNumber: undefined as string | undefined,
  componentName: '',
  ownerId: undefined as string | undefined,
  planDate: undefined as string | undefined,
  startDate: undefined as string | undefined,
  planNodeId: null as string | null | undefined,
  needsCustomerConfirm: false,
  customerPlanDate: undefined as string | undefined,
  note: '',
})
const form = reactive(empty())
const saving = ref(false)
const editing = computed(() => !!props.task)
/** A save belongs to the form session that started it, even if the same ID is reopened. */
let formVersion = 0
let loadingForm = false

watch(
  [() => props.open, () => props.task?.id, () => props.workOrderNumber, () => props.presetNode?.id, () => props.presetNode?.planDate],
  ([open]) => {
    formVersion++
    saving.value = false
    if (!open) return
    loadingForm = true
    const t = props.task
    Object.assign(
      form,
      t
        ? {
            workOrderNumber: t.workOrderNumber,
            componentName: t.componentName,
            ownerId: t.ownerId ?? undefined,
            planDate: dayText(t.planDate),
            startDate: t.startDate ? dayText(t.startDate) : undefined,
            planNodeId: t.planNodeId,
            needsCustomerConfirm: t.needsCustomerConfirm,
            customerPlanDate: t.customerPlanDate ? dayText(t.customerPlanDate) : undefined,
            note: t.note ?? '',
          }
        : { ...empty(), workOrderNumber: props.workOrderNumber, planNodeId: props.presetNode?.id ?? null, planDate: props.presetNode?.planDate },
    )
    loadingForm = false
  },
  { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => { formVersion++ })

watch(
  () => form.workOrderNumber,
  () => {
    if (loadingForm) return
    form.planNodeId = null
  },
  { flush: 'sync' },
)
/** 技术部的人排前面（按部门对照换算出的业务部门，班组、科室对到技术部的也算） */
const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === 'TECH') - Number(a.businessDept === 'TECH'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)
async function submit() {
  if (!props.open || saving.value) return
  const version = formVersion
  const task = props.task
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.componentName.trim()) return message.warning('请填写任务名称')
  if (!form.planDate) return message.warning('请选择计划完成日')
  if (isPlanStartLate(form.startDate, form.planDate)) return message.warning('计划开始日不能晚于计划完成日')
  const body = {
    componentName: form.componentName.trim(),
    ownerId: form.ownerId ?? null,
    planDate: form.planDate,
    startDate: form.startDate ?? null,
    planNodeId: form.planNodeId ?? null,
    needsCustomerConfirm: form.needsCustomerConfirm,
    customerPlanDate: form.needsCustomerConfirm ? (form.customerPlanDate ?? null) : null,
    note: form.note.trim() || null,
  }
  saving.value = true
  try {
    if (task) {
      const r = await drawingSend(`/api/drawings/${task.id}`, 'PATCH', body)
      if (version !== formVersion) return
      message.success(drawingResultText(r, '已保存'))
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', task.id)
    } else {
      const r = await drawingSend('/api/drawings', 'POST', { ...body, workOrderNumber: form.workOrderNumber })
      if (version !== formVersion) return
      message.success('已新建设计任务')
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', r.id)
    }
  } catch (e) {
    if (version === formVersion) message.error(apiError(e))
  } finally {
    if (version === formVersion) saving.value = false
  }
}
</script>

<template>
  <a-modal :open="open" :title="editing ? '编辑设计任务' : '新建设计任务'" ok-text="保存" :confirm-loading="saving" :closable="!saving" :mask-closable="!saving" :cancel-button-props="{ disabled: saving }" width="720px" @ok="submit" @cancel="emit('close')">
    <a-form layout="vertical" class="drawing-form">
      <a-alert v-if="ordersError || masterError" type="error" message="工单或负责人加载失败"><template #action><a-button @click="refreshOrders(); refreshMaster()">重试</a-button></template></a-alert>
      <a-form-item label="工单" required>
        <a-select
          v-model:value="form.workOrderNumber"
          :disabled="editing"
          show-search
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))"
        />
      </a-form-item>
      <div class="form-grid">
      <a-form-item label="任务名称" required><a-input v-model:value="form.componentName" :maxlength="191" placeholder="如：车架设计、原材料采购计划" /></a-form-item>
      <a-form-item label="设计负责人">
        <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" placeholder="不选 = 技术部负责人" :options="ownerOptions" />
      </a-form-item>
      </div>
      <div class="form-grid">
      <a-form-item label="计划开始日"><UiDatePicker v-model:value="form.startDate" /></a-form-item>
      <a-form-item required>
        <template #label>计划完成日 <UiHelpTip label="设计预警规则">未完成设计时，按系统设置在临近计划完成日预警；超过计划完成日提示逾期。</UiHelpTip></template>
        <UiDatePicker v-model:value="form.planDate" />
      </a-form-item>
      </div>
      <div class="confirmation-box">
        <a-checkbox v-model:checked="form.needsCustomerConfirm">需要客户确认</a-checkbox>
        <UiHelpTip label="设计完成与客户确认">登记设计完成后计入总计划节点进度；任务的图纸发放和客户确认继续单独跟踪。需要客户确认的任务，发放并确认后才进入“已完成”。</UiHelpTip>
        <a-form-item v-if="form.needsCustomerConfirm" label="客户确认计划日" class="confirmation-date">
          <UiDatePicker v-model:value="form.customerPlanDate" placeholder="未确定可暂不填" />
          <div v-if="isPlanStartLate(form.planDate, form.customerPlanDate)" class="warn">客户确认早于计划设计完成，请核对是否为提前方案确认。</div>
        </a-form-item>
      </div>
      <div class="section-label">关联信息</div>
      <a-form-item label="所属总计划节点">
        <PlanNodeSelect v-model:value="form.planNodeId" :work-order-number="form.workOrderNumber" :record-date="form.planDate" @pick="(d) => (form.planDate ||= d)" />
      </a-form-item>
      <a-form-item label="备注"><a-textarea v-model:value="form.note" :maxlength="500" :auto-size="{ minRows: 2, maxRows: 4 }" placeholder="补充任务要求（可选）" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.drawing-form { margin-top: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.form-grid :deep(.ant-picker) { width: 100%; }
.confirmation-box { padding: 12px 16px; margin-bottom: 20px; background: var(--ft-fill); border: 1px solid var(--ft-border); border-radius: var(--card-radius-inner); }
.confirmation-date { margin: 12px 0 0; }
.section-label { font-weight: 600; margin-bottom: 12px; }
.warn { color: var(--ft-upstream-text); font-size: 12px; margin-top: 6px; }
@media (max-width: 600px) { .form-grid { grid-template-columns: 1fr; gap: 0; } }
</style>
