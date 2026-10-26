<script setup lang="ts">
/**
 * 生产调度（生产管理重设计第一批，zhao 10-26 确认）：生产经理、班组每天来这里——跨工单看今天该开工的、在做的、超期的、卡住的，
 * 每行一个随状态变的主按钮（指定负责人 / 开工 / 发出 / 完工 / 登记返厂），不用再进工件页找按钮。
 *   列表视图：按页签（可以开工 / 进行中 / 已超期 / 卡住 / 近 7 天完成）；看板视图：原"车间看板"五列，卡片上同样有主按钮。
 *   "可以开工"口径与工作台待办一致（server/services/flow/readiness.ts）。点工件名打开工件抽屉。
 * 地址栏：?tab= ?view=board ?wo= ?supplierId= ?mine=1；旧地址 /workshop 跳到这里的看板视图。
 */
import { ACTION_TEXT, COLUMN_TEXT, COLUMN_TONE, PRODUCTION_TABS, TAB_TEXT, actionNeeds, inTab, isOverdue, primaryAction, tabCounts, type PrimaryAction, type ProductionColumn, type ProductionTab } from '#shared/production'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const { data: me } = await useMe()

const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
const tabOf = (v: string): ProductionTab => ((PRODUCTION_TABS as readonly string[]).includes(v) ? (v as ProductionTab) : 'ready')
const filter = reactive({ tab: tabOf(q('tab')), view: q('view') === 'board' ? 'board' : 'list', wo: q('wo'), supplierId: q('supplierId'), mine: q('mine') === '1' })
// 本地改了写回地址栏；地址栏变了（全局搜索、提醒里的同页链接）反向同步
watch(filter, (f) => {
  router.replace({
    query: {
      ...route.query,
      tab: f.tab === 'ready' ? undefined : f.tab,
      view: f.view === 'board' ? 'board' : undefined,
      wo: f.wo || undefined,
      supplierId: f.supplierId || undefined,
      mine: f.mine ? '1' : undefined,
    },
  })
})
watch(() => route.query, () => {
  filter.tab = tabOf(q('tab'))
  filter.view = q('view') === 'board' ? 'board' : 'list'
  filter.wo = q('wo')
  filter.supplierId = q('supplierId')
  filter.mine = q('mine') === '1'
  if (q('part')) openPart(q('part'))
})

const { data, pending, refresh } = await useFetch('/api/production', {
  query: computed(() => ({ wo: filter.wo || undefined, supplierId: filter.supplierId || undefined, mine: filter.mine ? '1' : undefined })),
  default: () => ({ rows: [], unroutedParts: 0 }),
})
type Row = (typeof data.value.rows)[number]
const rows = computed(() => data.value.rows)
const counts = computed(() => tabCounts(rows.value))
const tabOptions = computed(() => PRODUCTION_TABS.map((t) => ({ value: t, label: `${TAB_TEXT[t]} ${counts.value[t]}` })))
/** 列表：超期的在前，其余按服务端顺序（要求完成日从近到远） */
const listRows = computed(() => {
  const list = rows.value.filter((r) => inTab(r, filter.tab))
  return filter.tab === 'done' ? list : [...list].sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)))
})
const COLUMNS: ProductionColumn[] = ['ready', 'working', 'out', 'stuck', 'done']
const boardColumns = computed(() => COLUMNS.map((key) => ({ key, cards: rows.value.filter((r) => r.column === key) })))

