<script setup lang="ts">
/**
 * 工作台（前端改版第二轮）：顶部统计卡（我的待办 / 已过期 / 今天到期 / 未读提醒，点了按它筛选，?f= 便于分享），
 * 下面待办和提醒合成一条卡片流，按"已过期 / 今天 / 本周 / 以后 / 未定截止日"分组（只按真实截止日，由服务端按工厂时区算好，见 shared/workbench.ts）。
 * 原有操作全部保留：待办的登记发出 / 开工 / 签收 / 确认变更影响 / 去确认 / 转交，提醒的点开（标已读并跳转）、标已读、全部已读，
 * 每日汇总和同步故障置顶。
 */
import type { PartDetail } from '~~/server/services/flow/steps'
import { WORK_BUCKET_TEXT, factoryTimeText, groupByBucket, type WorkBucket } from '#shared/workbench'

const route = useRoute()
const { data, pending, error: remindersError } = await useReminders()

/** 点一条：标记已读，跳到关联对象 */
async function openReminder(item: ReminderItem) {
  await readReminder(item)
  if (item.link) await navigateTo(item.link)
}
/** 置顶的同步失败提醒：标为已读后去设置页看同步状态 */
async function openPinned(p: PinnedItem) {
  await readDigest(p)
  await navigateTo(p.link)
}
const digestOpen = ref(false)
async function openDigest() {
  digestOpen.value = !digestOpen.value
  if (data.value?.digest) await readDigest(data.value.digest)
}
async function readAll() {
  try {
    await readAllReminders()
  } catch (e) {
    message.error(apiError(e))
  }
}

const { data: todos, pending: todosPending, error: todosError, refresh: refreshTodos } = await useTodos()
const { data: master } = await useMaster()
const { data: me } = await useMe()
type Todo = (typeof todos.value)[number]

const sending = ref<{ id: string; supplierId: string | null; title: string } | null>(null)
function openSend(t: Todo) {
  if (t.step) sending.value = { id: t.step.id, supplierId: t.step.supplierId, title: `${t.step.partName} · ${t.step.processName}` }
}

