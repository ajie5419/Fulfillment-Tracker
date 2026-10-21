<script setup lang="ts">
import { DUE_GROUP_TEXT, DUE_GROUP_TONE, dueStats, factoryDay, groupByDue, todoDueDay, todoPrimaryLabel, type DueGroup, type Tone } from '#shared/mobile-todo'

definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const { data, pending } = await useReminders()
const { data: todos, pending: todosPending, refresh: refreshTodos } = await useTodos()
const { data: master } = await useMaster()
const levelType = { RED: 'danger', YELLOW: 'warning', REMIND: 'primary' } as const
const groups = computed(() => groupReminders(data.value?.items ?? []))

/** 点一条：标记已读，跳到能处理的手机页面；待确认匹配只有电脑端页面 */
async function openReminder(item: ReminderItem) {
  await readReminder(item)
  if (item.mobileLink) return navigateTo(item.mobileLink)
  if (item.rule === 'W1' && !item.cleared) showToast('待确认匹配请在电脑端处理')
}
const digestOpen = ref(false)
async function openDigest() {
  digestOpen.value = !digestOpen.value
  if (data.value?.digest) await readDigest(data.value.digest)
}
async function readAll() {
  try {
    await readAllReminders()
    showSuccessToast('已全部标为已读')
  } catch (e) {
    showFailToast(apiError(e))
  }
}
type Todo = (typeof todos.value)[number]

/** 安排发出 → 发出登记页（预填该步骤）；安排开工 → 确认后开工；签收 / 确认变更影响 → 手机签收页；可以开工 → 按第一道工序的方式发出或开工 */
async function open(t: Todo) {
  // 确认总计划节点（R14）：总计划页只有电脑端
  if (t.plan) return showToast('确认总计划节点请在电脑端“总计划”页处理')
  if (t.release) return navigateTo(`/m/release?id=${encodeURIComponent(t.release.id)}`)
  if (!t.step) return
  const ready = t.action === 'READY_TO_START' && t.step.status === 'PENDING'
  if (t.action === 'ARRANGE_SEND' || (ready && t.step.mode === 'EXTERNAL_OUTSOURCE')) return navigateTo(`/m/send?stepId=${encodeURIComponent(t.step.id)}`)
  if (t.action === 'ARRANGE_START' || ready) {
    try {
      await showConfirmDialog({ title: '确认开工', message: `${t.step.partName} · ${t.step.processName}` })
    } catch {
      return // 取消
    }
    try {
      await $fetch(`/api/steps/${t.step.id}/start`, { method: 'POST', body: { source: 'MOBILE' } })
      showSuccessToast('已开工')
      await refreshTodos()
    } catch (e) {
      showFailToast(apiError(e))
    }
  }
}

const transferring = ref<Todo | null>(null)
const transferActions = computed(() =>
  master.value.users.filter((u) => u.id !== me.value?.id).map((u) => ({ name: u.name, subname: u.department, id: u.id })),
)
async function transfer(action: { id: string }) {
  const t = transferring.value
  transferring.value = null
  if (!t) return
  try {
    await $fetch(`/api/todos/${t.id}/transfer`, { method: 'POST', body: { toUserId: action.id } })
    showSuccessToast('已转交')
    await refreshTodos()
  } catch (e) {
    showFailToast(apiError(e))
  }
}

