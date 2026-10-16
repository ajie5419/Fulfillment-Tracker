<script setup lang="ts">
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
async function readAll() {
  try {
    await readAllReminders()
    showSuccessToast('已全部标为已读')
  } catch (e) {
    showFailToast(apiError(e))
  }
}
type Todo = (typeof todos.value)[number]

/** 安排发出 → 发出登记页（预填该步骤）；安排开工 → 确认后开工 */
async function open(t: Todo) {
  if (!t.step) return
  if (t.action === 'ARRANGE_SEND') return navigateTo(`/m/send?stepId=${encodeURIComponent(t.step.id)}`)
  if (t.action === 'ARRANGE_START') {
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
</script>

<template>
  <div>
    <van-nav-bar title="我的提醒" />
    <van-cell-group inset class="me">
      <van-cell :title="me?.name ?? ''" :label="me?.department ?? ''">
        <template #value>
          <van-badge :content="data?.unread || ''">未读</van-badge>
        </template>
      </van-cell>
    </van-cell-group>

    <div class="section">我的待办<van-badge v-if="todos.length" :content="todos.length" class="count" /></div>
    <van-loading v-if="todosPending" class="center" />
    <van-empty v-else-if="!todos.length" description="暂时没有待办" image-size="80" />
    <van-cell-group v-else inset>
      <van-cell v-for="t in todos" :key="t.id" :title="t.title" :label="`${t.step?.workOrderNumber ?? ''} ${t.suggestion}`" is-link center @click="open(t)">
        <template #right-icon>
          <van-button size="mini" plain class="transfer" @click.stop="transferring = t">转交</van-button>
        </template>
      </van-cell>
    </van-cell-group>

    <div class="section">
      我的提醒<van-badge v-if="data?.unread" :content="data.unread" class="count" />
      <van-button v-if="data?.unread" size="mini" plain class="read-all" @click="readAll">全部已读</van-button>
    </div>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!data?.items.length" description="暂时没有提醒" image-size="80" />
    <template v-else>
      <template v-for="g in groups" :key="g.level">
      <div :class="['group-title', `lv-${g.level}`]">{{ LEVEL_TEXT[g.level] }}（{{ g.items.length }}）</div>
      <van-cell-group inset class="group">
        <van-cell
          v-for="item in g.items"
          :key="item.id"
          :title="item.title"
          :label="`${timeText(item.createdAt)}${item.cleared ? '　已消除' : ''}`"
          :class="{ unread: !item.readAt }"
          :is-link="!!item.mobileLink"
          center
          @click="openReminder(item)"
        >
          <template #icon>
            <van-badge :dot="!item.readAt" class="tag">
              <van-tag :type="levelType[item.level]">{{ item.level === 'RED' ? '红' : item.level === 'YELLOW' ? '黄' : '提醒' }}</van-tag>
            </van-badge>
          </template>
        </van-cell>
      </van-cell-group>
      </template>
    </template>

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
.me { margin: 12px 0; }
.section { padding: 16px 16px 8px; color: #646566; font-size: 14px; }
.count { margin-left: 6px; }
.center { display: flex; justify-content: center; padding: 32px; }
.tag { margin-right: 8px; align-self: center; }
.transfer { margin-left: 8px; }
.read-all { float: right; }
.group-title { padding: 12px 32px 6px; font-size: 13px; font-weight: 600; color: #1989fa; }
.group-title.lv-RED { color: #ee0a24; }
.group-title.lv-YELLOW { color: #ff976a; }
.group :deep(.van-cell__title) { color: #969799; }
.group .unread :deep(.van-cell__title) { color: #323233; font-weight: 600; }
</style>
