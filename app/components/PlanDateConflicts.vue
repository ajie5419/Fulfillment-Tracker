<script setup lang="ts">
import { PLAN_DATE_REVIEW, type PlanDateConflict } from '#shared/plan-schedule'
defineProps<{ conflicts: PlanDateConflict[] }>()
</script>

<template>
  <section v-if="conflicts.length" class="date-conflicts" role="alert" aria-label="计划日期校验">
    <strong>{{ PLAN_DATE_REVIEW }}</strong>
    <p>以下问题未核实前，预计交期、拖期结论和余量暂不作为有效结论。草稿可保存；阻断项解决后才能发布。</p>
    <ul>
      <li v-for="(conflict, index) in conflicts" :key="`${conflict.nodeId}:${conflict.code}:${index}`">
        {{ conflict.message }}（{{ conflict.blocksPublish ? '阻止发布' : '交付范围待核实' }}）
      </li>
    </ul>
  </section>
</template>

<style scoped>
.date-conflicts { padding: 12px; margin-bottom: 12px; border: 1px solid var(--ft-risk); border-radius: 8px; color: var(--ft-text); background: var(--ft-card-bg); overflow-wrap: anywhere; }
p { margin: 8px 0; }
ul { margin: 0; padding-left: 20px; }
li + li { margin-top: 8px; }
</style>
