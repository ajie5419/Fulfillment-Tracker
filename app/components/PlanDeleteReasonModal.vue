<script setup lang="ts">
import type { PlanNodeRow } from '#shared/plan-view'

/** 已发布的总计划删除节点时填写删除原因的弹窗（PlanEditor 拆分）；确认由父级提交。 */
defineProps<{ node: PlanNodeRow | null }>()
const open = defineModel<boolean>('open', { required: true })
const text = defineModel<string>('text', { required: true })
const emit = defineEmits<{ ok: [] }>()
</script>

<template>
<a-modal v-model:open="open" :title="`删除节点：${node?.name}`" @ok="emit('ok')">
  <p class="muted">总计划已发布，删除要写原因（记入调整记录）；挂在上面的部门记录变成未挂。</p>
  <a-textarea v-model:value="text" :rows="3" :maxlength="500" placeholder="删除原因" />
</a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
</style>
