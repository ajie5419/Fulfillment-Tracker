<script setup lang="ts">
import { cockpitMetrics, mergeCockpitItems, OVERDUE_ISSUES_LINK, RED_WORK_ORDERS_LINK } from '#shared/board-cockpit'
import type { MonitoredEntity } from '#shared/monitoring'

async function fetchAllRedEntities(): Promise<MonitoredEntity[]> {
  // SSR 时 $fetch 不会自动带上浏览器的会话 cookie，必须显式透传，否则接口会判未登录
  const headers = useRequestHeaders(['cookie'])
  const all: MonitoredEntity[] = []
  let page = 1
  const pageSize = 100
  while (true) {
    const res = await $fetch<{ asOf: string; threshold: unknown; total: number; rows: MonitoredEntity[] }>(
      '/api/monitoring/entities',
      { query: { level: 'RED', page, pageSize }, headers },
    )
    const rows = res?.rows ?? []
    all.push(...rows)
    if (!rows.length || all.length >= (res?.total ?? 0) || rows.length < pageSize) {
      break
    }
    page++
  }
  return all
}

const [overview, monitoring, releases, issues, stagnationEntities] = await Promise.all([
  useFetch('/api/overview', { key: 'overview' }),
  useFetch('/api/monitoring/status', { key: 'status-monitoring' }),
  useFetch('/api/releases/stats', { key: 'cockpit-releases' }),
  useFetch('/api/issues', { key: 'cockpit-issues', query: { overdue: '1', dept: '0', status: 'UNCLOSED' } }),
  useAsyncData('cockpit-stagnation-entities', fetchAllRedEntities),
])
const sources = [
  { name: '工单与异常统计', ...overview },
  { name: '监控汇总', ...monitoring },
  { name: '停滞红线', ...stagnationEntities },
  { name: '发放统计', ...releases },
  { name: '超期异常清单', ...issues },
]
const failures = computed(() => sources.filter((s) => s.error.value))
const loading = computed(() => sources.some((s) => s.pending.value))
const metrics = computed(() => cockpitMetrics(
  overview.error.value ? null : overview.data.value,
  releases.error.value ? null : releases.data.value,
  monitoring.error.value ? null : monitoring.data.value,
))
const items = computed(() => mergeCockpitItems({
  redWorkOrders: overview.error.value ? [] : overview.data.value?.redWorkOrders ?? [],
  issues: issues.error.value ? [] : issues.data.value ?? [],
  stagnation: stagnationEntities.error.value ? [] : stagnationEntities.data.value ?? [],
}))
const stages = computed(() => overview.data.value?.stages ?? [])
const topStage = computed(() => [...stages.value].sort((a, b) => b.count - a.count)[0])
const stageRiskLinks: Record<string, string> = {
  drawing: '/risks?tab=alerts&rule=W7', shortage: '/risks?tab=alerts&rule=W6',
  outsource: '/risks?tab=alerts&rule=W3', kitting: '/risks?tab=alerts&rule=W8', issue: OVERDUE_ISSUES_LINK,
}
const stageBars = computed(() => stages.value.map((s) => ({ key: s.key, label: s.label, value: s.count, to: s.link })))
async function refresh() {
  await Promise.all(sources.map((s) => s.refresh()))
}
defineExpose({ refresh })
</script>

