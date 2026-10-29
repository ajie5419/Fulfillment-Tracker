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
const { data, pending } = await useReminders()

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

const { data: todos, pending: todosPending, refresh: refreshTodos } = await useTodos()
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
    <div class="stats">
      <UiStatCard label="我的待办" :value="counts.todo" unit="条" tone="primary" accent icon="dot" :to="filterTo('todo')" :active="active === 'todo'" sub="点开只看待办" />
      <UiStatCard label="已过期" :value="counts.overdue" unit="条" tone="late" accent icon="alert" :to="filterTo('overdue')" :active="active === 'overdue'" sub="截止日已过" />
      <UiStatCard label="今天到期" :value="counts.today" unit="条" tone="risk" accent icon="warn" :to="filterTo('today')" :active="active === 'today'" sub="截止日就是今天" />
      <UiStatCard label="未读提醒" :value="counts.unread" unit="条" tone="primary" accent icon="dot" :to="filterTo('unread')" :active="active === 'unread'" sub="含每日汇总" />
    </div>

    <!-- QMS 同步连续失败（管理员）：未读时置顶 -->
    <div v-for="p in data?.pinned ?? []" :key="p.id" class="digest lv-RED unread" role="button" tabindex="0" @click="openPinned(p)" @keydown.enter="openPinned(p)">
      <div class="digest-title">
        <UiStatusIcon kind="alert" />
        <a-tag color="red">同步故障</a-tag>
        <b>{{ p.title }}</b>
        <span class="muted">{{ factoryTimeText(p.createdAt) }}</span>
      </div>
      <ol class="digest-lines">
        <li v-for="(l, i) in p.lines" :key="i">{{ l }}</li>
      </ol>
    </div>
    <!-- 每日汇总置顶（方案 6.3）：每天早上生成，红黄数量 + 前 5 项 -->
    <div v-if="data?.digest" class="digest" :class="[`lv-${data.digest.level}`, { unread: !data.digest.readAt }]" role="button" tabindex="0" @click="openDigest" @keydown.enter="openDigest">
      <div class="digest-title">
        <UiStatusIcon :kind="data.digest.level === 'RED' ? 'alert' : data.digest.level === 'YELLOW' ? 'warn' : 'dot'" />
        <a-tag color="geekblue">每日汇总</a-tag>
        <b>{{ data.digest.title }}</b>
        <span v-if="!data.digest.readAt" class="new">未读</span>
        <span class="muted">{{ factoryTimeText(data.digest.createdAt) }}</span>
      </div>
      <ol v-if="digestOpen || !data.digest.readAt" class="digest-lines">
        <li v-for="(l, i) in data.digest.lines" :key="i">{{ l }}</li>
      </ol>
    </div>

    <!-- 项目日历（zhao 10-21）：本周 / 下周 / 本月计划与实际完成台数，所有人都显示 -->
    <WorkbenchCalendarCard />

    <UiSectionCard title="待办与提醒" :sub="active ? `只看：${FILTER_TEXT[active]}` : '按截止日分组；提醒点开即标为已读并跳到对应页面'">
      <template #extra>
        <NuxtLink v-if="active" :to="{ query: { ...route.query, f: undefined } }" class="clear">清除筛选</NuxtLink>
        <a-button size="small" :disabled="!data?.unread" @click="readAll">全部已读</a-button>
      </template>
      <a-spin :spinning="pending || todosPending">
        <a-empty v-if="!groups.length" :description="active ? '没有符合条件的待办或提醒' : '暂时没有待办和提醒'" />
        <section v-for="g in groups" :key="g.bucket" class="group">
          <h3 class="group-title" :class="`b-${g.bucket}`">
            <span class="dot" />{{ WORK_BUCKET_TEXT[g.bucket] }}<span class="cnt">{{ g.items.length }}</span>
            <span v-if="g.bucket === 'NO_DUE'" class="hint">没有截止日的待办和提醒、已消除的预警；红、黄色仍排在前面</span>
          </h3>
          <div class="cards">
            <article
              v-for="c in g.items"
              :key="c.key"
              class="wcard"
              :class="[`tone-${c.tone}`, { unread: c.unread, read: c.kind === 'reminder' && !c.unread, clickable: !!c.reminder }]"
              @click="onCardClick(c)"
            >
              <UiStatusIcon :kind="toneIcon(c.tone)" :tone="c.tone === 'normal' ? 'primary' : c.tone" :size="16" class="icon" />
              <div class="main">
                <div class="title-row">
                  <span class="kind" :class="c.kind">{{ c.kind === 'todo' ? '待办' : LEVEL_LABEL[c.reminder!.level] }}</span>
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
                  <a-button v-if="c.reminder.link" size="small" type="primary" ghost @click="openReminder(c.reminder)">去处理 ›</a-button>
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
.wb { display: flex; flex-direction: column; gap: 16px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.muted { color: var(--ft-text-3); font-size: 12px; }
.clear { font-size: 13px; }

/* 置顶：每日汇总、同步故障 */
/* 设计改版：去掉左侧色条（用户意见），级别由标题前的图标和标签表达 */
.digest { cursor: pointer; background: var(--ft-card-bg); border-radius: var(--ft-card-radius); box-shadow: var(--ft-card-shadow); border: 1px solid var(--ft-border); padding: 12px 16px; }
.digest-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.digest-title b { color: var(--ft-text); }
.digest:not(.unread) .digest-title b { font-weight: normal; color: var(--ft-text-2); }
.digest-lines { margin: 8px 0 0 24px; padding: 0; color: var(--ft-text-2); font-size: 13px; }
.digest:focus-visible { outline: 2px solid var(--ft-primary); }

/* 分组 */
.group + .group { margin-top: 20px; }
.group-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ft-text); }
.group-title .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ft-none); }
.b-OVERDUE .dot { background: var(--ft-late); }
.b-TODAY .dot { background: var(--ft-risk); }
.b-WEEK .dot { background: var(--ft-primary); }
.b-LATER .dot { background: color-mix(in srgb, var(--ft-primary) 50%, var(--ft-card-bg)); }
.cnt { padding: 0 8px; border-radius: 10px; background: var(--ft-fill); color: var(--ft-text-2); font-size: 12px; font-weight: normal; line-height: 20px; }
.hint { font-size: 12px; font-weight: normal; color: var(--ft-text-3); }
.cards { display: flex; flex-direction: column; gap: 8px; }

