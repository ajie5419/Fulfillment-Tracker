<script setup lang="ts">
/**
 * 工单详情入口：选一个工单（可搜索，按工单号 / 项目 / 客户），选中跳到 /wo/:no。
 * 只列当前用户可见的工单（与 /api/work-orders 一致）。
 */
const { data: workOrders, pending } = await useWorkOrders()
const picked = ref<string | undefined>()
const options = computed(() =>
  workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName ?? ''}　交期 ${dayText(w.deliveryDate)}` })),
)
watch(picked, (no) => {
  if (no) navigateTo(`/wo/${encodeURIComponent(no)}`)
})
</script>

<template>
  <div class="page">
    <h1 class="page-title">工单详情</h1>
    <UiSectionCard title="选择工单" sub="一个工单的总计划、各部门进度、预警和异常都在详情页里">
      <a-select
        v-model:value="picked"
        show-search
        option-filter-prop="label"
        placeholder="输入工单号、项目或客户搜索"
        :loading="pending"
        :options="options"
        size="large"
        class="picker"
        :not-found-content="pending ? '加载中…' : '没有可见的工单'"
      />
      <div class="recent">
        <span class="ft-muted">交期最近的：</span>
        <WoLink v-for="w in workOrders.slice(0, 8)" :key="w.workOrderNumber" :no="w.workOrderNumber" class="chip" />
      </div>
    </UiSectionCard>
  </div>
</template>

<style scoped>
.page-title { font-size: 22px; font-weight: 600; margin: 8px 0 16px; color: var(--ft-text); }
.picker { width: 100%; max-width: 560px; }
.recent { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
</style>
