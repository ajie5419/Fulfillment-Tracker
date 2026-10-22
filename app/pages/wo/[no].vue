<script setup lang="ts">
/**
 * 工单详情（前端改版第一轮，以工单为中心的页面）：
 *   头部：工单号 · 产品、项目经理 · 客户、总计划状态、交期对比条（开始 → 今天 → 合同交期，预计超出部分标红）；
 *   指标卡：总计划节点完成、总装齐套率 + 缺件原因、活动预警红 / 黄、未关闭异常 + 超期；
 *   总计划时间线：每个节点一行（虚线框 = 计划区间，实心条 = 预计 / 实际，颜色按状态，竖线 = 今天），点节点展开挂在上面的设计、采购、工序、装配记录；
 *   右侧：要处理的事（活动预警 + 未关闭异常，按严重度排）、谁在拖（源头延误天数按责任部门）、还没挂到节点的记录。
 * 地址 #node-<id> 定位并展开该节点（列表"总计划节点"列点过来）。日期全部用服务端给的 'YYYY-MM-DD'。
 * 功能重复梳理第二批（zhao 10-22）：原"总计划"页并进来，成为第二个页签 ?tab=plan（编制、发布、调整、确认、标完成都在这里，?node= 定位节点）；
 *   旧地址 /plan?wo=&node= 跳到这里。总计划页签不依赖详情接口：手里有确认待办、但看不到这个工单的部门负责人也能打开（/api/plan 的规则）。
 */
import type { WorkOrderDetail } from '~~/server/services/workorder/detail'
import { BOARD_GROUP_TEXT, NODE_STATE_COLOR, NODE_STATE_TEXT, type NodeState, boardGroup, isClosedWorkOrder, woStatusText } from '#shared/status'
import { deliveryBar, ganttRange, monthTicks, nodeBars, pct } from '#shared/gantt'

const route = useRoute()
const no = computed(() => String(route.params.no ?? ''))
const { data, error, pending, refresh } = await useFetch<WorkOrderDetail>(() => `/api/work-orders/${encodeURIComponent(no.value)}/detail`, {
  key: computed(() => `wo-detail:${no.value}`),
})
const d = computed(() => data.value)

// ───── 页签：概览 / 总计划（?tab=plan）─────
type Tab = 'overview' | 'plan'
const tab = computed<Tab>(() => (route.query.tab === 'plan' ? 'plan' : 'overview'))
function setTab(v: unknown) {
  // 切回概览时去掉总计划的节点定位参数
  navigateTo({ query: v === 'plan' ? { ...route.query, tab: 'plan' } : { ...route.query, tab: undefined, node: undefined } }, { replace: true })
}
const planLink = (nodeId?: string) => ({ query: { tab: 'plan', node: nodeId } })

useHead({ title: computed(() => (d.value ? `${d.value.workOrder.workOrderNumber} · 工单详情` : '工单详情')) })

const title = computed(() => d.value?.workOrder.projectName ?? d.value?.workOrder.customerName ?? '')

// ───── 整体状态（与项目总览分组同一口径）─────
const group = computed(() => {
  const x = d.value
  if (!x) return 'NO_PLAN' as const
  const color = x.alerts.red ? 'RED' : x.alerts.yellow || x.issues.overdue ? 'YELLOW' : 'GREEN'
  return boardGroup({ hasPlan: x.published, delayDays: x.delayDays, delayedPlanNodes: x.progress.source, color })
})
const pill = computed(() => {
  const x = d.value!
  switch (group.value) {
    case 'LATE':
      return { tone: 'late', icon: 'alert' as const, text: `交期风险 · 预计拖期 ${x.delayDays} 天` }
    case 'RISK':
      return { tone: 'risk', icon: 'warn' as const, text: x.progress.source ? `有风险 · 源头延误节点 ${x.progress.source} 个` : '有风险 · 有活动预警或超期异常' }
    case 'OK':
      return { tone: 'done', icon: 'check' as const, text: '按计划' }
    default:
      return { tone: 'none', icon: 'ring' as const, text: x.plan ? '总计划未发布' : BOARD_GROUP_TEXT.NO_PLAN }
  }
})

// ───── 交期对比条 ─────
const bar = computed(() => {
  const x = d.value
  if (!x) return null
  const start = x.plan?.startDate ?? null
  if (!start) return null
  return { start, ...deliveryBar(start, x.today, x.workOrder.deliveryDate, x.expectedDelivery) }
})

