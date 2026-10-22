<script setup lang="ts">
/**
 * 项目总览的一张工单卡（前端改版第一轮）：整张卡点进工单详情 /wo/:no。
 *   工单号 · 产品；项目经理 · 交期；右上角拖期天数（或"按期""节点 x/y"）；
 *   总计划节点圆点；"卡在：节点名（部门）"= 最早的源头延误节点；底部小标签：红 / 黄预警、异常、缺件、齐套率。
 * 未建总计划的工单（group = NO_PLAN）只显示一行"还没建总计划 · 去生成"。
 */
import type { BoardGroup, NodeState } from '#shared/status'

const props = defineProps<{
  group: BoardGroup
  row: {
    workOrderNumber: string
    projectName: string | null
    customerName: string
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
  <div v-if="group === 'NO_PLAN'" class="card noplan">
    <div class="top">
      <span class="title"><WoLink :no="r.workOrderNumber" /><template v-if="product"> · {{ product }}</template></span>
    </div>
    <div class="sub">{{ r.projectManagerName ?? '未设置项目经理' }} · 交期 {{ dayText(r.deliveryDate) }}</div>
    <div class="sub">还没建总计划 · <NuxtLink :to="`/wo/${encodeURIComponent(r.workOrderNumber)}?tab=plan`">去生成</NuxtLink></div>
  </div>
  <NuxtLink v-else :to="to" class="card" :class="`g-${group}`">
    <div class="top">
      <span class="title">{{ r.workOrderNumber }}<template v-if="product"> · {{ product }}</template></span>
      <span v-if="right" class="right" :class="right.cls">{{ right.text }}</span>
    </div>
    <div class="sub">{{ r.projectManagerName ?? '未设置项目经理' }} · 交期 {{ dayText(r.deliveryDate) }}</div>
    <NodeDots v-if="r.planNodes.length" :nodes="r.planNodes" :stuck-id="r.stuck?.id" />
    <div v-if="r.stuck" class="banner late">卡在：{{ r.stuck.name }}（{{ r.stuck.deptText }}），自身晚 {{ r.stuck.days }} 天</div>
    <div class="tags">
      <span v-if="r.redAlerts" class="tag t-late"><UiStatusIcon kind="alert" :size="12" />红预警 {{ r.redAlerts }}</span>
      <span v-if="r.yellowAlerts" class="tag t-risk"><UiStatusIcon kind="warn" :size="12" />黄预警 {{ r.yellowAlerts }}</span>
      <span v-if="r.openIssues" class="tag" :class="{ 't-late': r.overdueIssues }">异常 {{ r.openIssues }}<template v-if="r.overdueIssues">（超期 {{ r.overdueIssues }}）</template></span>
      <span v-if="r.shortage" class="tag t-late">缺件 {{ r.shortage }}</span>
      <span v-if="r.kitPercent != null" class="tag" :class="r.kitPercent >= 100 ? 't-done' : ''">齐套 {{ r.kitPercent }}%</span>
    </div>
  </NuxtLink>
</template>

<style scoped>
.card { display: block; position: relative; padding: 14px 16px 12px; border: 1px solid var(--ft-border); background: var(--ft-card-bg); border-radius: 12px; box-shadow: var(--ft-card-shadow); color: var(--ft-text); min-width: 0; overflow: hidden; transition: box-shadow 0.15s; }
/* 设计改版：去掉左侧色条（用户意见）；卡片已按状态分组（组标题带图标），卡内有拖期天数和预警标签 */
a.card:hover { color: var(--ft-text); box-shadow: 0 2px 4px rgba(16, 24, 40, 0.06), 0 6px 16px rgba(16, 24, 40, 0.1); }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { flex: none; font-size: 13px; font-weight: 600; }
.right.ft-muted { font-weight: normal; font-size: 12px; }
.sub { margin-top: 2px; font-size: 12px; color: var(--ft-text-2); }
.banner { margin-top: 10px; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
.banner.late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tags:empty { display: none; }
.tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 6px; font-size: 12px; background: var(--ft-fill); color: var(--ft-text-2); }
.t-late { background: var(--ft-late-bg); color: var(--ft-late-text); }
.t-risk { background: var(--ft-risk-bg); color: var(--ft-risk-text); }
.t-done { background: var(--ft-done-bg); color: var(--ft-done-text); }
</style>
