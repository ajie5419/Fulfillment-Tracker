<script setup lang="ts">
/**
 * "筛选"按钮 + 弹出面板（设计改版）：次要的筛选条件收进面板，工具栏只留最常用的一两个。
 * count = 已生效（和默认不同）的条件数，显示在按钮上；面板内容放默认插槽，常用 .ft-filter-row 一行一个条件。
 * 面板底部固定"清空 / 完成"，清空由页面自己把条件恢复成默认（@clear）。
 */
withDefaults(defineProps<{ count?: number; width?: number }>(), { count: 0, width: 320 })
defineEmits<{ clear: [] }>()
const open = ref(false)
</script>

<template>
  <a-popover v-model:open="open" trigger="click" placement="bottomRight" :overlay-style="{ width: `${width}px` }">
    <template #content>
      <div class="panel">
        <slot />
        <div class="actions">
          <a-button size="small" :disabled="!count" @click="$emit('clear')">清空</a-button>
          <a-button size="small" type="primary" @click="open = false">完成</a-button>
        </div>
      </div>
    </template>
    <a-button>筛选<span v-if="count" class="count">{{ count }}</span></a-button>
  </a-popover>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ft-border); }
.count { display: inline-block; min-width: 18px; height: 18px; margin-left: 6px; padding: 0 5px; border-radius: 9px; background: var(--ft-text); color: var(--ft-card-bg); font-size: 12px; line-height: 18px; text-align: center; }
</style>