// ───── 时间线 ─────
const range = computed(() => {
  const x = d.value
  if (!x) return null
  const days = [x.today, x.workOrder.deliveryDate, x.expectedDelivery, x.plan?.startDate, ...x.nodes.flatMap((n) => [n.planDate, n.expectedDate, n.actualDate])]
  return ganttRange(days, x.today, 4, 30)
})
const ticks = computed(() => (range.value ? monthTicks(range.value) : []))
const todayLeft = computed(() => (range.value && d.value ? pct(d.value.today, range.value) : 0))
const bars = computed(() => {
  const x = d.value
  if (!x || !x.nodes.length) return []
  const first = x.nodes[0]!.planDate
  const start = x.plan?.startDate && x.plan.startDate < first ? x.plan.startDate : first
  return nodeBars(
    x.nodes.map((n) => ({ planDay: n.planDate, endDay: n.actualDate ?? n.expectedDate })),
    start,
  )
})
function seg(from: string, to: string) {
  const r = range.value!
  const l = pct(from, r)
  return { left: `${l}%`, width: `${Math.max(pct(to, r) - l, 0)}%` }
}

const STATE_DEPT_TEXT: Record<NodeState, (n: { selfDelayDays: number; delayDays: number }) => string> = {
  DONE: () => '已完成',
  SOURCE: (n) => `源头延误 ${n.selfDelayDays} 天`,
  UPSTREAM: (n) => `受上游影响 ${n.delayDays} 天`,
  ON_TRACK: () => '按计划',
}
const STATE_CLASS: Record<NodeState, string> = { DONE: 'ft-text-done', SOURCE: 'ft-text-late', UPSTREAM: 'ft-text-upstream', ON_TRACK: 'ft-muted' }

