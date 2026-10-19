<script setup lang="ts">
/**
 * 项目总览卡片上的总计划节点圆点（前端改版第一轮）：
 *   已完成 实心绿、源头延误 实心红、受上游影响 橙色空心、按计划（未完成） 灰色空心；形状 + 悬停文字区分，不只靠颜色。
 *   节点多时只显示头尾，中间用"…"（卡点一定显示）；名称取前几个字，悬停 title 显示完整名称、计划日、预计日。
 */
import { NODE_STATE_TEXT, type NodeState, compactIndexes, shortName } from '#shared/status'

const props = defineProps<{
  nodes: { id: string; seq: number; name: string; deptText: string; state: NodeState; planDate: string; expectedDate: string }[]
  stuckId?: string | null
  max?: number
}>()
const cells = computed(() => {
  const keep = props.stuckId ? props.nodes.findIndex((n) => n.id === props.stuckId) : -1
  return compactIndexes(props.nodes.length, props.max ?? 7, keep >= 0 ? keep : null).map((i) => (i === null ? null : props.nodes[i]!))
})
const tip = (n: (typeof props.nodes)[number]) =>
  `${n.seq}. ${n.name}（${n.deptText}）\n计划 ${n.planDate} · ${n.state === 'DONE' ? '完成' : '预计'} ${n.expectedDate}\n${NODE_STATE_TEXT[n.state]}`
</script>

<template>
  <div class="dots" :style="{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }" role="list" aria-label="总计划节点">
    <div v-for="(n, i) in cells" :key="n ? n.id : `gap-${i}`" class="cell" :class="[n ? `s-${n.state}` : 'gap', { first: i === 0 }]" role="listitem" :title="n ? tip(n) : '中间还有节点'" :aria-label="n ? `${n.name}：${NODE_STATE_TEXT[n.state]}` : '省略'">
      <span class="line" />
      <span v-if="n" class="dot" />
      <span v-else class="ellipsis">…</span>
      <span class="name">{{ n ? shortName(n.name) : '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.dots { display: grid; margin: 12px 0 4px; }
.cell { position: relative; display: flex; flex-direction: column; align-items: center; min-width: 0; }
.line { position: absolute; top: 6px; right: 50%; width: 100%; height: 2px; background: #d7dce4; }
.first .line { display: none; }
.s-DONE .line { background: var(--ft-done); }
.s-SOURCE .line { background: var(--ft-late); }
.dot { position: relative; z-index: 1; width: 14px; height: 14px; border-radius: 50%; box-sizing: border-box; background: #fff; border: 2px solid var(--ft-none); }
.s-DONE .dot { background: var(--ft-done); border-color: var(--ft-done); }
.s-SOURCE .dot { background: var(--ft-late); border-color: var(--ft-late); }
.s-UPSTREAM .dot { border-color: var(--ft-upstream); }
.ellipsis { position: relative; z-index: 1; height: 14px; line-height: 10px; padding: 0 2px; background: #fff; color: var(--ft-text-3); font-size: 12px; }
.name { margin-top: 4px; max-width: 100%; font-size: 11px; color: var(--ft-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-SOURCE .name { color: var(--ft-late); }
</style>
