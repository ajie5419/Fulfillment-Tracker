<script setup lang="ts">
/**
 * 项目计划（总计划一览 + 单工单计划编排）：
 *   不带 ?wo：全部在做工单的计划卡片流（按状态分段筛选 + 进度条 + 待办/风险胶囊），点卡片进入该工单总计划。
 *   带 ?wo（&node= 定位节点）：该工单的总计划编制 / 发布 / 调整（PlanEditor）。
 */
import { PLAN_STATUS_TEXT as STATUS_TEXT, type PlanListStatus } from '#shared/plan'

const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const wo = computed(() => (typeof route.query.wo === 'string' ? route.query.wo : ''))
useHead({ title: computed(() => (wo.value ? `${wo.value} · 项目计划` : '项目计划')) })
const createOpen = ref(false)
async function onCreated(no: string) {
  createOpen.value = false
  await Promise.all([refresh(), refreshNuxtData('work-orders')])
  await navigateTo({ path: '/plan', query: { wo: no } })
}

// ───── 一览 ─────
const showClosed = computed({
  get: () => route.query.closed === '1',
  set: (v: boolean) => void router.replace({ query: { ...route.query, closed: v ? '1' : undefined } }),
})
const { data, pending, error, refresh } = await useApiFetch('/api/plan/list', {
  query: computed(() => (showClosed.value ? { closed: '1' } : {})),
  default: () => ({ rows: [], summary: { total: 0, published: 0, draft: 0, none: 0, late: 0, unsplit: 0 } }),
  immediate: !wo.value,
  watch: [showClosed],
})
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
const isLate = (r: Row) => (r.delayDays ?? 0) > 0 || r.sourceNodes > 0
const rows = computed(() => {
  const f = filter.value
  const list = data.value.rows.filter((r) => (f === 'all' ? true : f === 'late' ? isLate(r) : r.status === f))
  return [...list.filter((r) => !r.closed), ...list.filter((r) => r.closed)]
})

const filterOptions = computed(() => [
  { value: 'all', label: `全部 ${data.value.summary.total}` },
  { value: 'PUBLISHED', label: `已发布 ${data.value.summary.published}` },
  { value: 'DRAFT', label: `草稿 ${data.value.summary.draft}` },
  { value: 'NONE', label: `未编制 ${data.value.summary.none}` },
  { value: 'late', label: `交期风险 ${data.value.summary.late}` },
])

const STATUS_TONE: Record<PlanListStatus, 'done' | 'primary' | 'none'> = { PUBLISHED: 'done', DRAFT: 'primary', NONE: 'none' }
const woOptions = computed(() => data.value.rows.map((r) => ({ value: r.workOrderNumber, label: `${r.workOrderNumber}　${r.projectName ?? r.customerName ?? ''}` })))
function openPlan(no: unknown) {
  if (typeof no === 'string' && no) navigateTo({ path: '/plan', query: { wo: no } })
}
const donePct = (r: Row) => (r.nodeCount ? Math.round((r.doneNodes / r.nodeCount) * 100) : 0)
const opText = (r: Row) => (r.canEdit && r.status === 'NONE' ? '去编制' : r.canEdit && !r.closed ? '查看 / 调整' : '查看')
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
      <PlanEditor :key="wo" :wo="wo" />
    </template>

    <!-- 一览：Linear 风格项目进度条卡片流 -->
    <template v-else>
      <a-result v-if="error" status="error" title="项目计划加载失败" :sub-title="apiError(error)">
        <template #extra><a-button type="primary" @click="refresh()">重试</a-button></template>
      </a-result>

      <div v-else class="plan-tray">
        <div class="tray-head">
          <div class="tray-left">
            <a-segmented v-model:value="filter" :options="filterOptions" />
            <UiHelpTip label="项目计划说明">每个工单一份总计划：项目经理、项目部按模板编制、发布、调整；发布后各部门在“部门计划”里接收本部门的节点、分解任务、委派责任人。点卡片进入该工单的计划。</UiHelpTip>
          </div>
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
            <a-button v-if="me?.can.workOrder" type="primary" class="ft-btn-ink" @click="createOpen = true">新建工单</a-button>
          </div>
        </div>

        <a-spin :spinning="pending">
          <div v-if="!rows.length" class="empty-inset">
            <a-empty :description="filter === 'all' ? '没有在做的工单' : '没有符合条件的工单'" />
          </div>
          <div v-else class="card-list">
            <article
              v-for="r in rows"
              :key="r.workOrderNumber"
              class="plan-card"
              role="button"
              tabindex="0"
              @click="openPlan(r.workOrderNumber)"
              @keydown.enter="openPlan(r.workOrderNumber)"
              @keydown.space.prevent="openPlan(r.workOrderNumber)"
            >
              <div class="col-main">
                <div class="title-row">
                  <NuxtLink class="wo-code" :to="{ path: '/plan', query: { wo: r.workOrderNumber } }" @click.stop>{{ r.workOrderNumber }}</NuxtLink>
                  <span class="proj-name">{{ r.projectName ?? r.customerName }}</span>
                  <UiStatusTag v-if="r.closed" tone="none">已完工</UiStatusTag>
                  <UiStatusTag v-else :tone="STATUS_TONE[r.status as PlanListStatus]">{{ STATUS_TEXT[r.status as PlanListStatus] }}</UiStatusTag>
                </div>
                <div class="sub-row">
                  <span v-if="r.publishedDay">{{ r.publishedDay }} 发布</span>
                  <span v-if="r.deliveryDate">合同交期 {{ r.deliveryDate }}</span>
                  <span v-if="r.expectedDelivery && !r.dateConflicts.length" :class="{ late: (r.delayDays ?? 0) > 0 }">
                    预计交期 {{ r.expectedDelivery }}<template v-if="(r.delayDays ?? 0) > 0">（拖期 {{ r.delayDays }} 天）</template>
                  </span>
                </div>
              </div>

              <div class="col-prog">
                <div class="prog-head">
                  <span>节点进度 <b>{{ r.nodeCount ? `${r.doneNodes} / ${r.nodeCount}` : '—' }}</b></span>
                  <span class="pct">{{ donePct(r) }}%</span>
                </div>
                <div class="prog-track">
                  <i class="prog-fill" :class="{ late: isLate(r), done: r.nodeCount > 0 && r.doneNodes === r.nodeCount }" :style="{ width: `${donePct(r)}%` }" />
                </div>
              </div>

              <div class="col-badges">
                <span v-if="r.pendingConfirm" class="chip chip-risk">待接收 {{ r.pendingConfirm }}</span>
                <span v-if="r.unsplit" class="chip chip-risk">未分解 {{ r.unsplit }}</span>
                <span v-if="r.sourceNodes" class="chip chip-late">源头延误 {{ r.sourceNodes }}</span>
                <span v-if="r.dateConflicts.length" class="chip chip-late">日期冲突 / 待核实</span>
                <span v-if="!r.pendingConfirm && !r.unsplit && !isLate(r) && !r.dateConflicts.length && r.status === 'PUBLISHED'" class="chip chip-ok">推进正常</span>
              </div>

              <div class="col-op" @click.stop>
                <NuxtLink :to="{ path: '/plan', query: { wo: r.workOrderNumber } }">
                  <a-button size="small" type="primary" ghost>{{ opText(r) }}</a-button>
                </NuxtLink>
              </div>
            </article>
          </div>
        </a-spin>
      </div>
    </template>
    <WorkOrderEditModal v-if="me?.can.workOrder" :open="createOpen" :work-order="null" @close="createOpen = false" @done="onCreated" />
  </div>
