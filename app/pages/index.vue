<script setup lang="ts">
import { WORK_BUCKET_TEXT, factoryTimeText } from '#shared/workbench'
import { RULE_TEXT, ALERT_LEVEL_TEXT } from '#shared/alert-rules'
import { todoLink, hasTodoMenu, toneIcon, type Card, type WorkbenchFilter } from '../composables/useWorkbenchFeed'

const { data, pending, error: remindersError } = await useReminders()
const { openReminder, openPinned, readAll } = useWorkbenchReminderActions()
const { data: todos, pending: todosPending, error: todosError, refresh: refreshTodos } = await useTodos()
const { data: master } = await useMaster()
const { data: me } = await useMe()

/** Refresh both feeds after business mutations; reading a notification never completes a task. */
async function afterTodo() {
  await Promise.all([refreshTodos(), refreshReminders()])
}
const { sending, openSend, start, finishing, finish, finishPlanTask, releaseId, transferring, transferTo, transfer } = useWorkbenchTodoActions({ afterTodo })
const todosAvailable = computed(() => !todosError.value && !todosPending.value)
const { allCards, active, counts, cards, groups, filterTo, isNotifications, notificationFilter, selectedWo, selectedAction, workOrders, actionOptions, updateFilter } = useWorkbenchFeed({ todos, reminders: data, todosAvailable })
const loadError = computed(() => isNotifications.value ? remindersError.value : todosError.value)
const loading = computed(() => isNotifications.value ? pending.value : todosPending.value)
const filterOptions = computed(() => [
  { value: 'todo', label: `待处理 ${todosAvailable.value ? counts.value.todo : '—'}` },
  { value: 'overdue', label: `逾期 ${todosAvailable.value ? counts.value.overdue : '—'}` },
  { value: 'today', label: `今日到期 ${todosAvailable.value ? counts.value.today : '—'}` },
  { value: 'notifications', label: `通知 · ${pending.value || remindersError.value ? '—' : counts.value.unread} 未读` },
])
const notificationOptions = [{ value: 'attention', label: '待关注' }, { value: 'unread', label: '未读' }, { value: 'history', label: '最近记录' }]
const filterChips = computed(() => [
  ...(selectedWo.value ? [{ key: 'wo', text: `工单：${selectedWo.value}`, clear: () => updateFilter('wo') }] : []),
  ...(!isNotifications.value && selectedAction.value ? [{ key: 'action', text: `类型：${actionOptions.value.find(a => a.value === selectedAction.value)?.label ?? selectedAction.value}`, clear: () => updateFilter('action') }] : []),
])
async function retryLoad() {
  await Promise.all([refreshTodos(), refreshReminders()])
}
function onCardClick(c: Card) {
  if (c.reminder) return openReminder(c.reminder)
}
</script>

