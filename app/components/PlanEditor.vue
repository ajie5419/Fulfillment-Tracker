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
const { data: templates } = await useApiFetch<PlanTemplateOption[]>('/api/plan/templates', { default: () => [] })
const { templateId, generate, publish } = usePlanGeneration({ wo, data, templates, act })

// ───── 新增 / 编辑节点 ─────
const { editOpen, editing, form, openEdit, predOptions, phaseOptions, parentOptions, formParent, defaultPredText, isSummary } = usePlanNodeForm(data)
const startLate = computed(() => isPlanStartLate(form.startDate?.isValid() ? form.startDate.format('YYYY-MM-DD') : undefined, form.planDate?.isValid() ? form.planDate.format('YYYY-MM-DD') : undefined))
/** 发布后：加节点、改计划日都要写原因 */
const needReason = computed(() => planAdjustmentNeedsReason(published.value, editing.value?.planDate ?? null, form.planDate?.format('YYYY-MM-DD'), editing.value?.startDate, form.startDate?.format('YYYY-MM-DD') ?? null))
const { saveNode } = usePlanNodeSave({ wo, published, editing, form, editOpen, startLate, needReason, act })

// ───── 删除 ─────
const { reasonOpen, reasonText, reasonFor, askDelete, submitReason } = usePlanNodeDelete({ published, act })

// ───── 顶部双栏焦点迷你清单（Brick 风格） ─────
const upcomingSpotlight = computed(() => {
  const list = (data.value?.nodes ?? []).filter((n) => !n.done && !n.childCount && n.planDate >= today.value)
  return [...list]
    .sort((a, b) => (a.startDate ?? a.planDate).localeCompare(b.startDate ?? b.planDate))
    .slice(0, SPOTLIGHT_MAX_ITEMS)
    .map((n) => ({
      id: n.id,
      title: `${n.code} ${n.name}`,
      meta: n.deptText,
      ownerName: n.confirmedByName || n.deptText,
      rightText: `计划 ${shortDayText(n.planDate)}`,
    }))
})

const attentionSpotlight = computed(() => {
  const list = (data.value?.nodes ?? []).filter((n) => !n.done && !n.childCount && (n.delayDays > 0 || n.overdueCount > 0 || n.dateConflict || n.confirmStatus === 'PENDING'))
  return [...list]
    .sort((a, b) => b.delayDays - a.delayDays)
    .slice(0, SPOTLIGHT_MAX_ITEMS)
    .map((n) => {
      const pct = n.taskCount ? Math.round((n.doneCount / n.taskCount) * 100) : 0
      const reason = n.delayDays > 0
        ? `已延误 ${n.delayDays} 天 · 计划 ${shortDayText(n.planDate)} · 已完 ${pct}%`
        : n.dateConflict
          ? `排期冲突 · ${shortDayText(n.planDate)}`
          : `待接收确认 · 计划 ${shortDayText(n.planDate)}`
      return {
        id: n.id,
        title: `${n.code} ${n.name}`,
        meta: n.deptText,
        ownerName: n.confirmedByName || n.deptText,
        rightText: reason,
        level: (n.delayDays > 0 || n.overdueCount > 0 ? 'late' : 'risk') as 'late' | 'risk',
      }
    })
})
</script>

