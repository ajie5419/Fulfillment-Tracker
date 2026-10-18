<script setup lang="ts">
/**
 * 新建 / 编辑关键物料采购行（R10）：工单、工件（可空）、物料名称、规格、数量、单位、供应商（选 QMS 供应商或手填）、
 * 需求日、承诺到货日、采购负责人（不选 = 采购部负责人）、备注；编辑时还能填延误原因、取消 / 重新启用、改到货日。
 */
const props = defineProps<{ open: boolean; line: PurchaseRow | null; workOrderNumber?: string }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const empty = () => ({
  workOrderNumber: undefined as string | undefined,
  partId: undefined as string | undefined,
  materialName: '',
  spec: '',
  quantity: 1 as number | undefined,
  unit: '',
  supplier: '',
  needDate: undefined as string | undefined,
  promisedDate: undefined as string | undefined,
  arrivedDate: undefined as string | undefined,
  buyerId: undefined as string | undefined,
  note: '',
  delayReason: undefined as string | undefined,
  delayNote: '',
  cancelled: false,
})
const form = reactive(empty())
const saving = ref(false)
const editing = computed(() => !!props.line)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const l = props.line
    Object.assign(
      form,
      l
        ? {
            workOrderNumber: l.workOrderNumber,
            partId: l.partId ?? undefined,
            materialName: l.materialName,
            spec: l.spec ?? '',
            quantity: l.quantity ?? undefined,
            unit: l.unit ?? '',
            supplier: l.supplierName ?? '',
            needDate: dayText(l.needDate),
            promisedDate: l.promisedDate ? dayText(l.promisedDate) : undefined,
            arrivedDate: l.arrivedDate ? dayText(l.arrivedDate) : undefined,
            buyerId: l.buyerId ?? undefined,
            note: l.note ?? '',
            delayReason: l.delayReason ?? undefined,
            delayNote: l.delayNote ?? '',
            cancelled: l.status === 'CANCELLED',
          }
        : { ...empty(), workOrderNumber: props.workOrderNumber },
    )
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
  (wo, old) => {
    // 编辑时工单不能改；这里的变化来自打开弹窗时装入另一行，不能清掉它的工件（否则保存会解绑工件）
    if (!editing.value && old !== undefined && wo !== old) form.partId = undefined
    if (wo) refreshParts()
  },
)
const partOptions = computed(() => (form.workOrderNumber ? parts.value : []).map((p) => ({ value: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name })))
/** 关键物料供应商：QMS 供应商（不含厂内班组）；也可以手填 */
const qmsSuppliers = computed(() => master.value.suppliers.filter((s) => s.kind !== 'TEAM'))
const supplierOptions = computed(() => qmsSuppliers.value.filter((s) => !form.supplier || s.name.includes(form.supplier)).slice(0, 50).map((s) => ({ value: s.name })))
const matchedSupplier = computed(() => qmsSuppliers.value.find((s) => s.name === form.supplier.trim()) ?? null)
/** 采购部的人排前面 */
const buyerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.department === '采购部') - Number(a.department === '采购部'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)
/** 晚了（到货 / 今天晚于需求日或承诺日）才需要延误原因 */
const late = computed(() => {
  const today = dayAfter(0)
  const ref = props.line?.status === 'ARRIVED' ? form.arrivedDate : today
  if (!ref || !form.needDate) return false
  return ref > form.needDate || (!!form.promisedDate && ref > form.promisedDate)
})

