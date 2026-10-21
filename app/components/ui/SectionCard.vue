<script setup lang="ts">
/**
 * 通用卡片（前端改版第一轮）：白底、圆角 14、轻阴影；标题 + 右上角操作（#extra）+ 内容。
 * 页面里的分区都用它，统一视觉。
 */
withDefaults(defineProps<{ title?: string; sub?: string; padding?: 'normal' | 'tight' | 'none' }>(), { title: undefined, sub: undefined, padding: 'normal' })
</script>

<template>
  <section class="ft-section" :class="`pad-${padding}`">
    <header v-if="title || $slots.title || $slots.extra" class="head">
      <div class="titles">
        <h2 v-if="title || $slots.title" class="title"><slot name="title">{{ title }}</slot></h2>
        <div v-if="sub" class="sub">{{ sub }}</div>
      </div>
      <div v-if="$slots.extra" class="extra"><slot name="extra" /></div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
/* 设计改版：内容面板是白底，卡片靠细边框区分（不再靠阴影） */
.ft-section { background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: var(--ft-card-radius); box-shadow: var(--ft-card-shadow); min-width: 0; }
.pad-normal { padding: 20px 24px; }
.pad-tight { padding: 14px 16px; }
.pad-none { padding: 0; overflow: hidden; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.pad-none .head { padding: 16px 20px 0; }
.titles { min-width: 0; }
.title { margin: 0; font-size: 16px; font-weight: 600; color: var(--ft-text); line-height: 24px; }
.sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-3); }
.extra { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
@media (max-width: 575px) {
  .pad-normal { padding: 16px; }
}
</style>
