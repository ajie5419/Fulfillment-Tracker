<script setup lang="ts">
import { PURCHASE_PLAN_STATUS_TEXT } from '#shared/purchase-plans'
const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const { data: workOrders, error: workOrderError, refresh: refreshWorkOrders } = await useWorkOrders()
const wo = computed(() => typeof route.query.wo === 'string' ? route.query.wo : undefined)
const status = computed(() => typeof route.query.status === 'string' ? route.query.status : undefined)
const page = computed(() => Math.max(1, Number(route.query.page) || 1))
function filter(key: string, value: unknown) { void router.replace({ query: { ...route.query, [key]: value as string | undefined, page: undefined } }) }
const { data, error, pending, refresh } = await useFetch('/api/purchase-plans', { query: computed(() => ({ workOrderNumber: wo.value, status: status.value, page: page.value })) })
const creating = ref(false)
const saving = ref(false)
const form = reactive({ workOrderNumber: '', title: '', category: '', planNodeId: null as string | null | undefined, note: '' })
const statusOptions = Object.entries(PURCHASE_PLAN_STATUS_TEXT).map(([value, label]) => ({ value, label }))
async function create() {
  saving.value = true
  try {
    const result = await $fetch('/api/purchase-plans', { method: 'POST', body: form })
    creating.value = false
    await navigateTo(`/purchase-plans/${result.id}`)
  } catch (err) { message.error(apiError(err)) } finally { saving.value = false }
}
</script>

<template>
  <div class="purchase-plans-page">
  <UiSectionCard title="采购计划下发" sub="技术部下发清单，采购部转入采购行执行">
    <template #extra>
      <a-space wrap>
        <UiRefreshButton :loading="pending" @click="refresh()" />
        <a-button v-if="me?.can.purchasePlan" type="primary" @click="Object.assign(form, { workOrderNumber: wo || '', title: '', category: '', planNodeId: null, note: '' }); creating = true">新建采购计划</a-button>
      </a-space>
    </template>
    <a-alert v-if="workOrderError" type="error" message="工单选项加载失败"><template #action><a-button size="small" @click="refreshWorkOrders()">重试</a-button></template></a-alert>
    <div class="ft-toolbar">
      <a-select :value="wo" allow-clear show-search option-filter-prop="label" placeholder="全部工单" :options="workOrders?.map(w => ({ value: w.workOrderNumber, label: w.workOrderNumber }))" style="min-width: 210px" @change="filter('wo', $event)" />
      <a-select :value="status" allow-clear placeholder="全部状态" :options="statusOptions" style="min-width: 130px" @change="filter('status', $event)" />
    </div>
    <a-result v-if="error" status="error" title="采购计划加载失败"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
    <a-spin v-else :spinning="pending">
      <div class="ft-well list">
        <UiListItem v-for="record in data?.rows ?? []" :key="record.id" :tone="record.status === 'ISSUED' ? 'done' : 'none'">
          <template #title><NuxtLink :to="`/purchase-plans/${record.id}`">{{ record.title }}</NuxtLink></template>
          <template #desc><div>{{ record.workOrderNumber }} · {{ record.category || '未分类' }} · {{ record.source === 'BOM_AUTO' ? 'BOM 自动带出' : '手工' }}</div><div>已转入 {{ record.progress.converted }}/{{ record.progress.total }} · 已到货 {{ record.progress.arrived }}/{{ record.progress.total }}</div></template>
          <template #extra><UiStatusTag :tone="record.status === 'ISSUED' ? 'done' : 'none'">{{ PURCHASE_PLAN_STATUS_TEXT[record.status] }}</UiStatusTag></template>
        </UiListItem>
        <p v-if="!pending && !data?.rows.length" class="muted">暂无采购计划</p>
      </div>
    </a-spin>
    <a-pagination v-if="data && !error" :current="data.page" :total="data.total" :page-size="data.pageSize" :show-size-changer="false" @change="router.replace({ query: { ...route.query, page: String($event) } })" />
  </UiSectionCard>
  <a-modal :open="creating" title="新建采购计划" :confirm-loading="saving" @ok="create" @cancel="creating = false">
    <a-form layout="vertical">
      <a-alert v-if="workOrderError" type="error" message="工单选项加载失败"><template #action><a-button size="small" @click="refreshWorkOrders()">重试</a-button></template></a-alert>
      <a-form-item label="工单" required><a-select v-model:value="form.workOrderNumber" show-search option-filter-prop="label" :options="workOrders?.map(w => ({ value: w.workOrderNumber, label: w.workOrderNumber }))" @change="form.planNodeId = null" /></a-form-item>
      <a-form-item label="标题" required><a-input v-model:value="form.title" :maxlength="191" /></a-form-item>
      <a-form-item label="类别"><a-auto-complete v-model:value="form.category" :options="['原材料', '主要外购件', '其他外购件', '电器件', '液压件'].map(value => ({ value }))" /></a-form-item>
      <a-form-item label="所属总计划节点"><PlanNodeSelect v-model:value="form.planNodeId" :work-order-number="form.workOrderNumber" /></a-form-item>
      <a-form-item label="备注"><a-textarea v-model:value="form.note" :maxlength="500" /></a-form-item>
    </a-form>
  </a-modal>
  </div>
</template>
<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