// ───── 展示（前端改版第二轮）：顶部统计、按截止日分组的卡片流、常用入口宫格 ─────
/** 工厂时区（Asia/Shanghai）的今天；截止日都是 'YYYY-MM-DD'，直接按字符串比较 */
const today = factoryDay(new Date())
const dueOf = (t: Todo) => todoDueDay(t)
const todoStats = computed(() => dueStats(todos.value, dueOf, today))
const todoGroups = computed(() => groupByDue(todos.value, dueOf, today))
const woOf = (t: Todo) => t.step?.workOrderNumber ?? t.release?.workOrderNumber ?? t.plan?.workOrderNumber ?? ''
/** 标题去掉开头的"动作："和"工单号 · "（动作、工单号单独显示在上一行） */
function titleOf(t: Todo) {
  let s = t.title.startsWith(`${t.actionText}：`) ? t.title.slice(t.actionText.length + 1) : t.title
  const wo = woOf(t)
  if (wo && s.startsWith(`${wo} · `)) s = s.slice(wo.length + 3)
  return s
}
/** 等变更（设计变更发放后还没确认影响）的工序按"受上游影响"显示 */
const todoTone = (t: Todo, g: DueGroup): Tone => (g === 'OVERDUE' || g === 'TODAY' ? DUE_GROUP_TONE[g] : t.step?.held ? 'upstream' : DUE_GROUP_TONE[g])
function dueText(t: Todo, g: DueGroup) {
  const d = dueOf(t)
  if (!d) return '未定截止日'
  if (g === 'OVERDUE') return `已过期 · 截止 ${d}`
  if (g === 'TODAY') return '今天到期'
  return `截止 ${d}`
}
const GROUP_ICON = { OVERDUE: 'alert', TODAY: 'warn', WEEK: 'dot', LATER: 'ring', NONE: 'ring' } as const
const LEVEL_TONE = { RED: 'late', YELLOW: 'risk', REMIND: 'primary' } as const
const LEVEL_ICON = { RED: 'alert', YELLOW: 'warn', REMIND: 'dot' } as const

/** 常用入口（宫格）：发出登记只给有发出权限的人 */
const entries = computed(() =>
  [
    { text: '上报异常', icon: 'warning-o', to: '/m/issue-new', tone: 'late' },
    { text: '我的异常', icon: 'todo-list-o', to: '/m/issues', tone: 'primary' },
    { text: '到货确认', icon: 'completed-o', to: '/m/arrivals', tone: 'done' },
    { text: '出图任务', icon: 'description', to: '/m/drawings', tone: 'primary' },
    { text: '齐套 / 缺件', icon: 'cluster-o', to: '/m/kitting', tone: 'upstream' },
    { text: '我的签收', icon: 'certificate', to: '/m/releases', tone: 'primary' },
    { text: '外协在途', icon: 'logistics', to: '/m/transit', tone: 'risk' },
    ...(me.value?.can.mobileSend ? [{ text: '发出登记', icon: 'send-gift-o', to: '/m/send', tone: 'primary' }] : []),
  ],
)
</script>

