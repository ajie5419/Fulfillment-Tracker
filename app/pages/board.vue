<script setup lang="ts">
/**
 * 看板（技术选型 6.2）：每个工单一行红黄绿、外协在途、超期、未关闭异常、缺料（R10）、出图逾期（R11）、未齐套节点（R12，需求日前 N 天内仍未齐套）、项目经理、交期；
 * 顶部 QMS 最后同步时间（各类资源里最旧的那类），有资源同步报错时显示错误提示。
 * 红 = 有活动红色预警或超期 ≥3 天的异常；黄 = 有活动黄色预警或超期异常；否则绿。
 */
const { data, pending, refresh } = await useFetch('/api/board', {
  default: () => ({ lastSyncAt: null, syncOldest: null, syncErrors: [], syncConfigured: false, summary: { red: 0, yellow: 0, green: 0 }, rows: [] }),
})
const syncText = computed(() => {
  if (data.value.lastSyncAt) return timeText(data.value.lastSyncAt)
  return data.value.syncConfigured ? '尚未完成首次同步' : '未同步（演示数据）'
})
const syncErrorText = computed(() =>
  data.value.syncErrors.map((e: { label: string; failCount: number; lastError: string }) => `${e.label}（连续失败 ${e.failCount} 次）：${e.lastError}`).join('；'),
)

const columns = [
  { title: '', key: 'color', width: 56 },
  { title: '工单', key: 'wo', width: 260 },
  { title: '外协在途', dataIndex: 'outCount', width: 90, align: 'center' as const },
  { title: '超期', key: 'overdue', width: 120, align: 'center' as const },
  { title: '未关闭异常', key: 'issues', width: 100, align: 'center' as const },
  { title: '活动预警', key: 'alerts', width: 120 },
  { title: '未签收发放', key: 'releases', width: 100, align: 'center' as const },
  { title: '缺料', key: 'shortage', width: 70, align: 'center' as const },
  { title: '出图逾期', key: 'drawingOverdue', width: 90, align: 'center' as const },
  { title: '未齐套节点', key: 'incompleteNodes', width: 100, align: 'center' as const },
  { title: '项目经理', key: 'pm', width: 110 },
  { title: '交期', key: 'delivery', width: 110 },
  { title: '预计交期', key: 'expectedDelivery', width: 110 },
  { title: '拖期天数', key: 'delayDays', width: 90, align: 'center' as const },
]
</script>