function start(t: Todo) {
  if (!t.step) return
  Modal.confirm({
    title: `确认开工：${t.step.partName} · ${t.step.processName}？`,
    okText: '开工',
    async onOk() {
      try {
        await $fetch(`/api/steps/${t.step!.id}/start`, { method: 'POST', body: { source: 'PC' } })
        message.success('已开工')
        await afterTodo()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

/** 直接完工（活已经干完才想起登记，生产管理重设计第一批）：同一个完工弹窗，可部分完工、报废 */
const finishing = ref<{ id: string; title: string; quantity: number; doneQty: number } | null>(null)
async function finish(t: Todo) {
  if (!t.step) return
  try {
    const p = await $fetch<PartDetail>(`/api/parts/${t.step.partId}`)
    const s = p.steps.find((x) => x.id === t.step!.id)
    finishing.value = { id: t.step.id, title: `${t.step.partName} · ${t.step.processName}`, quantity: p.quantity, doneQty: s?.returnedQty ?? 0 }
  } catch (e) {
    message.error(apiError(e))
  }
}

/** 完成部门任务（部门计划二次分解）：完成日记今天，关掉待办 */
function finishPlanTask(t: Todo) {
  const task = t.planTask
  if (!task) return
  Modal.confirm({
    title: `完成"${task.name}"？`,
    content: `总计划节点"${task.nodeName}"下的任务，完成日记为今天。`,
    onOk: async () => {
      try {
        await $fetch(`/api/plan/tasks/${task.id}/complete`, { method: 'POST', body: {} })
        message.success('已完成')
        await afterTodo()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

/** 待办处理后：待办、提醒（处理后预警可能消除）和菜单角标一起刷新 */
async function afterTodo() {
  await Promise.all([refreshTodos(), refreshReminders()])
}

/** 发放签收、确认变更影响：打开发放单详情抽屉处理 */
const releaseId = ref<string | null>(null)

const transferring = ref<Todo | null>(null)
const transferTo = ref<string | undefined>()
async function transfer() {
  if (!transferring.value || !transferTo.value) return message.warning('请选择转交对象')
  try {
    await $fetch(`/api/todos/${transferring.value.id}/transfer`, { method: 'POST', body: { toUserId: transferTo.value } })
    message.success('已转交')
    transferring.value = null
    transferTo.value = undefined
    await afterTodo()
  } catch (e) {
    message.error(apiError(e))
  }
}

// ───── 卡片流（分组见 shared/workbench.ts workBucket：只按真实截止日，没有的归"未定截止日"） ─────
type Tone = 'late' | 'risk' | 'normal'
interface Card {
  key: string
  kind: 'todo' | 'reminder'
  bucket: WorkBucket
  tone: Tone
  title: string
  wo: string | null
  dueDay: string | null
  createdAt: string
  unread: boolean
  todo?: Todo
  reminder?: ReminderItem
}
const TONE_RANK: Record<Tone, number> = { late: 0, risk: 1, normal: 2 }

const allCards = computed<Card[]>(() => {
  const list: Card[] = []
  for (const t of todos.value) {
    const bucket = (t.bucket ?? 'NO_DUE') as WorkBucket
    list.push({
      key: `t:${t.id}`,
      kind: 'todo',
      bucket,
      tone: bucket === 'OVERDUE' ? 'late' : 'normal',
      title: t.title,
      wo: t.workOrderNumber ?? null,
      dueDay: t.dueDay ?? null,
      createdAt: String(t.createdAt),
      unread: false,
      todo: t,
    })
  }
  for (const r of data.value?.items ?? []) {
    list.push({
      key: `r:${r.id}`,
      kind: 'reminder',
      bucket: r.bucket ?? 'NO_DUE',
      tone: r.cleared ? 'normal' : r.level === 'RED' ? 'late' : r.level === 'YELLOW' ? 'risk' : 'normal',
      title: r.title,
      wo: r.workOrderNumber ?? null,
      dueDay: r.dueDay ?? null,
      createdAt: r.createdAt,
      unread: !r.readAt,
      reminder: r,
    })
  }
  // 组内：红 → 黄 → 普通；同色未读在前，再按截止日从近到远（没有截止日的在后），待办在提醒前
  return list.sort(
    (a, b) =>
      TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
      Number(b.unread) - Number(a.unread) ||
      (a.dueDay ?? '9999').localeCompare(b.dueDay ?? '9999') ||
      (a.kind === b.kind ? 0 : a.kind === 'todo' ? -1 : 1),
  )
})

const FILTERS = ['todo', 'overdue', 'today', 'unread'] as const
type Filter = (typeof FILTERS)[number]
const active = computed<Filter | null>(() => (FILTERS as readonly string[]).includes(route.query.f as string) ? (route.query.f as Filter) : null)
const FILTER_TEXT: Record<Filter, string> = { todo: '我的待办', overdue: '已过期', today: '今天到期', unread: '未读提醒' }
const counts = computed(() => ({
  todo: todos.value.length,
  overdue: allCards.value.filter((c) => c.bucket === 'OVERDUE').length,
  today: allCards.value.filter((c) => c.bucket === 'TODAY').length,
  unread: data.value?.unread ?? 0,
}))
const statDenom = computed(() => Math.max(1, allCards.value.length))
const heroTitle = computed(() => (me.value?.name ? `${me.value.name}，今日工作概览` : '今日工作概览'))
const loadError = computed(() => Boolean(remindersError.value || todosError.value))
async function retryLoad() {
  await Promise.all([refreshTodos(), refreshReminders()])
}
const heroSummary = computed(() => {
  if (loadError.value) return '待办与提醒数据加载失败，暂无法汇总，请重试。'
  if ((pending.value || todosPending.value) && !allCards.value.length) return '正在同步待办事项与预警提醒…'
  const c = counts.value
  const parts: string[] = []
  if (c.overdue > 0) parts.push(`有 ${c.overdue} 项已过期事项急需跟进`)
  if (c.today > 0) parts.push(`${c.today} 项今天到期`)
  if (c.todo > 0) parts.push(`待办共 ${c.todo} 条`)
  if (c.unread > 0) parts.push(`未读提醒 ${c.unread} 条`)
  return parts.length ? `当前${parts.join('，')}。` : '当前所有待办均已清零，暂无未读预警提醒。'
})
const cards = computed(() => {
  const f = active.value
  if (!f) return allCards.value
  if (f === 'todo') return allCards.value.filter((c) => c.kind === 'todo')
  if (f === 'overdue') return allCards.value.filter((c) => c.bucket === 'OVERDUE')
  if (f === 'today') return allCards.value.filter((c) => c.bucket === 'TODAY')
  return allCards.value.filter((c) => c.unread)
})
const groups = computed(() => groupByBucket(cards.value))
/** 点统计卡：套用筛选；再点同一张取消 */
const filterTo = (f: Filter) => ({ query: { ...route.query, f: active.value === f ? undefined : f } })

const LEVEL_LABEL: Record<AlertLevelKey, string> = { RED: '红色', YELLOW: '黄色', REMIND: '提醒' }
const toneIcon = (t: Tone) => (t === 'late' ? 'alert' : t === 'risk' ? 'warn' : 'dot')
/** 待办的"查看"跳转：工序 → 工件抽屉（工序编排页）；发放 → 发放单；总计划 → 工单详情的总计划页签 */
function todoLink(t: Todo): string | null {
  if (t.link) return t.link
  if (t.plan) return t.plan.link
  if (t.planTask) return t.planTask.link
  if (t.release) return `/releases?id=${encodeURIComponent(t.release.id)}`
  // 工序 / 工件待办：打开工件抽屉（生产管理重设计第一批）
  const partId = t.step?.partId ?? (t.refType === 'part' ? t.refId : null)
  if (t.workOrderNumber && partId) return `/parts?wo=${encodeURIComponent(t.workOrderNumber)}&part=${encodeURIComponent(partId)}`
  if (t.workOrderNumber) return `/parts?wo=${encodeURIComponent(t.workOrderNumber)}`
  return null
}
function onCardClick(c: Card) {
  if (c.reminder) openReminder(c.reminder)
}
</script>

<template>
  <div>
  <div class="wb">
    <UiPageHero :title="heroTitle" :summary="heroSummary">
      <template #actions>
        <a-button v-if="loadError" size="small" :loading="pending || todosPending" @click="retryLoad">重试</a-button>
        <NuxtLink v-if="active" :to="{ query: { ...route.query, f: undefined } }">
          <a-button size="small">清除筛选：{{ FILTER_TEXT[active] }}</a-button>
        </NuxtLink>
        <NuxtLink to="/board"><a-button size="small">项目总览</a-button></NuxtLink>
        <a-button size="small" type="primary" class="ft-btn-ink" :disabled="!data?.unread" @click="readAll">全部已读</a-button>
      </template>
    </UiPageHero>

    <div class="stats">
      <UiStatCard label="我的待办" :value="counts.todo" :ratio="counts.todo / statDenom" unit="条" tone="primary" accent icon="dot" :to="filterTo('todo')" :active="active === 'todo'" sub="点开只看待办" />
      <UiStatCard label="已过期" :value="counts.overdue" :ratio="counts.overdue / statDenom" unit="条" tone="late" accent icon="alert" :to="filterTo('overdue')" :active="active === 'overdue'" sub="截止日已过" />
      <UiStatCard label="今天到期" :value="counts.today" :ratio="counts.today / statDenom" unit="条" tone="risk" accent icon="warn" :to="filterTo('today')" :active="active === 'today'" sub="截止日就是今天" />
      <UiStatCard label="未读提醒" :value="counts.unread" :ratio="counts.unread / Math.max(statDenom, counts.unread)" unit="条" tone="primary" accent icon="dot" :to="filterTo('unread')" :active="active === 'unread'" sub="含每日汇总" />
    </div>

    <!-- QMS 同步连续失败（管理员）：未读时置顶 -->
    <div v-for="p in data?.pinned ?? []" :key="p.id" class="digest lv-RED unread" role="button" tabindex="0" @click="openPinned(p)" @keydown.enter="openPinned(p)" @keydown.space.prevent="openPinned(p)">
      <span class="row-badge badge-late" aria-hidden="true"><UiStatusIcon kind="alert" tone="late" :size="15" /></span>
      <div class="digest-body">
        <div class="digest-title">
          <span class="sq-badge sq-late">同步故障</span>
          <b>{{ p.title }}</b>
          <span class="muted">{{ factoryTimeText(p.createdAt) }}</span>
        </div>
        <ol class="digest-lines">
          <li v-for="(l, i) in p.lines" :key="i">{{ l }}</li>
        </ol>
      </div>
    </div>
    <!-- 每日汇总置顶（方案 6.3）：每天早上生成，红黄数量 + 前 5 项 -->
    <div v-if="data?.digest" class="digest" :class="[`lv-${data.digest.level}`, { unread: !data.digest.readAt }]" role="button" tabindex="0" @click="openDigest" @keydown.enter="openDigest" @keydown.space.prevent="openDigest">
      <span class="row-badge" :class="data.digest.level === 'RED' ? 'badge-late' : data.digest.level === 'YELLOW' ? 'badge-risk' : 'badge-primary'" aria-hidden="true">
        <UiStatusIcon :kind="data.digest.level === 'RED' ? 'alert' : data.digest.level === 'YELLOW' ? 'warn' : 'dot'" :tone="data.digest.level === 'RED' ? 'late' : data.digest.level === 'YELLOW' ? 'risk' : 'primary'" :size="15" />
      </span>
      <div class="digest-body">
        <div class="digest-title">
          <span class="sq-badge sq-primary">每日汇总</span>
          <b>{{ data.digest.title }}</b>
          <span v-if="!data.digest.readAt" class="new">未读</span>
          <span class="muted">{{ factoryTimeText(data.digest.createdAt) }}</span>
        </div>
        <ol v-if="digestOpen || !data.digest.readAt" class="digest-lines">
          <li v-for="(l, i) in data.digest.lines" :key="i">{{ l }}</li>
        </ol>
      </div>
    </div>

    <!-- 项目日历（zhao 10-21）：本周 / 下周 / 本月计划与实际完成台数，所有人都显示 -->
    <WorkbenchCalendarCard />

    <UiSectionCard icon="inbox" padding="none" title="待办与提醒" :sub="active ? `只看：${FILTER_TEXT[active]}` : '按截止日分组；提醒点开即标为已读并跳到对应页面'">
      <template #extra>
        <span class="total-pill">共 {{ cards.length }} 条</span>
        <NuxtLink v-if="active" :to="{ query: { ...route.query, f: undefined } }" class="clear">清除筛选</NuxtLink>
      </template>
      <a-spin :spinning="pending || todosPending">
        <div v-if="!groups.length" class="empty-box">
          <a-empty :description="active ? '没有符合条件的待办或提醒' : '暂时没有待办和提醒'" />
        </div>
        <section v-for="g in groups" :key="g.bucket" class="group">
          <h3 class="group-title" :class="`b-${g.bucket}`">
            <span class="dot" />{{ WORK_BUCKET_TEXT[g.bucket] }}<span class="cnt">{{ g.items.length }}</span>
            <span v-if="g.bucket === 'NO_DUE'" class="hint">没有截止日的待办和提醒、已消除的预警；红、黄色仍排在前面</span>
          </h3>
          <div class="feed-rows">
            <article
              v-for="c in g.items"
              :key="c.key"
              class="wrow"
              :class="[`tone-${c.tone}`, { unread: c.unread, read: c.kind === 'reminder' && !c.unread, clickable: !!c.reminder }]"
              :role="c.reminder ? 'button' : undefined"
              :tabindex="c.reminder ? 0 : undefined"
              @click="onCardClick(c)"
              @keydown.enter="onCardClick(c)"
              @keydown.space.prevent="onCardClick(c)"
            >
              <span
                class="row-badge"
                :class="c.tone === 'late' ? 'badge-late' : c.tone === 'risk' ? 'badge-risk' : c.kind === 'todo' || c.unread ? 'badge-primary' : 'badge-none'"
                aria-hidden="true"
              >
                <UiStatusIcon :kind="toneIcon(c.tone)" :tone="c.tone === 'normal' ? (c.kind === 'todo' || c.unread ? 'primary' : 'none') : c.tone" :size="15" />
              </span>
              <div class="main">
                <div class="title-row">
                  <span class="title">{{ c.title }}</span>
                  <span v-if="c.unread" class="new">未读</span>
                  <a-tag v-if="c.reminder?.cleared" class="tag">已消除</a-tag>
                  <a-tag v-if="c.reminder?.issueNo" color="purple" class="tag">已转异常 {{ c.reminder.issueNo }}</a-tag>
                  <a-tag v-if="c.todo?.step?.held" color="purple" class="tag">等变更</a-tag>
                </div>
                <div class="meta">
                  <span v-if="c.wo" class="m">工单 <WoLink :no="c.wo" /></span>
                  <span v-if="c.dueDay" class="m" :class="{ late: c.bucket === 'OVERDUE' }">截止 {{ c.dueDay }}</span>
                  <span v-if="c.reminder?.rule" class="m">{{ RULE_TEXT[c.reminder.rule] }}</span>
                  <span class="m muted">{{ factoryTimeText(c.createdAt) }}</span>
                </div>
                <div v-if="c.todo?.suggestion" class="suggest">{{ c.todo.suggestion }}</div>
              </div>
              <div class="ops" @click.stop>
                <span
                  class="sq-badge"
                  :class="c.kind === 'todo' ? 'sq-primary' : c.tone === 'late' ? 'sq-late' : c.tone === 'risk' ? 'sq-risk' : 'sq-none'"
                >
                  {{ c.kind === 'todo' ? '待办' : LEVEL_LABEL[c.reminder!.level] }}
                </span>
                <template v-if="c.todo">
                  <a-button v-if="c.todo.link" type="primary" size="small" @click="navigateTo(c.todo.link)">查看采购计划</a-button>
                  <a-button v-else-if="c.todo.action === 'ARRANGE_SEND' && c.todo.step" type="primary" size="small" @click="openSend(c.todo)">登记发出</a-button>
                  <template v-else-if="c.todo.action === 'ARRANGE_START' && c.todo.step">
                    <a-button type="primary" size="small" @click="start(c.todo)">开工</a-button>
                    <a-button size="small" @click="finish(c.todo)">完工</a-button>
                  </template>
                  <template v-else-if="c.todo.action === 'READY_TO_START' && c.todo.step && c.todo.step.status === 'PENDING'">
                    <a-button v-if="c.todo.step.mode === 'EXTERNAL_OUTSOURCE'" type="primary" size="small" @click="openSend(c.todo)">登记发出</a-button>
                    <template v-else>
                      <a-button type="primary" size="small" @click="start(c.todo)">开工</a-button>
                      <a-button size="small" @click="finish(c.todo)">完工</a-button>
                    </template>
                  </template>
                  <a-button v-else-if="c.todo.action === 'SIGN_RELEASE' && c.todo.release" type="primary" size="small" @click="releaseId = c.todo.release.id">查看并签收</a-button>
                  <a-button v-else-if="c.todo.action === 'CONFIRM_CHANGE' && c.todo.release" type="primary" size="small" @click="releaseId = c.todo.release.id">确认变更影响</a-button>
                  <a-button v-else-if="c.todo.action === 'CONFIRM_PLAN_NODE' && c.todo.plan" type="primary" size="small" @click="navigateTo(c.todo.plan.link)">去确认</a-button>
                  <a-button v-else-if="c.todo.action === 'DO_PLAN_TASK' && c.todo.planTask" type="primary" size="small" @click="finishPlanTask(c.todo)">完成</a-button>
                  <a-button v-if="c.todo.action !== 'SIGN_RELEASE' && c.todo.action !== 'PURCHASE_PLAN_ISSUED'" size="small" @click="transferring = c.todo">转交</a-button>
                  <NuxtLink v-if="todoLink(c.todo) && !c.todo.plan && !c.todo.release && !c.todo.link" :to="todoLink(c.todo)!" class="go">查看 ›</NuxtLink>
                </template>
                <template v-else-if="c.reminder">
                  <a-button v-if="c.unread" size="small" @click="readReminder(c.reminder)">标已读</a-button>
                  <a-button v-if="c.reminder.link" size="small" @click="openReminder(c.reminder)">去处理 ›</a-button>
                </template>
              </div>
            </article>
          </div>
        </section>
      </a-spin>
    </UiSectionCard>
  </div>

  <SendStepModal :step="sending" @close="sending = null" @done="sending = null; afterTodo()" />
  <FinishStepModal :step="finishing" @close="finishing = null" @done="finishing = null; afterTodo()" />
  <ReleaseDrawer :id="releaseId" @close="releaseId = null" @changed="afterTodo()" />

  <a-modal :open="!!transferring" title="转交待办" ok-text="转交" @ok="transfer" @cancel="transferring = null">
    <p>{{ transferring?.title }}</p>
    <a-select
      v-model:value="transferTo"
      style="width: 100%"
      placeholder="选择转交给谁"
      show-search
      option-filter-prop="label"
      :options="master.users.filter((u) => u.id !== me?.id).map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` }))"
    />
  </a-modal>
  </div>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: 20px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.muted { color: var(--ft-text-3); font-size: 12px; }
.clear { font-size: 13px; }
.total-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--ft-fill); border: 1px solid var(--ft-border); font-size: 12px; font-weight: 500; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.empty-box { padding: 36px 20px; }

/* Ember Payouts 式左侧 34×34 圆角方形状态块 */
.row-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--card-border-subtle);
}
.badge-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.badge-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.badge-primary { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.badge-none { background: var(--ft-fill); color: var(--ft-text-3); }

/* Ember Payouts 式右侧紧凑圆角方形状态小牌 */
.sq-badge {
  display: inline-flex;
  align-items: center;
  height: 21px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 21px;
  white-space: nowrap;
}
.sq-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.sq-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.sq-primary { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.sq-none { background: var(--ft-fill); color: var(--ft-text-2); }

/* 置顶：每日汇总、同步故障 */
.digest { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; background: var(--ft-card-bg); border-radius: var(--ft-card-radius); box-shadow: var(--ft-card-shadow); border: 1px solid var(--ft-border); padding: 13px 16px; transition: border-color 0.15s, box-shadow 0.15s; }
.digest:hover { border-color: var(--ft-border-hover); box-shadow: var(--card-shadow-hover); }
.digest-body { flex: 1; min-width: 0; }
.digest-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; line-height: 22px; }
.digest-title b { color: var(--ft-text); }
.digest:not(.unread) .digest-title b { font-weight: 500; color: var(--ft-text-2); }
.digest-lines { margin: 8px 0 0 18px; padding: 0; color: var(--ft-text-2); font-size: 13px; }
.digest:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }

/* 卡片内的分组条与去框平铺行 */
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 7px 20px;
  background: var(--ft-fill);
  border-top: 1px solid var(--ft-border);
  border-bottom: 1px solid var(--card-border-subtle);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ft-text-2);
}
.group-title .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ft-none); }
.b-OVERDUE .dot { background: var(--ft-late); }
.b-TODAY .dot { background: var(--ft-risk); }
.b-WEEK .dot { background: var(--ft-primary); }
.b-LATER .dot { background: color-mix(in srgb, var(--ft-primary) 50%, var(--ft-card-bg)); }
.cnt { padding: 0 6px; border-radius: 5px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); color: var(--ft-text-2); font-size: 11.5px; font-weight: 600; line-height: 17px; font-variant-numeric: tabular-nums; }
.hint { font-size: 12px; font-weight: normal; color: var(--ft-text-3); }

.feed-rows { display: flex; flex-direction: column; }
.wrow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 13px 20px;
  background: var(--ft-card-bg);
  transition: background-color 0.14s;
}
.wrow + .wrow { border-top: 1px solid var(--card-border-subtle); }
.wrow.clickable { cursor: pointer; }
.wrow:hover { background: color-mix(in srgb, var(--ft-fill) 65%, transparent); }
.wrow:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }

.main { flex: 1; min-width: 0; }
.title-row { line-height: 22px; }
.title-row > * { vertical-align: middle; }
.title-row > * + * { margin-left: 8px; }
.title { color: var(--ft-text); font-size: 14px; font-weight: 500; line-height: 22px; word-break: break-word; }
.unread .title { font-weight: 600; }
.read .title { color: var(--ft-text-2); font-weight: 400; }
.new { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; color: var(--ft-primary-text); white-space: nowrap; }
.new::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--ft-primary); }
.tag { margin-inline-end: 0; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 3px; font-size: 12px; color: var(--ft-text-2); }
.meta .late { color: var(--ft-late-text); font-weight: 500; }
.suggest { margin-top: 4px; font-size: 12px; color: var(--ft-text-2); }
.ops { flex: none; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; max-width: 300px; }
.go { font-size: 13px; white-space: nowrap; }

@media (max-width: 991px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
}
@media (max-width: 575px) {
  .group-title { padding: 7px 14px; flex-wrap: wrap; }
  .wrow { align-items: flex-start; flex-wrap: wrap; padding: 12px 14px; }
  .ops { width: 100%; max-width: none; justify-content: flex-start; padding-left: 47px; }
}
</style>
