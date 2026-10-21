<script setup lang="ts">
/**
 * 领导总览（权限方案 R13 第四节）：一屏看全局，仅领导、项目部负责人、管理员（接口另有 403）。
 * 数据和看板同源，不另立统计口径。"本周" = 北京时间本周一 00:00 起。
 * 版式按 docs/前端设计规范.md：指标卡一排、柱状图 / 环形图、卡片里浅灰区域放列表；只换展示层，接口和数据不变。
 */
const { data: me } = await useMe()
const { data, pending, refresh, error } = await useFetch('/api/overview', { key: 'overview', immediate: !!me.value?.can.overview })

const total = computed(() => (data.value ? data.value.summary.red + data.value.summary.yellow + data.value.summary.green : 0))
/** 占全部工单（红 + 黄 + 绿）的比例，只是把已有的三个数换算一下，不另取数据 */
function pct(n: number): string {
  if (!total.value) return '0%'
  const p = (n / total.value) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

const kpis = computed(() => {
  const s = data.value?.summary
  if (!s) return []
  return [
    { key: 'red', label: '红色工单', value: s.red, desc: `占 ${pct(s.red)}`, tone: 'late', to: '/board' },
    { key: 'yellow', label: '黄色工单', value: s.yellow, desc: `占 ${pct(s.yellow)}`, tone: 'risk', to: '/board' },
    { key: 'green', label: '绿色工单', value: s.green, desc: `占 ${pct(s.green)}`, tone: 'done', to: '/board' },
    { key: 'new', label: '本周新增异常', value: s.newIssues, desc: '本周一起', tone: 'primary', to: undefined },
    { key: 'closed', label: '本周关闭异常', value: s.closedIssues, desc: '本周一起', tone: 'done', to: undefined },
    { key: 'overdue', label: '超期异常', value: s.overdueIssues, desc: s.overdueIssues ? '需尽快处理' : '没有超期', tone: s.overdueIssues ? 'late' : 'none', to: '/issues?overdue=1&dept=0' },
  ] as const
})
const stageBars = computed(() => data.value?.stages.map((s) => ({ key: s.key, label: s.label, value: s.count, to: s.link })) ?? [])
const statusSegments = computed(() => {
  const s = data.value?.summary
  if (!s) return []
  return [
    { key: 'red', label: '红色', value: s.red, tone: 'late', to: '/board' },
    { key: 'yellow', label: '黄色', value: s.yellow, tone: 'risk', to: '/board' },
    { key: 'green', label: '绿色', value: s.green, tone: 'done', to: '/board' },
  ] as const
})
</script>

<template>
  <a-result v-if="!me?.can.overview" status="403" title="没有权限" sub-title="领导总览仅领导、项目部负责人和管理员可以查看" />
  <div v-else class="ft-page">
    <header class="page-head">
      <!-- 页面名称已在页头（框架）显示，这里只留统计口径说明 -->
      <div v-if="data" class="page-sub">本周从 {{ dayText(data.weekStart) }}（周一）起，数据与看板同源</div>
      <UiRefreshButton @click="refresh()" />
    </header>
    <a-alert v-if="error" type="error" show-icon :message="apiError(error)" />
    <a-spin :spinning="pending">
      <div v-if="data" class="ft-page">
        <div class="kpis">
          <UiStatCard v-for="k in kpis" :key="k.key" :label="k.label" :value="k.value" :unit="k.desc" :tone="k.tone" :to="k.to" icon="dot" />
        </div>

        <!-- 左宽右窄两列各自往下排，两边卡片高度不同也不会留空 -->
        <div class="cols">
          <div class="col">
            <UiSectionCard title="卡在哪个环节" sub="按全部工单汇总，点柱子看清单">
              <UiColumnChart :items="stageBars" highlight="late" />
            </UiSectionCard>

            <UiSectionCard :title="`红色工单（${data.redWorkOrders.length}）`">
              <div class="ft-well list">
                <UiListItem v-for="w in data.redWorkOrders" :key="w.workOrderNumber" tone="late">
                  <template #title><WoLink :no="w.workOrderNumber" /><span class="sub">{{ w.projectName }}</span></template>
                  <template #desc>{{ w.reason }}</template>
                  <template #meta>项目经理 {{ w.projectManagerName ?? '—' }} · 交期 {{ dayText(w.deliveryDate) }}</template>
                </UiListItem>
                <a-empty v-if="!data.redWorkOrders.length" description="没有红色工单" />
              </div>
            </UiSectionCard>

            <UiSectionCard :title="`预计拖期工单（${data.planDelays.length}）`" sub="按已发布的总计划推算">
              <div class="ft-well list">
                <UiListItem v-for="w in data.planDelays" :key="w.workOrderNumber" tone="late">
                  <template #title><WoLink :no="w.workOrderNumber" /><span class="sub">{{ w.projectName }}</span></template>
                  <template #desc>最早源头延误：{{ w.cause ?? '—' }}</template>
                  <template #meta>合同交期 {{ dayText(w.deliveryDate) }} · 预计 {{ w.expectedDelivery }} · 源头延误节点 {{ w.delayedNodes }} · 项目经理 {{ w.projectManagerName ?? '—' }}</template>
                  <template #extra><UiStatusTag tone="late">拖期 {{ w.delayDays }} 天</UiStatusTag></template>
                </UiListItem>
                <a-empty v-if="!data.planDelays.length" description="按已发布的总计划推算，没有预计拖期的工单" />
              </div>
            </UiSectionCard>
          </div>

          <div class="col">
            <UiSectionCard title="工单状态分布" sub="点右侧进项目总览">
              <UiDonut :segments="statusSegments" caption="全部工单" />
            </UiSectionCard>

            <UiSectionCard title="按责任部门" sub="未关闭异常">
              <div class="ft-well list">
                <UiListItem v-for="d in data.byDept" :key="d.dept" :tone="d.overdue > 0 ? 'late' : 'none'" compact>
                  <template #title>{{ d.dept }}</template>
                  <template #meta>未关闭 {{ d.open }}</template>
                  <template #extra>
                    <UiStatusTag v-if="d.overdue > 0" tone="late">超期 {{ d.overdue }}</UiStatusTag>
                    <span v-else>无超期</span>
                  </template>
                </UiListItem>
                <a-empty v-if="!data.byDept.length" description="没有未关闭的异常" />
              </div>
            </UiSectionCard>

            <UiSectionCard title="总计划：按部门" sub="未完成节点与源头延误">
              <div class="ft-well list">
                <UiListItem v-for="d in data.planByDept" :key="d.dept" :tone="d.delayed > 0 ? 'late' : 'none'" compact>
                  <template #title>{{ d.deptText }}</template>
                  <template #meta>未完成节点 {{ d.open }}</template>
                  <template #extra>
                    <UiStatusTag v-if="d.delayed > 0" tone="late">源头延误 {{ d.delayed }}</UiStatusTag>
                    <span v-else>无延误</span>
                  </template>
                </UiListItem>
                <a-empty v-if="!data.planByDept.length" description="没有已发布总计划的未完成节点" />
              </div>
            </UiSectionCard>
          </div>
        </div>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-sub { font-size: 13px; line-height: 32px; color: var(--ft-text-2); }
.sub { font-size: 12px; font-weight: normal; color: var(--ft-text-2); }
.kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.cols { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
.col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@media (max-width: 1279px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 991px) { .cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 575px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
