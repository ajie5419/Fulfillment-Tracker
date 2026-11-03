<script setup lang="ts">
import type { PlanData } from '../../composables/usePlanData'
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const wo = computed(() => typeof route.query.wo === 'string' ? route.query.wo : '')
const { data, pending, error, refresh } = await useFetch<PlanData>('/api/plan', { query: computed(() => ({ workOrderNumber: wo.value })) })
</script>

<template>
  <div>
    <van-nav-bar title="项目计划 · 日期核查" left-arrow @click-left="navigateTo('/m/board')" />
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="error" image="error" description="计划加载失败"><van-button size="small" @click="refresh()">重试</van-button></van-empty>
    <div v-else-if="data" class="m-list">
      <div class="m-section">{{ data.workOrder.workOrderNumber }} {{ data.workOrder.projectName }}</div>
      <PlanDateConflicts :conflicts="data.dateConflicts" />
      <MCard>
        <div class="m-title">{{ data.plan?.status === 'PUBLISHED' ? '已发布' : '草稿' }}</div>
        <div class="m-meta">合同交期 {{ data.workOrder.deliveryDate ?? '—' }}</div>
        <div class="m-meta">预计交期 {{ data.expectedDelivery ?? '待核实' }}</div>
      </MCard>
      <MCard v-for="node in data.nodes" :key="node.id" :tone="node.dateConflict ? 'risk' : 'none'">
        <div class="m-title">{{ node.code }} {{ node.name }}</div>
        <div class="m-meta">计划开始 {{ node.startDate ?? '未填写' }} · 完成 {{ node.planDate }}</div>
        <div class="m-meta">预计开始 {{ node.expectedStartDate ?? '待核实 / 不适用' }} · 完成 {{ node.expectedDate }}（参考）</div>
        <div v-if="node.actualDate" class="m-meta">实际完成 {{ node.actualDate }}</div>
        <div v-if="node.slackDays != null" class="m-meta">余量 {{ node.slackDays }} 天</div>
      </MCard>
      <p class="m-hint">只读核查；编制、调整和发布请到电脑端项目计划。不会自动修改计划日期。</p>
    </div>
  </div>
</template>
