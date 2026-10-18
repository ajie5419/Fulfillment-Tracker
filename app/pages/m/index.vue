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

/** 安排发出 → 发出登记页（预填该步骤）；安排开工 → 确认后开工；签收 / 确认变更影响 → 手机签收页 */
async function open(t: Todo) {
  if (t.release) return navigateTo(`/m/release?id=${encodeURIComponent(t.release.id)}`)
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

    <div class="entries">
      <van-button type="danger" icon="warning-o" round block @click="navigateTo('/m/issue-new')">上报异常</van-button>
      <van-button type="primary" plain icon="todo-list-o" round block @click="navigateTo('/m/issues')">我的异常</van-button>
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

    <div class="section">我的待办<van-badge v-if="todos.length" :content="todos.length" class="count" /></div>
    <van-loading v-if="todosPending" class="center" />
    <van-empty v-else-if="!todos.length" description="暂时没有待办" image-size="80" />
    <van-cell-group v-else inset>
      <van-cell v-for="t in todos" :key="t.id" :title="t.title" :label="`${t.step?.workOrderNumber ?? t.release?.workOrderNumber ?? ''} ${t.suggestion}`" is-link center @click="open(t)">
        <template #right-icon>
          <van-button v-if="t.action !== 'SIGN_RELEASE'" size="mini" plain class="transfer" @click.stop="transferring = t">转交</van-button>
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
          :label="`${timeText(item.createdAt)}${item.cleared ? '　已消除' : ''}${item.issueNo ? `　已转异常 ${item.issueNo}` : ''}`"
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
.entries { display: flex; gap: 12px; padding: 0 16px; }
.digest { margin: 12px 16px 0; padding: 10px 12px; border-radius: 8px; background: #ecf5ff; border: 1px solid #b3d8ff; font-size: 14px; }
.digest.lv-RED { background: #fff1f0; border-color: #ffa39e; }
.digest.lv-YELLOW { background: #fff7e6; border-color: #ffd591; }
.digest:not(.unread) .digest-title { color: #969799; }
.digest.unread .digest-title { font-weight: 600; }
.digest-lines { margin: 6px 0 0 20px; padding: 0; color: #646566; font-size: 13px; }
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