<template>
  <a-card title="工单看板">
    <template #extra>
      <a-space>
        <span class="muted sync-time" :title="data.syncOldest ? `最旧的是：${data.syncOldest}` : undefined">QMS 最后同步：{{ syncText }}</span>
        <a-button size="small" @click="refresh()">刷新</a-button>
      </a-space>
    </template>
    <a-alert v-if="data.syncErrors.length" type="error" show-icon class="sync-error" message="QMS 同步出错，看板数据可能不是最新" :description="syncErrorText" />
    <a-space size="large" class="summary">
      <span><span class="dot" :style="{ background: BOARD_COLOR.RED }" />红 {{ data.summary.red }}</span>
      <span><span class="dot" :style="{ background: BOARD_COLOR.YELLOW }" />黄 {{ data.summary.yellow }}</span>
      <span><span class="dot" :style="{ background: BOARD_COLOR.GREEN }" />绿 {{ data.summary.green }}</span>
      <span class="muted">红 = 有红色预警或超期 ≥3 天的异常；黄 = 有黄色预警或超期异常</span>
    </a-space>
    <a-table :columns="columns" :data-source="data.rows" :loading="pending" row-key="workOrderNumber" size="middle" :pagination="false">
      <template #emptyText><a-empty description="没有可见的工单" /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'color'">
          <span class="light" :class="`c-${record.color}`" :style="{ background: BOARD_COLOR[record.color as keyof typeof BOARD_COLOR] }" :title="BOARD_TEXT[record.color as keyof typeof BOARD_TEXT]">{{ BOARD_TEXT[record.color as keyof typeof BOARD_TEXT] }}</span>
        </template>
        <template v-else-if="column.key === 'wo'">
          <NuxtLink :to="`/parts?wo=${encodeURIComponent(record.workOrderNumber)}`">{{ record.workOrderNumber }}</NuxtLink>
          <div class="muted">{{ record.projectName ?? record.customerName }}</div>
        </template>
        <template v-else-if="column.key === 'overdue'">
          <span :class="{ warn: record.overdueCount > 0 }">{{ record.overdueCount }}</span>
          <div v-if="record.overdueCount" class="muted">在途 {{ record.overdueSteps }} · 异常 {{ record.overdueIssues }}</div>
        </template>
        <template v-else-if="column.key === 'issues'">
          <NuxtLink v-if="record.openIssues" :to="`/issues?wo=${encodeURIComponent(record.workOrderNumber)}&dept=0`">{{ record.openIssues }}</NuxtLink>
          <span v-else>0</span>
        </template>
        <template v-else-if="column.key === 'alerts'">
          <NuxtLink v-if="record.redAlerts || record.yellowAlerts" :to="`/alerts?wo=${encodeURIComponent(record.workOrderNumber)}`">
            <a-tag v-if="record.redAlerts" color="red">红 {{ record.redAlerts }}</a-tag>
            <a-tag v-if="record.yellowAlerts" color="orange">黄 {{ record.yellowAlerts }}</a-tag>
          </NuxtLink>
          <span v-else class="muted">—</span>
        </template>
        <template v-else-if="column.key === 'releases'">
          <NuxtLink v-if="record.unsignedReleases" :to="`/releases?wo=${encodeURIComponent(record.workOrderNumber)}&progress=PENDING`">{{ record.unsignedReleases }}</NuxtLink>
          <span v-else class="muted">0</span>
        </template>
        <template v-else-if="column.key === 'shortage'">
          <NuxtLink v-if="record.shortage" class="warn" :to="`/purchases?wo=${encodeURIComponent(record.workOrderNumber)}&view=shortage`">{{ record.shortage }}</NuxtLink>
          <span v-else class="muted">0</span>
        </template>
        <template v-else-if="column.key === 'drawingOverdue'">
          <NuxtLink v-if="record.drawingOverdue" class="warn" :to="`/drawings?wo=${encodeURIComponent(record.workOrderNumber)}&view=overdue`">{{ record.drawingOverdue }}</NuxtLink>
          <span v-else class="muted">0</span>
        </template>
        <template v-else-if="column.key === 'incompleteNodes'">
          <NuxtLink v-if="record.incompleteNodes" class="warn" title="需求日前 N 天内（含已过）仍未齐套的装配节点" :to="`/kitting?wo=${encodeURIComponent(record.workOrderNumber)}&incomplete=1`">{{ record.incompleteNodes }}</NuxtLink>
          <span v-else class="muted">0</span>
        </template>
        <template v-else-if="column.key === 'pm'">{{ record.projectManagerName ?? '—' }}</template>
        <template v-else-if="column.key === 'delivery'">{{ dayText(record.deliveryDate) }}</template>
        <template v-else-if="column.key === 'expectedDelivery'">
          <NuxtLink v-if="record.expectedDelivery" :to="`/plan?wo=${encodeURIComponent(record.workOrderNumber)}`" :class="{ late: (record.delayDays ?? 0) > 0 }" title="按总计划推算（已发布的总计划）">{{ record.expectedDelivery }}</NuxtLink>
          <span v-else class="muted" title="还没有发布总计划">—</span>
        </template>
        <template v-else-if="column.key === 'delayDays'">
          <a-tag v-if="(record.delayDays ?? 0) > 0" color="red" :title="`${record.delayedPlanNodes} 个总计划节点延误`">{{ record.delayDays }} 天</a-tag>
          <span v-else-if="record.delayDays != null" class="muted">0</span>
          <span v-else class="muted">—</span>
        </template>
      </template>
    </a-table>
  </a-card>
</template>

<style scoped>
.sync-error { margin-bottom: 12px; }
.muted { color: #999; font-size: 12px; }
.summary { margin-bottom: 12px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.light { display: inline-block; width: 28px; height: 28px; line-height: 28px; border-radius: 50%; color: #fff; text-align: center; font-weight: 600; }
.warn { color: #cf1322; font-weight: 600; }
.late { color: #cf1322; font-weight: 600; }
</style>