/* 卡片：状态由图标 + 级别标签表达（设计改版去掉了左侧色条） */
.wcard { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--ft-border); border-radius: 10px; background: var(--ft-card-bg); overflow: hidden; }
.wcard.clickable { cursor: pointer; }
.wcard.clickable:hover { border-color: var(--ft-text-3); background: var(--ft-fill); }
.icon { margin-top: 3px; }
.main { flex: 1; min-width: 0; }
/* 标题一行：标签、标题、未读、附加标签都是行内的，长标题自然折行，不把标签挤到单独一行 */
.title-row { line-height: 22px; }
.title-row > * { vertical-align: middle; }
.title-row > * + * { margin-left: 8px; }
.kind { display: inline-block; font-size: 12px; line-height: 20px; padding: 0 6px; border-radius: 4px; background: var(--ft-fill); color: var(--ft-text-2); }
.kind.todo { background: var(--ft-primary-bg); color: var(--ft-primary-text); }
.tone-late .kind.reminder { background: var(--ft-late-bg); color: var(--ft-late-text); }
.tone-risk .kind.reminder { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.title { color: var(--ft-text); font-size: 14px; line-height: 22px; word-break: break-word; }
.unread .title { font-weight: 600; }
.read .title { color: var(--ft-text-2); }
.new { font-size: 12px; color: var(--ft-primary); white-space: nowrap; }
.tag { margin-inline-end: 0; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 4px; font-size: 12px; color: var(--ft-text-2); }
.meta .late { color: var(--ft-late-text); font-weight: 500; }
.suggest { margin-top: 4px; font-size: 12px; color: var(--ft-text-3); }
.ops { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 280px; }
.go { font-size: 13px; white-space: nowrap; }

@media (max-width: 991px) {
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
}
@media (max-width: 575px) {
  .wcard { flex-wrap: wrap; }
  .ops { width: 100%; max-width: none; justify-content: flex-start; padding-left: 26px; }
}
</style>
