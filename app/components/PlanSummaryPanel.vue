<script setup lang="ts">
import type { PlanData } from '../composables/usePlanData'

/** 总计划顶部概览（项目 / 状态 / 交期 / 拖期 / 延误节点）与草稿、无后续节点的提示（PlanEditor 拆分，只读展示）。 */
defineProps<{ data: PlanData; published: boolean }>()
</script>

<template>
  <a-descriptions :column="{ xs: 1, sm: 2, lg: 4 }" size="small" bordered class="summary">
    <a-descriptions-item label="项目">{{ data.workOrder.projectName ?? '—' }}<span class="muted">　{{ data.workOrder.customerName }}</span></a-descriptions-item>
    <a-descriptions-item label="项目经理">{{ data.workOrder.projectManagerName ?? '未设置' }}</a-descriptions-item>
    <a-descriptions-item label="状态">
      <a-tag v-if="!data.plan || !data.nodes.length" color="default">未编制</a-tag>
      <a-tag v-else-if="published" color="green">已发布</a-tag>
      <a-tag v-else color="blue">草稿</a-tag>
      <span v-if="data.plan?.templateName" class="muted">模板：{{ data.plan.templateName }}</span>
      <div v-if="published" class="muted">{{ data.plan?.publishedByName }} {{ timeText(data.plan!.publishedAt!) }} 发布</div>
    </a-descriptions-item>
    <a-descriptions-item label="未挂节点的部门记录">
      <span v-if="!data.unlinked.total" class="muted">0</span>
      <span v-else :class="{ warn: published }" :title="`设计 ${data.unlinked.drawing}，采购 ${data.unlinked.purchase}，工序 ${data.unlinked.step}，装配 ${data.unlinked.assembly}`">
        {{ data.unlinked.total }} 条（设计 {{ data.unlinked.drawing }} / 采购 {{ data.unlinked.purchase }} / 工序 {{ data.unlinked.step }} / 装配 {{ data.unlinked.assembly }}）
      </span>
    </a-descriptions-item>
    <a-descriptions-item label="合同交期">{{ data.workOrder.deliveryDate ?? '—' }}</a-descriptions-item>
    <a-descriptions-item label="预计交期">
      <span :class="{ late: (data.deliveryDelayDays ?? 0) > 0 }">{{ data.expectedDelivery ?? '—' }}</span>
    </a-descriptions-item>
    <a-descriptions-item label="拖期天数">
      <a-tag v-if="(data.deliveryDelayDays ?? 0) > 0" color="red">拖期 {{ data.deliveryDelayDays }} 天</a-tag>
      <a-tag v-if="data.planAlertLevel" color="red" title="W9 交期风险：已通知项目经理、项目部负责人、分管领导">W9 交期风险</a-tag>
      <span v-if="data.deliveryDelayDays != null && data.deliveryDelayDays <= 0" class="ok">不拖期</span>
      <span v-else-if="data.deliveryDelayDays == null" class="muted">—</span>
    </a-descriptions-item>
    <a-descriptions-item label="延误节点">
      <a-tag v-if="data.sourceNodes" color="orange" title="源头延误节点：自身就已延误（W9 只报这些）">源头 {{ data.sourceNodes }} 个</a-tag>
      <span v-if="data.delayedNodes > data.sourceNodes" class="muted">另 {{ data.delayedNodes - data.sourceNodes }} 个受上游影响</span>
      <span v-if="!data.delayedNodes" class="muted">0</span>
    </a-descriptions-item>
  </a-descriptions>

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
.muted { color: var(--ft-text-2); font-size: 12px; }
.late { color: var(--ft-late); }
.warn { color: var(--ft-upstream); }
.ok { color: var(--ft-done-text); }
.summary { margin-bottom: 12px; }
.tip { margin-bottom: 12px; }
</style>
