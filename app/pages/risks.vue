<script setup lang="ts">
/**
 * 风险（前端改版第二轮）：原"预警列表"和"异常列表"合成一页，页签 全部 / 预警 / 异常（?tab=all|alerts|issues）。
 * 顶部两张小横条图：按责任部门的风险数、按严重度（红色预警 / 黄色预警 / 超期异常 / 未超期异常），都按当前筛选算（口径见 shared/workbench.ts riskTallies）。
 * 数据沿用原接口 GET /api/alerts、GET /api/issues（权限、可见范围不变），筛选参数与原两页一致：
 *   预警 ?rule= ?level= ；异常 ?status= ?category= ?dept= ?mine= ?overdue=1 ；共用 ?wo= ；?id= 打开某条异常的处理抽屉。
 * 原操作全部保留：预警"转异常"（责任人、项目经理、管理员）、去处理；异常点开抽屉受理 / 改派 / 处理 / 关闭 / 退回，右上角"上报异常"。
 * 旧地址 /alerts、/issues 带原参数重定向到这里（见 pages/alerts.vue、pages/issues.vue）。
 */
import { ALERT_RULES } from '#shared/alert-rules'
import { NO_DEPT, RISK_SEVERITIES, RISK_SEVERITY_TEXT, factoryTimeText, riskTallies, type RiskSeverity } from '#shared/workbench'

const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const { data: workOrders } = await useWorkOrders()

type Tab = 'all' | 'alerts' | 'issues'
const TABS: Tab[] = ['all', 'alerts', 'issues']
const q = (k: string) => (route.query[k] as string) || undefined
const tab = ref<Tab>(TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'all')

const filter = reactive({
  workOrderNumber: q('wo'),
  // 预警
  rule: q('rule'),
  level: q('level'),
  // 异常（默认未关闭；地址栏 status=ALL 表示"全部状态"）
  status: (q('status') === 'ALL' ? undefined : (q('status') ?? 'UNCLOSED')) as string | undefined,
  category: q('category'),
  // 部门负责人默认看本部门，可切换全部
  dept: (route.query.dept as string) ?? (me.value?.deptHeadOf.length ? '1' : '0'),
  mine: q('mine'),
  // 只看超期（从领导总览"超期异常"点进来）
  overdue: route.query.overdue === '1' ? '1' : undefined,
})

