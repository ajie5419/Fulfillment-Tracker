<script setup lang="ts">
/**
 * 新建 / 编辑出图任务（R11）：工单、关联工件（可多选，可不选只写部件名称）、部件名称、设计负责人（不选 = 技术部负责人）、
 * 计划完成日、所属总计划节点（R14，工单总计划已发布时必选）、是否需要客户确认 + 客户确认计划日、备注；编辑时还能取消 / 重新启用。出图、客户确认在列表上操作。
 */
const props = defineProps<{ open: boolean; task: DrawingRow | null; workOrderNumber?: string }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const empty = () => ({
  workOrderNumber: undefined as string | undefined,
  partIds: [] as string[],
  componentName: '',
  ownerId: undefined as string | undefined,
  planDate: undefined as string | undefined,
  planNodeId: null as string | null | undefined,
  needsCustomerConfirm: false,
  customerPlanDate: undefined as string | undefined,
  note: '',
  cancelled: false,
})
const form = reactive(empty())
const saving = ref(false)
const editing = computed(() => !!props.task)

/** 打开时装入的工单：工单 watch 碰到它不清工件（编辑时要保留原来的关联工件） */
let loadedWo: string | undefined | null = null
watch(
  () => props.open,
  (open) => {
    if (!open) return
    const t = props.task
    Object.assign(
      form,
      t
        ? {
            workOrderNumber: t.workOrderNumber,
            partIds: [...t.partIds],
            componentName: t.componentName,
            ownerId: t.ownerId ?? undefined,
            planDate: dayText(t.planDate),
            planNodeId: t.planNodeId,
            needsCustomerConfirm: t.needsCustomerConfirm,
            customerPlanDate: t.customerPlanDate ? dayText(t.customerPlanDate) : undefined,
            note: t.note ?? '',
            cancelled: t.status === 'CANCELLED',
          }
        : { ...empty(), workOrderNumber: props.workOrderNumber },
    )
    loadedWo = form.workOrderNumber
    if (form.workOrderNumber) refreshParts()
  },
)

const { data: parts, refresh: refreshParts } = await useFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: form.workOrderNumber })),
  default: () => [],
  immediate: false,
  watch: false,
})
watch(
  () => form.workOrderNumber,
  (wo) => {
    if (wo === loadedWo) {
      loadedWo = null
      return
    }
    loadedWo = null
    form.partIds = []
    form.planNodeId = null
    if (wo) refreshParts()
  },
)
const partOptions = computed(() => (form.workOrderNumber ? parts.value : []).map((p) => ({ value: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name })))
/** 技术部的人排前面（按部门对照换算出的业务部门，班组、科室对到技术部的也算） */
const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === 'TECH') - Number(a.businessDept === 'TECH'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)
/** 选了工件、部件名称还空着时带出工件名 */
watch(
  () => form.partIds.length,
  (n, old) => {
    if (n === 1 && !old && !form.componentName.trim()) form.componentName = partOptions.value.find((p) => p.value === form.partIds[0])?.label ?? ''
  },
)

async function submit() {
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.componentName.trim()) return message.warning('请填写部件名称')
  if (!form.planDate) return message.warning('请选择计划完成日')
  const body: Record<string, unknown> = {
    partIds: form.partIds,
    componentName: form.componentName.trim(),
    ownerId: form.ownerId ?? null,
    planDate: form.planDate,
    planNodeId: form.planNodeId ?? null,
    needsCustomerConfirm: form.needsCustomerConfirm,
    customerPlanDate: form.needsCustomerConfirm ? (form.customerPlanDate ?? null) : null,
    note: form.note.trim() || null,
  }
  saving.value = true
  try {
    if (props.task) {
      const r = await drawingSend<DrawingResult & { planWarning?: string | null }>(`/api/drawings/${props.task.id}`, 'PATCH', { ...body, cancelled: form.cancelled })
      message.success(drawingResultText(r, '已保存'))
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', props.task.id)
    } else {
      const r = await drawingSend<{ id: string; planWarning?: string | null }>('/api/drawings', 'POST', { ...body, workOrderNumber: form.workOrderNumber })
      message.success('已新建出图任务')
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', r.id)
    }
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="open" :title="editing ? '编辑出图任务' : '新建出图任务'" ok-text="保存" :confirm-loading="saving" width="720px" @ok="submit" @cancel="emit('close')">
    <a-form layout="horizontal" :label-col="{ span: 5 }" :wrapper-col="{ span: 18 }">
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
      <a-form-item label="关联工件">
        <a-select v-model:value="form.partIds" mode="multiple" allow-clear option-filter-prop="label" :placeholder="form.workOrderNumber ? '可多选，可不选（只写部件名称）' : '先选工单'" :options="partOptions" />
        <div class="muted">关联的工件在出图完成并发放前不发"可以开工"</div>
      </a-form-item>
      <a-form-item label="部件名称" required><a-input v-model:value="form.componentName" :maxlength="191" placeholder="如 主梁总图、液压系统原理图" /></a-form-item>
      <a-form-item label="设计负责人">
        <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" placeholder="不选 = 技术部负责人" :options="ownerOptions" />
      </a-form-item>
      <a-form-item label="计划完成日" required>
        <a-date-picker v-model:value="form.planDate" value-format="YYYY-MM-DD" />
        <div class="muted">计划完成日前 2 天（可在设置里改）还没出图黄色预警，过了计划完成日红色</div>
      </a-form-item>
      <a-form-item label="所属总计划节点">
        <PlanNodeSelect v-model:value="form.planNodeId" :work-order-number="form.workOrderNumber" :record-date="form.planDate" @pick="(d) => (form.planDate ||= d)" />
      </a-form-item>
      <a-form-item label="客户确认">
        <a-checkbox v-model:checked="form.needsCustomerConfirm">需要客户确认</a-checkbox>
        <a-date-picker v-if="form.needsCustomerConfirm" v-model:value="form.customerPlanDate" value-format="YYYY-MM-DD" placeholder="客户确认计划日" style="margin-left: 8px" />
        <div v-if="form.needsCustomerConfirm" class="muted">出图后超过客户确认计划日还没确认会预警；客户确认后任务才算完成</div>
      </a-form-item>
      <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
      <a-form-item v-if="editing" label="不再跟踪">
        <a-checkbox v-model:checked="form.cancelled">已取消（不再预警，不挡"可以开工"）</a-checkbox>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
