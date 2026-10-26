<script setup lang="ts">
/**
 * 留言（工件 / 采购行，10-26 借鉴 ERPNext 记录评论）：按时间列出，底部写留言、可 @ 多人，被 @ 的人收到提醒，点开跳回这里。
 * 留言只新增不修改。能看到这个工单的人都能看、能写。
 */
const props = defineProps<{ refType: 'part' | 'purchase'; refId: string }>()
const emit = defineEmits<{ changed: [count: number] }>()

const { data: master } = await useMaster()
const { data: me } = await useMe()
const { data: rows, pending, refresh } = await useFetch('/api/comments', {
  query: computed(() => ({ refType: props.refType, refId: props.refId })),
  default: () => [],
  watch: [() => props.refId],
})
const userOptions = computed(() => master.value.users.filter((u) => u.id !== me.value?.id).map((u) => ({ value: u.id, label: u.name })))
const body = ref('')
const mentionIds = ref<string[]>([])
const saving = ref(false)

async function send() {
  if (!body.value.trim()) return message.warning('请填写留言内容')
  saving.value = true
  try {
    await $fetch('/api/comments', { method: 'POST', body: { refType: props.refType, refId: props.refId, body: body.value, mentionIds: mentionIds.value } })
    message.success(mentionIds.value.length ? `已留言，已提醒 ${mentionIds.value.length} 人` : '已留言')
    body.value = ''
    mentionIds.value = []
    await refresh()
    emit('changed', rows.value.length)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="comments">
    <a-spin :spinning="pending">
      <div v-if="rows.length" class="ft-well list">
        <UiListItem v-for="c in rows" :key="c.id" tone="primary" icon="dot">
          <template #title>{{ c.authorName }}<span class="time">{{ timeText(c.createdAt) }}</span></template>
          <template #desc><span class="body">{{ c.body }}</span></template>
          <template v-if="c.mentions.length" #meta>提醒了 {{ c.mentions.map((m) => m.name).join('、') }}</template>
        </UiListItem>
      </div>
      <p v-else class="empty">还没有留言</p>
    </a-spin>
    <div class="editor">
      <a-textarea v-model:value="body" :rows="3" :maxlength="1000" placeholder="写留言：进度、问题、要谁配合……" />
      <div class="row">
        <a-select v-model:value="mentionIds" mode="multiple" :options="userOptions" placeholder="@ 提醒谁（可多选）" show-search option-filter-prop="label" :max-tag-count="3" class="who" />
        <a-button type="primary" :loading="saving" @click="send">发送</a-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comments { display: flex; flex-direction: column; gap: 12px; }
.empty { margin: 8px 0; color: var(--ft-text-2); font-size: 13px; }
.time { margin-left: 8px; font-size: 12px; font-weight: normal; color: var(--ft-text-2); }
.body { white-space: pre-wrap; word-break: break-word; }
.editor { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 8px; }
.who { flex: 1; min-width: 0; }
</style>