<template>
  <div class="cockpit">
    <div class="cockpit-primary">
      <div class="cockpit-metrics">
        <UiStatCard v-for="m in metrics" :key="m.key" :label="m.label" :value="m.value" :unit="m.unit" :tone="m.tone" :to="m.to">
          <template v-if="m.key === 'red' && !overview.error.value && overview.data.value?.redStages.length" #sub>
            <span class="red-stages"><UiStatusTag v-for="s in overview.data.value.redStages" :key="s.key" tone="late">{{ s.label }} {{ s.count }}</UiStatusTag></span>
          </template>
        </UiStatCard>
      </div>
      <UiSectionCard title="今天盯什么 · 红色清单" class="cockpit-list" padding="tight">
        <template #title>
          今天盯什么 · 红色清单
          <UiHelpTip>一单一行；主问题优先级红色工单 → 超期异常 → 停滞红线；同一工单的其他问题以胶囊列在同行、可点进各自详情；最多 10 单。停滞按 W11 上海自然日计算，包含停工日。</UiHelpTip>
        </template>
        <template #extra>
          <NuxtLink :to="RED_WORK_ORDERS_LINK">全部红色工单</NuxtLink>
          <NuxtLink :to="OVERDUE_ISSUES_LINK">全部超期异常</NuxtLink>
          <NuxtLink to="/monitoring">查看全部监控</NuxtLink>
        </template>
        <div v-for="source in failures" :key="source.name" class="source-error" role="alert">
          {{ source.name }}加载失败：{{ apiError(source.error.value) }}
          <a-button size="small" @click="source.refresh()">重试</a-button>
        </div>
        <a-spin :spinning="loading">
          <div class="ft-well list">
            <UiListItem v-for="item in items" :key="item.key" tone="late" compact :data-kind="item.kind">
              <template #title>
                <template v-if="item.workOrder">
                  <NuxtLink :to="item.to">{{ item.workOrderNumber }} · {{ item.title }}</NuxtLink>
                  <span v-if="(item.workOrder.delayDays ?? 0) > 0" class="ft-text-late">晚 {{ item.workOrder.delayDays }} 天</span>
                </template>
                <template v-else><UiStatusTag tone="late">{{ item.label }}</UiStatusTag><NuxtLink :to="item.to">{{ item.title }}</NuxtLink></template>
              </template>
              <template v-if="item.workOrder || item.detail || item.also.length" #desc>
                <div class="cockpit-capsule-row">
                  <WoStatusCapsules v-if="item.workOrder" :row="item.workOrder" :to="item.to" />
                  <UiStatusTag v-else-if="item.detail" tone="late">{{ item.detail }}</UiStatusTag>
                  <span v-if="item.also.length" class="also-capsules">
                    <NuxtLink
                      v-for="c in item.also"
                      :key="c.key"
                      :to="c.to"
                      class="also-capsule-link"
                      :title="c.title + (c.detail ? ' · ' + c.detail : '')"
                    >
                      <UiStatusTag tone="late">{{ c.label }} {{ c.duration }}</UiStatusTag>
                    </NuxtLink>
                  </span>
                </div>
              </template>
              <template v-if="!item.workOrder" #meta><WoLink :no="item.workOrderNumber" /> · 责任方：{{ item.responsibility }}</template>
              <template v-if="!item.workOrder" #extra><UiStatusTag tone="late">{{ item.duration }}</UiStatusTag></template>
            </UiListItem>
            <p v-if="!items.length && !loading" class="ft-muted">{{ failures.length ? '清单数据尚未完整加载，请重试' : '暂无需要关注的红色事项' }}</p>
          </div>
        </a-spin>
      </UiSectionCard>
    </div>
    <div class="cockpit-secondary">
      <p class="week-summary">
        本周新增异常 <b>{{ overview.error.value ? '—' : overview.data.value?.summary.newIssues ?? '—' }}</b> ·
        本周关闭异常 <b>{{ overview.error.value ? '—' : overview.data.value?.summary.closedIssues ?? '—' }}</b> ·
        卡点最多环节：<span v-if="overview.error.value || !overview.data.value">—</span>
        <NuxtLink v-else-if="topStage && topStage.count > 0" :to="stageRiskLinks[topStage.key] ?? '/risks'">{{ topStage.label }} {{ topStage.count }}</NuxtLink>
        <span v-else>暂无卡点</span>
      </p>
      <UiSectionCard v-if="overview.data.value && !overview.error.value" title="卡点分布" padding="tight">
        <div class="ft-well compact-stage"><UiColumnChart :items="stageBars" highlight="late" :height="140" /></div>
      </UiSectionCard>
    </div>
  </div>
</template>

<style scoped>
.cockpit-primary { min-height: calc(100dvh - 128px); display: flex; flex-direction: column; gap: 16px; padding-bottom: 16px; }
.cockpit-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
.red-stages { display: flex; flex-wrap: wrap; gap: 4px; }
.cockpit-list { overflow-wrap: anywhere; }
.cockpit-list :deep(.ft-li) { padding: 10px 0; }
.cockpit-list :deep(.extra) { color: var(--ft-late-text); }
.cockpit-capsule-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.also-capsules { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.also-capsule-link { display: inline-flex; text-decoration: none; }
.also-capsule-link:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 999px; }
.also-capsule-link:hover :deep(.ft-status-tag) { opacity: 0.88; }
.source-error { margin-bottom: 8px; color: var(--ft-late-text); }
.week-summary { margin: 0 0 12px; color: var(--ft-text-2); }
.compact-stage { height: 180px; }
@media (max-width: 991px) { .cockpit-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 575px) {
  .cockpit-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .cockpit-list :deep(.ft-li) { flex-wrap: wrap; }
  .cockpit-list :deep(.main) { flex: 1 0 calc(100% - 48px); }
  .cockpit-list :deep(.extra) { margin-left: 48px; }
}
</style>
