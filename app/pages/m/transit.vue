<script setup lang="ts">
/** 外协在途：已发出未全部返回的步骤；超期标红；可补登返厂（QMS 漏报时） */
definePageMeta({ layout: 'mobile' })
const { data: workOrders } = useWorkOrders()
const { data: master } = useMaster()
const workOrderNumber = ref('')
const supplierId = ref('')
const { data: rows, pending, refresh } = useFetch('/api/transit', {
  query: computed(() => ({ workOrderNumber: workOrderNumber.value || undefined, supplierId: supplierId.value || undefined })),
  default: () => [],
})
type Row = (typeof rows.value)[number]

const woOptions = computed(() => [{ text: '全部工单', value: '' }, ...workOrders.value.map((w) => ({ text: w.workOrderNumber, value: w.workOrderNumber }))])
const supplierOptions = computed(() => [{ text: '全部外协厂', value: '' }, ...master.value.suppliers.map((s) => ({ text: s.name, value: s.id }))])

const returning = ref<Row | null>(null)
const qty = ref(1)
function openReturn(r: Row) {
  returning.value = r
  qty.value = Math.max(r.quantity - r.returnedQty, 1)
}
async function doReturn() {
  const r = returning.value
  if (!r) return
  try {
    await $fetch(`/api/steps/${r.stepId}/return`, { method: 'POST', body: { qty: qty.value, source: 'MOBILE' } })
    showSuccessToast('已补登返厂')
    returning.value = null
    await Promise.all([refresh(), refreshNuxtData('todos')])
  } catch (e) {
    showFailToast(apiError(e))
  }
}
</script>

<template>
  <div>
    <van-nav-bar title="外协在途" />
    <van-dropdown-menu>
      <van-dropdown-item v-model="workOrderNumber" :options="woOptions" />
      <van-dropdown-item v-model="supplierId" :options="supplierOptions" />
    </van-dropdown-menu>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!rows.length" description="没有在外的工件" />
    <van-cell-group v-else inset class="list">
      <van-cell v-for="r in rows" :key="r.stepId" :title="`${r.partName} · ${r.processName}`" center>
        <template #label>
          <div>{{ r.workOrderNumber }}　{{ r.supplierName ?? '—' }}</div>
          <div :class="{ overdue: r.overdueDays > 0 }">
            承诺 {{ dayText(r.promisedReturnDate) || '—' }}<template v-if="r.overdueDays > 0">　已超期 {{ r.overdueDays }} 天</template>
            　已回 {{ r.returnedQty }}/{{ r.quantity }}
          </div>
        </template>
        <template #value>
          <van-button size="small" :type="r.overdueDays > 0 ? 'danger' : 'primary'" plain @click="openReturn(r)">补登返厂</van-button>
        </template>
      </van-cell>
    </van-cell-group>

    <van-dialog :show="!!returning" title="补登返厂" show-cancel-button @confirm="doReturn" @cancel="returning = null">
      <div class="dialog">
        <p>{{ returning?.partName }} · {{ returning?.processName }}</p>
        <p class="muted">QMS 漏报检时使用；全部返回后步骤自动完成</p>
        <van-stepper v-model="qty" :min="1" integer />
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.list { margin-top: 12px; }
.overdue { color: #ee0a24; font-weight: 600; }
.dialog { padding: 12px 24px 20px; text-align: center; }
.muted { color: #969799; font-size: 12px; }
</style>
