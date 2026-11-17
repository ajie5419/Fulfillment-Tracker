<script setup lang="ts">
/**
 * 异常闭环台账与系统预警（/risks）：
 *   默认落地为「异常台账」（?tab=issues），以状态漏斗 KPI + 结构化台账追踪异常从待受理、处理中到待确认关闭的全流程；
 *   「系统预警」（?tab=alerts）作为预警升级池，保留“转异常”与业务详情直达。
 *   旧地址 /alerts、/issues 带原参数重定向到这里（见 pages/alerts.vue、pages/issues.vue）。
 */
import { ALERT_RULES } from '#shared/alert-rules'
import { factoryTimeText } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const returnTo = computed(() => typeof route.query.returnTo === 'string' && route.query.returnTo.startsWith('/board?') ? route.query.returnTo : undefined)
const { data: workOrders } = await useWorkOrders()

type Tab = 'issues' | 'alerts'
const TABS: Tab[] = ['issues', 'alerts']
const q = (k: string) => (route.query[k] as string) || undefined
const tab = ref<Tab>(TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'issues')

const filter = reactive({
  workOrderNumber: q('wo'),
  // 预警
  rule: q('rule'),
  level: q('level'),
  // 异常（默认未关闭；地址栏 status=ALL 表示"全部状态"）
  status: (q('status') === 'ALL' ? undefined : (q('status') ?? 'UNCLOSED')) as string | undefined,
  category: q('category'),
  dept: (route.query.dept as string) ?? '0',
  mine: q('mine'),
  overdue: route.query.overdue === '1' ? '1' : undefined,
})

const { data: alerts, pending: alertsPending, error: alertsError, refresh: refreshAlerts } = await useApiFetch('/api/alerts', {
  query: computed(() => ({ rule: filter.rule, level: filter.level, workOrderNumber: filter.workOrderNumber })),
  default: () => [],
})
const { data: issues, pending: issuesPending, error: issuesError, refresh: refreshIssues } = await useApiFetch('/api/issues', {
  query: computed(() => ({
    status: filter.status || undefined,
    category: filter.category,
    workOrderNumber: filter.workOrderNumber,
    dept: filter.dept,
    mine: filter.mine,
    overdue: filter.overdue,
  })),
  default: () => [],
})
async function refresh() {
  await Promise.all([refreshAlerts(), refreshIssues()])
}

const selected = ref<string | null>(q('id') ?? null)
watch(
  () => route.query.id,
  (id) => {
    const v = (id as string) || null
    if (v !== selected.value) selected.value = v
  },
)

watch(
  () => [tab.value, selected.value, { ...filter }],
  () => {
    if (!import.meta.client) return
    router.replace({
      query: {
        returnTo: returnTo.value,
        tab: tab.value,
        wo: filter.workOrderNumber,
        rule: filter.rule,
        level: filter.level,
        status: filter.status ?? 'ALL',
        category: filter.category,
        dept: filter.dept,
        mine: filter.mine,
        overdue: filter.overdue,
        id: selected.value || undefined,
      },
    })
  },
  { deep: true },
)

const reporting = ref(false)
function onReported(issue: { id: string }) {
  reporting.value = false
  tab.value = 'issues'
  refresh()
  selected.value = issue.id
}

const converting = ref<string | null>(null)
function convert(row: { id: string; subject: string }) {
  Modal.confirm({
    title: '把这条预警转为异常？',
    content: row.subject,
    okText: '转异常',
    async onOk() {
      converting.value = row.id
      try {
        const r = await clientRequest(`/api/alerts/${row.id}/convert`, { method: 'POST' })
        message.success(`已转为异常 ${r.issueNo}`)
        await refresh()
      } catch (e) {
        message.error(apiError(e))
      } finally {
        converting.value = null
      }
    },
  })
}

type AlertRow = (typeof alerts.value)[number]
type IssueRow = (typeof issues.value)[number]

