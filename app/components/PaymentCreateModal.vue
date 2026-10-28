<script setup lang="ts">
import { MAX_PAYMENT_LINES } from '#shared/purchases'
import type { PageResult } from '#shared/pagination'
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

const search = ref('')
const picked = ref(new Map<string, PurchaseOption>())
const choices = usePagedList<PurchaseOption>('/api/purchases/options', {
  key: 'payment-material-options', mode: 'append', pageSize: ref(20),
  enabled: computed(() => props.open && !!form.workOrderNumber),
  query: computed(() => ({ workOrderNumber: form.workOrderNumber, q: search.value.trim() || undefined })),
})
const { rows: choiceRows, pending: choiceLoading, error: choiceError, finished: choicesFinished } = choices
let opening = 0

/** Selected records may be on any page. Hydrate them separately without widening
 * the work-order scope, and discard results from a closed or replaced dialog. */
async function hydrate(ids: string[], wo: string, version: number) {
  try {
    const read = $fetch as unknown as (url: string, opts: { query: object }) => Promise<PageResult<PurchaseOption>>
    const result = await read('/api/purchases/options', { query: { workOrderNumber: wo, ids, pageSize: MAX_PAYMENT_LINES } })
    if (version !== opening || !props.open || wo !== form.workOrderNumber) return
    picked.value = new Map([...picked.value.values(), ...result.rows]
      .filter((row) => form.purchaseLineIds.includes(row.id)).map((row) => [row.id, row]))
  } catch (e) {
    if (version === opening && props.open) message.error(`已选物料加载失败：${apiError(e)}`)
  }
}

watch(
  () => props.open,
  (open) => {
    const version = ++opening
    if (!open) return
    const pre = props.lines ?? []
    Object.assign(form, { workOrderNumber: pre[0]?.workOrderNumber, purchaseLineIds: pre.map((l) => l.id), amount: undefined, requestDate: dayAfter(0), blocksDelivery: false, note: '' })
    search.value = ''
    picked.value.clear()
    if (form.workOrderNumber && pre.length) void hydrate(form.purchaseLineIds, form.workOrderNumber, version)
  },
  { immediate: true },
)
/** 只有用户手动换工单时才清空已选采购行（打开弹窗时预选的不受影响） */
function onWorkOrderChange() {
  opening++
  form.purchaseLineIds = []
  picked.value.clear()
  search.value = ''
}
watch(() => form.purchaseLineIds, (ids) => {
  for (const row of choiceRows.value) if (ids.includes(row.id)) picked.value.set(row.id, row)
  for (const id of picked.value.keys()) if (!ids.includes(id)) picked.value.delete(id)
})
const lineOptions = computed(() => [...new Map([...picked.value.values(), ...choiceRows.value].map((row) => [row.id, row])).values()]
  .map((l) => ({ value: l.id, label: `${l.materialName}${l.spec ? `（${l.spec}）` : ''} · ${l.supplierName ?? '未填供应商'} · 需求日 ${dayText(l.needDate)}` })))
function onOptionsScroll(event: UIEvent) {
  const target = event.target as HTMLElement
  if (target.scrollHeight - target.scrollTop - target.clientHeight < 40) void choices.next()
}
onBeforeUnmount(() => { opening++ })

async function submit() {
  if (!form.purchaseLineIds.length) return message.warning('请选择关联的采购行')
  if (form.purchaseLineIds.length > MAX_PAYMENT_LINES) return message.warning(`最多关联 ${MAX_PAYMENT_LINES} 项`)
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
          @change="onWorkOrderChange"
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))"
        />
      </a-form-item>
      <a-form-item label="关联物料" required>
        <a-select v-model:value="form.purchaseLineIds" mode="multiple" show-search :filter-option="false" :loading="choiceLoading"
          :disabled="!form.workOrderNumber" :placeholder="form.workOrderNumber ? '搜索这笔钱付的是哪些物料' : '先选工单'"
          :options="lineOptions" @search="(value: string) => search = value" @popup-scroll="onOptionsScroll" />
        <div v-if="form.workOrderNumber" class="muted">
          已加载 {{ choiceRows.length }} / {{ choices.total.value }} 项
          <a-button v-if="choiceError || !choicesFinished" type="link" size="small" :loading="choiceLoading" @click="choices.next()">{{ choiceError ? '加载失败，重试' : '加载更多' }}</a-button>
        </div>
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
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
