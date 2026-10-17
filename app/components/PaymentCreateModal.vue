<script setup lang="ts">
/**
 * 新建付款申请（R10）：关联同一工单的采购行、金额、申请日、是否卡交期、说明。不审批，财务标记已付 / 暂缓。
 * 从采购到货页勾选几行进来时预先选好；从付款申请页进来时先选工单再选采购行。
 */
const props = defineProps<{ open: boolean; lines?: PurchaseRow[] }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { data: workOrders } = await useWorkOrders()

const form = reactive({
  workOrderNumber: undefined as string | undefined,
  purchaseLineIds: [] as string[],
  amount: undefined as number | undefined,
  requestDate: dayAfter(0),
  blocksDelivery: false,
  note: '',
})
const saving = ref(false)

const { data: list, refresh } = await useFetch('/api/purchases', {
  query: computed(() => ({ workOrderNumber: form.workOrderNumber, view: 'all' })),
  default: () => ({ rows: [] as PurchaseRow[], total: 0, stats: null }),
  immediate: false,
  watch: false,
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const pre = props.lines ?? []
    Object.assign(form, { workOrderNumber: pre[0]?.workOrderNumber, purchaseLineIds: pre.map((l) => l.id), amount: undefined, requestDate: dayAfter(0), blocksDelivery: false, note: '' })
    if (form.workOrderNumber) refresh()
  },
)
watch(
  () => form.workOrderNumber,
  (wo, old) => {
    if (old !== undefined && wo !== old) form.purchaseLineIds = []
    if (wo) refresh()
  },
)
const lineOptions = computed(() =>
  (list.value.rows as PurchaseRow[])
    .filter((l) => l.status !== 'CANCELLED')
    .map((l) => ({ value: l.id, label: `${l.materialName}${l.spec ? `（${l.spec}）` : ''} · ${l.supplierName ?? '未填供应商'} · 需求日 ${dayText(l.needDate)} · ${l.progressText}` })),
)

async function submit() {
  if (!form.purchaseLineIds.length) return message.warning('请选择关联的采购行')
  if (!form.amount || form.amount <= 0) return message.warning('请填写金额')
  saving.value = true
  try {
    await purchaseSend('/api/payments', 'POST', {
      purchaseLineIds: form.purchaseLineIds,
      amount: form.amount,
      requestDate: form.requestDate,
      blocksDelivery: form.blocksDelivery,
      note: form.note.trim() || null,
    })
    message.success('已提交付款申请')
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="open" title="申请付款" ok-text="提交" :confirm-loading="saving" width="720px" @ok="submit" @cancel="emit('close')">
    <a-form layout="horizontal" :label-col="{ span: 4 }" :wrapper-col="{ span: 19 }">
      <a-form-item label="工单" required>
        <a-select
          v-model:value="form.workOrderNumber"
          show-search
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))"
        />
      </a-form-item>
      <a-form-item label="关联物料" required>
        <a-select v-model:value="form.purchaseLineIds" mode="multiple" option-filter-prop="label" :placeholder="form.workOrderNumber ? '选这笔钱付的是哪些物料' : '先选工单'" :options="lineOptions" />
      </a-form-item>
      <a-form-item label="金额（元）" required>
        <a-input-number v-model:value="form.amount" :min="0.01" :max="1000000000000" :precision="2" :controls="false" style="width: 200px" />
      </a-form-item>
      <a-form-item label="申请日" required><a-date-picker v-model:value="form.requestDate" value-format="YYYY-MM-DD" :allow-clear="false" /></a-form-item>
      <a-form-item label="卡交期">
        <a-checkbox v-model:checked="form.blocksDelivery">不付就不发货 / 不排产（如预付款）</a-checkbox>
        <div class="muted">卡交期的排在财务列表最前面；物料超期时 W6 预警会通知财务</div>
      </a-form-item>
      <a-form-item label="说明"><a-input v-model:value="form.note" :maxlength="500" placeholder="如：钢板预付款 30%" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
</style>