// ───── 状态漏斗 KPI（保留未关闭全量基数，避免点选某状态后其余卡片归零） ─────
const unclosedSnapshot = ref<IssueRow[]>([])
watch(
  [issues, () => filter.status, () => filter.overdue],
  ([rows, st, ov]) => {
    if (st === 'UNCLOSED' && !ov) unclosedSnapshot.value = rows
    else if (!unclosedSnapshot.value.length && rows.length) unclosedSnapshot.value = rows
  },
  { immediate: true },
)
const funnelSource = computed(() => (filter.status === 'UNCLOSED' && !filter.overdue ? issues.value : unclosedSnapshot.value))
const funnel = computed(() => {
  const rows = funnelSource.value
  return {
    open: rows.filter((i) => i.status === 'OPEN').length,
    accepted: rows.filter((i) => i.status === 'ACCEPTED').length,
    overdue: rows.filter((i) => i.status !== 'CLOSED' && i.overdue).length,
    resolved: rows.filter((i) => i.status === 'RESOLVED').length,
  }
})
function toggleFunnelStatus(status: 'OPEN' | 'ACCEPTED' | 'RESOLVED') {
  tab.value = 'issues'
  filter.overdue = undefined
  filter.status = filter.status === status ? 'UNCLOSED' : status
}
function toggleFunnelOverdue() {
  tab.value = 'issues'
  filter.status = 'UNCLOSED'
  filter.overdue = filter.overdue ? undefined : '1'
}

const summaryError = computed(() => (tab.value === 'alerts' ? Boolean(alertsError.value) : Boolean(issuesError.value)))
const summaryPending = computed(() => (tab.value === 'alerts' ? alertsPending.value : issuesPending.value))
const heroSummary = computed(() => {
  if (summaryError.value) return tab.value === 'alerts' ? '预警数据加载失败，暂无法汇总，请重试。' : '异常数据加载失败，暂无法汇总，请重试。'
  if (tab.value === 'alerts') {
    const red = alerts.value.filter((a) => a.status !== 'CONVERTED' && a.level === 'RED').length
    const yellow = alerts.value.filter((a) => a.status !== 'CONVERTED' && a.level === 'YELLOW').length
    return alerts.value.length ? `当前可见 ${alerts.value.length} 条系统预警（红 ${red} · 黄 ${yellow}），15 分钟自动更新。` : '当前筛选范围内暂无活动中的系统预警。'
  }
  const f = funnel.value
  const total = issues.value.length
  return total ? `当前列表共 ${total} 条异常（待受理 ${f.open} · 处理中 ${f.accepted} · 已超期 ${f.overdue} · 待确认 ${f.resolved}）。` : '当前筛选范围内暂无异常记录。'
})

// ───── 异常台账表格 & 预警列表 ─────
const sortedIssues = computed(() =>
  [...issues.value].sort((a, b) => {
    const rank = (x: IssueRow) => (x.status === 'CLOSED' ? 4 : x.overdue ? 0 : x.status === 'OPEN' ? 1 : x.status === 'ACCEPTED' ? 2 : 3)
    return rank(a) - rank(b)
  }),
)
const sortedAlerts = computed(() =>
  [...alerts.value].sort((a, b) => {
    const rank = (x: AlertRow) => (x.status === 'CONVERTED' ? 3 : x.level === 'RED' ? 0 : x.level === 'YELLOW' ? 1 : 2)
    return rank(a) - rank(b)
  }),
)

const issueColumns = [
  { title: '异常单号', key: 'issueNo', width: 145 },
  { title: '工单 / 关联对象', key: 'ref', width: 170 },
  { title: '问题描述与分类', key: 'desc' },
  { title: '状态', key: 'status', width: 96 },
  { title: '责任部门 / 责任人', key: 'owner', width: 155 },
  { title: '要求解决日', key: 'dueDate', width: 135 },
  { title: '操作', key: 'ops', width: 112, align: 'right' as const },
]

