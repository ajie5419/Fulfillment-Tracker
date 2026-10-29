<script setup lang="ts">
import { MONITORING_PART_STATUSES, MONITORING_STEP_STATUSES, MONITORING_STATUS_TEXT, type MonitoringEntityType, type MonitoringStatus } from '#shared/monitoring'

const { data: me } = await useMe()
const route = useRoute()
const router = useRouter()
// URL 为筛选唯一来源，同页深链、前进 / 后退自然同步。
const entityType = computed<MonitoringEntityType>(() => route.query.entityType === 'part' ? 'part' : 'step')
const statusOptions = computed(() => (entityType.value === 'part' ? MONITORING_PART_STATUSES : MONITORING_STEP_STATUSES).map((value) => ({ value, label: MONITORING_STATUS_TEXT[value] })))
const status = computed(() => statusOptions.value.find((o) => o.value === route.query.status)?.value)
const positiveInt = (value: unknown, fallback: number) => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(+value) && +value > 0 ? +value : fallback
const page = computed(() => positiveInt(route.query.page, 1))
const pageSize = computed(() => Math.min(100, positiveInt(route.query.pageSize, 20)))
const query = computed(() => ({ entityType: entityType.value, status: status.value, page: page.value, pageSize: pageSize.value }))
const { data, pending, error, refresh } = await useFetch('/api/monitoring/entities', { query, immediate: !!me.value?.can.overview })
function changeEntity(value: MonitoringEntityType) {
  router.replace({ query: { entityType: value } })
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
  <UiSectionCard v-else title="状态监控清单" :sub="`在制对象 ${error ? '—' : data?.total ?? '—'} 项 · 按已停天数倒序`">
    <template #extra><NuxtLink to="/board">返回项目总览</NuxtLink><UiRefreshButton :loading="pending" @click="refresh()" /></template>
    <div class="ft-toolbar">
      <a-segmented :value="entityType" :options="[{ value: 'step', label: '在制工序' }, { value: 'part', label: '在制工件' }]" @change="changeEntity($event as MonitoringEntityType)" />
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
</template>

<style scoped>
.status-filter { width: 160px; }
</style>