const { data: alerts, pending: alertsPending, error: alertsError, refresh: refreshAlerts } = await useFetch('/api/alerts', {
  query: computed(() => ({ rule: filter.rule, level: filter.level, workOrderNumber: filter.workOrderNumber })),
  default: () => [],
})
const { data: issues, pending: issuesPending, error: issuesError, refresh: refreshIssues } = await useFetch('/api/issues', {
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

// ?id= 打开某条异常（从提醒、工件页、预警"已转异常"跳过来）
const selected = ref<string | null>(q('id') ?? null)
watch(
  () => route.query.id,
  (id) => {
    const v = (id as string) || null
    if (v !== selected.value) selected.value = v
  },
)

// 筛选、页签、打开的异常写进地址栏，便于分享
watch(
  () => [tab.value, selected.value, { ...filter }],
  () => {
    if (!import.meta.client) return
    router.replace({
      query: {
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

// 电脑端上报异常：提交后刷新列表并打开刚报的那条
const reporting = ref(false)
function onReported(issue: { id: string }) {
  reporting.value = false
  refresh()
  selected.value = issue.id
}

/** 黄色预警手动转异常（责任人、项目经理、管理员）；红色由扫描任务自动转 */
const converting = ref<string | null>(null)
function convert(row: { id: string; subject: string }) {
  Modal.confirm({
    title: '把这条预警转为异常？',
    content: row.subject,
    okText: '转异常',
    async onOk() {
      converting.value = row.id
      try {
        const r = await ($fetch as unknown as (u: string, o: { method: 'POST' }) => Promise<{ issueId: string; issueNo: string }>)(`/api/alerts/${row.id}/convert`, { method: 'POST' })
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

// ───── 汇总图 ─────
// 按当前页签取数：预警页签不算异常，异常页签不算预警
const tallies = computed(() => riskTallies(tab.value === 'issues' ? [] : alerts.value, tab.value === 'alerts' ? [] : issues.value))
const summaryError = computed(() =>
  tab.value === 'alerts' ? Boolean(alertsError.value) : tab.value === 'issues' ? Boolean(issuesError.value) : Boolean(alertsError.value || issuesError.value),
)
const summaryPending = computed(() =>
  tab.value === 'alerts' ? alertsPending.value : tab.value === 'issues' ? issuesPending.value : alertsPending.value || issuesPending.value,
)
const heroSummary = computed(() => {
  if (summaryError.value) {
    if (tab.value === 'alerts') return '预警数据加载失败，暂无法汇总，请重试。'
    if (tab.value === 'issues') return '异常数据加载失败，暂无法汇总，请重试。'
    return '预警与异常数据加载失败，暂无法汇总，请重试。'
  }
  if (summaryPending.value && !items.value.length) return '正在汇总当前预警与未关闭异常…'
  const t = tallies.value
  if (!t.total) return '当前筛选范围内暂无活动预警与未关闭异常。'
  const sev = t.bySeverity
  const parts: string[] = []
  if (sev.RED) parts.push(`红色预警 ${sev.RED}`)
  if (sev.ISSUE_OVERDUE) parts.push(`超期异常 ${sev.ISSUE_OVERDUE}`)
  if (sev.YELLOW) parts.push(`黄色预警 ${sev.YELLOW}`)
  if (sev.ISSUE_OPEN) parts.push(`待处理异常 ${sev.ISSUE_OPEN}`)
  const top = t.byDept[0]
  const deptNote = top && top.name !== NO_DEPT ? `，主要集中在${top.name}（${top.count} 项）` : ''
  return `当前筛选下共 ${t.total} 项风险${parts.length ? `（${parts.join(' · ')}）` : ''}${deptNote}。`
})
const SEVERITY_TONE: Record<RiskSeverity, string> = { RED: 'late', YELLOW: 'risk', ISSUE_OVERDUE: 'upstream', ISSUE_OPEN: 'on-track' }
const severityBars = computed(() => RISK_SEVERITIES.map((s) => ({ key: s, label: RISK_SEVERITY_TEXT[s], value: tallies.value.bySeverity[s], tone: SEVERITY_TONE[s] })))
/** 部门多时只列前 8 个，其余合并 */
const deptBars = computed(() => {
  const rows = tallies.value.byDept
  const head = rows.slice(0, 8).map((r) => ({ key: r.name, label: r.name, value: r.count, tone: r.name === NO_DEPT ? 'none' : 'late' }))
  const rest = rows.slice(8).reduce((n, r) => n + r.count, 0)
  return rest ? [...head, { key: '__rest', label: '其他部门', value: rest, tone: 'none' }] : head
})

// ───── 卡片列表 ─────
type AlertRow = (typeof alerts.value)[number]
type IssueRow = (typeof issues.value)[number]
type Tone = 'late' | 'risk' | 'upstream' | 'primary' | 'none'
type Item = { key: string; kind: 'alert'; rank: number; tone: Tone; a: AlertRow } | { key: string; kind: 'issue'; rank: number; tone: Tone; i: IssueRow }

/** 排序：红色预警 → 超期异常 → 黄色预警 → 未超期异常 → 提醒 → 已转异常的预警 → 已关闭的异常（同级保持接口原来的顺序） */
const alertItem = (a: AlertRow): Item => {
  const converted = a.status === 'CONVERTED'
  const rank = converted ? 5 : a.level === 'RED' ? 0 : a.level === 'YELLOW' ? 2 : 4
  const tone: Tone = converted ? 'none' : a.level === 'RED' ? 'late' : a.level === 'YELLOW' ? 'risk' : 'primary'
  return { key: `a:${a.id}`, kind: 'alert', rank, tone, a }
}
const issueItem = (i: IssueRow): Item => {
  const closed = i.status === 'CLOSED'
  const rank = closed ? 6 : i.overdue ? 1 : 3
  const tone: Tone = closed ? 'none' : i.overdue ? (i.alertLevel === 'RED' ? 'late' : 'upstream') : 'primary'
  return { key: `i:${i.id}`, kind: 'issue', rank, tone, i }
}
const items = computed<Item[]>(() => {
  const list = [...(tab.value === 'issues' ? [] : alerts.value.map(alertItem)), ...(tab.value === 'alerts' ? [] : issues.value.map(issueItem))]
  return list.map((x, idx) => ({ x, idx })).sort((p, r) => p.x.rank - r.x.rank || p.idx - r.idx).map((p) => p.x)
})
const PAGE = 60
const shown = ref(PAGE)
watch([tab, () => ({ ...filter })], () => (shown.value = PAGE), { deep: true })

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
const iconOf = (t: Tone) => (t === 'late' ? 'alert' : t === 'risk' || t === 'upstream' ? 'warn' : t === 'none' ? 'ring' : 'dot')
const showAlertFilters = computed(() => tab.value !== 'issues')
const showIssueFilters = computed(() => tab.value !== 'alerts')

// ───── 筛选区简化（设计改版）：常用的工单留在工具栏，其余收进"筛选"面板；生效的条件在下方显示成可关闭的标签 ─────
const tabOptions = computed(() => [
  { value: 'all', label: `全部 ${alerts.value.length + issues.value.length}` },
  { value: 'alerts', label: `预警 ${alerts.value.length}` },
  { value: 'issues', label: `异常 ${issues.value.length}` },
])
/** 各条件的默认值：和上面 filter 初始化时的默认一致（状态默认"未关闭"，部门负责人默认看本部门） */
const deptDefault = computed(() => (me.value?.deptHeadOf.length ? '1' : '0'))
const labelOf = (opts: { value: string; label: string }[], v?: string) => opts.find((o) => o.value === v)?.label ?? v
/** 已生效（和默认不同）的条件；切到只看预警 / 只看异常时，另一类的条件不显示（它们本来也不参与筛选） */
const activeChips = computed(() => {
  const out: { key: string; text: string; clear: () => void }[] = []
  if (showAlertFilters.value) {
    if (filter.rule) out.push({ key: 'rule', text: `规则：${labelOf(ruleOptions, filter.rule)}`, clear: () => (filter.rule = undefined) })
    if (filter.level) out.push({ key: 'level', text: `级别：${labelOf(levelOptions, filter.level)}`, clear: () => (filter.level = undefined) })
  }
  if (showIssueFilters.value) {
    if (filter.dept !== deptDefault.value) out.push({ key: 'dept', text: `异常范围：${filter.dept === '1' ? '本部门' : '全部'}`, clear: () => (filter.dept = deptDefault.value) })
    if (filter.mine) out.push({ key: 'mine', text: labelOf(mineOptions, filter.mine)!, clear: () => (filter.mine = undefined) })
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
    <UiPageHero title="风险与异常监控" :summary="heroSummary">
      <template #titleAfter>
        <UiHelpTip label="风险页说明">预警由扫描任务每 15 分钟更新，对象状态变化后自动消除；红色预警（W1–W3）会自动转成异常。电脑上点右上角"上报异常"；手机上打开手机端"异常"→"上报异常"。系统会把 QMS 检验不合格和红色预警自动转成异常。</UiHelpTip>
      </template>
      <template #actions>
        <UiRefreshButton @click="refresh()" />
        <a-button type="primary" class="ft-btn-ink" @click="reporting = true">上报异常</a-button>
      </template>
    </UiPageHero>

    <div class="charts">
      <UiSectionCard icon="bars" title="按责任部门" :sub="`当前筛选下 ${tallies.total} 项风险；一条预警有多个责任部门时各算一次`" padding="tight">
        <UiBarList :items="deptBars" empty="没有风险" :label-width="84" />
      </UiSectionCard>
      <UiSectionCard icon="chart" title="按严重度" sub="预警只算活动中的红、黄（已转异常的算在异常里）；异常只算未关闭的" padding="tight">
        <UiBarList :items="severityBars" :label-width="84" />
      </UiSectionCard>
    </div>

    <UiSectionCard icon="shield" padding="none" title="风险明细" :sub="filter.workOrderNumber ? `工单 ${filter.workOrderNumber}` : '按紧急度排序：红色预警 → 超期异常 → 黄色预警 → 未超期异常'">
      <template #extra>
        <a-segmented v-model:value="tab" :options="tabOptions" class="tabs" />
        <a-select v-model:value="filter.workOrderNumber" allow-clear show-search placeholder="全部工单" style="width: 168px" :options="woOptions" />
        <UiFilterButton :count="activeChips.length" @clear="clearFilters">
          <template v-if="showAlertFilters">
            <div class="ft-filter-group">预警</div>
            <label class="ft-filter-row"><span>规则</span><a-select v-model:value="filter.rule" allow-clear placeholder="全部规则" :options="ruleOptions" /></label>
            <label class="ft-filter-row"><span>级别</span><a-select v-model:value="filter.level" allow-clear placeholder="全部级别" :options="levelOptions" /></label>
          </template>
          <template v-if="showIssueFilters">
            <div class="ft-filter-group">异常</div>
            <div class="ft-filter-row"><span>范围</span>
              <a-segmented v-model:value="filter.dept" :options="[{ value: '1', label: '本部门' }, { value: '0', label: '全部' }]" block />
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

      <a-spin :spinning="alertsPending || issuesPending">
        <div v-if="!items.length" class="empty-box">
          <a-empty :description="tab === 'alerts' ? '没有活动中的预警' : tab === 'issues' ? '没有符合条件的异常' : '没有符合条件的预警和异常'" />
        </div>
        <div v-else class="feed-list">
          <template v-for="it in items.slice(0, shown)" :key="it.key">
            <!-- 预警 -->
            <article v-if="it.kind === 'alert'" class="rrow" :class="`tone-${it.tone}`">
              <span class="row-badge" :class="`badge-${it.tone}`" aria-hidden="true">
                <UiStatusIcon :kind="iconOf(it.tone)" :tone="it.tone" :size="15" />
              </span>
              <div class="main">
                <div class="head">
                  <NuxtLink v-if="it.a.link" :to="it.a.link" class="subject strong">{{ it.a.subject }}</NuxtLink>
                  <span v-else class="subject strong">{{ it.a.subject }}</span>
                  <span class="rule">{{ RULE_TEXT[it.a.rule as keyof typeof RULE_TEXT] }}</span>
                </div>
                <div class="desc">{{ it.a.summary }}<span v-if="it.a.duration" class="muted">　已持续 {{ it.a.duration }}（不含停工日）</span></div>
                <div class="meta">
                  <span v-if="it.a.workOrderNumber">工单 <WoLink :no="it.a.workOrderNumber" /></span>
                  <span>责任人 <template v-if="it.a.owners.length">{{ ownerText(it.a.owners) }}</template><span v-else class="muted">未设置</span></span>
                  <span v-if="it.a.deptNames.length">{{ it.a.deptNames.join('、') }}</span>
                  <span class="muted">首次 {{ factoryTimeText(it.a.firstAt) }} · 升级 {{ factoryTimeText(it.a.levelAt) }}</span>
                </div>
              </div>
              <div class="ops">
                <span class="sq-badge" :class="`k-${it.a.level}`">{{ LEVEL_TEXT[it.a.level as AlertLevelKey] }}预警</span>
                <a-button v-if="it.a.issue" size="small" class="issue-btn" @click="selected = it.a.issue.id">已转异常 {{ it.a.issue.issueNo }}</a-button>
                <a-button v-else-if="it.a.canConvert" size="small" danger :loading="converting === it.a.id" @click="convert({ id: it.a.id, subject: it.a.subject })">转异常</a-button>
                <NuxtLink v-if="it.a.link" :to="it.a.link" class="go">去处理 ›</NuxtLink>
              </div>
            </article>
            <!-- 异常：点开处理抽屉 -->
            <article v-else class="rrow clickable" :class="`tone-${it.tone}`" role="button" tabindex="0" @click="selected = it.i.id" @keydown.enter="selected = it.i.id" @keydown.space.prevent="selected = it.i.id">
              <span class="row-badge" :class="`badge-${it.tone}`" aria-hidden="true">
                <UiStatusIcon :kind="iconOf(it.tone)" :tone="it.tone" :size="15" />
              </span>
              <div class="main">
                <div class="head">
                  <span class="subject strong">{{ it.i.issueNo }}</span>
                  <span class="rule">{{ it.i.categoryText }} · {{ ISSUE_SOURCE_TEXT[it.i.source as keyof typeof ISSUE_SOURCE_TEXT] }}</span>
                  <a-tag :color="ISSUE_STATUS_COLOR[it.i.status as IssueStatusKey]" class="tag">{{ ISSUE_STATUS_TEXT[it.i.status as IssueStatusKey] }}</a-tag>
                  <a-tag v-if="it.i.overdue" :color="it.i.alertLevel === 'RED' ? 'red' : 'orange'" class="tag">{{ it.i.overdueDays ? `超期 ${it.i.overdueDays} 天` : '待受理超时' }}</a-tag>
                </div>
                <div class="desc clamp">{{ it.i.description }}</div>
                <div class="meta">
                  <span>工单 <WoLink :no="it.i.workOrderNumber" /></span>
                  <span v-if="it.i.refText">{{ it.i.refText }}<template v-if="it.i.photoCount">　照片 {{ it.i.photoCount }} 张</template></span>
                  <span>责任 {{ it.i.responsibleDeptName ?? '—' }} / {{ it.i.responsibleUserName ?? '未指定' }}<template v-if="it.i.responsibleSupplierName"> / {{ it.i.responsibleSupplierName }}</template></span>
                  <span :class="{ late: it.i.overdue }">要求解决 {{ dayText(it.i.dueDate) || '—' }}</span>
                </div>
              </div>
              <div class="ops">
                <span class="sq-badge k-ISSUE">异常</span>
                <a-button size="small" @click.stop="selected = it.i.id">处理 ›</a-button>
              </div>
            </article>
          </template>
        </div>
        <div v-if="items.length > shown" class="more">
          <a-button @click="shown += PAGE">再显示 {{ Math.min(PAGE, items.length - shown) }} 条（共 {{ items.length }} 条）</a-button>
        </div>
      </a-spin>
    </UiSectionCard>
  </div>

  <IssueDrawer :id="selected" @close="selected = null" @changed="refresh()" />
  <IssueReportModal :open="reporting" :work-order-number="filter.workOrderNumber" @close="reporting = false" @done="onReported" />
  </div>
</template>

<style scoped>
.risks { display: flex; flex-direction: column; gap: 20px; }
.charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.muted { color: var(--ft-text-3); font-size: 12px; }
.tabs { font-weight: normal; }
.chips-bar { padding: 0 20px 10px; }
.empty-box { padding: 36px 20px; }
.feed-list { display: flex; flex-direction: column; border-top: 1px solid var(--ft-border); }
.more { padding: 14px 20px; border-top: 1px solid var(--card-border-subtle); text-align: center; }

/* Ember Payouts 式去框平铺风险行 */
.rrow {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 14px 20px;
  background: transparent;
  transition: background-color 0.14s;
}
.rrow + .rrow { border-top: 1px solid var(--card-border-subtle); }
.rrow.clickable { cursor: pointer; }
.rrow:hover { background: color-mix(in srgb, var(--ft-fill) 65%, transparent); }
.rrow:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }

.row-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-top: 1px;
  border-radius: 9px;
  background-clip: padding-box;
  border: 1px solid var(--card-hairline);
  box-shadow: var(--card-badge-shadow);
}
.badge-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.badge-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.badge-upstream { background: var(--ft-upstream-bg); color: var(--ft-upstream-text); }
.badge-primary { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.badge-none { background: var(--ft-fill); color: var(--ft-text-3); }

.sq-badge {
  display: inline-flex;
  align-items: center;
  height: 21px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 21px;
  background: var(--ft-fill);
  color: var(--ft-text-2);
  white-space: nowrap;
}
.k-RED { background: var(--ft-late-bg); color: var(--ft-late-text); }
.k-YELLOW { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.k-REMIND { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.k-ISSUE { background: var(--ft-upstream-bg); color: var(--ft-upstream-text); }

.main { flex: 1; min-width: 0; }
.head { line-height: 22px; }
.head > * { vertical-align: middle; }
.head > * + * { margin-left: 8px; }
.subject { font-size: 14px; line-height: 22px; word-break: break-word; }
span.subject { color: var(--ft-text); }
.strong { font-weight: 600; }
.rule { font-size: 12px; color: var(--ft-text-2); }
.tag { margin-inline-end: 0; }
.desc { margin-top: 3px; font-size: 13px; color: var(--ft-text); line-height: 1.45; }
.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; color: var(--ft-text-2); }
.meta .late { color: var(--ft-late-text); font-weight: 500; }
.ops { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; max-width: 260px; }
.issue-btn { color: var(--ft-primary-text); border-color: var(--ft-primary-bg); }
.go { font-size: 13px; white-space: nowrap; }

@media (max-width: 991px) {
  .charts { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 575px) {
  .rrow { flex-wrap: wrap; padding: 12px 14px; }
  .ops { width: 100%; max-width: none; justify-content: flex-start; padding-left: 47px; }
}
</style>
