<script setup lang="ts">
/**
 * 项目计划（zhao 10-22：总计划从工单详情里拿出来，单独成菜单页；工单详情只留概览）。
 *   不带 ?wo：全部在做工单的计划一览——统计卡（已发布 / 草稿 / 未编制 / 交期风险，点了按它筛选）+ 表格
 *     （计划状态、节点完成、待确认、未分解、源头延误、预计交期），点一行进该工单的计划。
 *   带 ?wo（&node= 定位节点）：该工单的总计划编制 / 发布 / 调整 / 确认 / 分解（PlanEditor）。
 *   提醒、待办、W9 通知里的链接一直是 /plan?wo=&node=，直接落在这里；旧的 /wo/:no?tab=plan 跳过来。
 */
import type { PlanListStatus } from '~~/server/services/plan/list'

const route = useRoute()
const router = useRouter()
const wo = computed(() => (typeof route.query.wo === 'string' ? route.query.wo : ''))
useHead({ title: computed(() => (wo.value ? `${wo.value} · 项目计划` : '项目计划')) })

// ───── 一览 ─────
const showClosed = computed({
  get: () => route.query.closed === '1',
  set: (v: boolean) => void router.replace({ query: { ...route.query, closed: v ? '1' : undefined } }),
})
const { data, pending, error, refresh } = await useFetch('/api/plan/list', {
  query: computed(() => (showClosed.value ? { closed: '1' } : {})),
  default: () => ({ rows: [], summary: { total: 0, published: 0, draft: 0, none: 0, late: 0, unsplit: 0 } }),
  immediate: !wo.value,
  watch: [showClosed],
})
// 从某个工单的计划返回一览时再取（进页面时带着 ?wo 就没取过）
watch(wo, (v, old) => {
  if (!v && old) refresh()
})
type Row = (typeof data.value.rows)[number]

type Filter = 'all' | 'PUBLISHED' | 'DRAFT' | 'NONE' | 'late'
const FILTERS: Filter[] = ['all', 'PUBLISHED', 'DRAFT', 'NONE', 'late']
const filter = computed<Filter>({
  get: () => (FILTERS.includes(route.query.status as Filter) ? (route.query.status as Filter) : 'all'),
  set: (v) => void router.replace({ query: { ...route.query, status: v === 'all' ? undefined : v } }),
})
const toggle = (v: Filter) => (filter.value = filter.value === v ? 'all' : v)
const isLate = (r: Row) => (r.delayDays ?? 0) > 0 || r.sourceNodes > 0
const rows = computed(() => {
  const f = filter.value
  const list = data.value.rows.filter((r) => (f === 'all' ? true : f === 'late' ? isLate(r) : r.status === f))
  // 在做的在前；同组按交期（服务端已按交期排）
  return [...list.filter((r) => !r.closed), ...list.filter((r) => r.closed)]
})

const STATUS_TEXT: Record<PlanListStatus, string> = { PUBLISHED: '已发布', DRAFT: '草稿', NONE: '未编制' }
const STATUS_TONE: Record<PlanListStatus, 'done' | 'primary' | 'none'> = { PUBLISHED: 'done', DRAFT: 'primary', NONE: 'none' }

const woOptions = computed(() => data.value.rows.map((r) => ({ value: r.workOrderNumber, label: `${r.workOrderNumber}　${r.projectName ?? r.customerName ?? ''}` })))
function openPlan(no: unknown) {
  if (typeof no === 'string' && no) navigateTo({ path: '/plan', query: { wo: no } })
}
const customRow = (r: Row) => ({ class: 'click-row', onClick: () => openPlan(r.workOrderNumber) })

const columns = [
  { title: '工单', key: 'wo', width: 200 },
  { title: '项目经理', key: 'pm', width: 96 },
  { title: '合同交期', key: 'delivery', width: 104 },
  { title: '计划状态', key: 'status', width: 150 },
  { title: '节点完成', key: 'nodes', width: 90, align: 'center' as const },
  { title: '待确认', key: 'confirm', width: 76, align: 'center' as const },
  { title: '未分解', key: 'unsplit', width: 76, align: 'center' as const },
  { title: '源头延误', key: 'source', width: 86, align: 'center' as const },
  { title: '预计交期', key: 'expected', width: 120 },
  { title: '', key: 'op', width: 104, fixed: 'right' as const },
]
const enc = encodeURIComponent
</script>

