<script setup lang="ts">
/**
 * 发放签收（R9）：图纸、设计变更、工艺文件的发放单列表；按工单、类型、签收进度、我发出的/发给我的筛选。
 * 点一行打开详情抽屉（签收情况、签收/拒收、确认变更影响、作废）。地址栏 ?id= 直接打开某张，?wo= 预选工单。
 * 新建发放：技术部、管理员（权限方案 R13）。
 * 前端改版第二轮：顶部统计卡（全部 / 有人未签收 / 有拒收 / 待我签收，点了套用"签收进度"筛选；数字来自 GET /api/releases/stats，
 * 与列表同一范围、同一口径，不受进度筛选影响）；列表默认按工单分组（?layout=group|table），组标题带本组签收完成度。
 */
import { factoryDateTimeText, groupByWorkOrder, groupProgress } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const { data: workOrders, pending: ordersPending, error: ordersError, refresh: refreshOrders } = await useWorkOrders()
const { data: me, error: meError, refresh: refreshMe } = await useMe()

const filter = reactive({
  workOrderNumber: (route.query.wo as string) || undefined,
  type: (route.query.type as string) || undefined,
  progress: (route.query.progress as string) || undefined,
  mine: (route.query.mine as string) || '',
})
const { data: rows, pending, error, refresh: refreshRows } = await useFetch('/api/releases', {
  query: computed(() => ({ ...filter, mine: filter.mine || undefined })),
  default: () => [],
})
const { data: stats, pending: statsPending, error: statsError, refresh: refreshStats } = await useFetch('/api/releases/stats', {
  query: computed(() => ({ workOrderNumber: filter.workOrderNumber, type: filter.type, mine: filter.mine || undefined })),
  default: () => null,
})
const { state } = useRequestState({ pending, error }, () => !rows.value.length)
const { displayStat } = useRequestState({ pending: statsPending, error: statsError }, () => !stats.value)
async function refresh() {
  await Promise.all([refreshRows(), refreshStats()])
}
watch(
  () => [filter.workOrderNumber, filter.type, filter.progress, filter.mine],
  () => router.replace({ query: { ...route.query, wo: filter.workOrderNumber || undefined, type: filter.type, progress: filter.progress, mine: filter.mine || undefined } }),
)

// ───── 统计卡、按工单分组 ─────
/** 点统计卡：套用签收进度筛选；再点一次取消 */
const applyProgress = (p: string | undefined) => (filter.progress = filter.progress === p ? undefined : p)
const layout = useListLayout()
type Row = (typeof rows.value)[number]
const tables = computed(() =>
  layout.value === 'group' ? groupByWorkOrder(rows.value).map((g) => ({ key: g.workOrderNumber, ...g })) : [{ key: '__all', workOrderNumber: '', rows: rows.value }],
)
/** 本组签收完成度：已全部签收的发放单 / 未作废的发放单 */
const signedOf = (g: { rows: Row[] }) => groupProgress(g.rows, (r) => r.status === 'ACTIVE' && r.total > 0 && r.counts.SIGNED === r.total, (r) => r.status !== 'VOID')

const selected = ref<string | null>((route.query.id as string) || null)
// 页面没换、只换了 ?id=（从提醒或别的链接跳过来）时也要跟着打开
watch(
  () => route.query.id,
  (id) => {
    const v = (id as string) || null
    if (v !== selected.value) selected.value = v
  },
)
watch(selected, (id) => {
  if (import.meta.client) router.replace({ query: { ...route.query, id: id || undefined } })
})
const rowProps = (r: Record<string, unknown>) => ({ onClick: () => (selected.value = String(r.id)), style: 'cursor: pointer' })

const creating = ref(false)
async function created(id: string) {
  creating.value = false
  await refresh()
  selected.value = id
}

const typeOptions = Object.entries(RELEASE_TYPE_TEXT).map(([value, label]) => ({ value, label }))
const progressOptions = [
  { value: 'PENDING', label: '有人未签收' },
  { value: 'REJECTED', label: '有拒收' },
  { value: 'MINE_PENDING', label: '待我签收' },
  { value: 'VOID', label: '已作废' },
]
const columns = [
  { title: '编号', key: 'releaseNo', width: 150 },
  { title: '类型', key: 'type', width: 100 },
  { title: '工单', key: 'wo', width: 140 },
  { title: '工件 / 版本', key: 'parts', width: 200 },
  { title: '说明', key: 'description' },
  { title: '发放人', dataIndex: 'issuerName', width: 100 },
  { title: '签收', key: 'progress', width: 150 },
  { title: '发放时间', key: 'createdAt', width: 165 },
]
const groupColumns = columns.filter((c) => c.key !== 'wo')
</script>

