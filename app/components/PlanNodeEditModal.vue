<script setup lang="ts">
import { BUSINESS_DEPT_OPTIONS } from '#shared/business-depts'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanNodeForm } from '../composables/usePlanNodeForm'

/** 新增 / 编辑总计划节点的弹窗（PlanEditor 拆分）：表单状态由 usePlanNodeForm 持有，这里直接绑定同一个 reactive 表单；保存由父级提交。 */
defineProps<{
  editing: PlanNodeRow | null
  form: PlanNodeForm
  published: boolean
  isSummary: boolean
  startLate: boolean
  needReason: boolean
  formParent: PlanNodeRow | null
  parentOptions: { value: string; label: string }[]
  phaseOptions: { value: string }[]
  predOptions: { value: string; label: string }[]
  defaultPredText: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ ok: [] }>()

const DEPTS = BUSINESS_DEPT_OPTIONS
</script>

<template>
<a-modal v-model:open="open" :title="editing ? `调整节点：${editing.name}` : '新增节点'" @ok="emit('ok')">
  <a-form layout="vertical">
    <a-form-item label="节点名称" required><a-input v-model:value="form.name" :maxlength="191" /></a-form-item>
    <a-form-item label="责任部门" required>
      <a-select v-model:value="form.dept" :options="DEPTS" />
      <div v-if="published && editing && form.dept !== editing.dept" class="muted">改责任部门后会重新请新部门负责人接收</div>
    </a-form-item>
    <a-form-item label="上级节点（挂在某个节点下面当子节点；上级是汇总行：日期由子节点算，子节点都完成上级才算完成）">
      <a-select
        v-model:value="form.parentId"
        :options="parentOptions"
        allow-clear
        show-search
        option-filter-prop="label"
        placeholder="不选 = 一级节点"
        :disabled="!!editing?.childCount"
        style="width: 100%"
      />
      <div v-if="editing?.childCount" class="muted">这个节点下面有 {{ editing.childCount }} 个子节点，不能再挂到别的节点下面（子节点只有一层）</div>
    </a-form-item>
    <a-form-item v-if="formParent" label="阶段">
      <span class="muted">跟上级：{{ formParent.phase ?? '未分阶段' }}</span>
    </a-form-item>
    <a-form-item v-else label="阶段（分组显示，可不填）">
      <a-auto-complete v-model:value="form.phase" :options="phaseOptions" :maxlength="64" placeholder="如：图纸设计及文件下发、采购" />
    </a-form-item>
    <a-form-item v-if="isSummary" label="计划日期">
      <span>{{ editing!.startDate ?? editing!.planDate }} ～ {{ editing!.planDate }}</span>
      <div class="muted">由子节点汇总（最早开始～最晚完成），请改子节点的日期。别的节点把它设为前置 = 等它下面的子节点全部完成。</div>
    </a-form-item>
    <div v-else class="date-pair">
      <a-form-item label="计划开始日（可不填）">
        <a-date-picker v-model:value="form.startDate" style="width: 100%" />
      </a-form-item>
      <a-form-item label="计划完成日" required>
        <a-date-picker v-model:value="form.planDate" style="width: 100%" />
      </a-form-item>
    </div>
    <div v-if="startLate" class="late small form-tip">计划开始日晚于计划完成日</div>
    <div v-if="editing?.baselineDate" class="muted form-tip">基线 {{ editing.baselineDate }}</div>
    <a-form-item v-if="!isSummary" label="前置节点（等它们完成才能开始；它们晚了，本节点跟着往后推）">
      <a-radio-group v-model:value="form.depMode">
        <a-radio value="default">默认：{{ formParent ? '' : '上一个节点（' }}{{ defaultPredText }}{{ formParent ? '' : '）' }}</a-radio>
        <a-radio value="custom">自己选</a-radio>
      </a-radio-group>
      <a-select
        v-if="form.depMode === 'custom'"
        v-model:value="form.preds"
        mode="multiple"
        :options="predOptions"
        option-filter-prop="label"
        placeholder="不选 = 没有前置（和别的节点并行开始）"
        style="width: 100%; margin-top: 8px"
      />
      <div v-if="form.depMode === 'custom'" class="muted">填了开始日时，前置节点晚到开始日前一天之前都不影响本节点（中间的空档是余量）。</div>
    </a-form-item>
    <a-form-item :label="formParent ? '顺序号（同一上级下小的在前，不填排最后）' : '顺序号（小的在前，不填排最后）'"><a-input-number v-model:value="form.seq" :precision="0" style="width: 100%" /></a-form-item>
    <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
    <a-form-item v-if="needReason" label="调整原因（已发布，必填；会记入调整记录并重新请部门接收）" required>
      <a-textarea v-model:value="form.reason" :rows="2" :maxlength="500" />
    </a-form-item>
  </a-form>
</a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late); }
.date-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-tip { margin: -16px 0 16px; }
</style>