const alertColumns = [
  { title: '级别 / 规则', key: 'level', width: 170 },
  { title: '工单', key: 'wo', width: 120 },
  { title: '预警对象与说明', key: 'subject' },
  { title: '责任部门 / 责任人', key: 'owner', width: 170 },
  { title: '持续 / 首次触发', key: 'time', width: 165 },
  { title: '操作', key: 'ops', width: 185, align: 'right' as const },
]

function primaryIssueAction(i: IssueRow): { label: string; primary: boolean } {
  if (i.can.accept) return { label: '受理', primary: true }
  if (i.can.resolve) return { label: '去处理', primary: true }
  if (i.can.close) return { label: '验证关闭', primary: true }
  if (i.can.reassign || i.can.reject) return { label: '处理', primary: false }
  return { label: '查看详情', primary: false }
}

const ruleOptions = ALERT_RULES.map((r) => ({ value: r, label: RULE_TEXT[r] }))
const levelOptions = LEVEL_ORDER.map((l) => ({ value: l, label: LEVEL_TEXT[l] }))
const statusOptions = [{ value: 'UNCLOSED', label: '未关闭' }, ...Object.entries(ISSUE_STATUS_TEXT).map(([value, label]) => ({ value, label }))]
const categoryOptions = Object.entries(ISSUE_CATEGORY_TEXT).map(([value, label]) => ({ value, label }))
const mineOptions = [
  { value: 'todo', label: '等我处理' },
  { value: 'responsible', label: '我负责的' },
  { value: 'reported', label: '我上报的' },
]
const woOptions = computed(() => workOrders.value.map((w) => ({ value: w.workOrderNumber, label: w.workOrderNumber })))
const ownerText = (owners: { name: string }[]) => owners.map((o) => o.name).join('、')
const alertTone = (a: AlertRow) => (a.status === 'CONVERTED' ? 'none' : a.level === 'RED' ? 'late' : a.level === 'YELLOW' ? 'risk' : 'primary')
const alertIcon = (a: AlertRow) => (a.status === 'CONVERTED' ? 'ring' : a.level === 'RED' ? 'alert' : a.level === 'YELLOW' ? 'warn' : 'dot')

const tabOptions = computed(() => [
  { value: 'issues', label: `异常台账 ${issues.value.length}` },
  { value: 'alerts', label: `系统预警 ${alerts.value.length}` },
])
const deptDefault = computed(() => '0')
const labelOf = (opts: { value: string; label: string }[], v?: string) => opts.find((o) => o.value === v)?.label ?? v
const activeChips = computed(() => {
  const out: { key: string; text: string; clear: () => void }[] = []
  if (tab.value === 'alerts') {
    if (filter.rule) out.push({ key: 'rule', text: `规则：${labelOf(ruleOptions, filter.rule)}`, clear: () => (filter.rule = undefined) })
    if (filter.level) out.push({ key: 'level', text: `级别：${labelOf(levelOptions, filter.level)}`, clear: () => (filter.level = undefined) })
  } else {
    if (filter.dept !== deptDefault.value) out.push({ key: 'dept', text: `异常范围：${filter.dept === '1' ? '本部门' : '可见范围'}`, clear: () => (filter.dept = deptDefault.value) })
    if (filter.mine) out.push({ key: 'mine', text: labelOf(mineOptions, filter.mine) ?? filter.mine, clear: () => (filter.mine = undefined) })
    if (filter.status !== 'UNCLOSED') out.push({ key: 'status', text: `状态：${filter.status ? labelOf(statusOptions, filter.status) : '全部'}`, clear: () => (filter.status = 'UNCLOSED') })
    if (filter.category) out.push({ key: 'category', text: `分类：${labelOf(categoryOptions, filter.category)}`, clear: () => (filter.category = undefined) })
    if (filter.overdue) out.push({ key: 'overdue', text: '只看超期', clear: () => (filter.overdue = undefined) })
  }
  return out
})
const overdueOnly = computed({ get: () => !!filter.overdue, set: (v: boolean) => (filter.overdue = v ? '1' : undefined) })
function clearFilters() {
  for (const c of activeChips.value) c.clear()
}
</script>