<template>
  <div>
  <div class="ft-page">
  <div class="ft-stats">
    <UiStatCard label="发放单" :value="displayStat(stats?.all)" unit="张" tone="primary" accent icon="dot" clickable :active="!filter.progress" sub="当前工单 / 类型 / 范围下全部" @click="filter.progress = undefined" />
    <UiStatCard label="有人未签收" :value="displayStat(stats?.pending)" unit="张" tone="risk" accent icon="warn" clickable :active="filter.progress === 'PENDING'" sub="超时没签收按 W5 预警" @click="applyProgress('PENDING')" />
    <UiStatCard label="有拒收" :value="displayStat(stats?.rejected)" unit="张" tone="late" accent icon="alert" clickable :active="filter.progress === 'REJECTED'" sub="接收人拒收，需发放人处理" @click="applyProgress('REJECTED')" />
    <UiStatCard label="待我签收" :value="displayStat(stats?.minePending)" unit="张" tone="upstream" accent icon="warn" clickable :active="filter.progress === 'MINE_PENDING'" sub="发给我、我还没签收的" @click="applyProgress('MINE_PENDING')" />
  </div>
  <a-spin v-if="statsPending" />
  <a-alert v-else-if="statsError" type="error" message="发放统计加载失败" :description="apiError(statsError)"><template #action><a-button @click="refreshStats()">重试</a-button></template></a-alert>
  <a-alert v-if="ordersError" type="error" message="工单选项加载失败" :description="apiError(ordersError)"><template #action><a-button @click="refreshOrders()">重试</a-button></template></a-alert>
  <a-alert v-if="meError" type="error" message="用户权限加载失败" :description="apiError(meError)"><template #action><a-button @click="refreshMe()">重试</a-button></template></a-alert>
  <a-card>
    <div class="ft-toolbar">
      <a-segmented v-model:value="filter.mine" :options="[{ value: '', label: '全部' }, { value: 'received', label: '发给我的' }, { value: 'issued', label: '我发出的' }]" />
      <div class="ft-toolbar-right">
        <a-select
          v-model:value="filter.workOrderNumber"
          :loading="ordersPending" :disabled="!!ordersError"
          allow-clear
          show-search
          placeholder="全部工单"
          style="width: 168px"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber }))"
        />
        <a-select v-model:value="filter.type" allow-clear placeholder="全部类型" style="width: 116px" :options="typeOptions" />
        <a-select v-model:value="filter.progress" allow-clear placeholder="全部进度" style="width: 122px" :options="progressOptions" />
        <a-segmented v-model:value="layout" :options="LAYOUT_OPTIONS" />
        <UiRefreshButton @click="refresh()" />
        <a-button v-if="canDo(me, 'release')" type="primary" class="ft-btn-ink" @click="creating = true">新建发放</a-button>
      </div>
    </div>
    <a-spin v-if="state === 'loading'" />
    <a-result v-else-if="state === 'error'" status="error" title="发放单加载失败" :sub-title="apiError(error)"><template #extra><a-button @click="refreshRows()">重试</a-button></template></a-result>
    <a-empty v-else-if="state === 'empty'" :description="filter.progress ? '没有符合条件的发放单' : '还没有发放单'" />
    <template v-else>
    <div v-for="t in tables" :key="t.key" :class="{ 'ft-wo-group': layout === 'group' }">
    <UiWoGroupHead v-if="layout === 'group'" :no="t.workOrderNumber" v-bind="signedOf(t)" label="已全部签收" :count="t.rows.length" unit="张" />
    <a-table
      class="ft-table"
      :columns="layout === 'group' ? groupColumns : columns"
      :data-source="t.rows"
      :loading="pending"
      row-key="id"
      size="small"
      :custom-row="rowProps"
      :scroll="{ x: 1000 }"
      :pagination="layout === 'group' ? false : { pageSize: 50, hideOnSinglePage: true }"
    >
      <template #emptyText><a-empty description="还没有发放单" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'releaseNo'">
          {{ record.releaseNo }}
          <a-tag v-if="record.myStatus === 'PENDING'" color="orange">待我签收</a-tag>
        </template>
        <template v-else-if="column.key === 'type'">
          <a-tag :color="RELEASE_TYPE_COLOR[record.type as ReleaseTypeKey]">{{ record.typeText }}</a-tag>
          <a-tag v-if="record.heldSteps" color="purple">等变更 {{ record.heldSteps }}</a-tag>
        </template>
        <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
        <template v-else-if="column.key === 'parts'">
          {{ partsText(record.parts) || '—' }}
          <div v-if="record.version" class="muted">版本 {{ record.version }}</div>
        </template>
        <template v-else-if="column.key === 'description'"><span class="desc">{{ record.description }}</span></template>
        <template v-else-if="column.key === 'progress'">
          <a-tag :color="PROGRESS_COLOR[record.progressText]">{{ record.progressText }}</a-tag>
          <span class="muted">{{ record.counts.SIGNED }}/{{ record.total }}</span>
        </template>
        <template v-else-if="column.key === 'createdAt'">{{ factoryDateTimeText(record.createdAt) }}</template>
      </template>
    </a-table>
    </div>
    </template>
  </a-card>
  </div>

  <ReleaseCreateModal :open="creating" :work-order-number="filter.workOrderNumber" @close="creating = false" @done="created" />
  <ReleaseDrawer :id="selected" @close="selected = null" @changed="refresh()" />
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
