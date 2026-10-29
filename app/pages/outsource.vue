<script setup lang="ts">
/**
 * 外协（生产管理重设计第一批，zhao 10-26 确认）：外协专员每天来这里。
 *   待发出：厂外外协、可以开工了的工序，点"发出"（选外协厂、承诺返回日、随件发料）；
 *   在外：已发出没全部返回的，按外协厂分组（一个电话问完一家），超期标红；QMS 漏报检时"登记返厂"；
 *   待确认匹配：原 /unmatched，QMS 报检没自动对上工序的，人工关联或忽略；
 *   近 7 天返回：外协工序最近 7 天完成的。
 * 地址栏：?tab=send|out|match|back ?wo= ?supplierId=；旧地址 /unmatched 跳到 ?tab=match。
 * ?step=（外协在外的提醒跳过来，只用一次）：在"在外"里标出这道；已经不在外了（返回了等）转到生产调度去定位。
 */
import { primaryAction, type PrimaryAction } from '#shared/production'

const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const { data: me } = await useMe()

type Tab = 'send' | 'out' | 'match' | 'back'
const TABS: Tab[] = ['send', 'out', 'match', 'back']
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
const tabOf = (v: string): Tab => ((TABS as string[]).includes(v) ? (v as Tab) : 'out')
const filter = reactive({ tab: tabOf(q('tab')), wo: q('wo'), supplierId: q('supplierId') })
watch(filter, (f) => router.replace({ query: { ...route.query, step: undefined, tab: f.tab, wo: f.wo || undefined, supplierId: f.supplierId || undefined } }))
watch(() => route.query, () => {
  filter.tab = tabOf(q('tab'))
  filter.wo = q('wo')
  filter.supplierId = q('supplierId')
})

const query = computed(() => ({ wo: filter.wo || undefined, supplierId: filter.supplierId || undefined }))
const { data: prod, pending: prodPending, error: prodError, refresh: refreshProd } = await useFetch('/api/production', { query, default: () => ({ rows: [], unroutedParts: 0 }) })
const { data: transit, pending: transitPending, error: transitError, refresh: refreshTransit } = await useFetch('/api/transit', {
  query: computed(() => ({ workOrderNumber: filter.wo || undefined, supplierId: filter.supplierId || undefined })),
  default: () => [],
})
const { data: unmatched, error: unmatchedError, refresh: refreshUnmatched } = await useFetch('/api/unmatched', { default: () => [] })
type ProdRow = (typeof prod.value.rows)[number]
type TransitRow = (typeof transit.value)[number]