<template>
  <div class="plan-workspace">
    <!-- 顶部主操作栏 (Page Topbar) -->
    <header class="brick-page-head">
      <div class="head-left">
        <div class="crumbs">
          <NuxtLink to="/plan" class="crumb-link">项目计划</NuxtLink>
          <span class="crumb-sep">/</span>
          <span class="wo-name">{{ wo }}</span>
        </div>
        <h1 class="page-title">{{ data?.workOrder.projectName ?? data?.workOrder.customerName ?? '总计划' }}</h1>
        <span class="sub-link">
          <UiHelpTip label="排期协同操作指南">
            每个工单一份总计划：项目经理、项目部编制、发布和调整；各部门在“部门计划”里接收节点、分解任务，这里只读看执行情况。
          </UiHelpTip>
        </span>
      </div>
      <div class="head-actions">
        <NuxtLink :to="`/wo/${encodeURIComponent(wo)}`" class="wo-detail-link">工单详情 ›</NuxtLink>
        <a-segmented
          v-model:value="view"
          :options="[{ value: 'gantt', label: '甘特图 Gantt Beta' }, { value: 'table', label: '表格 Table' }]"
          class="view-segmented"
        />
        <a-button v-if="view === 'table' && collapsibleIds.length" @click="toggleAll">
          {{ allOpen ? (phaseGroups.length ? '只看阶段' : '收起子节点') : '全部展开' }}
        </a-button>
        <UiRefreshButton @click="load()" />
        <template v-if="data?.canEdit">
          <template v-if="!published">
            <a-select v-model:value="templateId" placeholder="模板" style="width: 140px" :options="templates.map((t) => ({ value: t.id, label: t.name }))" />
            <a-button @click="generate">按模板生成</a-button>
          </template>
          <a-button @click="openEdit(null)">新增节点</a-button>
          <a-button v-if="!published" type="primary" :disabled="!data.nodes.length || data.dateConflicts.some((conflict) => conflict.blocksPublish)" @click="publish">发布</a-button>
        </template>
      </div>
    </header>

    <a-result v-if="loadError" status="error" :title="loadError" />
    <a-spin v-else-if="!data" />
    <template v-else>
      <!-- 顶部双栏焦点迷你清单卡 (UiSpotlightGrid) -->
      <UiSpotlightGrid
        v-if="data.nodes.length"
        style="margin-bottom: 16px"
        left-title="今日与近期节点 STARTS TODAY"
        :left-items="upcomingSpotlight"
        right-title="需要关注 / 延误与排期 NEEDS ATTENTION"
        :right-items="attentionSpotlight"
        @select="(it) => selectFromGantt(it.id)"
      />

      <!-- 日期校验与概览 -->
      <PlanSummaryPanel :data="data" :published="published" />

      <!-- 主视图：甘特图模式 / 表格模式 -->
      <PlanGantt
        v-if="view === 'gantt'"
        :nodes="data.nodes"
        :delivery-date="data.workOrder.deliveryDate"
        :today="today"
        :wo="wo"
        :project-name="data.workOrder.projectName ?? data.workOrder.customerName"
        @select="selectFromGantt"
      />

      <div v-else class="project-tray">
        <div class="tray-head">
          <div class="tray-left">
            <button type="button" class="tray-chevron" aria-label="展开/收起">⌄</button>
            <span class="av-circle">{{ (wo || '工')[0] }}</span>
            <span class="tray-wo">{{ wo }}</span>
            <span class="tray-sep">/</span>
            <span class="tray-product">{{ data.workOrder.projectName ?? data.workOrder.customerName }}</span>
            <span class="tray-scope">表格大纲视图</span>
          </div>
          <div class="tray-right">
            <span v-if="data.workOrder.deliveryDate">合同交期 <b class="tray-strong">{{ shortDayText(data.workOrder.deliveryDate) }}</b></span>
            <span class="tray-sep">·</span>
            <span class="mini-progress">
              <span class="mini-track"><span class="mini-fill" :style="{ width: `${data.nodes.length ? Math.round((data.nodes.filter(n => n.done).length / data.nodes.length) * 100) : 0}%` }" /></span>
              <span>{{ data.nodes.filter(n => n.done).length }}/{{ data.nodes.length }} 已完成</span>
            </span>
          </div>
        </div>
        <div class="inset-card">
          <PlanNodeTable
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
        </div>
      </div>

      <PlanChangeLogTable :logs="data.changeLogs" style="margin-top: 16px" />
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
  </div>
</template>

<style scoped>
.plan-workspace {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-variant-numeric: tabular-nums;
}
.brick-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.head-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.crumbs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  color: var(--ft-text-2);
}
.crumb-link {
  color: var(--ft-text-2);
  text-decoration: none;
}
.crumb-link:hover {
  color: var(--ft-primary);
}
.crumb-sep {
  color: var(--ft-text-3);
}
.wo-name {
  color: var(--ft-text);
  font-weight: 600;
}
.wo-detail-link {
  font-size: 13px;
  color: var(--ft-primary);
  text-decoration: none;
  font-weight: 500;
  margin-right: 6px;
}
.wo-detail-link:hover {
  text-decoration: underline;
}
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--ft-text);
  letter-spacing: -0.02em;
}
.title-en {
  font-size: 13px;
  font-weight: 500;
  color: var(--ft-text-3);
  margin-left: 2px;
}
.sub-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ft-text-3);
  font-size: 12px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-left: auto;
}

/* 托盘与内嵌卡（用于表格模式） */
.project-tray {
  background: var(--ft-tray-bg);
  border: 1px solid var(--ft-tray-border);
  border-radius: 16px;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tray-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 2px 4px;
  font-size: 13px;
  color: var(--ft-text-2);
}
.tray-left, .tray-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tray-chevron {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ft-text-2);
  font-size: 11px;
  line-height: 1;
  padding: 0;
}
.av-circle {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--ft-av-2-bg);
  color: var(--ft-av-2-text);
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tray-wo { font-size: 14px; font-weight: 600; color: var(--ft-text); }
.tray-sep { color: var(--ft-border-hover); margin: 0 1px; }
.tray-product { color: var(--ft-text-2); font-size: 13px; }
.tray-scope {
  font-size: 11.5px;
  color: var(--ft-text-2);
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  border-radius: 6px;
  padding: 2px 7px;
  margin-left: 2px;
}
.tray-strong { color: var(--ft-text); font-weight: 600; }
.mini-progress { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; }
.mini-track { width: 42px; height: 5px; border-radius: 999px; background: var(--ft-border-hover); overflow: hidden; }
.mini-fill { display: block; height: 100%; background: var(--ft-done); border-radius: 999px; }
.inset-card {
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}
</style>