<template>
  <div>
  <div class="risks">
    <NuxtLink v-if="returnTo" :to="returnTo">返回全盘统计（保留条件）</NuxtLink>
    <UiPageHero title="风险与异常监控" :summary="heroSummary">
      <template #titleAfter>
        <UiHelpTip label="异常台账说明">「异常台账」用于追踪跨部门异常从受理、处理到验证关闭的全流程；「系统预警」由扫描任务每 15 分钟更新，红色预警与 QMS 不合格会自动转成异常。</UiHelpTip>
      </template>
      <template #actions>
        <UiRefreshButton @click="refresh()" />
        <a-button type="primary" class="ft-btn-ink" @click="reporting = true">上报异常</a-button>
      </template>
    </UiPageHero>

    <!-- 异常状态漏斗 KPI：点击联动过滤台账 -->
    <div class="kpi-row">
      <UiStatCard
        label="待受理"
        :value="funnel.open"
        unit="条"
        tone="risk"
        accent
        icon="warn"
        clickable
        :active="tab === 'issues' && filter.status === 'OPEN'"
        sub="刚上报或预警转入，等待责任人接单"
        @click="toggleFunnelStatus('OPEN')"
      />
      <UiStatCard
        label="处理中"
        :value="funnel.accepted"
        unit="条"
        tone="primary"
        accent
        icon="dot"
        clickable
        :active="tab === 'issues' && filter.status === 'ACCEPTED'"
        sub="已受理正在整改推进"
        @click="toggleFunnelStatus('ACCEPTED')"
      />
      <UiStatCard
        label="已超期"
        :value="funnel.overdue"
        unit="条"
        tone="late"
        accent
        icon="alert"
        clickable
        :active="tab === 'issues' && !!filter.overdue"
        sub="超过要求解决日或待受理超时"
        @click="toggleFunnelOverdue"
      />
      <UiStatCard
        label="待关闭验证"
        :value="funnel.resolved"
        unit="条"
        tone="done"
        accent
        icon="ok"
        clickable
        :active="tab === 'issues' && filter.status === 'RESOLVED'"
        sub="已提交处理结果，等确认关闭"
        @click="toggleFunnelStatus('RESOLVED')"
      />
    </div>

    <UiSectionCard icon="shield" padding="none" title="风险明细" tray>
      <template #title>
        <div class="tray-title-row">
          <a-segmented v-model:value="tab" :options="tabOptions" class="tabs" />
          <span v-if="tab === 'issues'" class="tray-hint">{{ filter.workOrderNumber ? `工单 ${filter.workOrderNumber}` : '点击任意行处理闭环' }}</span>
          <span v-else class="tray-hint">15 分钟自动扫描 · 黄色预警可手动转异常</span>
        </div>
      </template>
      <template #extra>
        <a-select v-model:value="filter.workOrderNumber" allow-clear show-search placeholder="全部工单" style="width: 168px" :options="woOptions" />
        <UiFilterButton :count="activeChips.length" @clear="clearFilters">
          <template v-if="tab === 'alerts'">
            <div class="ft-filter-group">预警</div>
            <label class="ft-filter-row"><span>规则</span><a-select v-model:value="filter.rule" allow-clear placeholder="全部规则" :options="ruleOptions" /></label>
            <label class="ft-filter-row"><span>级别</span><a-select v-model:value="filter.level" allow-clear placeholder="全部级别" :options="levelOptions" /></label>
          </template>
          <template v-else>
            <div class="ft-filter-group">异常</div>
            <div class="ft-filter-row"><span>范围</span>
              <a-segmented v-model:value="filter.dept" :options="[{ value: '1', label: '本部门' }, { value: '0', label: '可见范围' }]" block />
            </div>
            <label class="ft-filter-row"><span>与我</span><a-select v-model:value="filter.mine" allow-clear placeholder="全部人" :options="mineOptions" /></label>
            <label class="ft-filter-row"><span>状态</span><a-select v-model:value="filter.status" allow-clear placeholder="全部状态" :options="statusOptions" /></label>
            <label class="ft-filter-row"><span>分类</span><a-select v-model:value="filter.category" allow-clear placeholder="全部分类" :options="categoryOptions" /></label>
            <a-checkbox v-model:checked="overdueOnly">只看超期</a-checkbox>
          </template>
        </UiFilterButton>
      </template>

      <div v-if="activeChips.length" class="chips-bar">
        <UiFilterChips :items="activeChips" @clear-all="clearFilters" />
      </div>

      <a-spin :spinning="summaryPending">
        <a-result v-if="summaryError && !summaryPending" status="error" :title="tab === 'alerts' ? '预警数据加载失败' : '异常数据加载失败'">
          <template #extra><a-button @click="refresh()">重试</a-button></template>
        </a-result>

        <!-- 异常闭环台账表格 -->
        <template v-else-if="tab === 'issues'">
          <div v-if="!sortedIssues.length" class="empty-box">
            <a-empty description="没有符合条件的异常记录" />
          </div>
          <a-table
            v-else
            :columns="issueColumns"
            :data-source="sortedIssues"
            row-key="id"
            size="middle"
            :pagination="{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }"
            :custom-row="(record: IssueRow) => ({
              class: 'issue-table-row',
              tabindex: 0,
              onClick: () => (selected = record.id),
              onKeydown: (e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  selected = record.id
                }
              },
            })"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'issueNo'">
                <div class="mono strong">{{ record.issueNo }}</div>
                <div class="sub-line">{{ ISSUE_SOURCE_TEXT[record.source as keyof typeof ISSUE_SOURCE_TEXT] }}</div>
              </template>
              <template v-else-if="column.key === 'ref'">
                <div @click.stop><WoLink :no="record.workOrderNumber" /></div>
                <div v-if="record.refText" class="sub-line ellipsis" :title="record.refText">{{ record.refText }}</div>
              </template>
              <template v-else-if="column.key === 'desc'">
                <div class="desc clamp" :title="record.description">{{ record.description }}</div>
                <div class="sub-line">
                  <span>{{ record.categoryText }}</span>
                  <span v-if="record.photoCount"> · 照片 {{ record.photoCount }} 张</span>
                  <span v-if="record.responsibleSupplierName"> · 外协：{{ record.responsibleSupplierName }}</span>
                </div>
              </template>
              <template v-else-if="column.key === 'status'">
                <a-tag :color="ISSUE_STATUS_COLOR[record.status as IssueStatusKey]" class="tag">{{ ISSUE_STATUS_TEXT[record.status as IssueStatusKey] }}</a-tag>
              </template>
              <template v-else-if="column.key === 'owner'">
                <div>{{ record.responsibleDeptName ?? '—' }}</div>
                <div class="sub-line">{{ record.responsibleUserName ?? '未指定' }}</div>
              </template>
              <template v-else-if="column.key === 'dueDate'">
                <div class="mono" :class="{ late: record.overdue }">{{ dayText(record.dueDate) || '—' }}</div>
                <div v-if="record.overdue" class="sub-line late">{{ record.overdueDays ? `已超期 ${record.overdueDays} 天` : '待受理超时' }}</div>
              </template>
              <template v-else-if="column.key === 'ops'">
                <a-button
                  size="small"
                  :type="primaryIssueAction(record).primary ? 'primary' : 'default'"
                  :ghost="primaryIssueAction(record).primary"
                  @click.stop="selected = record.id"
                >
                  {{ primaryIssueAction(record).label }}
                </a-button>
              </template>
            </template>
          </a-table>
        </template>

        <!-- 系统预警升级池表格 -->
        <template v-else>
          <div v-if="!sortedAlerts.length" class="empty-box">
            <a-empty description="没有活动中的系统预警" />
          </div>
          <a-table
            v-else
            :columns="alertColumns"
            :data-source="sortedAlerts"
            row-key="id"
            size="middle"
            :pagination="{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'level'">
                <span class="sq-badge" :class="`k-${record.level}`">{{ LEVEL_TEXT[record.level as AlertLevelKey] }}预警</span>
                <div class="sub-line">{{ RULE_TEXT[record.rule as keyof typeof RULE_TEXT] }}</div>
              </template>
              <template v-else-if="column.key === 'wo'">
                <WoLink v-if="record.workOrderNumber" :no="record.workOrderNumber" />
                <span v-else class="muted">—</span>
              </template>
              <template v-else-if="column.key === 'subject'">
                <div class="strong">
                  <NuxtLink v-if="record.link" :to="record.link" class="subject-link">{{ record.subject }}</NuxtLink>
                  <span v-else>{{ record.subject }}</span>
                </div>
                <div class="sub-line clamp" :title="record.summary">{{ record.summary }}</div>
              </template>
              <template v-else-if="column.key === 'owner'">
                <div>{{ record.deptNames.length ? record.deptNames.join('、') : '—' }}</div>
                <div class="sub-line">
                  <template v-if="record.owners.length">{{ ownerText(record.owners) }}</template>
                  <span v-else class="muted">未设置责任人</span>
                </div>
              </template>
              <template v-else-if="column.key === 'time'">
                <div class="mono">{{ record.duration ? `已持续 ${record.duration}` : '刚触发' }}</div>
                <div class="sub-line">首次 {{ factoryTimeText(record.firstAt) }}</div>
              </template>
              <template v-else-if="column.key === 'ops'">
                <div class="table-ops">
                  <a-button v-if="record.issue" size="small" class="issue-btn" @click="selected = record.issue.id">已转 {{ record.issue.issueNo }}</a-button>
                  <a-button v-else-if="record.canConvert" size="small" danger :loading="converting === record.id" @click="convert({ id: record.id, subject: record.subject })">转异常</a-button>
                  <NuxtLink v-if="record.link" :to="record.link" class="go">{{ record.canHandle ? '去处理' : '查看详情' }}</NuxtLink>
                </div>
              </template>
            </template>
          </a-table>
        </template>
      </a-spin>
    </UiSectionCard>
  </div>

  <IssueDrawer :id="selected" @close="selected = null" @changed="refresh()" />
  <IssueReportModal :open="reporting" :work-order-number="filter.workOrderNumber" @close="reporting = false" @done="onReported" />
  </div>
