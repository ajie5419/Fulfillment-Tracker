<script setup lang="ts">
import { MONITORING_PART_STATUSES, MONITORING_STEP_STATUSES, MONITORING_STATUS_TEXT, type MonitoringEntityType, type MonitoringStatus } from '#shared/monitoring'

const { data: me } = await useMe()
const route = useRoute()
const router = useRouter()
// URL 为筛选唯一来源，同页深链、前进 / 后退自然同步。
const redOnly = computed(() => route.query.level === 'RED')
const entityType = computed<MonitoringEntityType | undefined>(() => route.query.entityType === 'part' ? 'part' : route.query.entityType === 'step' ? 'step' : redOnly.value ? undefined : 'step')
const statusOptions = computed(() => (entityType.value === 'part' ? MONITORING_PART_STATUSES : entityType.value === 'step' ? MONITORING_STEP_STATUSES : [...MONITORING_STEP_STATUSES, ...MONITORING_PART_STATUSES]).map((value) => ({ value, label: MONITORING_STATUS_TEXT[value] })))
const entityOptions = computed(() => [...(redOnly.value ? [{ value: 'all', label: '全部在制' }] : []), { value: 'step', label: '在制工序' }, { value: 'part', label: '在制工件' }])
function changeRedOnly(value: boolean) {
  router.replace({ query: { ...route.query, level: value ? 'RED' : undefined, page: undefined } })
}
const status = computed(() => statusOptions.value.find((o) => o.value === route.query.status)?.value)
const positiveInt = (value: unknown, fallback: number) => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(+value) && +value > 0 ? +value : fallback
const page = computed(() => positiveInt(route.query.page, 1))
const pageSize = computed(() => Math.min(100, positiveInt(route.query.pageSize, 20)))
const query = computed(() => ({ entityType: entityType.value, status: status.value, level: redOnly.value ? 'RED' : undefined, page: page.value, pageSize: pageSize.value }))
const { data, pending, error, refresh } = await useFetch('/api/monitoring/entities', { query, immediate: !!me.value?.can.overview })
function changeEntity(value: MonitoringEntityType | undefined) {
  router.replace({ query: { ...route.query, entityType: value, status: undefined, page: undefined } })
}
function changeStatus(value: MonitoringStatus | undefined) {
  router.replace({ query: { ...route.query, status: value, page: undefined } })
}
function changePage(value: number, size: number) {
  router.replace({ query: { ...route.query, page: value, pageSize: size } })
}
</script>

<template>
  <a-result v-if="me && !me.can.overview" status="403" title="仅领导、项目部负责人和管理员可查看" />
  <div v-else>
  <MonitoringOverview v-if="me?.can.overview" :red-only="redOnly" />
  <UiSectionCard title="状态监控清单" :sub="`在制对象 ${error ? '—' : data?.total ?? '—'} 项 · 按已停天数倒序`">
    <template #extra><NuxtLink to="/board">返回项目总览</NuxtLink><UiRefreshButton :loading="pending" @click="refresh()" /></template>
    <div class="ft-toolbar">
      <a-segmented :value="entityType ?? 'all'" :options="entityOptions" @change="changeEntity($event === 'all' ? undefined : $event as MonitoringEntityType)" />
      <label class="red-filter"><a-switch :checked="redOnly" size="small" @change="changeRedOnly($event as boolean)" />只看红线</label>
      <a-select :value="status" :options="statusOptions" allow-clear placeholder="全部状态" aria-label="当前状态" class="status-filter" @change="changeStatus($event as MonitoringStatus | undefined)" />
    </div>
    <a-result v-if="error" status="error" title="清单加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
    <a-spin v-else :spinning="pending">
      <template v-if="data">
        <MonitoringEntityList :rows="data.rows" />
        <UiListPager :page="page" :page-size="pageSize" :total="data.total" :loading="pending" @change="changePage" />
      </template>
    </a-spin>
  </UiSectionCard>
  </div>
</template>

<style scoped>
.red-filter { display: inline-flex; align-items: center; gap: 6px; color: var(--ft-text-2); font-size: 13px; }
.status-filter { width: 160px; }
</style>
