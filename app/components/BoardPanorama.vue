<script setup lang="ts">
import { woStatusText } from '#shared/status'
import { aggregatePanorama, filterPanoramaRows, PANORAMA_METRICS, type PanoramaMetric } from '#shared/panorama'

const props = defineProps<{ mobile?: boolean; listOnly?: boolean }>()
const route = useRoute()
const router = useRouter()
const { data, pending, error, refresh } = await useApiFetch('/api/board', { query: { closed: '1' }, key: 'board:panorama' })
const rows = computed(() => data.value?.rows ?? [])
const stats = computed(() => aggregatePanorama(rows.value))
const selected = computed(() => filterPanoramaRows(rows.value, route.query))
const metric = computed(() => PANORAMA_METRICS.find(item => item.value === route.query.metric) ?? PANORAMA_METRICS[0])
const groups = computed(() => [
  { title: '按项目经理', items: stats.value.byManager.map(item => ({ key: item.projectManagerId ?? '', label: item.projectManagerName, inProgress: item.inProgress, abnormal: item.abnormal })), field: 'manager' },
  { title: '按产品线', items: stats.value.byProductLine.map(item => ({ key: item.productLine ?? '', label: item.productLine || '未指定产品线', inProgress: item.inProgress, abnormal: item.abnormal })), field: 'productLine' },
])
const scopeText = computed(() => [
  typeof route.query.manager === 'string' ? `项目经理：${stats.value.byManager.find(item => (item.projectManagerId ?? '') === route.query.manager)?.projectManagerName ?? '无匹配'}` : '',
  typeof route.query.productLine === 'string' ? `产品线：${route.query.productLine || '未指定'}` : '',
].filter(Boolean).join('；'))
function drill(value: PanoramaMetric, group?: { field: string; key: string }) {
  void router.replace({ query: { ...route.query, view: props.mobile ? 'orders' : 'panorama', metric: value, manager: undefined, productLine: undefined, ...(group ? { [group.field]: group.key } : {}) }, hash: '#panorama-orders' })
}
function processing(workOrderNumber: string) {
  return { path: props.mobile ? '/m/issues' : '/risks', query: { ...(props.mobile ? { workOrderNumber } : { wo: workOrderNumber }), tab: 'all', dept: '0', returnTo: route.fullPath } }
}
defineExpose({ refresh })
</script>

