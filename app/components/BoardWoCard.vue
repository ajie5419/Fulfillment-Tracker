<script setup lang="ts">
/**
 * 项目总览的一张工单卡（前端改版第一轮）：整张卡点进工单详情 /wo/:no。
 *   工单号 · 产品；项目经理 · 交期；右上角拖期天数（或"按期""节点 x/y"）；
 *   总计划节点圆点；底部复用工单状态胶囊，最多四枚（含 +N）。
 * 未建总计划的工单（group = NO_PLAN）保留生成入口及业务状态胶囊。
 * 已完工 / 已取消的工单（row.closed，只在"显示已完工"打开时出现）只显示工单、交期和 QMS 状态，不显示预警、拖期。
 */
import { type BoardGroup, type NodeState, woStatusText } from '#shared/status'
import type { WoStatusFields } from '#shared/wo-status-capsules'

const props = defineProps<{
  group: BoardGroup
  row: WoStatusFields & {
    workOrderNumber: string
    projectName: string | null
    customerName: string
    status?: string
    closed?: boolean
    deliveryDate: string | Date
    projectManagerName: string | null
    delayDays: number | null
    redAlerts: number
    yellowAlerts: number
    openIssues: number
    overdueIssues: number
    shortage: number
    kitPercent: number | null
    planNodes: { id: string; seq: number; name: string; deptText: string; state: NodeState; planDate: string; expectedDate: string }[]
    stuck: { id: string; name: string; deptText: string; days: number } | null
  }
}>()
const r = computed(() => props.row)
const to = computed(() => `/wo/${encodeURIComponent(r.value.workOrderNumber)}`)
const done = computed(() => r.value.planNodes.filter((n) => n.state === 'DONE').length)
const right = computed(() => {
  if ((r.value.delayDays ?? 0) > 0) return { text: `晚 ${r.value.delayDays} 天`, cls: 'ft-text-late' }
  if (props.group === 'OK' || props.group === 'RISK') return { text: `节点 ${done.value}/${r.value.planNodes.length}`, cls: 'ft-muted' }
  return null
})
const product = computed(() => r.value.projectName ?? r.value.customerName)
</script>

<template>
  <NuxtLink v-if="r.closed" :to="to" class="card closed">
    <div class="top">
      <span class="title">{{ r.workOrderNumber }}<template v-if="product"> · {{ product }}</template></span>
      <UiStatusTag tone="none">{{ woStatusText(r.status) }}</UiStatusTag>
    </div>
    <div class="sub">{{ r.projectManagerName ?? '未设置项目经理' }} · 交期 {{ dayText(r.deliveryDate) }}</div>
  </NuxtLink>
  <div v-else-if="group === 'NO_PLAN'" class="card noplan">
    <div class="top">
      <span class="title"><WoLink :no="r.workOrderNumber" /><template v-if="product"> · {{ product }}</template></span>
    </div>
    <div class="sub">{{ r.projectManagerName ?? '未设置项目经理' }} · 交期 {{ dayText(r.deliveryDate) }}</div>
    <div class="sub"><NuxtLink :to="{ path: '/plan', query: { wo: r.workOrderNumber } }">生成总计划</NuxtLink></div>
    <WoStatusCapsules :row="r" :to="to" class="statuses" />
  </div>
  <NuxtLink v-else :to="to" class="card" :class="`g-${group}`">
    <div class="top">
      <span class="title">{{ r.workOrderNumber }}<template v-if="product"> · {{ product }}</template></span>
      <span v-if="right" class="right" :class="right.cls">{{ right.text }}</span>
    </div>
    <div class="sub">{{ r.projectManagerName ?? '未设置项目经理' }} · 交期 {{ dayText(r.deliveryDate) }}</div>
    <NodeDots v-if="r.planNodes.length" :nodes="r.planNodes" :stuck-id="r.stuck?.id" />
    <WoStatusCapsules :row="r" :to="to" embedded class="statuses" />
  </NuxtLink>
</template>

<style scoped>
.card { display: block; position: relative; padding: 14px 16px 12px; border: 1px solid var(--ft-border); background: var(--ft-card-bg); border-radius: 12px; box-shadow: var(--ft-card-shadow); color: var(--ft-text); min-width: 0; overflow: hidden; transition: border-color 0.15s, background-color 0.15s; }
/* 设计改版：去掉左侧色条（用户意见）；卡片已按状态分组（组标题带图标），卡内有拖期天数和预警标签 */
a.card:hover { color: var(--ft-text); border-color: var(--ft-text-3); background: var(--ft-fill); }
a.card:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 2px; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.title { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.right { flex: none; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.right.ft-muted { font-weight: normal; font-size: 12px; }
.sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
.statuses { margin-top: 10px; }
</style>
