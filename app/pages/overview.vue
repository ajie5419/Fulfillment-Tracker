<script setup lang="ts">
/**
 * 领导总览（权限方案 R13 第四节）：一屏看全局，仅领导、项目部负责人、管理员（接口另有 403）。
 * 数据和看板同源，不另立统计口径。"本周" = 北京时间本周一 00:00 起。
 */
const { data: me } = await useMe()
const { data, pending, refresh, error } = await useFetch('/api/overview', { key: 'overview', immediate: !!me.value?.can.overview })

const deptColumns = [
  { title: '责任部门', dataIndex: 'dept' },
  { title: '未关闭异常', dataIndex: 'open', width: 110, align: 'center' as const },
  { title: '其中超期', key: 'overdue', width: 100, align: 'center' as const },
]
const redColumns = [
  { title: '工单', key: 'wo', width: 220 },
  { title: '项目经理', key: 'pm', width: 110 },
  { title: '交期', key: 'delivery', width: 110 },
  { title: '主要原因', dataIndex: 'reason' },
]
// R14 总计划
const planDelayColumns = [
  { title: '工单', key: 'wo', width: 220 },
  { title: '项目经理', key: 'pm', width: 110 },
  { title: '合同交期', key: 'delivery', width: 110 },
  { title: '预计交期', dataIndex: 'expectedDelivery', width: 110 },
  { title: '拖期', key: 'delay', width: 80, align: 'center' as const },
  { title: '源头延误节点', key: 'sources', width: 90, align: 'center' as const },
  { title: '最早源头延误节点', dataIndex: 'cause' },
]
const planDeptColumns = [
  { title: '责任部门', dataIndex: 'deptText' },
  { title: '未完成节点', dataIndex: 'open', width: 110, align: 'center' as const },
  { title: '源头延误', key: 'delayed', width: 100, align: 'center' as const },
]
</script>

<template>
  <a-result v-if="!me?.can.overview" status="403" title="没有权限" sub-title="领导总览仅领导、项目部负责人和管理员可以查看" />
  <a-card v-else title="领导总览">
    <template #extra>
      <a-space>
        <span v-if="data" class="muted">本周从 {{ dayText(data.weekStart) }}（周一）起</span>
        <a-button size="small" @click="refresh()">刷新</a-button>
      </a-space>
    </template>
    <a-alert v-if="error" type="error" show-icon :message="apiError(error)" class="block" />
    <a-spin :spinning="pending">
      <template v-if="data">
        <a-row :gutter="[12, 12]" class="block">
          <a-col :xs="12" :sm="8" :lg="4">
            <NuxtLink to="/board"><a-statistic title="红色工单" :value="data.summary.red" :value-style="{ color: BOARD_COLOR.RED }" /></NuxtLink>
          </a-col>
          <a-col :xs="12" :sm="8" :lg="4">
            <NuxtLink to="/board"><a-statistic title="黄色工单" :value="data.summary.yellow" :value-style="{ color: BOARD_COLOR.YELLOW }" /></NuxtLink>
          </a-col>
          <a-col :xs="12" :sm="8" :lg="4">
            <NuxtLink to="/board"><a-statistic title="绿色工单" :value="data.summary.green" :value-style="{ color: BOARD_COLOR.GREEN }" /></NuxtLink>
          </a-col>
          <a-col :xs="12" :sm="8" :lg="4"><a-statistic title="本周新增异常" :value="data.summary.newIssues" /></a-col>
          <a-col :xs="12" :sm="8" :lg="4"><a-statistic title="本周关闭异常" :value="data.summary.closedIssues" /></a-col>
          <a-col :xs="12" :sm="8" :lg="4">
            <NuxtLink to="/issues?overdue=1&dept=0"><a-statistic title="超期异常" :value="data.summary.overdueIssues" :value-style="data.summary.overdueIssues ? { color: BOARD_COLOR.RED } : undefined" /></NuxtLink>
          </a-col>
        </a-row>

        <h3>卡在哪个环节</h3>
        <a-row :gutter="[12, 12]" class="block">
          <a-col v-for="s in data.stages" :key="s.key" :xs="12" :sm="8" :lg="4">
            <NuxtLink :to="s.link">
              <a-card size="small" hoverable>
                <a-statistic :title="s.label" :value="s.count" :value-style="s.count ? { color: BOARD_COLOR.RED } : undefined" />
              </a-card>
            </NuxtLink>
          </a-col>
        </a-row>

        <a-row :gutter="24">
          <a-col :xs="24" :lg="9">
            <h3>按责任部门</h3>
            <a-table :columns="deptColumns" :data-source="data.byDept" row-key="dept" size="small" :pagination="false" class="block">
              <template #emptyText><a-empty description="没有未关闭的异常" /></template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'overdue'">
                  <span :class="{ warn: record.overdue > 0 }">{{ record.overdue }}</span>
                </template>
              </template>
            </a-table>
          </a-col>
          <a-col :xs="24" :lg="15">
            <h3>红色工单（{{ data.redWorkOrders.length }}）</h3>
            <a-table :columns="redColumns" :data-source="data.redWorkOrders" row-key="workOrderNumber" size="small" :pagination="false" class="block">
              <template #emptyText><a-empty description="没有红色工单" /></template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'wo'">
                  <NuxtLink :to="`/alerts?wo=${encodeURIComponent(record.workOrderNumber)}`">{{ record.workOrderNumber }}</NuxtLink>
                  <div class="muted">{{ record.projectName }}</div>
                </template>
                <template v-else-if="column.key === 'pm'">{{ record.projectManagerName ?? '—' }}</template>
                <template v-else-if="column.key === 'delivery'">{{ dayText(record.deliveryDate) }}</template>
              </template>
            </a-table>
          </a-col>
        </a-row>

        <a-row :gutter="24">
          <a-col :xs="24" :lg="9">
            <h3>总计划：按部门源头延误节点数</h3>
            <a-table :columns="planDeptColumns" :data-source="data.planByDept" row-key="dept" size="small" :pagination="false" class="block">
              <template #emptyText><a-empty description="没有已发布总计划的未完成节点" /></template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'delayed'">
                  <span :class="{ warn: record.delayed > 0 }">{{ record.delayed }}</span>
                </template>
              </template>
            </a-table>
          </a-col>
          <a-col :xs="24" :lg="15">
            <h3>预计拖期工单（{{ data.planDelays.length }}）</h3>
            <a-table :columns="planDelayColumns" :data-source="data.planDelays" row-key="workOrderNumber" size="small" :pagination="false" class="block">
              <template #emptyText><a-empty description="按已发布的总计划推算，没有预计拖期的工单" /></template>
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'wo'">
                  <NuxtLink :to="`/plan?wo=${encodeURIComponent(record.workOrderNumber)}`">{{ record.workOrderNumber }}</NuxtLink>
                  <div class="muted">{{ record.projectName }}</div>
                </template>
                <template v-else-if="column.key === 'pm'">{{ record.projectManagerName ?? '—' }}</template>
                <template v-else-if="column.key === 'delivery'">{{ dayText(record.deliveryDate) }}</template>
                <template v-else-if="column.key === 'delay'"><span class="warn">{{ record.delayDays }} 天</span></template>
                <template v-else-if="column.key === 'sources'">{{ record.delayedNodes }}</template>
              </template>
            </a-table>
          </a-col>
        </a-row>
      </template>
    </a-spin>
  </a-card>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.muted { color: #999; font-size: 12px; }
.warn { color: #cf1322; font-weight: 600; }
h3 { font-size: 15px; margin: 8px 0; }
</style>