<template>
  <section class="panorama">
    <div v-if="mobile" class="m-section">全盘统计 <van-button size="mini" :loading="pending" @click="refresh()">刷新</van-button></div>
    <UiPageHero v-else title="全盘统计" summary="当前可见工单的规模与健康度，不是预警或异常事项数量" />
    <p :class="mobile ? 'm-hint' : 'ft-muted'">范围：当前账号可见、未删除工单，含已完工；已取消不计数。在制仅 IN_PROGRESS，未开工仅 OPEN。有风险指在制工单非绿色，不等于预警／异常事项数。</p>
    <template v-if="error">
      <van-empty v-if="mobile" image="error" description="全盘统计加载失败"><van-button size="small" @click="refresh()">重试</van-button></van-empty>
      <a-result v-else status="error" title="全盘统计加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refresh()">重试</a-button></template></a-result>
    </template>
    <template v-else>
      <div v-if="!listOnly" class="counts">
        <template v-for="item in PANORAMA_METRICS" :key="item.value">
          <van-cell v-if="mobile" :title="item.label" :value="pending ? '—' : stats.counts[item.value]" is-link @click="drill(item.value)" />
          <UiStatCard v-else :label="item.label" :value="pending ? '—' : stats.counts[item.value]" unit="个" clickable @click="drill(item.value)" />
        </template>
        <van-cell v-if="mobile" title="未验收" value="待接入" />
        <UiStatCard v-else label="未验收" value="待接入" sub="现场验收数据尚未接入" />
      </div>
      <p v-if="pending" role="status" class="ft-muted">正在加载可见工单…</p>
      <template v-else>
        <div v-if="!listOnly" class="distributions">
          <div v-for="group in groups" :key="group.field">
            <template v-if="mobile">
              <h2 class="m-section">{{ group.title }}</h2>
              <div v-for="item in group.items" :key="item.key" class="group-row">
                <van-cell :title="item.label" :value="`在制 ${item.inProgress}`" is-link @click="drill('inProgress', { field: group.field, key: item.key })" />
                <van-button size="small" plain @click="drill('abnormal', { field: group.field, key: item.key })">有风险 {{ item.abnormal }}</van-button>
              </div>
              <p v-if="!group.items.length" class="m-hint">当前范围暂无工单</p>
            </template>
            <UiSectionCard v-else :title="group.title" sub="点击在制数或风险数查看工单" flat>
              <UiListItem v-for="item in group.items" :key="item.key" compact>
                <template #title>{{ item.label }}</template>
                <template #extra>
                  <a-button type="link" @click="drill('inProgress', { field: group.field, key: item.key })">在制 {{ item.inProgress }}</a-button>
                  <a-button type="link" @click="drill('abnormal', { field: group.field, key: item.key })">有风险 {{ item.abnormal }}</a-button>
                </template>
              </UiListItem>
              <p v-if="!group.items.length" class="ft-muted">当前范围暂无工单</p>
            </UiSectionCard>
          </div>
        </div>
        <div id="panorama-orders">
          <div :class="mobile ? 'm-section' : 'list-head'">
            <h2>{{ metric.label }} · {{ selected.length }} 个</h2>
            <span>{{ scopeText || '全部可见范围' }}</span>
            <van-button v-if="mobile && scopeText" size="small" @click="drill(metric.value)">清除分组</van-button>
            <a-button v-else-if="scopeText" size="small" @click="drill(metric.value)">清除分组</a-button>
          </div>
          <p v-if="!selected.length" :class="mobile ? 'm-hint' : 'ft-muted'">此条件下没有可见工单，可切换统计条件。</p>
          <template v-for="row in selected" :key="row.workOrderNumber">
            <MCard v-if="mobile" :tone="row.color === 'GREEN' ? 'done' : row.color === 'RED' ? 'late' : 'risk'">
              <div class="m-title">{{ row.workOrderNumber }} {{ row.projectName }}</div>
              <div class="m-meta">{{ woStatusText(row.status) }} · {{ row.projectManagerName || '未指定项目经理' }}</div>
              <PlanDateConflicts :conflicts="row.dateConflicts" />
              <div class="order-actions">
                <NuxtLink :to="`/m/plan?wo=${encodeURIComponent(row.workOrderNumber)}`">计划日期核查</NuxtLink>
                <NuxtLink :to="`/wo/${encodeURIComponent(row.workOrderNumber)}`">工单详情</NuxtLink>
                <NuxtLink :to="processing(row.workOrderNumber)">处理异常事项（{{ row.openIssues }}）</NuxtLink>
              </div>
            </MCard>
            <UiListItem v-else compact>
              <template #title><NuxtLink :to="`/wo/${encodeURIComponent(row.workOrderNumber)}`">{{ row.workOrderNumber }} {{ row.projectName }}</NuxtLink></template>
              <template #desc>{{ woStatusText(row.status) }} · {{ row.projectManagerName || '未指定项目经理' }}</template>
              <template #extra><NuxtLink :to="processing(row.workOrderNumber)">预警与异常处理（未关闭异常 {{ row.openIssues }}）</NuxtLink></template>
            </UiListItem>
          </template>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.panorama { display: grid; gap: 16px; min-width: 0; }
.counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.distributions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.list-head { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
h2 { font-size: 16px; margin: 0; }
.group-row { display: flex; align-items: center; background: var(--ft-card-bg); }
.group-row :deep(.van-cell) { min-width: 0; }
.group-row :deep(.van-button) { flex-shrink: 0; margin-right: 8px; }
.order-actions { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; }
@media (max-width: 767px) {
  .counts, .distributions { grid-template-columns: minmax(0, 1fr); }
  .counts { gap: 0; }
  .panorama { gap: 12px; }
  .panorama :deep(.m-title), .panorama :deep(.m-meta) { overflow-wrap: anywhere; }
}
</style>
