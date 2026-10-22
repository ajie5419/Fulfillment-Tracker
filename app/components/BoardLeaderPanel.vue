<script setup lang="ts">
/**
 * 项目总览里的"全局"一块（功能重复梳理第一批，原领导总览并入项目总览）：
 * 只给领导、项目部负责人、管理员看（页面用 me.can.overview 控制是否显示，接口 /api/overview 另有 403）。
 * 只放原领导总览独有的内容：卡在哪个环节、本周新增 / 关闭异常、超期异常、未关闭异常按责任部门。
 * 红黄绿工单数、红色工单清单、预计拖期工单、总计划按部门 和项目总览的分组 / "源头延误在哪个部门"重复，不再显示。
 * 排版：两栏等高（左边柱状图撑满卡片），右边异常卡片再高，左边也不会在卡片下面留出一大块空白（zhao 10-22）。
 * 范围是全部工单，和这几类人在项目总览看到的范围一致（他们的可见范围本来就是全部）。
 */
const { data, error } = await useFetch('/api/overview', { key: 'overview' })
const stageBars = computed(() => data.value?.stages.map((s) => ({ key: s.key, label: s.label, value: s.count, to: s.link })) ?? [])
</script>

<template>
  <a-alert v-if="error" type="error" show-icon :message="apiError(error)" class="err" />
  <div v-else-if="data" class="leader">
    <UiSectionCard title="卡在哪个环节" :sub="`全部工单汇总，点柱子看清单`" class="stage-card">
      <div class="stage-chart"><UiColumnChart :items="stageBars" highlight="late" height="fill" /></div>
    </UiSectionCard>
    <UiSectionCard title="异常" :sub="`本周从 ${dayText(data.weekStart)}（周一）起`">
      <div class="kpis">
        <UiStatCard label="本周新增" :value="data.summary.newIssues" unit="条" tone="primary" icon="dot" />
        <UiStatCard label="本周关闭" :value="data.summary.closedIssues" unit="条" tone="done" icon="check" />
        <UiStatCard label="超期" :value="data.summary.overdueIssues" unit="条" :tone="data.summary.overdueIssues ? 'late' : 'none'" icon="alert" to="/risks?tab=issues&overdue=1&dept=0" />
      </div>
      <div class="ft-well list">
        <UiListItem v-for="d in data.byDept" :key="d.dept" :tone="d.overdue > 0 ? 'late' : 'none'" compact>
          <template #title>{{ d.dept }}</template>
          <template #meta>未关闭 {{ d.open }}</template>
          <template #extra>
            <UiStatusTag v-if="d.overdue > 0" tone="late">超期 {{ d.overdue }}</UiStatusTag>
            <span v-else class="ft-muted">无超期</span>
          </template>
        </UiListItem>
        <a-empty v-if="!data.byDept.length" description="没有未关闭的异常" />
      </div>
    </UiSectionCard>
  </div>
</template>

<style scoped>
.err { margin-bottom: 20px; }
.leader { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: stretch; margin-bottom: 20px; }
.stage-card { display: flex; flex-direction: column; }
.stage-chart { flex: 1; min-height: 200px; }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
@media (max-width: 991px) { .leader { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 575px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