<template>
  <div class="wb">
    <UiSectionCard icon="inbox" padding="none" :title="isNotifications ? '通知' : '我的待办'" tray>
      <template #extra><UiRefreshButton :loading="loading" @click="retryLoad" /></template>
      <div class="controls">
        <a-segmented class="views" :value="isNotifications ? 'notifications' : active" :options="filterOptions" @change="(f) => navigateTo(filterTo(f as WorkbenchFilter))" />
        <div class="filters">
          <a-segmented v-if="isNotifications" :value="notificationFilter" :options="notificationOptions" @change="(v) => updateFilter('n', String(v))" />
          <a-select v-else aria-label="任务类型" :value="selectedAction" :options="actionOptions" allow-clear placeholder="全部类型" @change="(v) => updateFilter('action', typeof v === 'string' ? v : undefined)" />
          <a-select aria-label="工单筛选" :value="selectedWo" :options="workOrders" allow-clear show-search option-filter-prop="label" placeholder="全部工单" @change="(v) => updateFilter('wo', typeof v === 'string' ? v : undefined)" />
          <a-button v-if="isNotifications" size="small" :disabled="pending || !!remindersError || !counts.unread" @click="readAll">全部标为已读</a-button>
        </div>
        <UiFilterChips :items="filterChips" @clear-all="navigateTo({ query: { f: active === 'todo' ? undefined : active, n: notificationFilter === 'attention' ? undefined : notificationFilter } })" />
      </div>
      <div v-if="!remindersError && !pending && data?.pinned.length" class="sync-notices">
        <div v-for="p in data.pinned" :key="p.id" class="sync-notice">
          <UiAlertMark level="late" /><span>{{ p.title }}</span><a-button size="small" @click="openPinned(p)">查看同步</a-button>
        </div>
      </div>
      <a-alert v-if="!isNotifications && remindersError" class="notice-error" type="warning" message="通知加载失败，待办仍可处理。" show-icon>
        <template #action><a-button size="small" @click="refreshReminders()">重试</a-button></template>
      </a-alert>
      <a-spin :spinning="loading">
        <a-result v-if="loadError && !loading" status="error" :title="isNotifications ? '通知加载失败' : '待办加载失败'" :sub-title="apiError(loadError)">
          <template #extra><a-button @click="retryLoad">重试</a-button></template>
        </a-result>
        <template v-else-if="!loading">
          <template v-if="isNotifications">
            <p class="notification-hint">{{ notificationFilter === 'attention' ? '已关联待办的预警在任务中展示；已消除的预警可在最近记录中查看。' : '已读仅表示看过通知，不代表业务已处理。' }}</p>
            <div v-if="!cards.length" class="empty-box"><a-empty description="没有符合条件的通知" /></div>
            <div v-else class="feed-rows">
              <UiListItem v-for="c in cards" :key="c.key" compact :tone="c.tone === 'normal' ? 'none' : c.tone" :icon="toneIcon(c.tone)">
                <template #title>
                  <button type="button" class="notification-title" :class="{ unread: c.unread }" @click="onCardClick(c)">{{ c.title }}</button>
                  <span v-if="c.unread" class="muted">未读</span>
                </template>
                <template #meta>
                  <span v-if="c.wo"><WoLink :no="c.wo" /> · </span>
                  <span>{{ factoryTimeText(c.createdAt) }}</span>
                  <span v-if="c.reminder?.cleared"> · 已消除</span>
                  <span v-else-if="c.reminder?.issueNo"> · 已转异常 {{ c.reminder.issueNo }}</span>
                  <span v-else-if="c.reminder?.rule"> · {{ RULE_TEXT[c.reminder.rule] }}</span>
                </template>
                <template #extra>
                  <a-button v-if="c.reminder?.link" size="small" @click="onCardClick(c)">查看</a-button>
                  <a-button v-else-if="c.reminder && c.unread" size="small" @click="readReminder(c.reminder)">标为已读</a-button>
                </template>
              </UiListItem>
            </div>
          </template>
          <template v-else>
            <div v-if="!groups.length" class="empty-box"><a-empty :description="active !== 'todo' || filterChips.length ? '没有符合条件的待办' : '暂无待处理事项'" /></div>
            <section v-for="g in groups" :key="g.bucket" class="group">
              <h3 class="group-title">{{ WORK_BUCKET_TEXT[g.bucket] }} <span>{{ g.items.length }}</span></h3>
              <div class="feed-rows">
                <UiListItem v-for="c in g.items" :key="c.key" compact :tone="c.tone === 'normal' ? 'none' : c.tone" :icon="toneIcon(c.tone)">
                  <template #title>{{ c.title }} <span v-if="c.todo?.step?.held" class="muted">等待变更确认</span></template>
                  <template #meta><WoLink v-if="c.wo" :no="c.wo" /><span v-else>未关联工单</span></template>
                  <template #desc>
                    <details v-if="c.todo?.suggestion || c.alerts.length" class="task-details">
                      <summary><span v-if="c.alerts.length" :class="{ late: c.alerts.some(r => r.level === 'RED') }">{{ c.alerts.length }} 条预警 · </span>处理说明</summary>
                      <p v-if="c.todo?.suggestion">{{ c.todo.suggestion }}</p>
                      <div v-for="r in c.alerts" :key="r.id" class="linked-alert">
                        <span>{{ ALERT_LEVEL_TEXT[r.level] }} · {{ r.title }}</span>
                        <a-button size="small" @click="openReminder(r)">{{ r.link ? '查看预警' : '标为已读' }}</a-button>
                      </div>
                    </details>
                  </template>
                  <template #extra>
                    <span class="due" :class="{ late: c.bucket === 'OVERDUE' }">{{ c.dueDay ? `${c.bucket === 'OVERDUE' ? '逾期 · ' : '截止 '}${c.dueDay}` : '未定截止日' }}</span>
                    <div v-if="c.todo" class="ops">
                      <a-button v-if="c.todo.link" size="small" @click="navigateTo(c.todo.link)">去处理</a-button>
                      <a-button v-else-if="c.todo.action === 'ARRANGE_SEND' && c.todo.step" size="small" @click="openSend(c.todo)">登记发出</a-button>
                      <a-button v-else-if="c.todo.action === 'ARRANGE_START' && c.todo.step" size="small" @click="start(c.todo)">开工</a-button>
                      <template v-else-if="c.todo.action === 'READY_TO_START' && c.todo.step && c.todo.step.status === 'PENDING'">
                        <a-button v-if="c.todo.step.mode === 'EXTERNAL_OUTSOURCE'" size="small" @click="openSend(c.todo)">登记发出</a-button>
                        <a-button v-else size="small" @click="start(c.todo)">开工</a-button>
                      </template>
                      <a-button v-else-if="c.todo.action === 'SIGN_RELEASE' && c.todo.release" size="small" @click="releaseId = c.todo.release.id">查看并签收</a-button>
                      <a-button v-else-if="c.todo.action === 'CONFIRM_CHANGE' && c.todo.release" size="small" @click="releaseId = c.todo.release.id">确认变更影响</a-button>
                      <a-button v-else-if="c.todo.action === 'CONFIRM_PLAN_NODE' && c.todo.plan" size="small" @click="navigateTo(c.todo.plan.link)">去接收</a-button>
                      <a-button v-else-if="c.todo.action === 'DO_PLAN_TASK' && c.todo.planTask" size="small" @click="finishPlanTask(c.todo)">完成</a-button>
                      <a-dropdown v-if="hasTodoMenu(c.todo)" :trigger="['click']">
                        <a-button size="small" aria-label="更多任务操作">更多</a-button>
                        <template #overlay>
                          <a-menu>
                            <a-menu-item v-if="todoLink(c.todo)" key="view" @click="navigateTo(todoLink(c.todo) ?? '/')">查看详情</a-menu-item>
                            <a-menu-item v-if="c.todo.step && (c.todo.action === 'ARRANGE_START' || (c.todo.action === 'READY_TO_START' && c.todo.step.status === 'PENDING' && c.todo.step.mode !== 'EXTERNAL_OUTSOURCE'))" key="finish" @click="finish(c.todo)">登记完工</a-menu-item>
                            <a-menu-item v-if="c.todo.refType !== 'drawing' && c.todo.action !== 'SIGN_RELEASE' && c.todo.action !== 'PURCHASE_PLAN_ISSUED'" key="transfer" @click="transferring = c.todo">转交</a-menu-item>
                          </a-menu>
                        </template>
                      </a-dropdown>
                    </div>
                  </template>
                </UiListItem>
              </div>
            </section>
          </template>
        </template>
      </a-spin>
    </UiSectionCard>
    <SendStepModal :step="sending" @close="sending = null" @done="sending = null; afterTodo()" />
    <FinishStepModal :step="finishing" @close="finishing = null" @done="finishing = null; afterTodo()" />
    <ReleaseDrawer :id="releaseId" @close="releaseId = null" @changed="afterTodo()" />
    <a-modal :open="!!transferring" title="转交待办" ok-text="转交" @ok="transfer" @cancel="transferring = null">
      <p>{{ transferring?.title }}</p>
      <a-select v-model:value="transferTo" style="width: 100%" placeholder="选择转交给谁" show-search option-filter-prop="label" :options="master.users.filter((u) => u.id !== me?.id).map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` }))" />
    </a-modal>
  </div>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: 16px; }
