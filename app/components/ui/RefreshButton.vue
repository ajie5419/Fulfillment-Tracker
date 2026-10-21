<script setup lang="ts">
/** 刷新按钮（设计改版）：只有图标，省一个文字按钮的位置；读屏和鼠标悬停都能看到"刷新" */
defineEmits<{ click: [e: MouseEvent] }>()
</script>

<template>
  <a-button aria-label="刷新" title="刷新" @click="$emit('click', $event)">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="ico"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </a-button>
</template>

<style scoped>
.ico { display: block; }
</style>