<template>
  <div>
    <van-nav-bar title="我的提醒" />

    <!-- 我是谁 + 顶部统计 -->
    <div class="hello">
      <div class="hello-main">
        <div class="hello-name">{{ me?.name ?? '' }}</div>
        <div class="hello-dept">{{ [me?.department, `今天 ${today}`].filter(Boolean).join(' · ') }}</div>
      </div>
      <van-badge :content="data?.unread || ''" class="hello-unread">未读提醒</van-badge>
    </div>
    <div class="stats">
      <div class="stat">
        <div class="stat-num">{{ todoStats.total }}</div>
        <div class="stat-label"><UiStatusIcon kind="dot" tone="primary" :size="12" />我的待办</div>
      </div>
      <div class="stat" :class="{ hot: todoStats.overdue }">
        <div class="stat-num" :class="{ 'm-text-late': todoStats.overdue }">{{ todoStats.overdue }}</div>
        <div class="stat-label"><UiStatusIcon kind="alert" tone="late" :size="12" />已过期</div>
      </div>
      <div class="stat" :class="{ warm: todoStats.dueToday }">
        <div class="stat-num" :class="{ 'm-text-risk': todoStats.dueToday }">{{ todoStats.dueToday }}</div>
        <div class="stat-label"><UiStatusIcon kind="warn" tone="risk" :size="12" />今天到期</div>
      </div>
    </div>

    <!-- 常用入口 -->
    <div class="entries">
      <van-grid :column-num="4" :border="false">
        <van-grid-item v-for="e in entries" :key="e.to" :to="e.to" :text="e.text">
          <template #icon>
            <span :class="['entry-icon', `tone-${e.tone}`]"><van-icon :name="e.icon" /></span>
          </template>
        </van-grid-item>
      </van-grid>
    </div>

    <!-- QMS 同步连续失败（管理员）：未读时置顶，点一下标为已读（处理请到电脑端设置页） -->
    <div v-for="p in data?.pinned ?? []" :key="p.id" class="digest lv-RED unread" @click="readDigest(p)">
      <div class="digest-title"><van-tag type="danger">同步故障</van-tag> {{ p.title }}</div>
      <ol class="digest-lines">
        <li v-for="(l, i) in p.lines" :key="i">{{ l }}</li>
      </ol>
    </div>

    <!-- 每日汇总置顶（方案 6.3） -->
    <div v-if="data?.digest" class="digest" :class="[`lv-${data.digest.level}`, { unread: !data.digest.readAt }]" @click="openDigest">
      <div class="digest-title"><van-tag type="primary">每日汇总</van-tag> {{ data.digest.title }}</div>
      <ol v-if="digestOpen || !data.digest.readAt" class="digest-lines">
        <li v-for="(l, i) in data.digest.lines" :key="i">{{ l }}</li>
      </ol>
    </div>

    <!-- 我的待办：已过期 / 今天 / 本周 / 以后（/ 未定截止日） -->
    <div class="m-section">我的待办<span v-if="todos.length" class="m-count">{{ todos.length }}</span></div>
    <van-loading v-if="todosPending" class="m-center" />
    <van-empty v-else-if="!todos.length" description="暂时没有待办" image-size="80" />
    <template v-else>
      <template v-for="g in todoGroups" :key="g.group">
        <div :class="['group-title', `m-text-${DUE_GROUP_TONE[g.group]}`]">
          <UiStatusIcon :kind="GROUP_ICON[g.group]" :tone="DUE_GROUP_TONE[g.group]" :size="13" />{{ DUE_GROUP_TEXT[g.group] }}<span class="group-count">{{ g.items.length }}</span>
        </div>
        <div class="m-list">
          <MCard v-for="t in g.items" :key="t.id" :tone="todoTone(t, g.group)" @click="open(t)">
            <div class="m-row">
              <van-tag type="primary" plain>{{ t.actionText }}</van-tag>
              <span v-if="woOf(t)" class="wo">{{ woOf(t) }}</span>
            </div>
            <div class="m-title todo-title">{{ titleOf(t) }}</div>
            <div class="m-desc clamp sugg">{{ t.suggestion }}</div>
            <div class="m-foot-row">
              <span :class="['due', `m-text-${DUE_GROUP_TONE[g.group]}`]">{{ dueText(t, g.group) }}</span>
              <van-tag v-if="t.step?.held" type="warning" class="held">等变更</van-tag>
              <span class="m-spacer" />
              <van-button v-if="t.action !== 'SIGN_RELEASE'" size="small" plain @click.stop="transferring = t">转交</van-button>
              <van-button v-if="todoPrimaryLabel(t)" size="small" type="primary" @click.stop="open(t)">{{ todoPrimaryLabel(t) }}</van-button>
              <span v-else-if="t.plan" class="pc-only">请在电脑端处理</span>
            </div>
          </MCard>
        </div>
      </template>
    </template>

    <!-- 我的提醒：按红、黄、提醒分组 -->
    <div class="m-section">
      我的提醒<span v-if="data?.unread" class="m-count">未读 {{ data.unread }}</span>
      <span class="m-section-extra"><van-button v-if="data?.unread" size="mini" plain @click="readAll">全部已读</van-button></span>
    </div>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!data?.items.length" description="暂时没有提醒" image-size="80" />
    <template v-else>
      <template v-for="g in groups" :key="g.level">
        <div :class="['group-title', `m-text-${LEVEL_TONE[g.level]}`]">
          <UiStatusIcon :kind="LEVEL_ICON[g.level]" :tone="LEVEL_TONE[g.level]" :size="13" />{{ LEVEL_TEXT[g.level] }}<span class="group-count">{{ g.items.length }}</span>
        </div>
        <div class="m-list">
          <MCard
            v-for="item in g.items"
            :key="item.id"
            :tone="item.cleared ? 'none' : LEVEL_TONE[item.level]"
            :link="!!item.mobileLink"
            :class="{ read: !!item.readAt }"
            @click="openReminder(item)"
          >
            <div class="m-row">
              <van-badge :dot="!item.readAt">
                <van-tag :type="levelType[item.level]">{{ item.level === 'RED' ? '红' : item.level === 'YELLOW' ? '黄' : '提醒' }}</van-tag>
              </van-badge>
              <span v-if="!item.readAt" class="unread-text">未读</span>
            </div>
            <div class="m-title reminder-title">{{ item.title }}</div>
            <div class="m-meta">
              <span>{{ timeText(item.createdAt) }}</span>
              <span v-if="item.cleared" class="m-text-done">已消除</span>
              <span v-if="item.issueNo">已转异常 {{ item.issueNo }}</span>
            </div>
          </MCard>
        </div>
      </template>
    </template>
    <div class="bottom-gap" />

    <van-action-sheet
      :show="!!transferring"
      :actions="transferActions"
      cancel-text="取消"
      description="转交给"
      close-on-click-action
      @select="transfer"
      @update:show="(v: boolean) => { if (!v) transferring = null }"
    />
  </div>