<template>
  <div class="page">
    <!-- 某个工单的计划 -->
    <template v-if="wo">
      <div class="topbar">
        <div class="crumbs">
          <NuxtLink to="/plan">项目计划</NuxtLink><span class="sep">/</span><span>{{ wo }}</span>
        </div>
        <NuxtLink :to="`/wo/${enc(wo)}`">工单详情 ›</NuxtLink>
      </div>
      <!-- key：换工单时重建，避免上一个工单打开的编辑框（节点 ID）带到新工单里被保存 -->
      <PlanEditor :key="wo" :wo="wo" />
    </template>

    <!-- 一览 -->
    <template v-else>
      <div class="page-head">
        <h1 class="page-title">
          项目计划
          <UiHelpTip>每个工单一份总计划：项目经理、项目部按模板编制、发布、调整；责任部门负责人确认节点，并在节点下分解部门任务。点一行进入该工单的计划。</UiHelpTip>
        </h1>
        <div class="tools">
          <a-select
            :value="undefined"
            show-search
            option-filter-prop="label"
            placeholder="搜工单号 / 项目"
            :options="woOptions"
            class="wo-search"
            aria-label="搜工单进计划"
            :not-found-content="'没有可见的工单'"
            @change="openPlan"
          />
          <label class="closed-switch"><a-switch v-model:checked="showClosed" size="small" />显示已完工</label>
          <UiRefreshButton @click="refresh()" />
        </div>
      </div>

      <!-- 取不到数据时明确说加载失败，不把默认的空列表当成"没有工单" -->
      <a-result v-if="error" status="error" title="项目计划加载失败" :sub-title="apiError(error)">
        <template #extra><a-button type="primary" @click="refresh()">重试</a-button></template>
      </a-result>
      <template v-else>
      <div class="ft-stats summary">
        <UiStatCard label="已发布" :value="data.summary.published" unit="个工单" tone="done" icon="check" clickable :active="filter === 'PUBLISHED'" @click="toggle('PUBLISHED')" />
        <UiStatCard label="草稿" :value="data.summary.draft" unit="个工单" tone="primary" icon="dot" clickable :active="filter === 'DRAFT'" @click="toggle('DRAFT')" />
        <UiStatCard label="未编制" :value="data.summary.none" unit="个工单" tone="none" icon="ring" clickable :active="filter === 'NONE'" @click="toggle('NONE')" />
        <UiStatCard label="交期风险" :value="data.summary.late" unit="个工单" tone="late" icon="alert" sub="预计拖期或有源头延误节点" clickable :active="filter === 'late'" @click="toggle('late')" />
      </div>

      <UiSectionCard padding="none">
        <div class="ft-toolbar bar">
          <a-segmented
            v-model:value="filter"
            :options="[{ value: 'all', label: '全部' }, { value: 'PUBLISHED', label: '已发布' }, { value: 'DRAFT', label: '草稿' }, { value: 'NONE', label: '未编制' }, { value: 'late', label: '交期风险' }]"
          />
          <span class="ft-muted small">共 {{ rows.length }} 个工单<template v-if="data.summary.unsplit"> · {{ data.summary.unsplit }} 个工单还有未分解的节点</template></span>
        </div>
        <a-table class="ft-table" :columns="columns" :data-source="rows" row-key="workOrderNumber" size="middle" :loading="pending" :pagination="false" :custom-row="customRow" :scroll="{ x: 1090 }">
          <template #emptyText><a-empty :description="filter === 'all' ? '没有在做的工单' : '没有符合条件的工单'" /></template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'wo'">
              <NuxtLink :to="{ path: '/plan', query: { wo: record.workOrderNumber } }" @click.stop>{{ record.workOrderNumber }}</NuxtLink>
              <div class="ft-muted small ellipsis">{{ record.projectName ?? record.customerName }}</div>
            </template>
            <template v-else-if="column.key === 'pm'">{{ record.projectManagerName ?? '—' }}</template>
            <template v-else-if="column.key === 'delivery'">{{ record.deliveryDate }}</template>
            <template v-else-if="column.key === 'status'">
              <UiStatusTag v-if="record.closed" tone="none">已完工</UiStatusTag>
              <UiStatusTag v-else :tone="STATUS_TONE[record.status as PlanListStatus]">{{ STATUS_TEXT[record.status as PlanListStatus] }}</UiStatusTag>
              <div v-if="record.publishedDay" class="ft-muted small">{{ record.publishedDay }} {{ record.publishedByName ?? '' }}</div>
            </template>
            <template v-else-if="column.key === 'nodes'">
              <span v-if="record.nodeCount">{{ record.doneNodes }}/{{ record.nodeCount }}</span>
              <span v-else class="ft-muted">—</span>
            </template>
            <template v-else-if="column.key === 'confirm'">
              <span v-if="record.pendingConfirm" class="risk">{{ record.pendingConfirm }}</span>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'unsplit'">
              <span v-if="record.unsplit" class="risk">{{ record.unsplit }}</span>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'source'">
              <span v-if="record.sourceNodes" class="late">{{ record.sourceNodes }}</span>
              <span v-else class="ft-muted">0</span>
            </template>
            <template v-else-if="column.key === 'expected'">
              <template v-if="record.expectedDelivery">
                <span :class="{ late: (record.delayDays ?? 0) > 0 }">{{ record.expectedDelivery }}</span>
                <div v-if="(record.delayDays ?? 0) > 0" class="late small">拖期 {{ record.delayDays }} 天</div>
              </template>
              <span v-else class="ft-muted" title="发布后按总计划推算">—</span>
            </template>
            <template v-else-if="column.key === 'op'">
              <NuxtLink class="nowrap" :to="{ path: '/plan', query: { wo: record.workOrderNumber } }" @click.stop>
                {{ record.canEdit && record.status === 'NONE' ? '去编制' : record.canEdit && !record.closed ? '查看 / 调整' : '查看' }}
              </NuxtLink>
            </template>
          </template>
        </a-table>
      </UiSectionCard>
      </template>
    </template>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 8px 0 16px; }
.page-title { display: inline-flex; align-items: center; gap: 6px; font-size: 22px; font-weight: 600; margin: 0; color: var(--ft-text); }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wo-search { width: 240px; }
.closed-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ft-text-2); cursor: pointer; white-space: nowrap; }
.summary { margin-bottom: 16px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 20px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; }
.crumbs { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--ft-text-2); }
.sep { color: var(--ft-text-3); }
.small { font-size: 12px; }
.nowrap { white-space: nowrap; }
.ellipsis { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.late { color: var(--ft-late-text); font-weight: 600; }
.risk { color: var(--ft-risk-text); font-weight: 600; }
:deep(.click-row) { cursor: pointer; }
@media (max-width: 600px) {
  .wo-search { width: 100%; }
  .tools { width: 100%; }
}
</style>
