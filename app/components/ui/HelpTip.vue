<script setup lang="ts">
/**
 * 标题旁的小问号（设计改版）：页面上大段的说明文字收进来，鼠标移上去或键盘聚焦时显示，不占版面。
 */
withDefaults(defineProps<{ label?: string }>(), { label: '说明' })
</script>

<template>
  <a-tooltip placement="bottomLeft" :overlay-style="{ maxWidth: '420px' }">
    <template #title><slot /></template>
    <button type="button" class="ft-help" :aria-label="label">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><circle cx="8" cy="11.4" r=".8" fill="currentColor" /></svg>
    </button>
  </a-tooltip>
</template>

<style scoped>
.ft-help { display: inline-flex; align-items: center; padding: 2px; border: none; border-radius: 50%; background: none; color: var(--ft-text-2); cursor: help; vertical-align: middle; }
.ft-help:hover { color: var(--ft-text); }
.ft-help:focus-visible { outline: 2px solid var(--ft-primary); }
</style>
