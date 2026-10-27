<script setup lang="ts">
/**
 * 侧栏菜单图标（设计改版试点 v2）：内联线条 SVG，颜色跟随文字（currentColor）。
 * 不引入图标库：@ant-design/icons-vue 不是直接依赖，加依赖要改 package.json。
 * name 用菜单路由；没有对应图标时画一个小圆点，不报错。
 */
defineProps<{ name: string; size?: number }>()
const PATHS: Record<string, string[]> = {
  '/': ['M3 10.5 12 3l9 7.5', 'M5 9v11h14V9', 'M10 20v-6h4v6'],
  '/calendar': ['M4 5h16v15H4z', 'M4 9h16', 'M8 3v4', 'M16 3v4', 'M8 13h.01', 'M12 13h.01', 'M16 13h.01', 'M8 17h.01', 'M12 17h.01'],
  '/risks': ['M12 3 2 20h20L12 3Z', 'M12 10v4', 'M12 17h.01'],
  '/board': ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  '/plan': ['M4 4v16h16', 'M8 8h6', 'M10 12h7', 'M8 16h4'],
  '/dept-plan': ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M4 6l1.5 1.5L8 5', 'M4 12l1.5 1.5L8 11', 'M4 18h4'],
  '/drawings': ['M4 20l4-1 11-11-3-3L5 16l-1 4Z', 'M14 7l3 3'],
  '/process': ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 12h7', 'M9 16h7'],
  '/releases': ['M21 3 10 14', 'M21 3l-7 18-4-7-7-4 18-7Z'],
  '/purchases': ['M3 4h2l2.5 11h11L21 7H6.5', 'M9 20h.01', 'M18 20h.01'],
  '/payments': ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'],
  '/kitting': ['M12 3 3 7.5l9 4.5 9-4.5L12 3Z', 'M3 12l9 4.5 9-4.5', 'M3 16.5 12 21l9-4.5'],
  '/parts': ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1 7 17', 'M17 7l2.1-2.1'],
  '/production': ['M4 4h4v16H4z', 'M10 4h4v11h-4z', 'M16 4h4v7h-4z'],
  '/outsource': ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  '/settings': ['M4 6h10', 'M18 6h2', 'M16 4v4', 'M4 12h4', 'M12 12h8', 'M10 10v4', 'M4 18h12', 'M20 18h0', 'M18 16v4'],
  '/dev': ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3', 'M7 15h10'],
}
</script>

<template>
  <svg class="ft-nav-icon" :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="PATHS[name]"><path v-for="(d, i) in PATHS[name]" :key="i" :d="d" /></template>
    <circle v-else cx="12" cy="12" r="3" />
  </svg>
</template>

<style scoped>
.ft-nav-icon { flex: none; display: block; }
</style>
