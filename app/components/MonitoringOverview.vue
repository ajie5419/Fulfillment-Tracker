<script setup lang="ts">
const props = defineProps<{ redOnly?: boolean }>()
const { data, error, pending, refresh } = await useFetch('/api/monitoring/status', { key: 'status-monitoring' })
const top = computed(() => data.value?.top.filter((e) => !props.redOnly || e.level === 'RED') ?? [])
</script>

<template>
  <UiSectionCard flat title="在制分布" sub="全部在履约工单 · 点击状态数字查看清单" class="monitoring-panel">
    <template #extra><UiRefreshButton :loading="pending" @click="refresh()" /></template>
    <a-result v-if="error" status="error" title="状态监控加载失败" :sub-title="apiError(error)">
      <template #extra><a-button @click="refresh()">重试</a-button></template>
    </a-result>
    <a-spin v-else :spinning="pending">
      <template v-if="data">
        <div class="distributions">
          <div>
            <h3>在制工序</h3>
            <div class="step-stats"><UiStatCard v-for="s in data.steps" :key="s.status" :label="s.label" :value="s.count" unit="道" :to="s.link" /></div>
          </div>
          <div>
            <h3>在制工件</h3>
            <UiStatCard v-for="s in data.parts" :key="s.status" :label="s.label" :value="s.count" unit="件" :to="s.link" />
          </div>
        </div>
        <h3 class="top-title">{{ redOnly ? '停滞红线' : '停滞清单' }} Top 10 <UiHelpTip>工件用 statusSince；工序用最近流转事件时间，无事件时依次取开工时间、创建时间。按上海自然日计算，含停工日。黄线 {{ data.threshold.yellowDays }} 天关注，红线 {{ data.threshold.redDays }} 天停滞并生成预警。下方按已停天数倒序。</UiHelpTip></h3>
        <MonitoringEntityList :rows="top" />
      </template>
    </a-spin>
  </UiSectionCard>
</template>

<style scoped>
.monitoring-panel { margin-bottom: 20px; }
h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ft-text); }
.distributions { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 1fr); gap: 16px; }
.step-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.top-title { display: flex; align-items: center; gap: 6px; margin-top: 16px; }
@media (max-width: 991px) { .distributions { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 575px) { .step-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
