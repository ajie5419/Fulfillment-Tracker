<script setup lang="ts">
/**
 * 已生效的筛选条件（设计改版）：一排可单独关掉的小标签 + "清空"。没有条件时不渲染。
 * items 由页面算：只放和默认值不同的条件，clear 把这一条恢复成默认。
 */
defineProps<{ items: readonly { key: string; text: string; clear: () => void }[] }>()
defineEmits<{ clearAll: [] }>()
</script>

<template>
  <div v-if="items.length" class="ft-chips">
    <span v-for="c in items" :key="c.key" class="chip">{{ c.text }}<button type="button" class="x" :aria-label="`去掉条件：${c.text}`" @click="c.clear()">×</button></span>
    <a-button type="link" size="small" @click="$emit('clearAll')">清空</a-button>
  </div>
</template>

<style scoped>
.ft-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 13px; background: var(--ft-fill); border: 1px solid var(--ft-border); font-size: 12px; color: var(--ft-text); }
.x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: none; border-radius: 50%; background: none; color: var(--ft-text-2); cursor: pointer; font-size: 14px; line-height: 1; }
.x:hover { background: var(--ft-border); color: var(--ft-text); }
.x:focus-visible { outline: 2px solid var(--ft-primary); }
</style>