const woOptions = computed(() => workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` })))
// 班组在前（派工看班组），外协厂在后
const supplierOptions = computed(() => [
  ...master.value.suppliers.filter((s) => s.kind === 'TEAM').map((s) => ({ value: s.id, label: `${s.name}（班组）` })),
  ...master.value.suppliers.filter((s) => s.kind !== 'TEAM').map((s) => ({ value: s.id, label: s.name })),
])
const supplierName = (id: string) => supplierOptions.value.find((o) => o.value === id)?.label ?? id
const chips = computed(() =>
  [
    filter.supplierId ? { key: 'sup', text: `班组 / 外协厂：${supplierName(filter.supplierId)}`, clear: () => { filter.supplierId = '' } } : null,
    filter.mine ? { key: 'mine', text: '只看我负责的', clear: () => { filter.mine = false } } : null,
  ].filter((x): x is { key: string; text: string; clear: () => void } => !!x),
)
function clearFilters() {
  filter.supplierId = ''
  filter.mine = false
}

// ───── 操作 ─────
const host = ref<{ run: (a: Exclude<PrimaryAction, null>, r: Row) => void } | null>(null)
const actionOf = (r: Row) => primaryAction(r)
function canAct(r: Row, a: Exclude<PrimaryAction, null>) {
  return actionNeeds(a) === 'route' ? canDo(me.value, 'route', { workOrderNumber: r.workOrderNumber }) : canDo(me.value, 'stepAction', { workOrderNumber: r.workOrderNumber, ownerId: r.ownerId })
}

// ───── 工件抽屉（?part= 打开）─────
const drawerPartId = ref<string | null>(null)
function openPart(id: string) {
  drawerPartId.value = id
}
function closePart() {
  drawerPartId.value = null
  if (route.query.part) router.replace({ query: { ...route.query, part: undefined } })
}
onMounted(() => { if (q('part')) openPart(q('part')) })

const modeText = (r: Row) => (r.mode === 'SELF' ? `自制${r.supplierName ? ` · ${r.supplierName}` : ''}` : `${MODE_TEXT[r.mode]} · ${r.supplierName ?? '未选外协厂'}`)
/** 日期一列：按所在列显示最要紧的那个日期 */
function dateInfo(r: Row): { text: string; tone: 'late' | 'none' } {
  if (r.column === 'done') return { text: `完成 ${dayText(r.finishedAt)}`, tone: 'none' }
  if (r.column === 'out') return r.promisedReturnDate ? { text: r.overdueDays ? `承诺返回超 ${r.overdueDays} 天` : `承诺 ${dayText(r.promisedReturnDate)} 返回`, tone: r.overdueDays ? 'late' : 'none' } : { text: '未填承诺返回日', tone: 'none' }
  if (r.column === 'ready' && r.startLateDays) return { text: `应开工已过 ${r.startLateDays} 天`, tone: 'late' }
  if (r.overdueDays) return { text: `要求完成超 ${r.overdueDays} 天`, tone: 'late' }
  if (r.column === 'ready' && r.planStartDate) return { text: `应开工 ${dayText(r.planStartDate)}`, tone: 'none' }
  return r.dueDate ? { text: `要求 ${dayText(r.dueDate)} 完成`, tone: 'none' } : { text: '未定日期', tone: 'none' }
}
const tableColumns = [
  { title: '工单', key: 'wo', width: 150 },
  { title: '工件 · 工序', key: 'name' },
  { title: '方式 · 班组 / 外协厂', key: 'mode', width: 190 },
  { title: '负责人', key: 'owner', width: 110 },
  { title: '数量', key: 'qty', width: 90 },
  { title: '日期', key: 'date', width: 160 },
  { title: '', key: 'action', width: 120, fixed: 'right' as const },
]
const EMPTY_TEXT: Record<ProductionTab, string> = { ready: '没有可以开工的工序', active: '没有在做的工序', overdue: '没有超期的工序', stuck: '没有卡住的工序', done: '近 7 天没有完成的工序' }
</script>

<template>
  <div class="ft-page">
    <div class="stats">
      <UiStatCard label="可以开工" :value="counts.ready" unit="道" tone="primary" accent icon="dot" clickable :active="filter.view === 'list' && filter.tab === 'ready'" sub="上一道已完成，第一道物料图纸已齐" @click="filter.view = 'list'; filter.tab = 'ready'" />
      <UiStatCard label="进行中" :value="counts.active" unit="道" tone="primary" accent icon="ring" clickable :active="filter.view === 'list' && filter.tab === 'active'" sub="加工中 + 在外加工" @click="filter.view = 'list'; filter.tab = 'active'" />
      <UiStatCard label="已超期" :value="counts.overdue" unit="道" tone="late" accent icon="alert" clickable :active="filter.view === 'list' && filter.tab === 'overdue'" sub="要求完成 / 承诺返回 / 应开工日已过" @click="filter.view = 'list'; filter.tab = 'overdue'" />
      <UiStatCard label="卡住" :value="counts.stuck" unit="道" tone="upstream" accent icon="warn" clickable :active="filter.view === 'list' && filter.tab === 'stuck'" sub="有异常、等变更、缺料缺图" @click="filter.view = 'list'; filter.tab = 'stuck'" />
      <UiStatCard label="没排工序的工件" :value="data.unroutedParts" unit="个" tone="risk" accent icon="warn" :to="{ path: '/parts', query: { wo: filter.wo || undefined, noRoute: '1' } }" sub="点开到工序编排" />
    </div>

    <a-card>
      <template #title>
        <span class="ft-title">生产调度 <UiHelpTip>跨工单看工序，每行一个主按钮：没有负责人先"指定负责人"；可以开工的自制 / 厂内外协点"开工"，厂外外协点"发出"；加工中点"完工"（可部分完工、报废）；在外的 QMS 漏报检时点"登记返厂"。"可以开工"= 上一道已完成或已有部分返回；第一道还要求挂着的关键物料都到货、设计任务都完成。排工序、改日期到"工序编排"。</UiHelpTip></span>
      </template>
      <template #extra>
        <a-segmented v-if="filter.view === 'list'" v-model:value="filter.tab" class="tabs-seg" :options="tabOptions" />
        <a-select :value="filter.wo || undefined" allow-clear show-search option-filter-prop="label" placeholder="全部工单" :options="woOptions" class="filter-wo" @change="(v: unknown) => (filter.wo = (v as string) ?? '')" />
        <UiFilterButton :count="chips.length" @clear="clearFilters">
          <label class="ft-filter-row"><span>班组 / 外协厂</span><a-select :value="filter.supplierId || undefined" allow-clear show-search option-filter-prop="label" placeholder="全部" :options="supplierOptions" @change="(v: unknown) => (filter.supplierId = (v as string) ?? '')" /></label>
          <a-checkbox v-model:checked="filter.mine">只看我负责的</a-checkbox>
        </UiFilterButton>
        <a-segmented v-model:value="filter.view" :options="[{ value: 'list', label: '列表' }, { value: 'board', label: '看板' }]" />
        <UiRefreshButton @click="refresh()" />
      </template>

      <UiFilterChips :items="chips" @clear-all="clearFilters" />

      <a-spin :spinning="pending">
        <template v-if="filter.view === 'list'">
          <a-empty v-if="!listRows.length" :description="EMPTY_TEXT[filter.tab]" />
          <a-table v-else class="ft-table" :columns="tableColumns" :data-source="listRows" row-key="stepId" size="small" :scroll="{ x: 980 }" :pagination="listRows.length > 50 ? { pageSize: 50, showSizeChanger: false } : false">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'wo'"><span class="nowrap"><WoLink :no="record.workOrderNumber" /></span></template>
              <template v-else-if="column.key === 'name'">
                <button type="button" class="name-btn" @click="openPart(record.partId)">{{ record.partName }}</button>
                <span class="muted"> · {{ record.seq }}. </span>{{ record.processName }}
                <div v-if="record.stuckText" class="stuck">{{ record.stuckText }}
                  <NuxtLink v-for="i in record.issues" :key="i.id" :to="`/issues?id=${encodeURIComponent(i.id)}`" class="issue">{{ i.issueNo }}</NuxtLink>
                  <NuxtLink v-if="record.stuckKind === 'HELD' && record.holdReleaseId" :to="`/releases?id=${encodeURIComponent(record.holdReleaseId)}`" class="issue">看变更</NuxtLink>
                </div>
              </template>
              <template v-else-if="column.key === 'mode'"><span class="muted">{{ modeText(record as Row) }}</span></template>
              <template v-else-if="column.key === 'owner'">
                <span v-if="record.ownerName">{{ record.ownerName }}</span>
                <UiStatusTag v-else tone="risk">未指定</UiStatusTag>
              </template>
              <template v-else-if="column.key === 'qty'"><span class="num">{{ record.doneQty ? `${record.doneQty}/` : '' }}{{ record.quantity }} 件</span></template>
              <template v-else-if="column.key === 'date'">
                <UiStatusTag v-if="dateInfo(record as Row).tone === 'late'" tone="late">{{ dateInfo(record as Row).text }}</UiStatusTag>
                <span v-else class="muted">{{ dateInfo(record as Row).text }}</span>
              </template>
              <template v-else-if="column.key === 'action'">
                <template v-if="actionOf(record as Row)">
                  <a-button v-if="canAct(record as Row, actionOf(record as Row)!)" size="small" :type="actionOf(record as Row) === 'assign' ? 'default' : 'primary'" @click="host?.run(actionOf(record as Row)!, record as Row)">{{ ACTION_TEXT[actionOf(record as Row)!] }}</a-button>
                  <span v-else class="muted">{{ COLUMN_TEXT[record.column as ProductionColumn] }}</span>
                </template>
                <UiStatusTag v-else :tone="COLUMN_TONE[record.column as ProductionColumn]">{{ COLUMN_TEXT[record.column as ProductionColumn] }}</UiStatusTag>
              </template>
            </template>
          </a-table>
        </template>

        <div v-else class="board">
          <section v-for="col in boardColumns" :key="col.key" class="col" :aria-label="COLUMN_TEXT[col.key]">
            <header class="col-head">
              <UiStatusTag :tone="COLUMN_TONE[col.key]">{{ COLUMN_TEXT[col.key] }}</UiStatusTag>
              <span class="count">{{ col.cards.length }}</span>
            </header>
            <div class="ft-well col-body">
              <p v-if="!col.cards.length" class="empty">无</p>
              <article v-for="c in col.cards" :key="c.stepId" class="card" :class="{ late: isOverdue(c) }">
                <div class="card-top">
                  <span class="wo">{{ c.workOrderNumber }}</span>
                  <UiStatusTag v-if="dateInfo(c).tone === 'late'" tone="late">{{ dateInfo(c).text }}</UiStatusTag>
                </div>
                <button type="button" class="link name" @click="openPart(c.partId)">{{ c.partName }} · {{ c.seq }}. {{ c.processName }}</button>
                <div class="meta">{{ modeText(c) }} · {{ c.doneQty ? `${c.doneQty}/` : '' }}{{ c.quantity }} 件</div>
                <div class="meta">{{ c.ownerName ?? '未指定负责人' }}{{ dateInfo(c).tone === 'late' ? '' : ` · ${dateInfo(c).text}` }}</div>
                <div v-if="c.stuckText" class="stuck">{{ c.stuckText }}</div>
                <div v-if="actionOf(c) && canAct(c, actionOf(c)!)" class="card-foot">
                  <a-button size="small" :type="actionOf(c) === 'assign' ? 'default' : 'primary'" @click="host?.run(actionOf(c)!, c)">{{ ACTION_TEXT[actionOf(c)!] }}</a-button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </a-spin>
    </a-card>

    <StepActionHost ref="host" @done="refresh()" />
    <PartDrawer :part-id="drawerPartId" @close="closePart" @changed="refresh()" />
  </div>
</template>

<style scoped>
/* 状态页签窄屏时在自己的框里横向滑，不撑破卡片 */
.tabs-seg { max-width: 100%; overflow-x: auto; }
/* 卡片右上角的切换和筛选：窄屏时换行、不超出卡片 */
:deep(.ant-card-extra) { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; max-width: 100%; }
.stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 991px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; } }
.filter-wo { width: 220px; max-width: calc(100vw - 72px); }
.name-btn { padding: 0; border: none; background: none; color: var(--ft-primary); cursor: pointer; font: inherit; text-align: left; }
.name-btn:hover { text-decoration: underline; }
.name-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 4px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.num { font-variant-numeric: tabular-nums; }
.nowrap { white-space: nowrap; }
.stuck { margin-top: 2px; font-size: 12px; color: var(--ft-upstream-text); }
.issue { margin-left: 6px; color: var(--ft-late-text); }
/* 看板：五列等宽，1440 一屏放下；窄屏横向滑动 */
.board { display: grid; grid-template-columns: repeat(5, minmax(200px, 1fr)); gap: 12px; overflow-x: auto; }
.col { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.col-head { display: flex; align-items: center; gap: 8px; }
.count { font-size: 14px; font-weight: 600; color: var(--ft-text); }
.col-body { display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.empty { margin: 8px 0; color: var(--ft-text-2); font-size: 13px; text-align: center; }
.card { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 10px; color: var(--ft-text); }
.card.late { border-color: var(--ft-late); }
.card-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wo { font-size: 12px; color: var(--ft-text-2); }
.name { margin-top: 2px; font-size: 14px; font-weight: 500; }
.meta { font-size: 12px; color: var(--ft-text-2); }
.card-foot { display: flex; justify-content: flex-end; margin-top: 6px; }
</style>