.controls { display: flex; flex-direction: column; gap: 12px; padding: 4px 20px 16px; }
.views { align-self: flex-start; max-width: 100%; }
.filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.filters :deep(.ant-select) { width: 180px; max-width: 100%; }
.muted, .notification-hint { color: var(--ft-text-2); font-size: 12px; }
.notification-hint { margin: 12px 20px; }
.sync-notices, .notice-error { margin: 0 20px 12px; }
.sync-notice { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ft-late-text); }
.sync-notice > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.empty-box { padding: 24px 20px; }
.group-title { margin: 0; padding: 8px 20px; background: var(--ft-fill); border-block: 1px solid var(--ft-border); font-size: 13px; color: var(--ft-text-2); }
.group-title span { margin-left: 8px; font-weight: 400; }
.feed-rows { padding: 0 20px; }
.feed-rows :deep(.title), .task-details { overflow-wrap: anywhere; }
.feed-rows :deep(.extra) { gap: 24px; }
.due { min-width: 145px; text-align: right; color: var(--ft-text-2); }
.late { color: var(--ft-late-text); }
.ops { display: flex; justify-content: flex-end; gap: 8px; white-space: nowrap; }
.task-details { color: var(--ft-text-2); font-size: 12px; }
.task-details summary { cursor: pointer; width: fit-content; }
.task-details p { margin: 8px 0; }
.linked-alert { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.linked-alert span { flex: 1; min-width: 0; }
.notification-title { text-align: left; padding: 0; border: 0; background: none; color: var(--ft-text); cursor: pointer; font: inherit; }
.notification-title.unread { font-weight: 600; }
.due, .views, .group-title, .feed-rows :deep(.meta) { font-variant-numeric: tabular-nums; }
.notification-title:focus-visible, summary:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
@media (max-width: 767px) {
  .controls { padding-inline: 12px; }
  .views { align-self: stretch; font-size: 12px; }
  .views :deep(.ant-segmented-item-label) { padding-inline: 7px; }
  .filters :deep(.ant-select) { flex: 1; min-width: 120px; }
  .feed-rows { padding-inline: 12px; }
  .feed-rows :deep(.ft-li) { flex-wrap: wrap; }
  .feed-rows :deep(.extra) { width: 100%; padding-left: 46px; justify-content: space-between; flex-wrap: wrap; gap: 8px; white-space: normal; }
  .due { min-width: 0; text-align: left; }
  .ops { flex-shrink: 0; }
  .group-title { padding-inline: 12px; }
}
@media (max-width: 480px) {
  .views :deep(.ant-segmented-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .due { width: 100%; }
  .ops { margin-left: auto; }
}
</style>