</template>

<style scoped>
.risks { display: flex; flex-direction: column; gap: 16px; }
.kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tray-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tray-hint { font-size: 12px; font-weight: 400; color: var(--ft-text-3); }
.muted { color: var(--ft-text-3); font-size: 12px; }
.tabs { font-weight: normal; }
.chips-bar { padding: 0 20px 10px; }
.empty-box { padding: 36px 20px; }
.mono { font-variant-numeric: tabular-nums; }
.sub-line { margin-top: 2px; font-size: 12px; color: var(--ft-text-3); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.late { color: var(--ft-late-text); font-weight: 500; }
.strong { font-weight: 600; color: var(--ft-text); }
.subject-link { color: var(--ft-text); }
.subject-link:hover { color: var(--ft-primary-text); }
.tag { margin-inline-end: 0; }
.desc { font-size: 13px; color: var(--ft-text); line-height: 1.45; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
:deep(.issue-table-row) { cursor: pointer; }
:deep(.issue-table-row:focus-visible) { outline: 2px solid var(--ft-primary); outline-offset: -2px; }
.sq-badge { display: inline-flex; align-items: center; height: 21px; padding: 0 7px; border-radius: 5px; font-size: 11.5px; font-weight: 600; line-height: 21px; background: var(--ft-fill); color: var(--ft-text-2); white-space: nowrap; }
.k-RED { background: var(--ft-late-bg); color: var(--ft-late-text); }
.k-YELLOW { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.k-REMIND { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.table-ops { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; white-space: nowrap; }
.issue-btn { color: var(--ft-primary-text); border-color: var(--ft-primary-bg); }
.go { font-size: 13px; white-space: nowrap; }

@media (max-width: 991px) { .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 575px) { .kpi-row { grid-template-columns: minmax(0, 1fr); } }
</style>
