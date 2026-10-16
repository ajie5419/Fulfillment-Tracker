<script setup lang="ts">
const { data, pending } = await useReminders()
const groups = computed(() => groupReminders(data.value?.items ?? []))

/** 点一条：标记已读，跳到关联对象 */
async function openReminder(item: ReminderItem) {
  await readReminder(item)
  if (item.link) await navigateTo(item.link)
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
        await refreshTodos()
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}

const transferring = ref<Todo | null>(null)
const transferTo = ref<string | undefined>()
async function transfer() {
  if (!transferring.value || !transferTo.value) return message.warning('请选择转交对象')
  try {
    await $fetch(`/api/todos/${transferring.value.id}/transfer`, { method: 'POST', body: { toUserId: transferTo.value } })
    message.success('已转交')
    transferring.value = null
    transferTo.value = undefined
    await refreshTodos()
  } catch (e) {
    message.error(apiError(e))
  }
}
</script>

<template>
  <a-space direction="vertical" size="large" style="width: 100%">
    <a-card title="我的待办" :loading="todosPending">
      <template #extra>
        <a-badge :count="todos.length" />
      </template>
      <a-empty v-if="!todos.length" description="暂时没有待办" />
      <a-list v-else :data-source="todos" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-list-item-meta :title="item.title" :description="`${item.step?.workOrderNumber ?? ''}　${item.suggestion}`" />
            <template #actions>
              <a-button v-if="item.action === 'ARRANGE_SEND' && item.step" type="primary" size="small" @click="openSend(item)">登记发出</a-button>
              <a-button v-else-if="item.action === 'ARRANGE_START' && item.step" type="primary" size="small" @click="start(item)">开工</a-button>
              <a-button size="small" @click="transferring = item">转交</a-button>
            </template>
            <span class="muted">{{ timeText(item.createdAt) }}</span>
          </a-list-item>
        </template>
      </a-list>
    </a-card>

    <a-card title="我的提醒" :loading="pending">
      <template #extra>
        <a-space>
          <a-badge :count="data?.unread ?? 0" />
          <a-button size="small" :disabled="!data?.unread" @click="readAll">全部已读</a-button>
        </a-space>
      </template>
      <a-empty v-if="!data?.items.length" description="暂时没有提醒" />
      <div v-for="g in groups" :key="g.level" class="group">
        <div class="group-title" :class="`lv-${g.level}`">{{ LEVEL_TEXT[g.level] }}（{{ g.items.length }}）</div>
        <a-list :data-source="g.items" item-layout="horizontal" size="small">
          <template #renderItem="{ item }">
            <a-list-item class="reminder" :class="[`lv-${item.level}`, { unread: !item.readAt }]" @click="openReminder(item)">
              <a-space>
                <a-badge :status="item.readAt ? 'default' : 'processing'" />
                <a-tag :color="LEVEL_COLOR[item.level as AlertLevelKey]">{{ LEVEL_TEXT[item.level as AlertLevelKey] }}</a-tag>
                <span class="title">{{ item.title }}</span>
                <a-tag v-if="item.cleared" color="default">已消除</a-tag>
              </a-space>
              <template #extra><span class="muted">{{ timeText(item.createdAt) }}</span></template>
            </a-list-item>
          </template>
        </a-list>
      </div>
    </a-card>
  </a-space>

  <SendStepModal :step="sending" @close="sending = null" @done="sending = null; refreshTodos()" />

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
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.group + .group { margin-top: 12px; }
.group-title { font-weight: 600; padding: 4px 8px; border-left: 4px solid; }
.group-title.lv-RED { border-color: #f5222d; color: #cf1322; background: #fff1f0; }
.group-title.lv-YELLOW { border-color: #fa8c16; color: #d46b08; background: #fff7e6; }
.group-title.lv-REMIND { border-color: #1677ff; color: #0958d9; background: #e6f4ff; }
.reminder { cursor: pointer; }
.reminder:hover { background: #fafafa; }
.reminder .title { color: #666; }
.reminder.unread .title { font-weight: 600; color: rgba(0, 0, 0, 0.88); }
</style>
