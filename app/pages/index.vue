<script setup lang="ts">
const { data, pending } = useReminders()
const levelColor = { RED: 'red', YELLOW: 'orange', REMIND: 'blue' } as const
const levelText = { RED: '红色', YELLOW: '黄色', REMIND: '提醒' } as const

const { data: todos, pending: todosPending, refresh: refreshTodos } = useTodos()
const { data: master } = useMaster()
const { data: me } = useMe()
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
        <a-badge :count="data?.unread ?? 0" />
      </template>
      <a-empty v-if="!data?.items.length" description="暂时没有提醒" />
      <a-list v-else :data-source="data.items" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-tag :color="levelColor[item.level as keyof typeof levelColor]">{{ levelText[item.level as keyof typeof levelText] }}</a-tag>
            <span :style="{ fontWeight: item.readAt ? 'normal' : 600 }">{{ item.title }}</span>
            <template #extra>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</template>
          </a-list-item>
        </template>
      </a-list>
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
</style>
