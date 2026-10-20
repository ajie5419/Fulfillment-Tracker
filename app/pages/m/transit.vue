<script setup lang="ts">
/** 外协在途：已发出未全部返回的步骤；超期标红；可补登返厂（QMS 漏报时；生产部、外协专员、该工序责任人、管理员） */
definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const route = useRoute()
// 从提醒跳过来时带 ?wo=，先按该工单筛选
const workOrderNumber = ref((route.query.wo as string) || '')
const supplierId = ref('')
const { data: rows, pending, refresh } = await useFetch('/api/transit', {
  query: computed(() => ({ workOrderNumber: workOrderNumber.value || undefined, supplierId: supplierId.value || undefined })),
  default: () => [],
})
type Row = (typeof rows.value)[number]

const woOptions = computed(() => [{ text: '全部工单', value: '' }, ...workOrders.value.map((w) => ({ text: w.workOrderNumber, value: w.workOrderNumber }))])
const supplierOptions = computed(() => [{ text: '全部外协厂', value: '' }, ...master.value.suppliers.map((s) => ({ text: s.label, value: s.id }))])

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
/** 已返回数量占比（进度条），0–100 */
const returnedPercent = (r: Row) => (r.quantity > 0 ? Math.min(100, Math.round((r.returnedQty / r.quantity) * 100)) : 0)
</script>

<template>
  <div>
    <van-nav-bar title="外协在途" />
    <van-dropdown-menu>
      <van-dropdown-item v-model="workOrderNumber" :options="woOptions" />
      <van-dropdown-item v-model="supplierId" :options="supplierOptions" />
    </van-dropdown-menu>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!rows.length" description="没有在外的工件" image-size="80" />
    <div v-else class="m-list">
      <MCard v-for="r in rows" :key="r.stepId" :tone="r.overdueDays > 0 ? 'late' : 'primary'">
        <div class="m-row">
          <van-tag v-if="r.overdueDays > 0" type="danger">已超期 {{ r.overdueDays }} 天</van-tag>
          <van-tag v-else type="primary">在外加工</van-tag>
          <span class="wo">{{ r.workOrderNumber }}</span>
        </div>
        <div class="m-title name">{{ r.partName }} · {{ r.processName }}</div>
        <div class="m-meta">
          <span>{{ r.supplierName ?? '—' }}</span>
          <span :class="{ 'm-text-late': r.overdueDays > 0 }">承诺返回 {{ dayText(r.promisedReturnDate) || '—' }}</span>
        </div>
        <div class="m-progress">
          <van-progress :percentage="returnedPercent(r)" :show-pivot="false" :class="r.overdueDays > 0 ? 'm-progress-late' : 'm-progress-primary'" />
          <span class="m-progress-text">已回 {{ r.returnedQty }}/{{ r.quantity }}</span>
        </div>
        <div v-if="canDo(me, 'stepAction', { ownerId: r.ownerId })" class="m-foot-row">
          <span class="m-spacer" />
          <van-button size="small" :type="r.overdueDays > 0 ? 'danger' : 'primary'" plain @click="openReturn(r)">补登返厂</van-button>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />

    <van-dialog :show="!!returning" title="补登返厂" show-cancel-button @confirm="doReturn" @cancel="returning = null">
      <div class="dialog">
        <p>{{ returning?.partName }} · {{ returning?.processName }}</p>
        <p class="m-muted tip">QMS 漏报检时使用；全部返回后步骤自动完成</p>
        <van-stepper v-model="qty" :min="1" integer />
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.dialog { padding: 12px 24px 20px; text-align: center; }
.tip { font-size: 12px; }
</style>
