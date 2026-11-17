<script setup lang="ts">
import type { PlanData } from '../composables/usePlanData'
import { PLAN_STATUS_TEXT, planDisplayState } from '#shared/plan'

/** 总计划顶部概览（项目 / 状态 / 交期 / 拖期 / 延误节点）与草稿、无后续节点的提示（PlanEditor 拆分，只读展示）。 */
const props = defineProps<{ data: PlanData; published: boolean }>()
const displayState = computed(() => planDisplayState(props.data.plan?.status, props.data.nodes.length))
const pastDraftDates = computed(() => !props.published && props.data.nodes.some(n => (n.startDate ?? n.planDate) < dayAfter(0)))
const statusTone = computed(() => (displayState.value === 'NONE' ? 'none' : displayState.value === 'PUBLISHED' ? 'done' : 'primary'))
</script>

<template>
  <PlanDateConflicts :conflicts="data.dateConflicts" />

  <div class="plan-meta-strip">
    <div class="meta-item">
      <span class="meta-label">项目 / 客户</span>
      <span class="meta-val">{{ data.workOrder.projectName ?? '—' }} <span class="muted">{{ data.workOrder.customerName }}</span></span>
    </div>
    <div class="meta-item">
      <span class="meta-label">工单号</span>
      <span class="meta-val strong">{{ data.workOrder.workOrderNumber }}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">计划状态</span>
      <span class="meta-val">
        <UiStatusTag :tone="statusTone">{{ PLAN_STATUS_TEXT[displayState] }}</UiStatusTag>
        <span v-if="data.plan?.templateName" class="muted">模板：{{ data.plan.templateName }}</span>
        <span v-if="published" class="muted">{{ data.plan?.publishedByName }} {{ timeText(data.plan?.publishedAt) }} 发布</span>
      </span>
    </div>
    <div class="meta-item">
      <span class="meta-label">合同生效 / 交期</span>
      <span class="meta-val">{{ data.workOrder.effectiveTime ?? '—' }} / <b>{{ data.workOrder.deliveryDate ?? '—' }}</b></span>
    </div>
    <div class="meta-item">
      <span class="meta-label">预计交期</span>
      <span class="meta-val" :class="{ late: (data.deliveryDelayDays ?? 0) > 0 }">{{ data.expectedDelivery ?? '—' }}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">拖期结论</span>
      <span class="meta-val">
        <UiStatusTag v-if="(data.deliveryDelayDays ?? 0) > 0" tone="late">拖期 {{ data.deliveryDelayDays }} 天</UiStatusTag>
        <UiStatusTag v-if="data.planAlertLevel" tone="late" title="W9 交期风险：已通知项目经理、项目部负责人、分管领导">W9 交期风险</UiStatusTag>
        <span v-if="data.deliveryDelayDays != null && data.deliveryDelayDays <= 0" class="ok">不拖期</span>
        <span v-else-if="data.deliveryDelayDays == null" class="muted">—</span>
      </span>
    </div>
    <div class="meta-item">
      <span class="meta-label">延误节点</span>
      <span class="meta-val">
        <UiStatusTag v-if="data.sourceNodes" tone="upstream" title="源头延误节点：自身就已延误（W9 只报这些）">源头 {{ data.sourceNodes }} 个</UiStatusTag>
        <span v-if="data.delayedNodes > data.sourceNodes" class="muted">另 {{ data.delayedNodes - data.sourceNodes }} 个受上游影响</span>
        <span v-if="!data.delayedNodes" class="muted">0</span>
      </span>
    </div>
  </div>

  <a-alert
    v-if="pastDraftDates"
    type="info"
    show-icon
    class="tip"
    message="部分计划日期早于今天，请在发布前核对。草稿尚未下发，不计执行延期。"
  />
  <a-alert
    v-if="!published && data.nodes.length"
    type="info"
    show-icon
    class="tip"
    message="草稿：调整好后点“发布”。发布前改日期不用写原因，部门记录也可以先挂上来。"
  />
  <a-alert
    v-if="data.dangling.length"
    type="warning"
    show-icon
    class="tip"
    :message="`${data.dangling.map((n) => `${n.code} ${n.name}`).join('、')} 后面没有节点接着：它们晚了不会推迟预计交期。如果交付要等它们，请把它们加进后续节点的“前置节点”。`"
  />
</template>

<style scoped>
.plan-meta-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 24px;
  padding: 10px 14px;
  margin-bottom: 14px;
  background: var(--ft-tray-bg);
  border: 1px solid var(--ft-border);
  border-radius: var(--card-radius-inner);
  font-variant-numeric: tabular-nums;
}
.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.meta-label {
  font-size: 11px;
  color: var(--ft-text-3);
  line-height: 1.3;
}
.meta-val {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
  color: var(--ft-text);
  line-height: 1.4;
}
.strong { font-weight: 600; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.late { color: var(--ft-late-text); font-weight: 600; }
.ok { color: var(--ft-done-text); font-weight: 600; }
.tip { margin-bottom: 12px; }
</style>