const toSend = computed(() => prod.value.rows.filter((r) => r.column === 'ready' && r.mode === 'EXTERNAL_OUTSOURCE'))
const back = computed(() => prod.value.rows.filter((r) => r.column === 'done' && r.mode !== 'SELF'))
/** 在外按外协厂分组：有超期的厂在前，组内超期天数多的在前 */
const outGroups = computed(() => {
  const m = new Map<string, { key: string; name: string; rows: TransitRow[]; late: number }>()
  for (const r of transit.value) {
    const key = r.supplierId ?? '-'
    const g = m.get(key) ?? { key, name: r.supplierName ?? '未填外协厂', rows: [], late: 0 }
    g.rows.push(r)
    if (r.overdueDays > 0) g.late++
    m.set(key, g)
  }
  const groups = [...m.values()]
  for (const g of groups) g.rows.sort((a, b) => b.overdueDays - a.overdueDays)
  return groups.sort((a, b) => b.late - a.late || b.rows.length - a.rows.length)
})
const tabOptions = computed(() => [
  { value: 'send', label: `待发出 ${prodError.value ? '—' : toSend.value.length}` },
  { value: 'out', label: `在外 ${transitError.value ? '—' : transit.value.length}` },
  { value: 'match', label: `待确认匹配 ${unmatchedError.value ? '—' : unmatched.value.length}` },
  { value: 'back', label: '近 7 天返回' },
])
const woOptions = computed(() => workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` })))
const supplierOptions = computed(() => master.value.suppliers.filter((s) => s.kind !== 'TEAM').map((s) => ({ value: s.id, label: s.label })))

// ───── ?step=：在外提醒跳过来定位那道工序 ─────
const focusStep = ref('')
// 只处理一次（useOneShotQuery）：处理完删掉 step，之后刷新、切页签都不会再被拉回
useOneShotQuery(['step'], { fetches: [{ pending: transitPending, error: transitError }] }, ({ step: id }) => {
  if (!transit.value.some((r) => r.stepId === id)) {
    // 已经不在外了（返回了、被改了状态）：交给生产调度按它实际所在页签定位（参数带过去，这边不删）
    navigateTo({ path: '/production', query: { wo: filter.wo || undefined, step: id } }, { replace: true })
    return false
  }
  filter.tab = 'out'
  focusStep.value = id!
  nextTick(() => document.querySelector('.focus-row')?.scrollIntoView({ block: 'center' }))
  return { tab: 'out' }
})
const rowClass = (r: { stepId: string }) => (r.stepId === focusStep.value ? 'focus-row' : '')

function refreshAll() {
  return Promise.all([refreshProd(), refreshTransit(), refreshUnmatched()])
}
const host = ref<{ run: (a: Exclude<PrimaryAction, null>, r: { stepId: string; partName: string; processName: string; quantity: number; doneQty: number; supplierId: string | null; ownerId: string | null }) => void } | null>(null)
const canStep = (r: { workOrderNumber: string; ownerId: string | null }) => canDo(me.value, 'stepAction', { workOrderNumber: r.workOrderNumber, ownerId: r.ownerId })
const canAssign = (r: { workOrderNumber: string }) => canDo(me.value, 'route', { workOrderNumber: r.workOrderNumber })
const sendAction = (r: ProdRow) => primaryAction(r)

const drawerPartId = ref<string | null>(null)
const sendColumns = [
  { title: '工件 · 工序', key: 'name' },
  { title: '工单', key: 'wo', width: 130 },
  { title: '计划外协厂', key: 'sup', width: 170 },
  { title: '负责人', key: 'owner', width: 110 },
  { title: '应开工', key: 'date', width: 150 },
  { title: '', key: 'action', width: 120, fixed: 'right' as const },
]
const outColumns = [
  { title: '工件 · 工序', key: 'name' },
  { title: '工单', key: 'wo', width: 130 },
  { title: '已回 / 发出', key: 'qty', width: 110 },
  { title: '发出', key: 'sent', width: 110 },
  { title: '承诺返回', key: 'date', width: 140 },
  { title: '', key: 'action', width: 120, fixed: 'right' as const },
]
const backColumns = [
  { title: '工件 · 工序', key: 'name' },
  { title: '工单', key: 'wo', width: 130 },
  { title: '外协厂', key: 'sup', width: 170 },
  { title: '完成', key: 'date', width: 150 },
]
</script>

<template>
  <div>
  <a-card>
    <template #title>
      <span class="ft-title">外协 <UiHelpTip>待发出：厂外外协可以开工了，点"发出"登记外协厂、承诺返回日和随件发料。在外：按外协厂分组，超期的在前；返厂以 QMS 报检为准自动记上，QMS 漏报检时点"登记返厂"。待确认匹配：QMS 报检没自动对上工序的，选一个关联或忽略。</UiHelpTip></span>
    </template>
    <template #extra>
      <a-segmented v-model:value="filter.tab" class="tabs-seg" :options="tabOptions" />
      <a-select :value="filter.supplierId || undefined" allow-clear show-search option-filter-prop="label" placeholder="全部外协厂" :options="supplierOptions" class="filter-sup" @change="(v: unknown) => (filter.supplierId = (v as string) ?? '')" />
      <a-select :value="filter.wo || undefined" allow-clear show-search option-filter-prop="label" placeholder="全部工单" :options="woOptions" class="filter-wo" @change="(v: unknown) => (filter.wo = (v as string) ?? '')" />
      <UiRefreshButton @click="refreshAll()" />
    </template>

    <!-- 加载失败：数据是退回的默认空值，不能显示成"没有" -->
    <a-result v-if="(filter.tab === 'send' || filter.tab === 'back') && prodError && !prodPending" status="error" title="外协工序加载失败" :sub-title="apiError(prodError)">
      <template #extra><a-button type="primary" @click="refreshProd()">重试</a-button></template>
    </a-result>
    <a-result v-else-if="filter.tab === 'out' && transitError && !transitPending" status="error" title="在外清单加载失败" :sub-title="apiError(transitError)">
      <template #extra><a-button type="primary" @click="refreshTransit()">重试</a-button></template>
    </a-result>
    <a-spin v-else-if="filter.tab === 'send'" :spinning="prodPending">
      <a-empty v-if="!toSend.length" description="没有待发出的外协工序" />
      <a-table v-else class="ft-table" :columns="sendColumns" :data-source="toSend" row-key="stepId" size="small" :scroll="{ x: 820 }" :pagination="false">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'"><button type="button" class="name-btn" @click="drawerPartId = record.partId">{{ record.partName }}</button><span class="muted"> · </span>{{ record.processName }}</template>
          <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
          <template v-else-if="column.key === 'sup'"><span v-if="record.supplierName">{{ record.supplierName }}</span><UiStatusTag v-else tone="risk">未选</UiStatusTag></template>
          <template v-else-if="column.key === 'owner'"><span v-if="record.ownerName">{{ record.ownerName }}</span><UiStatusTag v-else tone="risk">未指定</UiStatusTag></template>
          <template v-else-if="column.key === 'date'">
            <UiStatusTag v-if="record.startLateDays" tone="late">应开工已过 {{ record.startLateDays }} 天</UiStatusTag>
            <span v-else class="muted">{{ record.planStartDate ? dayText(record.planStartDate) : '未定' }}</span>
          </template>
          <template v-else-if="column.key === 'action'">
            <a-button v-if="sendAction(record as ProdRow) === 'assign' && canAssign(record as ProdRow)" size="small" @click="host?.run('assign', record as ProdRow)">指定负责人</a-button>
            <a-button v-else-if="sendAction(record as ProdRow) === 'send' && canStep(record as ProdRow)" size="small" type="primary" @click="host?.run('send', record as ProdRow)">发出</a-button>
          </template>
        </template>
      </a-table>
    </a-spin>

    <a-spin v-else-if="filter.tab === 'out'" :spinning="transitPending">
      <a-empty v-if="!outGroups.length" description="没有在外的工件" />
      <section v-for="g in outGroups" :key="g.key" class="group">
        <header class="group-head">
          <span class="group-name">{{ g.name }}</span>
          <UiStatusTag v-if="g.late" tone="late">{{ g.late }} 项超期</UiStatusTag>
          <span class="muted">在外 {{ g.rows.length }} 项</span>
        </header>
        <a-table class="ft-table" :columns="outColumns" :data-source="g.rows" row-key="stepId" :row-class-name="rowClass" size="small" :scroll="{ x: 820 }" :pagination="false">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <button type="button" class="name-btn" @click="drawerPartId = record.partId">{{ record.partName }}</button><span class="muted"> · </span>{{ record.processName }}
              <div v-if="record.sendNote" class="muted">随件发料：{{ record.sendNote }}</div>
            </template>
            <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
            <template v-else-if="column.key === 'qty'"><span class="num">{{ record.returnedQty }} / {{ record.quantity }} 件</span></template>
            <template v-else-if="column.key === 'sent'"><span class="muted">{{ dayText(record.startedAt) || '—' }}</span></template>
            <template v-else-if="column.key === 'date'">
              <UiStatusTag v-if="record.overdueDays > 0" tone="late">超 {{ record.overdueDays }} 天</UiStatusTag>
              <span v-else class="muted">{{ dayText(record.promisedReturnDate) || '未填' }}</span>
            </template>
            <template v-else-if="column.key === 'action'">
              <a-button v-if="canStep(record as TransitRow)" size="small" @click="host?.run('return', { ...(record as TransitRow), doneQty: record.returnedQty })">登记返厂</a-button>
            </template>
          </template>
        </a-table>
      </section>
    </a-spin>

    <UnmatchedTable v-else-if="filter.tab === 'match'" @changed="refreshAll()" />

    <a-spin v-else :spinning="prodPending">
      <a-empty v-if="!back.length" description="近 7 天没有返回的外协工序" />
      <a-table v-else class="ft-table" :columns="backColumns" :data-source="back" row-key="stepId" size="small" :scroll="{ x: 820 }" :pagination="false">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'"><button type="button" class="name-btn" @click="drawerPartId = record.partId">{{ record.partName }}</button><span class="muted"> · </span>{{ record.processName }}</template>
          <template v-else-if="column.key === 'wo'"><WoLink :no="record.workOrderNumber" /></template>
          <template v-else-if="column.key === 'sup'">{{ record.supplierName ?? '—' }}</template>
          <template v-else-if="column.key === 'date'"><span class="muted">{{ dayText(record.finishedAt) }}</span></template>
        </template>
      </a-table>
    </a-spin>
  </a-card>

  <StepActionHost ref="host" @done="refreshAll()" />
  <PartDrawer :part-id="drawerPartId" @close="drawerPartId = null" @changed="refreshAll()" />
  </div>
</template>

<style scoped>
.tabs-seg { max-width: 100%; overflow-x: auto; }
/* 从提醒跳过来的那道工序 */
:deep(.focus-row) > td { background: var(--ft-primary-bg) !important; }
/* 卡片右上角的切换和筛选：窄屏时换行、不超出卡片 */
:deep(.ant-card-extra) { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; max-width: 100%; }
.filter-wo { width: 200px; max-width: calc(100vw - 72px); }
.filter-sup { width: 180px; max-width: calc(100vw - 72px); }
.name-btn { padding: 0; border: none; background: none; color: var(--ft-primary); cursor: pointer; font: inherit; text-align: left; }
.name-btn:hover { text-decoration: underline; }
.name-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 4px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.num { font-variant-numeric: tabular-nums; }
.group + .group { margin-top: 16px; }
.group-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.group-name { font-weight: 600; font-size: 14px; }
</style>