// 展开的节点（#node-<id> 定位）
const expanded = ref(new Set<string>())
function toggle(id: string) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}
async function focusHash() {
  const m = /^#node-(.+)$/.exec(route.hash)
  if (!m || !d.value) return
  const id = decodeURIComponent(m[1]!)
  if (!d.value.nodes.some((n) => n.id === id)) return
  expanded.value = new Set([...expanded.value, id])
  await nextTick()
  document.getElementById(`node-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
onMounted(focusHash)
watch(() => [route.hash, d.value?.nodes.length], focusHash)

const TASK_STATE_CLASS = { DONE: 'ft-text-done', OVERDUE: 'ft-text-late', LATE: 'ft-text-upstream', EXCLUDED: 'ft-muted', NORMAL: '' } as const
type Task = WorkOrderDetail['nodes'][number]['tasks'][number]
function taskStatus(t: Task) {
  if (t.state === 'OVERDUE') return `${t.statusText} · 逾期 ${t.overdueDays} 天`
  if (t.state === 'LATE') return `${t.statusText} · 晚于节点`
  if (t.state === 'EXCLUDED') return `${t.statusText}（不计入）`
  return t.statusText
}

// ───── 右侧 ─────
const lagItems = computed(() => (d.value?.lagByDept ?? []).map((x) => ({ key: x.dept, label: x.deptText, value: x.days, text: `${x.days} 天` })))
const unlinkedItems = computed(() => {
  const u = d.value?.unlinked
  const wo = encodeURIComponent(no.value)
  return u
    ? [
        { key: 'drawing', label: '设计', n: u.drawing, to: `/drawings?wo=${wo}&view=all` },
        { key: 'purchase', label: '采购', n: u.purchase, to: `/purchases?wo=${wo}&view=all` },
        { key: 'step', label: '工序', n: u.step, to: `/parts?wo=${wo}` },
        { key: 'assembly', label: '装配', n: u.assembly, to: `/kitting?wo=${wo}` },
      ]
    : []
})
type Action = WorkOrderDetail['actions'][number]
const actionIcon = (a: Action) => (a.level === 'RED' ? 'alert' : a.level === 'YELLOW' ? 'warn' : 'dot')
const actionLevelText = (a: Action) => (a.kind === 'issue' ? (a.level === 'RED' ? '超期异常' : '异常') : a.level === 'RED' ? '红' : a.level === 'YELLOW' ? '黄' : '提醒')
const ruleText = (r: string | null) => (r ? (RULE_TEXT[r as keyof typeof RULE_TEXT] ?? r) : '')
const showAllActions = ref(false)
const actions = computed(() => (showAllActions.value ? d.value?.actions ?? [] : (d.value?.actions ?? []).slice(0, 8)))

const enc = encodeURIComponent
</script>

<template>
  <div class="page">
    <div class="topbar">
      <div class="crumbs">
        <NuxtLink to="/board">项目总览</NuxtLink><span class="sep">/</span><span>{{ no }}</span>
      </div>
      <a-segmented :value="tab" :options="[{ value: 'overview', label: '概览' }, { value: 'plan', label: '总计划' }]" @change="setTab" />
    </div>

    <!-- key：换工单时重建，避免上一个工单打开的编辑框（节点 ID）带到新工单里被保存 -->
    <PlanEditor v-if="tab === 'plan'" :key="no" :wo="no" @changed="refresh()" />

    <template v-else>

    <a-result v-if="error" :status="error.statusCode === 403 ? '403' : error.statusCode === 404 ? '404' : 'error'" :title="error.statusCode === 403 ? '没有权限' : error.statusCode === 404 ? '工单不存在' : '加载失败'" :sub-title="apiError(error)">
      <template #extra><NuxtLink to="/board"><a-button type="primary">回项目总览</a-button></NuxtLink></template>
    </a-result>

    <a-spin v-else :spinning="pending && !d">
      <template v-if="d">
        <!-- 头部 -->
        <UiSectionCard class="head-card">
          <div class="head">
            <div class="head-main">
              <div class="title-row">
                <h1 class="wo-title">{{ d.workOrder.workOrderNumber }}<template v-if="title"> · {{ title }}</template></h1>
                <span class="pill" :class="`pill-${pill.tone}`"><UiStatusIcon :kind="pill.icon" :tone="pill.tone" />{{ pill.text }}</span>
                <UiStatusTag v-if="isClosedWorkOrder(d.workOrder.status)" tone="none" title="QMS 里的工单状态；已完工 / 已取消的工单默认不在项目总览和工单下拉里出现">QMS {{ woStatusText(d.workOrder.status) }}</UiStatusTag>
              </div>
              <div class="meta">
                <span>项目经理 {{ d.workOrder.projectManagerName ?? '未设置' }}</span>
                <span>客户 {{ d.workOrder.customerName }}</span>
                <span v-if="d.plan">总计划{{ d.published ? '已发布' : '草稿（未发布，预计交期不计算）' }}（{{ d.nodes.length }} 个节点）</span>
                <span v-else>还没有总计划</span>
                <span><NuxtLink :to="planLink()">编辑总计划</NuxtLink></span>
                <span><a @click="refresh()">刷新</a></span>
              </div>
              <div class="dates">
                <span>合同交期 <b>{{ d.workOrder.deliveryDate }}</b></span>
                <span>预计交期 <b :class="{ 'ft-text-late': (d.delayDays ?? 0) > 0 }">{{ d.expectedDelivery ?? '—' }}</b></span>
                <span v-if="d.delayDays != null">拖期 <b :class="(d.delayDays ?? 0) > 0 ? 'ft-text-late' : 'ft-text-done'">{{ d.delayDays > 0 ? `${d.delayDays} 天` : d.delayDays < 0 ? `提前 ${-d.delayDays} 天` : '0 天' }}</b></span>
                <span v-if="d.stuck">卡在 <b class="ft-text-late">{{ d.stuck.name }}（{{ d.stuck.deptText }}）</b></span>
              </div>
            </div>
            <div v-if="bar" class="dbar">
              <div class="dbar-labels">
                <span>开始 {{ bar.start }}</span>
                <span>今天 {{ d.today }}</span>
                <span>合同交期 {{ d.workOrder.deliveryDate }}</span>
              </div>
              <div class="dbar-track">
                <span class="dbar-used" :style="{ width: `${Math.min(bar.today, bar.delivery)}%` }" />
                <span v-if="bar.overDays > 0 && bar.expected != null" class="dbar-over" :style="{ left: `${bar.delivery}%`, width: `${bar.expected - bar.delivery}%` }" />
                <span class="dbar-mark today" :style="{ left: `${bar.today}%` }" title="今天" />
                <span class="dbar-mark delivery" :style="{ left: `${bar.delivery}%` }" title="合同交期" />
              </div>
              <div class="dbar-legend">
                <span><i class="sq used" />已用工期 {{ bar.usedPercent }}%</span>
                <span v-if="bar.overDays > 0"><i class="sq over" />预计超出 {{ bar.overDays }} 天</span>
                <span v-else-if="d.expectedDelivery"><i class="sq ok" />预计按期</span>
              </div>
            </div>
          </div>
        </UiSectionCard>

        <!-- 指标卡 -->
        <div class="metrics">
          <UiSectionCard padding="tight" class="metric">
            <div class="ring-row">
              <UiRing :value="d.progress.done" :total="d.progress.total" :color="NODE_STATE_COLOR.DONE" />
              <div>
                <div class="m-label">总计划节点完成</div>
                <div v-if="d.progress.total" class="m-sub">
                  按计划 {{ d.progress.onTrack }} · <span :class="{ 'ft-text-late': d.progress.source + d.progress.upstream }">延误 {{ d.progress.source + d.progress.upstream }}</span>
                  <div v-if="d.progress.source" class="ft-muted">其中源头 {{ d.progress.source }}、受上游影响 {{ d.progress.upstream }}</div>
                </div>
                <div v-else class="m-sub ft-muted">还没有节点</div>
              </div>
            </div>
          </UiSectionCard>
          <UiSectionCard padding="tight" class="metric">
            <div class="m-head">
              <span class="m-label">总装齐套率</span>
              <b v-if="d.kitting.main?.percent != null" class="m-big">{{ d.kitting.main.percent }}%</b>
            </div>
            <template v-if="d.kitting.main">
              <a-progress v-if="d.kitting.main.percent != null" :percent="d.kitting.main.percent" :show-info="false" :stroke-color="d.kitting.main.percent >= 100 ? NODE_STATE_COLOR.DONE : undefined" size="small" />
              <div class="m-sub">
                <NuxtLink :to="`/kitting?wo=${enc(no)}&id=${enc(d.kitting.main.id)}`">{{ d.kitting.main.name }}</NuxtLink>
                <template v-if="d.kitting.main.total === 0"> · 清单为空</template>
                <template v-else-if="d.kitting.main.shortageCount"> · 缺 {{ d.kitting.main.shortageCount }} 件：{{ d.kitting.main.reasons.map((r) => `${r.reason} ${r.count}`).join(' · ') }}</template>
                <template v-else> · <span class="ft-text-done">已齐套</span></template>
              </div>
            </template>
            <div v-else class="m-sub ft-muted">还没有装配节点</div>
          </UiSectionCard>
          <UiSectionCard padding="tight" class="metric">
            <div class="m-label">活动预警</div>
            <div class="m-counts">
              <NuxtLink :to="`/alerts?wo=${enc(no)}&level=RED`" class="cnt"><UiStatusIcon kind="alert" /><b>{{ d.alerts.red }}</b><span>红</span></NuxtLink>
              <NuxtLink :to="`/alerts?wo=${enc(no)}&level=YELLOW`" class="cnt"><UiStatusIcon kind="warn" /><b>{{ d.alerts.yellow }}</b><span>黄</span></NuxtLink>
            </div>
            <div class="m-sub ft-muted">{{ d.alerts.oldestDate ? `最早一条 ${d.alerts.oldestDate} 起` : '没有活动预警' }}</div>
          </UiSectionCard>
          <UiSectionCard padding="tight" class="metric">
            <div class="m-label">未关闭异常</div>
            <div class="m-counts">
              <NuxtLink :to="`/issues?wo=${enc(no)}&dept=0`" class="cnt"><b>{{ d.issues.open }}</b></NuxtLink>
              <span v-if="d.issues.overdue" class="ft-text-late">其中超期 {{ d.issues.overdue }}</span>
            </div>
            <div class="m-sub ft-muted ellipsis">{{ d.issues.byDept.length ? d.issues.byDept.map((x) => `${x.dept} ${x.count}`).join(' · ') : '没有未关闭的异常' }}</div>
          </UiSectionCard>
        </div>

        <div class="body">
          <!-- 时间线 -->
          <UiSectionCard title="总计划时间线" class="timeline-card">
            <template v-if="d.nodes.length" #extra>
              <div class="legend">
                <span><i class="lg plan" />计划</span>
                <span v-for="s in (['DONE', 'ON_TRACK', 'SOURCE', 'UPSTREAM'] as const)" :key="s"><i class="lg" :style="{ background: NODE_STATE_COLOR[s] }" />{{ NODE_STATE_TEXT[s] }}</span>
              </div>
            </template>

            <div v-if="!d.nodes.length" class="empty">
              <a-empty description="这个工单还没有总计划">
                <NuxtLink :to="planLink()"><a-button type="primary">去生成</a-button></NuxtLink>
              </a-empty>
            </div>
            <div v-else class="gantt-scroll">
              <div class="gantt">
                <div class="g-row g-axis">
                  <div class="g-label" />
                  <div class="g-track">
                    <span v-for="t in ticks" :key="t.label + t.left" class="tick" :class="{ end: t.left > 90 }" :style="{ left: `${t.left}%` }">{{ t.label }}</span>
                  </div>
                </div>
                <template v-for="(n, i) in d.nodes" :key="n.id">
                  <div :id="`node-${n.id}`" class="g-row node-row" :class="{ open: expanded.has(n.id) }" role="button" tabindex="0" :aria-expanded="expanded.has(n.id)" @click="toggle(n.id)" @keydown.enter.prevent="toggle(n.id)" @keydown.space.prevent="toggle(n.id)">
                    <div class="g-label">
                      <div class="n-name">
                        <span class="caret">{{ expanded.has(n.id) ? '▾' : '▸' }}</span><span class="n-text">{{ n.seq }} {{ n.name }}</span>
                        <span v-if="n.taskCount" class="n-count" :title="`挂了 ${n.taskCount} 条记录，完成 ${n.doneCount} 条`">{{ n.doneCount }}/{{ n.taskCount }}</span>
                      </div>
                      <div class="n-sub" :class="STATE_CLASS[n.state]">{{ n.deptText }} · {{ STATE_DEPT_TEXT[n.state](n) }}</div>
                    </div>
                    <div class="g-track" :title="`计划 ${n.planDate}${n.actualDate ? ` · 实际 ${n.actualDate}` : ` · 预计 ${n.expectedDate}`}${n.baselineDate && n.baselineDate !== n.planDate ? ` · 基线 ${n.baselineDate}` : ''}`">
                      <span class="today-line" :style="{ left: `${todayLeft}%` }" />
                      <span class="plan-box" :style="seg(bars[i]!.planFrom, bars[i]!.planTo)" />
                      <span class="real-bar" :style="{ ...seg(bars[i]!.from, bars[i]!.to), background: NODE_STATE_COLOR[n.state] }" />
                    </div>
                  </div>
                  <div v-if="expanded.has(n.id)" class="tasks">
                    <div v-if="!n.tasks.length" class="ft-muted no-task">这个节点上还没有挂设计、采购、工序或装配记录（挂上才计入预计交期）</div>
                    <NuxtLink v-for="t in n.tasks" :key="`${t.kind}:${t.id}`" :to="t.link" class="task">
                      <span class="kind">{{ t.kindText }}</span>
                      <span class="t-name" :title="t.name">{{ t.name }}</span>
                      <span class="t-status" :class="TASK_STATE_CLASS[t.state]">{{ taskStatus(t) }}<template v-if="t.payment"> · <span :class="t.payment === '已付' ? 'ft-text-done' : 'ft-text-late'">{{ t.payment }}</span></template></span>
                    </NuxtLink>
                  </div>
                </template>
              </div>
            </div>
            <p v-if="d.nodes.length" class="foot ft-muted">竖线 = 今天（{{ d.today }}）。点节点名展开挂在上面的设计、采购、工序、装配记录，点记录跳到对应部门列表。</p>
          </UiSectionCard>

          <!-- 右侧 -->
          <div class="side">
            <UiSectionCard title="要处理的事" :sub="d.actions.length ? `活动预警 ${d.alerts.total} · 未关闭异常 ${d.issues.open}` : undefined">
              <div v-if="!d.actions.length" class="ft-muted">没有活动预警和未关闭异常</div>
              <ul class="actions">
                <li v-for="a in actions" :key="`${a.kind}:${a.id}`">
                  <UiStatusIcon :kind="actionIcon(a)" :tone="a.level === 'RED' ? 'late' : a.level === 'YELLOW' ? 'risk' : 'primary'" />
                  <div class="a-body">
                    <div class="a-title">
                      <span :class="a.level === 'RED' ? 'ft-text-late' : a.level === 'YELLOW' ? 'ft-text-risk' : ''">{{ actionLevelText(a) }}</span>
                      <NuxtLink v-if="a.link" :to="a.link">{{ a.kind === 'issue' ? `${a.tag} ` : '' }}{{ a.title }}</NuxtLink>
                      <span v-else>{{ a.title }}</span>
                    </div>
                    <div class="a-sub" :title="[a.kind === 'alert' ? ruleText(a.rule) : '', a.detail, a.owners].filter(Boolean).join(' · ')">{{ [a.kind === 'alert' ? ruleText(a.rule) : '', a.detail, a.owners].filter(Boolean).join(' · ') }}<template v-if="a.kind === 'alert' && a.issueNo"> · 已转异常 {{ a.issueNo }}</template></div>
                  </div>
                </li>
              </ul>
              <a v-if="d.actions.length > 8" class="more" @click="showAllActions = !showAllActions">{{ showAllActions ? '收起' : `展开全部 ${d.actions.length} 条` }}</a>
            </UiSectionCard>

            <UiSectionCard title="谁在拖" sub="源头延误天数（只因上游顺延的不算），按节点责任部门汇总">
              <UiBarList :items="lagItems" :empty="d.published ? '没有源头延误的节点' : '总计划发布后才统计'" />
            </UiSectionCard>

            <UiSectionCard title="还没挂到节点的记录" sub="挂上节点才计入预计交期">
              <div class="unlinked">
                <NuxtLink v-for="u in unlinkedItems" :key="u.key" :to="u.to" class="u-cell" :class="{ has: u.n > 0 }">
                  <b>{{ u.n }}</b><span>{{ u.label }}</span>
                </NuxtLink>
              </div>
            </UiSectionCard>
          </div>
        </div>
      </template>
    </a-spin>
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
.crumbs { font-size: 12px; color: var(--ft-text-3); }
.crumbs .sep { margin: 0 6px; }
.head-card { margin-bottom: 16px; }
.head { display: flex; gap: 24px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.head-main { min-width: 0; flex: 1 1 380px; }
.title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.wo-title { margin: 0; font-size: 22px; font-weight: 600; color: var(--ft-text); line-height: 1.3; word-break: break-all; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 12px; border-radius: 999px; font-size: 13px; white-space: nowrap; }
.pill-late { background: var(--ft-late-bg); color: var(--ft-late); }
.pill-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.pill-done { background: var(--ft-done-bg); color: var(--ft-done); }
.pill-none { background: var(--ft-none-bg); color: var(--ft-text-2); }
.meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 2px 16px; color: var(--ft-text-2); font-size: 13px; }
.meta > span { white-space: nowrap; }
.dot-sep { margin: 0 6px; color: var(--ft-text-3); }
.dates { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px 20px; font-size: 13px; color: var(--ft-text-2); }
.dates b { color: var(--ft-text); font-weight: 600; }
.dates b.ft-text-late { color: var(--ft-late); }
.dates b.ft-text-done { color: var(--ft-done); }
.dbar { flex: 1 1 420px; max-width: 600px; min-width: 0; }
.dbar-labels { display: flex; justify-content: space-between; font-size: 12px; color: var(--ft-text-2); gap: 8px; }
.dbar-track { position: relative; height: 14px; margin: 8px 0; border-radius: 7px; background: var(--ft-fill); }
.dbar-used { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 7px; background: var(--ft-primary); }
.dbar-over { position: absolute; top: 0; bottom: 0; border-radius: 0 7px 7px 0; background: var(--ft-late); }
.dbar-mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--ft-text); }
.dbar-mark.delivery { background: var(--ft-text-2); }
.dbar-legend { display: flex; gap: 16px; font-size: 12px; color: var(--ft-text-2); }
.sq { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.sq.used { background: var(--ft-primary); }
.sq.over { background: var(--ft-late); }
.sq.ok { background: var(--ft-done); }

.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.metric { min-height: 112px; }
.ring-row { display: flex; align-items: center; gap: 16px; }
.m-label { font-size: 13px; color: var(--ft-text-2); }
.m-head { display: flex; justify-content: space-between; align-items: baseline; }
.m-big { font-size: 24px; font-weight: 600; }
.m-sub { margin-top: 6px; font-size: 12px; color: var(--ft-text-2); }
.m-counts { display: flex; align-items: center; gap: 18px; margin-top: 6px; }
.cnt { display: inline-flex; align-items: center; gap: 6px; color: var(--ft-text); }
.cnt b { font-size: 24px; font-weight: 600; }
.cnt span { font-size: 12px; color: var(--ft-text-2); }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--ft-text-2); }
.lg { display: inline-block; width: 16px; height: 8px; border-radius: 4px; margin-right: 5px; vertical-align: 0; }
.lg.plan { border: 1px dashed var(--ft-text-3); background: transparent; }

.gantt-scroll { overflow-x: auto; }
.gantt { min-width: 640px; }
.g-row { display: grid; grid-template-columns: 210px minmax(0, 1fr); align-items: center; }
.g-axis { height: 26px; border-bottom: 1px solid var(--ft-border); }
.g-axis .g-track { height: 26px; }
.tick { position: absolute; top: 4px; font-size: 12px; color: var(--ft-text-3); white-space: nowrap; transform: translateX(-2px); }
.tick.end { transform: translateX(-100%); }
.tick.end::before { left: auto; right: 0; }
.tick::before { content: ''; position: absolute; left: 0; top: 18px; height: 6px; border-left: 1px solid var(--ft-border); }
.node-row { min-height: 54px; border-bottom: 1px solid var(--ft-border); cursor: pointer; outline: none; }
.node-row:hover, .node-row:focus-visible { background: var(--ft-fill); }
.node-row.open { background: var(--ft-fill); }
.g-label { padding: 8px 10px 8px 2px; min-width: 0; }
.n-name { display: flex; align-items: center; font-weight: 600; color: var(--ft-text); min-width: 0; }
.n-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.n-count { flex: none; margin-left: 6px; padding: 0 6px; border-radius: 4px; background: var(--ft-fill); color: var(--ft-text-2); font-size: 11px; font-weight: normal; line-height: 18px; }
.caret { display: inline-block; width: 14px; color: var(--ft-text-3); font-weight: normal; }
.n-sub { font-size: 12px; padding-left: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-track { position: relative; height: 40px; }
.today-line { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--ft-text); opacity: 0.85; z-index: 2; }
.plan-box { position: absolute; top: 9px; height: 14px; min-width: 8px; border: 1px dashed var(--ft-text-3); border-radius: 4px; }
.real-bar { position: absolute; top: 14px; height: 12px; min-width: 8px; border-radius: 6px; z-index: 1; }
.tasks { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; margin: 6px 0 10px; background: var(--ft-fill); border-radius: 10px; }
.task { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 10px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 8px; color: var(--ft-text); font-size: 13px; }
.task:hover { border-color: var(--ft-primary); color: var(--ft-text); }
.kind { flex: none; font-size: 12px; padding: 0 6px; border-radius: 4px; background: var(--ft-fill); color: var(--ft-text-2); }
.t-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.t-status { flex: none; font-size: 12px; }
.no-task { font-size: 12px; }
.foot { margin: 12px 0 0; font-size: 12px; }
.empty { padding: 24px 0; }

.actions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.actions li { display: flex; gap: 8px; align-items: flex-start; }
.actions li > .ft-icon { margin-top: 3px; }
.a-body { min-width: 0; }
.a-title { font-size: 13px; color: var(--ft-text); word-break: break-all; }
.a-title > span:first-child { margin-right: 6px; }
.a-sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-3); word-break: break-all; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.more { display: inline-block; margin-top: 10px; font-size: 12px; }
.unlinked { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.u-cell { display: flex; flex-direction: column; align-items: center; padding: 10px 4px; border-radius: 10px; background: var(--ft-fill); color: var(--ft-text-2); font-size: 12px; }
.u-cell b { font-size: 20px; color: var(--ft-text); }
.u-cell.has { background: var(--ft-upstream-bg); }
.u-cell:hover { color: var(--ft-text); }

@media (max-width: 1279px) {
  .body { grid-template-columns: minmax(0, 1fr); }
  .side { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: start; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 575px) {
  .metrics { grid-template-columns: minmax(0, 1fr); }
  .dbar-labels span:nth-child(2) { display: none; }
}
</style>