async function submit() {
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.materialName.trim()) return message.warning('请填写物料名称')
  if (!form.quantity || form.quantity <= 0) return message.warning('数量要大于 0')
  if (!form.needDate) return message.warning('请选择需求日')
  const supplier = matchedSupplier.value
  const body: Record<string, unknown> = {
    partId: form.partId ?? null,
    materialName: form.materialName.trim(),
    spec: form.spec.trim() || null,
    quantity: form.quantity,
    unit: form.unit.trim() || null,
    supplierId: supplier?.id ?? null,
    supplierName: supplier ? null : form.supplier.trim() || null,
    needDate: form.needDate,
    promisedDate: form.promisedDate ?? null,
    buyerId: form.buyerId ?? null,
    note: form.note.trim() || null,
  }
  saving.value = true
  try {
    if (props.line) {
      // 供应商没改就不提交（原来关联的 QMS 供应商后来停用了，也不影响改别的）
      if (form.supplier.trim() === (props.line.supplierName ?? '')) {
        delete body.supplierId
        delete body.supplierName
      }
      Object.assign(body, { delayReason: form.delayReason ?? null, delayNote: form.delayNote.trim() || null })
      if (props.line.status !== 'ARRIVED') body.status = form.cancelled ? 'CANCELLED' : 'OPEN'
      else if (form.arrivedDate) body.arrivedDate = form.arrivedDate
      await purchaseSend(`/api/purchases/${props.line.id}`, 'PATCH', body)
      message.success('已保存')
      emit('done', props.line.id)
    } else {
      const r = await purchaseSend<{ id: string }>('/api/purchases', 'POST', { ...body, workOrderNumber: form.workOrderNumber, arrivedDate: form.arrivedDate ?? null })
      message.success('已登记')
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
  <a-modal :open="open" :title="editing ? '编辑关键物料' : '登记关键物料'" ok-text="保存" :confirm-loading="saving" width="760px" @ok="submit" @cancel="emit('close')">
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
      <a-form-item label="用于工件">
        <a-select v-model:value="form.partId" allow-clear show-search option-filter-prop="label" :placeholder="form.workOrderNumber ? '可空；全部到货时给它的第一道工序发“可以开工”' : '先选工单'" :options="partOptions" />
      </a-form-item>
      <a-form-item label="物料名称" required>
        <a-input v-model:value="form.materialName" :maxlength="191" placeholder="如 回转支承；QMS 进货检验按名称自动确认到货" />
      </a-form-item>
      <a-form-item label="规格型号"><a-input v-model:value="form.spec" :maxlength="191" /></a-form-item>
      <a-form-item label="数量" required>
        <a-space>
          <a-input-number v-model:value="form.quantity" :min="0.001" :max="1000000000" :precision="3" :controls="false" style="width: 140px" />
          <a-input v-model:value="form.unit" :maxlength="20" placeholder="单位，如 台、t" style="width: 120px" />
        </a-space>
      </a-form-item>
      <a-form-item label="供应商">
        <a-auto-complete v-model:value="form.supplier" :options="supplierOptions" placeholder="选 QMS 供应商，或直接填写名称" allow-clear />
        <div class="muted">{{ form.supplier.trim() ? (matchedSupplier ? '已关联 QMS 供应商（进货检验自动到货时核对供应商）' : '手填的供应商') : '' }}</div>
      </a-form-item>
      <a-form-item label="需求日" required><a-date-picker v-model:value="form.needDate" value-format="YYYY-MM-DD" /></a-form-item>
      <a-form-item label="承诺到货日">
        <a-date-picker v-model:value="form.promisedDate" value-format="YYYY-MM-DD" placeholder="供应商承诺的日期" />
        <div class="muted">需求日前 7 天（可在设置里改）还没有承诺日会预警</div>
      </a-form-item>
      <a-form-item v-if="!editing || line?.status === 'ARRIVED'" label="实际到货日">
        <a-date-picker v-model:value="form.arrivedDate" value-format="YYYY-MM-DD" :allow-clear="!editing" placeholder="已经到了才填" />
        <div v-if="!editing" class="muted">新登记时只用于补录已到货的物料；之后到货请用"确认到货"</div>
      </a-form-item>
      <a-form-item label="采购负责人">
        <a-select v-model:value="form.buyerId" allow-clear show-search option-filter-prop="label" placeholder="不选 = 采购部负责人" :options="buyerOptions" />
      </a-form-item>
      <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
      <template v-if="editing">
        <a-form-item label="延误原因">
          <a-radio-group v-model:value="form.delayReason" :options="DELAY_REASON_OPTIONS" />
          <a-button v-if="form.delayReason" type="link" size="small" @click="form.delayReason = undefined">清除</a-button>
          <div class="muted">{{ late ? '已延误：请选原因，统计时"付款"和其他（管理原因）分开算' : '没有延误时不用填' }}</div>
        </a-form-item>
        <a-form-item v-if="form.delayReason" label="延误说明"><a-input v-model:value="form.delayNote" :maxlength="500" placeholder="如：预付款未付，供应商不发货" /></a-form-item>
        <a-form-item v-if="line?.status !== 'ARRIVED'" label="不再跟踪">
          <a-checkbox v-model:checked="form.cancelled">已取消（不再预警、不算缺料）</a-checkbox>
        </a-form-item>
      </template>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
</style>
