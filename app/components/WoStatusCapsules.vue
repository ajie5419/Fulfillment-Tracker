<script setup lang="ts">
import { visibleWoStatusCapsules, type WoStatusFields } from '#shared/wo-status-capsules'

const props = defineProps<{ row: WoStatusFields; to: string; embedded?: boolean }>()
const capsules = computed(() => visibleWoStatusCapsules(props.row))
const hiddenText = computed(() => capsules.value.hidden.map((c) => c.text).join(' · '))
</script>

<template>
  <div v-if="capsules.all.length" class="wo-status-capsules" aria-label="工单状态">
    <UiStatusTag v-for="c in capsules.visible" :key="c.key" :tone="c.tone" :title="c.hint">{{ c.text }}</UiStatusTag>
    <a-tooltip v-if="capsules.hidden.length" :title="hiddenText">
      <!-- 看板卡本身是链接，避免嵌套链接；驾驶舱则提供独立的详情链接。 -->
      <span v-if="embedded" class="capsule-more" :aria-label="`另有 ${capsules.hidden.length} 项：${hiddenText}`"><UiStatusTag tone="none">+{{ capsules.hidden.length }}</UiStatusTag></span>
      <NuxtLink v-else :to="to" class="capsule-more" :aria-label="`另有 ${capsules.hidden.length} 项：${hiddenText}，查看工单详情`"><UiStatusTag tone="none">+{{ capsules.hidden.length }}</UiStatusTag></NuxtLink>
    </a-tooltip>
  </div>
</template>

<style scoped>
.wo-status-capsules { display: flex; flex-wrap: wrap; gap: 6px; }
.capsule-more { display: inline-flex; }
.capsule-more:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; border-radius: 999px; }
</style>
