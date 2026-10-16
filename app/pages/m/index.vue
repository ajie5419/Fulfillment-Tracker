<script setup lang="ts">
definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const { data, pending } = await useReminders()
const { data: todos, pending: todosPending, refresh: refreshTodos } = await useTodos()
const { data: master } = await useMaster()
const levelType = { RED: 'danger', YELLOW: 'warning', REMIND: 'primary' } as const
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

    <div class="section">我的提醒</div>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!data?.items.length" description="暂时没有提醒" image-size="80" />
    <van-cell-group v-else inset>
      <van-cell v-for="item in data.items" :key="item.id" :title="item.title" :label="new Date(item.createdAt).toLocaleString('zh-CN')">
        <template #icon>
          <van-tag :type="levelType[item.level]" class="tag">{{ item.level === 'RED' ? '红' : item.level === 'YELLOW' ? '黄' : '提醒' }}</van-tag>
        </template>
      </van-cell>
    </van-cell-group>

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
</style>
