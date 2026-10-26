<script setup lang="ts">
/**
 * 工件抽屉（10-26 借鉴 ERPNext 单据的活动和留言）：时间线（建档、设计、物料、流转、异常、留言，新的在上）+ 留言。
 * 打开方式：生产管理页工件卡片上的"时间线"、关联记录数；留言提醒跳过来时带 comments=1 直接打开留言。
 */
const props = defineProps<{ part: { id: string; name: string } | null; tab?: 'timeline' | 'comments' }>()
const emit = defineEmits<{ close: []; commented: [] }>()

const tab = ref<'timeline' | 'comments'>('timeline')
watch(() => props.part, (p) => { if (p) tab.value = props.tab ?? 'timeline' }, { immediate: true })

const { data: timeline, pending, refresh } = await useFetch(() => `/api/parts/${props.part?.id}/timeline`, {
  immediate: !!props.part,
  watch: false,
})
watch(() => props.part?.id, (id) => { if (id) refresh() })
const KIND_TEXT = { part: '建档', drawing: '设计', purchase: '物料', flow: '流转', issue: '异常', comment: '留言' } as const
async function onCommented() {
  emit('commented')
  await refresh()
}
</script>

<template>
  <a-drawer :open="!!part" :title="part?.name ?? ''" :width="560" destroy-on-close @close="emit('close')">
    <a-segmented v-model:value="tab" :options="[{ value: 'timeline', label: '时间线' }, { value: 'comments', label: '留言' }]" class="tabs" />
    <template v-if="part && tab === 'timeline'">
      <a-spin :spinning="pending">
        <p v-if="!timeline?.entries.length" class="empty">还没有记录</p>
        <ol v-else class="tl">
          <li v-for="(e, i) in timeline.entries" :key="i" class="tl-item">
            <span class="dot" :style="{ background: `var(--ft-${e.tone})` }" aria-hidden="true" />
            <div class="tl-main">
              <div class="tl-head">
                <UiStatusTag :tone="e.tone">{{ KIND_TEXT[e.kind] }}</UiStatusTag>
                <NuxtLink v-if="e.link" :to="e.link" class="tl-title">{{ e.title }}</NuxtLink>
                <span v-else class="tl-title">{{ e.title }}</span>
              </div>
              <div v-if="e.sub" class="tl-sub">{{ e.sub }}</div>
              <div class="tl-time">{{ timeText(e.at) }}</div>
            </div>
          </li>
        </ol>
      </a-spin>
    </template>
    <CommentPanel v-else-if="part" ref-type="part" :ref-id="part.id" @changed="onCommented" />
  </a-drawer>
</template>

<style scoped>
.tabs { margin-bottom: 16px; }
.empty { margin: 8px 0; color: var(--ft-text-2); font-size: 13px; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl-item { position: relative; display: flex; gap: 12px; padding: 0 0 16px; }
/* 竖线把各条串起来 */
.tl-item:not(:last-child)::before { content: ''; position: absolute; left: 4px; top: 14px; bottom: 0; width: 1px; background: var(--ft-border); }
.dot { flex: none; width: 9px; height: 9px; margin-top: 6px; border-radius: 50%; }
.tl-main { flex: 1; min-width: 0; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-title { font-size: 14px; color: var(--ft-text); }
a.tl-title { color: var(--ft-primary); }
.tl-sub { margin-top: 2px; font-size: 13px; color: var(--ft-text); word-break: break-word; }
.tl-time { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
</style>
