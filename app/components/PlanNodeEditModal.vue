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
<a-modal v-model:open="open" :title="editing ? `调整节点：${editing.name}` : '新增节点'" :width="560" @ok="emit('ok')">
  <a-form layout="vertical" class="node-edit-form">
    <a-form-item label="节点名称" required>
      <a-input v-model:value="form.name" :maxlength="191" placeholder="请输入节点名称" />
    </a-form-item>

    <div class="form-grid cols-2">
      <a-form-item label="责任部门" required>
        <a-select v-model:value="form.dept" :options="DEPTS" />
        <div v-if="published && editing && form.dept !== editing.dept" class="muted field-hint">改责任部门后会重新请新部门负责人接收</div>
      </a-form-item>

      <a-form-item v-if="formParent" label="阶段">
        <a-input :value="`跟上级：${formParent.phase ?? '未分阶段'}`" disabled />
      </a-form-item>
      <a-form-item v-else>
        <template #label>
          <span class="ft-title">阶段 <UiHelpTip label="阶段说明">按阶段在表格中分组折叠显示，可不填</UiHelpTip></span>
        </template>
        <a-auto-complete v-model:value="form.phase" :options="phaseOptions" :maxlength="64" placeholder="可不填，如：采购" />
      </a-form-item>
    </div>

    <div class="form-grid cols-parent-seq">
      <a-form-item>
        <template #label>
          <span class="ft-title">上级节点 <UiHelpTip label="上级节点说明">挂在某个节点下面当子节点；上级是汇总行：日期由子节点汇总（最早开始～最晚完成），子节点都完成上级才算完成</UiHelpTip></span>
        </template>
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
        <div v-if="editing?.childCount" class="muted field-hint">已有 {{ editing.childCount }} 个子节点，不能再挂到别的节点下</div>
      </a-form-item>

      <a-form-item>
        <template #label>
          <span class="ft-title">顺序号 <UiHelpTip label="顺序号说明">{{ formParent ? '同一上级下数字小的排在前面，不填默认排最后' : '数字小的排在前面，不填默认排最后' }}</UiHelpTip></span>
        </template>
        <a-input-number v-model:value="form.seq" :precision="0" placeholder="不填排最后" style="width: 100%" />
      </a-form-item>
    </div>

    <a-form-item v-if="isSummary" label="计划日期">
      <div class="summary-date-box">
        <span>{{ editing!.startDate ?? editing!.planDate }} ～ {{ editing!.planDate }}</span>
        <span class="muted">由子节点汇总（最早开始～最晚完成），请直接修改子节点的日期</span>
      </div>
    </a-form-item>
    <div v-else class="form-grid cols-2">
      <a-form-item label="计划开始日">
        <a-date-picker v-model:value="form.startDate" placeholder="可不填" style="width: 100%" />
      </a-form-item>
      <a-form-item label="计划完成日" required>
        <a-date-picker v-model:value="form.planDate" style="width: 100%" />
      </a-form-item>
    </div>
    <div v-if="startLate" class="late small form-tip">计划开始日晚于计划完成日</div>
    <div v-if="editing?.baselineDate" class="muted form-tip">基线日期：{{ editing.baselineDate }}</div>

    <a-form-item v-if="!isSummary">
      <template #label>
        <span class="ft-title">前置节点 <UiHelpTip label="前置节点说明">等前置节点完成才能开始；前置晚了本节点跟着往后推。填了开始日时，前置晚到开始日前一天之前都不影响本节点（中间空档为余量）</UiHelpTip></span>
      </template>
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
        placeholder="不选 = 没有前置（与其他节点并行开始）"
        style="width: 100%; margin-top: 8px"
      />
    </a-form-item>

    <a-form-item label="备注">
      <a-input v-model:value="form.note" :maxlength="500" placeholder="选填" />
    </a-form-item>
    <a-form-item v-if="needReason" label="调整原因（已发布必填，记入调整记录并重新请部门接收）" required>
      <a-textarea v-model:value="form.reason" :rows="2" :maxlength="500" placeholder="请说明调整原因" />
    </a-form-item>
  </a-form>
</a-modal>
</template>

<style scoped>
.node-edit-form :deep(.ant-form-item) { margin-bottom: 14px; }
.node-edit-form :deep(.ant-form-item:last-child) { margin-bottom: 0; }
.form-grid { display: grid; gap: 12px; }
.cols-2 { grid-template-columns: 1fr 1fr; }
.cols-parent-seq { grid-template-columns: 2fr 1fr; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late); }
.field-hint { margin-top: 4px; line-height: 1.4; }
.form-tip { margin: -8px 0 12px; }
.summary-date-box { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; background: var(--ft-fill); border: 1px solid var(--ft-border); border-radius: 8px; }
</style>