</template>

<style scoped>
/* 问候卡：白底细边框（设计规范：不用渐变色块） */
.hello { display: flex; align-items: center; gap: 12px; margin: 12px 12px 0; padding: 14px 16px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: var(--ft-card-radius); color: var(--ft-text); }
.hello-main { flex: 1; min-width: 0; }
.hello-name { font-size: 18px; font-weight: 600; line-height: 26px; }
.hello-dept { font-size: 13px; color: var(--ft-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hello-unread { flex: none; font-size: 13px; padding: 4px 10px; border-radius: 999px; background: var(--ft-fill); color: var(--ft-text); }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 10px 12px 0; }
.stat { background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: var(--ft-card-radius); padding: 12px 10px 10px; text-align: center; }
.stat.hot { background: var(--ft-late-bg); }
.stat.warm { background: var(--ft-risk-bg); }
.stat-num { font-size: 24px; font-weight: 600; line-height: 32px; color: var(--ft-text); font-variant-numeric: tabular-nums; }
.stat-label { margin-top: 2px; display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 12px; color: var(--ft-text-2); white-space: nowrap; }
.entries { margin: 10px 12px 0; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: var(--ft-card-radius); overflow: hidden; padding: 4px 0; }
.entries :deep(.van-grid-item__content) { background: transparent; }
.entries :deep(.van-grid-item__text) { margin-top: 6px; white-space: nowrap; }
.entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: 12px; font-size: 22px; }
.entry-icon.tone-primary { background: var(--ft-primary-bg); color: var(--ft-primary); }
.entry-icon.tone-late { background: var(--ft-late-bg); color: var(--ft-late); }
.entry-icon.tone-done { background: var(--ft-done-bg); color: var(--ft-done-text); }
.entry-icon.tone-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.entry-icon.tone-upstream { background: var(--ft-upstream-bg); color: var(--ft-upstream-text); }
.digest { margin: 12px 12px 0; padding: 12px 14px; border-radius: var(--ft-card-radius); background: var(--ft-primary-bg); font-size: 14px; }
.digest.lv-RED { background: var(--ft-late-bg); }
.digest.lv-YELLOW { background: var(--ft-risk-bg); }
.digest:not(.unread) .digest-title { color: var(--ft-text-2); }
.digest.unread .digest-title { font-weight: 600; }
.digest-lines { margin: 6px 0 0 20px; padding: 0; color: var(--ft-text-2); font-size: 13px; line-height: 20px; }
.group-title { display: flex; align-items: center; gap: 6px; padding: 10px 16px 0; font-size: 13px; font-weight: 600; }
.group-count { color: var(--ft-text-2); font-weight: 400; }
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.todo-title { margin-top: 6px; }
.sugg { color: var(--ft-text-2); }
.due { font-size: 12px; font-weight: 600; }
.pc-only { font-size: 12px; color: var(--ft-text-3); }
.unread-text { font-size: 12px; color: var(--ft-late-text); }
.reminder-title { margin-top: 6px; font-size: 14px; }
.read .reminder-title { font-weight: 400; color: var(--ft-text-2); }
.bottom-gap { height: 16px; }
</style>
