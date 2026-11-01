<script setup lang="ts">
/**
 * 总计划编辑（R14）：一个工单一份主线计划，部门记录（设计 / 采购 / 工序 / 装配节点）挂到节点上。
 * 用在"项目计划"页 /plan?wo=（zhao 10-22：一度并进工单详情的页签，测试后又单独成菜单页；旧的 /wo/:no?tab=plan 跳过来）。
 *   节点表：基线 / 当前计划 / 预计 / 实际日期、责任部门、确认状态、挂靠任务数、逾期数；展开看挂靠任务（可跳到各自页面）。
 *   10-22 按真实 MS Project 计划补：节点可设阶段（表格按阶段分组）、计划开始日、前置节点（多条线并行，只沿前置往后推），
 *     用了前置 / 开始日的计划显示余量和关键节点；"甘特图"视图（PlanGantt，只读）。
 *   顶部：合同交期、预计交期、拖期天数、未挂节点的部门记录条数。
 *   项目经理、项目部、管理员可按模板生成、增删改节点、发布（发布后改日期 / 加删节点要写原因，记调整记录）；
 *   节点完成由部门任务自动汇总。
 *   10-23 zhao："不够直观，没分成 1、2 级；部门的任务分解不应该在这个界面"——
 *     按 MS Project 大纲显示：阶段 = 1 级（灰底粗体行，可折叠），节点 = 2 级，子节点 = 3 级（再缩进，汇总行可折叠），编号 阶段.节点.子节点；
 *     接收、退回、分解都挪到"部门计划"页（/dept-plan），这里的"部门执行"列和展开行只读（任务负责人仍可标完成）。
 * 地址栏 ?node= 定位节点（W9 提醒、任务待办跳过来）。所有人可见（看不到的工单接口会拒绝；手里有接收待办的部门负责人例外，见 server/utils/auth.ts）。
 */
import type { PlanTemplateOption } from '../composables/usePlanGeneration'
import { isPlanStartLate, planAdjustmentNeedsReason } from '#shared/plan-validation'

const props = defineProps<{ wo: string }>()
/** 节点有变动（生成、发布、改日期、确认、完成……）时通知工单详情刷新概览 */
const emit = defineEmits<{ changed: [] }>()
const wo = computed(() => props.wo)

// 数据加载与动作包装；加载完成后的定位交给 usePlanFocus（afterLoad 在两者创建完后才会被调用）
const { data, loading, loadError, load, published, act, onWorkChanged } = usePlanData({ wo, afterLoad: (d) => focus.afterLoad(d), onChanged: () => emit('changed') })
const { hasPhase, phaseGroups, collapsed, toggleCollapse, collapsibleIds, allOpen, toggleAll, reveal, tableRows } = usePlanPhaseGroups(data)
const focus = usePlanFocus({ reveal, reload: load })
const { focusNode, expanded, view, today, selectFromGantt } = focus

// ───── 按模板生成 / 发布 ─────
const { data: templates } = await useFetch<PlanTemplateOption[]>('/api/plan/templates', { default: () => [] })
const { templateId, generate, publish } = usePlanGeneration({ wo, data, templates, act })

// ───── 新增 / 编辑节点 ─────
const { editOpen, editing, form, openEdit, predOptions, phaseOptions, parentOptions, formParent, defaultPredText, isSummary } = usePlanNodeForm(data)
const startLate = computed(() => isPlanStartLate(form.startDate?.isValid() ? form.startDate.format('YYYY-MM-DD') : undefined, form.planDate?.isValid() ? form.planDate.format('YYYY-MM-DD') : undefined))
/** 发布后：加节点、改计划日都要写原因 */
const needReason = computed(() => planAdjustmentNeedsReason(published.value, editing.value?.planDate ?? null, form.planDate?.format('YYYY-MM-DD')))
const { saveNode } = usePlanNodeSave({ wo, published, editing, form, editOpen, startLate, needReason, act })

// ───── 删除 ─────
const { reasonOpen, reasonText, reasonFor, askDelete, submitReason } = usePlanNodeDelete({ published, act })
</script>

<template>
  <UiSectionCard title="总计划" sub="项目经理、项目部编制、发布和调整；各部门在“部门计划”里接收本部门节点、分解任务，这里只读看执行情况">
    <template #extra>
      <a-space wrap>
        <a-segmented v-model:value="view" :options="[{ value: 'table', label: '表格' }, { value: 'gantt', label: '甘特图' }]" aria-label="切换表格 / 甘特图" />
        <a-button v-if="view === 'table' && collapsibleIds.length" @click="toggleAll">{{ allOpen ? (phaseGroups.length ? '只看阶段' : '收起子节点') : '全部展开' }}</a-button>
        <UiRefreshButton @click="load()" />
        <template v-if="data?.canEdit">
          <template v-if="!published">
            <a-select v-model:value="templateId" placeholder="模板" style="width: 140px" :options="templates.map((t) => ({ value: t.id, label: t.name }))" />
            <a-button @click="generate">按模板生成</a-button>
          </template>
          <a-button @click="openEdit(null)">新增节点</a-button>
          <a-button v-if="!published" type="primary" :disabled="!data.nodes.length" @click="publish">发布</a-button>
        </template>
      </a-space>
    </template>

    <a-result v-if="loadError" status="error" :title="loadError" />
    <a-spin v-else-if="!data" />
    <template v-else>
      <PlanSummaryPanel :data="data" :published="published" />

      <PlanGantt v-if="view === 'gantt'" :nodes="data.nodes" :delivery-date="data.workOrder.deliveryDate" :today="today" @select="selectFromGantt" />

      <PlanNodeTable
        v-else
        v-model:expanded="expanded"
        :data="data"
        :table-rows="tableRows"
        :collapsed="collapsed"
        :has-phase="hasPhase"
        :loading="loading"
        :published="published"
        :wo="wo"
        :focus-node="focusNode"
        @toggle-collapse="toggleCollapse"
        @edit="openEdit($event)"
        @add-child="openEdit(null, $event)"
        @remove="askDelete"
        @changed="onWorkChanged"
      />

      <PlanChangeLogTable :logs="data.changeLogs" />
    </template>

    <PlanNodeEditModal
      v-model:open="editOpen"
      :editing="editing"
      :form="form"
      :published="published"
      :is-summary="isSummary"
      :start-late="startLate"
      :need-reason="needReason"
      :form-parent="formParent"
      :parent-options="parentOptions"
      :phase-options="phaseOptions"
      :pred-options="predOptions"
      :default-pred-text="defaultPredText"
      @ok="saveNode"
    />

    <PlanDeleteReasonModal v-model:open="reasonOpen" v-model:text="reasonText" :node="reasonFor" @ok="submitReason" />
  </UiSectionCard>
</template>
