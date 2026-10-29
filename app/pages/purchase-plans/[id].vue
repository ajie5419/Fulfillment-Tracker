<script setup lang="ts">
import { PURCHASE_PLAN_STATUS_TEXT, purchasePlanEditable } from '#shared/purchase-plans'
const route = useRoute()
const { data: me } = await useMe()
const id = computed(() => String(route.params.id))
const url = computed(() => `/api/purchase-plans/${id.value}` as const)
const { data: plan, error, pending, refresh } = await useFetch(url)
type Item = NonNullable<typeof plan.value>['items'][number]
const editable = computed(() => !!plan.value && !!me.value?.can.purchasePlan && purchasePlanEditable(plan.value.status))
// 动态明细路径的 PATCH / POST 共用表单；显式约束写请求，避免 Nitro 对联合路径进行递归推断。
const mutate = $fetch as unknown as <T = unknown>(url: string, options: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>
const busy = ref(false)
const headOpen = ref(false)
const itemOpen = ref(false)
const editingId = ref<string | null>(null)
const head = reactive({ title: '', category: '', planNodeId: null as string | null | undefined, note: '' })
const emptyItem = () => ({ materialName: '', spec: '', quantity: 1, unit: '', needDate: undefined as string | undefined, partId: undefined as string | undefined, supplierName: '', note: '', sortOrder: 0 })
const itemForm = reactive(emptyItem())
const { data: parts, error: partError, refresh: refreshParts } = await useFetch('/api/parts', { query: computed(() => ({ workOrderNumber: plan.value?.workOrderNumber })), immediate: !!plan.value })
const conversionErrors = ref<{ itemId: string; error?: string }[]>([])
async function action(fn: () => Promise<unknown>) {
  busy.value = true
  try { await fn(); await refresh() } catch (err) { message.error(apiError(err)) } finally { busy.value = false }
}
function editHead() {
  if (!plan.value) return
  Object.assign(head, { title: plan.value.title, category: plan.value.category, planNodeId: plan.value.planNodeId, note: plan.value.note ?? '' }); headOpen.value = true
}
function editItem(item?: Item) {
  editingId.value = item?.id ?? null
  Object.assign(itemForm, item ? { materialName: item.materialName, spec: item.spec ?? '', quantity: item.quantity, unit: item.unit ?? '', needDate: item.needDate?.slice(0, 10) ?? undefined, partId: item.partId ?? undefined, supplierName: item.supplierName ?? '', note: item.note ?? '', sortOrder: item.sortOrder } : { ...emptyItem(), sortOrder: plan.value?.items.length ?? 0 })
  itemOpen.value = true
}
async function saveHead() { await action(async () => { await mutate(url.value, { method: 'PATCH', body: head }); headOpen.value = false }) }
async function saveItem() { await action(async () => { await mutate(`${url.value}/items${editingId.value ? `/${editingId.value}` : ''}`, { method: editingId.value ? 'PATCH' : 'POST', body: { ...itemForm, needDate: itemForm.needDate ?? null, partId: itemForm.partId ?? null } }); itemOpen.value = false }) }
async function changeStatus(actionName: 'issue' | 'withdraw') {
  await action(async () => {
    const r = await mutate<{ notified: number }>(`${url.value}/${actionName}`, { method: 'POST' })
    message.success(actionName === 'withdraw' ? '已撤回，可继续编辑后再下发；已转入的采购行保留' : r.notified ? `已下发，已通知 ${r.notified} 位采购部负责人` : '已下发，但未设置采购部负责人，请到设置中指定')
  })
}
async function convert(itemId?: string) {
  await action(async () => {
    const r = await mutate<{ succeeded: number; failed: number; results: { itemId: string; error?: string }[] }>(`${url.value}/convert`, { method: 'POST', body: itemId ? { itemIds: [itemId] } : {} })
    conversionErrors.value = r.results.filter(r => r.error)
    message.info(`成功转入 ${r.succeeded} 项，失败 ${r.failed} 项`)
  })
}
async function removeItem(itemId: string) { await action(() => mutate(`${url.value}/items/${itemId}`, { method: 'DELETE' })) }
const statusText = (item: Item) => !item.convertedLineId ? '未转入' : `已转采购行 · ${{ OPEN: '待到货', ARRIVED: '已到货', CANCELLED: '已取消' }[item.convertedLine?.status ?? 'OPEN']}`
</script>
<template>
  <div class="purchase-plans-page">
  <a-button style="margin-bottom: 16px" @click="navigateTo('/purchase-plans')">返回采购计划列表</a-button>
  <a-result v-if="error" status="error" title="采购计划加载失败"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
  <a-spin v-else :spinning="pending">
    <template v-if="plan">
      <UiSectionCard :title="plan.title" :sub="`${plan.workOrderNumber} · ${plan.category || '未分类'} · ${plan.source === 'BOM_AUTO' ? 'BOM 自动带出' : '手工'}`">
        <template #extra><UiRefreshButton :loading="pending" @click="refresh()" /></template>
        <a-space wrap>
          <UiStatusTag :tone="plan.status === 'ISSUED' ? 'done' : 'none'">{{ PURCHASE_PLAN_STATUS_TEXT[plan.status] }}</UiStatusTag>
          <span>已转入 {{ plan.progress.converted }}/{{ plan.progress.total }}</span><span>已到货 {{ plan.progress.arrived }}/{{ plan.progress.total }}</span>
          <a-button v-if="editable" :disabled="busy" @click="editHead">编辑计划头</a-button>
          <a-popconfirm v-if="editable" title="确认下发给采购部？下发后锁定明细。" @confirm="changeStatus('issue')"><a-button type="primary" :loading="busy">下发</a-button></a-popconfirm>
          <a-popconfirm v-if="plan.status === 'ISSUED' && me?.can.purchasePlan" title="撤回后可编辑，已经转入的采购行保留，且不允许修改对应明细。" @confirm="changeStatus('withdraw')"><a-button :disabled="busy">撤回</a-button></a-popconfirm>
          <a-button v-if="plan.status === 'ISSUED' && me?.can.purchasePlanConvert" type="primary" :loading="busy" :disabled="plan.progress.converted === plan.progress.total" @click="convert()">整单转采购行</a-button>
        </a-space>
        <p class="muted">总计划节点：{{ plan.planNode ? `${plan.planNode.seq}. ${plan.planNode.name}` : '未关联' }}<br>创建人：{{ plan.createdBy }}<template v-if="plan.issuedAt"><br>最近下发：{{ plan.issuedAt.slice(0, 10) }}（{{ plan.issuedBy }}）</template><br>{{ plan.note || '无备注' }}</p>
      </UiSectionCard>
      <UiSectionCard title="计划明细" style="margin-top: 16px">
        <template #extra><a-button v-if="editable" :disabled="busy" @click="editItem()">添加明细</a-button></template>
        <a-alert v-if="conversionErrors.length" type="error" message="以下明细转入失败，其余成功项已保留" style="margin-bottom: 12px"><template #description><p v-for="r in conversionErrors" :key="r.itemId">{{ plan.items.find(i => i.id === r.itemId)?.materialName ?? r.itemId }}：{{ r.error }}</p></template></a-alert>
        <div class="ft-well list">
          <UiListItem v-for="item in plan.items" :key="item.id" :tone="item.convertedLine?.status === 'ARRIVED' ? 'done' : 'none'">
            <template #title>{{ item.materialName }} <span class="muted">{{ item.spec }}</span></template>
            <template #desc><div>{{ item.quantity }} {{ item.unit }} · 需求日 {{ item.needDate?.slice(0, 10) || '待补齐' }}</div><div>工件：{{ item.part?.name || '—' }} · 供应商：{{ item.supplierName || '—' }}</div><div v-if="item.note">{{ item.note }}</div><NuxtLink v-if="item.convertedLineId" :to="`/purchases?wo=${encodeURIComponent(plan.workOrderNumber)}&id=${item.convertedLineId}`">{{ statusText(item) }}</NuxtLink><span v-else>未转入</span></template>
            <template #extra><a-space wrap>
              <a-button v-if="editable && !item.convertedLineId" size="small" :disabled="busy" @click="editItem(item)">编辑</a-button>
              <a-popconfirm v-if="editable && !item.convertedLineId" title="删除这项明细？" @confirm="removeItem(item.id)"><a-button size="small" danger :disabled="busy">删除</a-button></a-popconfirm>
              <a-button v-if="plan.status === 'ISSUED' && me?.can.purchasePlanConvert && !item.convertedLineId" size="small" type="primary" :loading="busy" @click="convert(item.id)">转采购行</a-button>
            </a-space></template>
          </UiListItem>
          <p v-if="!plan.items.length" class="muted">暂无明细，请添加。</p>
        </div>
      </UiSectionCard>
    </template>
  </a-spin>
  <a-modal :open="headOpen" title="编辑采购计划" :confirm-loading="busy" @ok="saveHead" @cancel="headOpen = false">
    <a-form layout="vertical">
      <a-form-item label="标题" required><a-input v-model:value="head.title" :maxlength="191" /></a-form-item>
      <a-form-item label="类别"><a-input v-model:value="head.category" :maxlength="191" /></a-form-item>
      <a-form-item label="所属总计划节点"><PlanNodeSelect v-model:value="head.planNodeId" :work-order-number="plan?.workOrderNumber" /></a-form-item>
      <a-form-item label="备注"><a-textarea v-model:value="head.note" :maxlength="500" /></a-form-item>
    </a-form>
  </a-modal>
  <a-modal :open="itemOpen" :title="editingId ? '编辑明细' : '添加明细'" :confirm-loading="busy" @ok="saveItem" @cancel="itemOpen = false">
    <a-form layout="vertical">
      <a-form-item label="物料名称" required><a-input v-model:value="itemForm.materialName" :maxlength="191" /></a-form-item>
      <a-form-item label="规格型号"><a-input v-model:value="itemForm.spec" :maxlength="191" /></a-form-item>
      <a-form-item label="数量 / 单位" required><a-space><a-input-number v-model:value="itemForm.quantity" :min="0" :max="1e9" :precision="3" /><a-input v-model:value="itemForm.unit" placeholder="单位" :maxlength="20" /></a-space></a-form-item>
      <a-form-item label="需求日（下发前必填）"><UiDatePicker v-model:value="itemForm.needDate" /></a-form-item>
      <a-form-item label="工件（可空）"><a-alert v-if="partError" type="error" message="工件列表加载失败"><template #action><a-button size="small" @click="refreshParts()">重试</a-button></template></a-alert><a-select v-else v-model:value="itemForm.partId" allow-clear show-search option-filter-prop="label" :options="parts?.map(p => ({ value: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name }))" /></a-form-item>
      <a-form-item label="供应商（手填）"><a-input v-model:value="itemForm.supplierName" :maxlength="191" /></a-form-item>
      <a-form-item label="排序（越小越靠前）"><a-input-number v-model:value="itemForm.sortOrder" :min="0" :max="100000" :precision="0" /></a-form-item>
      <a-form-item label="备注"><a-textarea v-model:value="itemForm.note" :maxlength="500" /></a-form-item>
    </a-form>
  </a-modal>
  </div>
</template>
<style scoped>
.muted { color: var(--ft-text-2); font-size: 13px; overflow-wrap: anywhere; }
</style>