</template>

<style scoped>
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 0 16px; }
.crumbs { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--ft-text-2); }
.sep { color: var(--ft-text-3); }

.plan-tray { background: var(--card-tray-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-outer); padding: 8px 6px 6px; }
.tray-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 2px 6px 8px; }
.tray-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; }
.wo-search { width: 220px; }
.closed-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ft-text-2); cursor: pointer; white-space: nowrap; }

.empty-inset { background: var(--card-surface-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius-inner); padding: 40px 20px; }
.card-list { display: flex; flex-direction: column; gap: 6px; }
.plan-card {
  background: var(--card-surface-bg);
  border: 1px solid var(--card-hairline);
  border-radius: var(--card-radius-inner);
  box-shadow: var(--card-shadow);
  padding: 14px 18px;
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) minmax(170px, 1fr) minmax(180px, 1.2fr) auto;
  align-items: center;
  gap: 16px;
  cursor: pointer;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.plan-card:hover { border-color: var(--ft-border-hover); box-shadow: var(--card-shadow-hover); }
.plan-card:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }

.col-main { min-width: 0; }
.title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wo-code { font-size: 14px; font-weight: 600; color: var(--ft-primary-text); font-variant-numeric: tabular-nums; }
.proj-name { font-size: 14px; font-weight: 600; color: var(--ft-text); }
.sub-row { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 5px; font-size: 12px; color: var(--ft-text-3); font-variant-numeric: tabular-nums; }
.late { color: var(--ft-late-text); font-weight: 500; }

.col-prog { min-width: 0; }
.prog-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.prog-head b { color: var(--ft-text); font-weight: 600; }
.pct { color: var(--ft-text-3); }
.prog-track { height: 6px; margin-top: 6px; border-radius: 999px; background: var(--ft-fill); overflow: hidden; }
.prog-fill { display: block; height: 100%; border-radius: 999px; background: var(--ft-primary); transition: width 0.2s; }
.prog-fill.done { background: var(--ft-done); }
.prog-fill.late { background: var(--ft-risk); }

.col-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; }
.chip-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.chip-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.chip-ok { background: var(--ft-done-bg); color: var(--ft-done-text); }

.col-op { white-space: nowrap; }

@media (max-width: 1020px) {
  .plan-card { grid-template-columns: minmax(0, 1fr) auto; }
  .col-prog, .col-badges { grid-column: 1 / -1; }
}
@media (max-width: 600px) {
  .wo-search, .tools { width: 100%; }
}
</style>
