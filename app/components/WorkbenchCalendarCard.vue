<script setup lang="ts">
/**
 * 工作台"项目日历"卡片（zhao 10-21）：本周、下周、本月计划完成多少台、实际完成多少台、逾期未完成多少台，点进项目日历。
 * 所有人都显示（不分权限）。数据单独取、不挡工作台首屏（lazy）；取失败只在卡片里提示。
 */
const { data, error } = await useFetch('/api/calendar/summary', { key: 'calendar-summary', lazy: true })
const items = computed(() =>
  (data.value?.items ?? []).map((i) => {
    const s = i.summary
    const planned = s.planned.units
    const ratio = s.overdue.orders
      ? (planned > 0 ? s.overdue.units / planned : 1)
      : (planned > 0 ? s.actual.units / planned : 0)
    return {
      key: i.key,
      label: `${i.title}（${i.period.label}）`,
      value: planned,
      ratio,
      tone: s.overdue.orders ? ('late' as const) : ('primary' as const),
      sub: `实际完成 ${s.actual.units} 台${s.overdue.orders ? ` · 逾期 ${s.overdue.units} 台` : ''}`,
      // 本周 / 下周 → 列表并滚到那一周（wk = 那周周一）；本月 → 日历。本周用今天（周一可能在上个月，会翻到上个月去）
      to:
        i.key === 'thisMonth'
          ? { path: '/calendar', query: { mode: 'calendar', d: i.period.start } }
          : { path: '/calendar', query: { mode: 'list', d: i.key === 'thisWeek' ? data.value!.today : i.period.start, wk: i.period.start } },
    }
  }),
)
</script>

<template>
  <UiSectionCard flat>
    <template #title>
      <span class="ft-title">项目日历 <UiHelpTip label="项目日历说明">"完成"指总计划的发运节点完成，台数取 QMS 工单数量；没有已发布总计划的工单按 QMS 交期计入计划。</UiHelpTip></span>
    </template>
    <template #extra><NuxtLink to="/calendar" class="more">查看日历</NuxtLink></template>
    <a-alert v-if="error" type="error" show-icon :message="apiError(error)" />
    <div v-else class="cells">
      <UiStatCard v-for="i in items" :key="i.key" :label="i.label" :value="i.value" :ratio="i.ratio" unit="台计划完成" :tone="i.tone" :sub="i.sub" :to="i.to" />
      <template v-if="!data">
        <a-skeleton v-for="n in 3" :key="n" active :paragraph="{ rows: 1 }" :title="false" />
      </template>
    </div>
  </UiSectionCard>
</template>

<style scoped>
.cells { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.more { font-size: 13px; white-space: nowrap; }
@media (max-width: 767px) { .cells { grid-template-columns: minmax(0, 1fr); } }
</style>
