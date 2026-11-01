<script setup lang="ts">
import { CONFIRM_TONE } from '~/utils/plan-status'
import type { PlanNodeRow } from '#shared/plan-view'
import type { PlanData } from '../composables/usePlanData'
import { isPhaseRow, type TableRow } from '../composables/usePlanPhaseGroups'

/**
 * 总计划节点表（PlanEditor 拆分，展示 + 事件上抛）：阶段汇总行 / 节点 / 子节点按大纲分级，行内操作与展开行（挂靠任务）。
 * 列宽按内容收紧，1440 宽屏幕不横向滚动（设计规范第 3 节）；操作列固定在右边，窄屏横向滚动时也看得到。
 */
const props = defineProps<{
  data: PlanData
  tableRows: TableRow[]
  collapsed: string[]
  hasPhase: boolean
  loading: boolean
  published: boolean
  wo: string
  focusNode: string | null
}>()
const expanded = defineModel<string[]>('expanded', { required: true })
const emit = defineEmits<{ toggleCollapse: [id: string]; edit: [node: PlanNodeRow]; addChild: [node: PlanNodeRow]; remove: [node: PlanNodeRow]; changed: [] }>()

const DRIVER_TEXT: Record<string, string> = { self: '', task: '挂靠任务拖后', prev: '前置节点顺延', today: '计划日已过仍未完成', actual: '' }

const isCollapsed = (id: string) => props.collapsed.includes(id)
/** 缩进层级：有阶段时 节点 = 2 级、子节点 = 3 级；没阶段时 节点 = 1 级、子节点 = 2 级 */
const levelOf = (n: PlanNodeRow) => (n.parentId ? 3 : 2) - (props.hasPhase ? 0 : 1)
/** 汇总行的"部门执行"：子节点接收情况 */
function childSummary(n: PlanNodeRow) {
  const kids = (props.data.nodes ?? []).filter((x) => x.parentId === n.id)
  return { total: kids.length, accepted: kids.filter((x) => x.confirmStatus === 'CONFIRMED').length, pending: kids.filter((x) => x.confirmStatus === 'PENDING').length }
}
const affectsText = (n: PlanNodeRow) => n.affects.map((p) => `${p.code} ${p.name}`).join('、')
const predsText = (n: PlanNodeRow) => n.preds.map((p) => p.code).join(' ')
const predsTitle = (n: PlanNodeRow) =>
  [...n.preds.map((p) => `${p.code} ${p.name}`), ...(n.customDeps ? [] : ['（默认：上一个节点）'])].join('\n')
/** 受谁影响：子节点晚了 / 前置节点晚了 */
const pushedText = (n: PlanNodeRow) => (!n.pushedBy ? '受上游影响' : n.pushedBy.child ? `受子节点影响（${n.pushedBy.code} ${n.pushedBy.name}）` : `受 ${n.pushedBy.code} 影响`)

const columns = [
  { title: '编号 / 节点', key: 'name', width: 280 },
  { title: '责任部门', dataIndex: 'deptText', width: 80 },
  { title: '前置', key: 'preds', width: 72 },
  { title: '计划', key: 'plan', width: 112 },
  { title: '预计 / 完成', key: 'expected', width: 140 },
  { title: '部门执行', key: 'exec', width: 180 },
  { title: '', key: 'ops', width: 148, fixed: 'right' as const },
]
const rowClass = (n: TableRow) =>
  isPhaseRow(n) ? 'phase-row' : [n.id === props.focusNode ? 'focus-row' : '', !n.done && n.delayDays > 0 ? 'late-row' : '', n.parentId ? 'child-row' : '', n.childCount ? 'summary-row' : ''].join(' ')
const levelColor = (l: string | null) => (l === 'RED' ? 'red' : l === 'YELLOW' ? 'orange' : l === 'REMIND' ? 'blue' : undefined)
</script>

<template>
  <a-table
    v-else
    v-model:expanded-row-keys="expanded"
    :columns="columns"
    :data-source="tableRows"
    :loading="loading"
    row-key="id"
    size="small"
    :pagination="false"
    :row-class-name="(r: TableRow) => rowClass(r)"
    :row-expandable="(r: TableRow) => !isPhaseRow(r)"
    :scroll="{ x: 1100 }"
  >
    <template #emptyText><a-empty :description="data.canEdit ? '还没有节点：选模板“按模板生成”，或“新增节点”' : '还没有编制总计划'" /></template>
    <template #bodyCell="{ column, record }">
      <template v-if="isPhaseRow(record as TableRow)">
        <template v-if="column.key === 'name'">
          <button type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}阶段 ${record.phase}`" @click="emit('toggleCollapse', record.id)">
            {{ isCollapsed(record.id) ? '▸' : '▾' }}
          </button>
          <span class="phase-line">
            <span class="code">{{ record.code }}</span><span class="phase-name">{{ record.phase }}</span>
            <span class="muted">{{ record.count }} 个节点</span>
          </span>
        </template>
        <template v-else-if="column.key === 'plan'">{{ record.start === record.end ? record.end : `${record.start.slice(5)} ~ ${record.end.slice(5)}` }}</template>
        <template v-else-if="column.key === 'expected'">
          <span v-if="record.expected" :class="{ late: record.late }">{{ record.expected }}</span>
          <UiStatusTag v-else tone="done">已完成</UiStatusTag>
        </template>
        <template v-else-if="column.key === 'exec'">
          <span v-if="published" class="muted">已接收 {{ record.accepted }}/{{ record.leaves }}<template v-if="record.pending"> · <span class="warn">{{ record.pending }} 个待接收</span></template></span>
        </template>
      </template>
      <template v-else-if="column.key === 'name'">
        <span class="node-name" :class="`lv${levelOf(record as PlanNodeRow)}`">
          <button v-if="record.childCount" type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}子节点`" @click="emit('toggleCollapse', record.id)">
            {{ isCollapsed(record.id) ? '▸' : '▾' }}
          </button>
          <span class="code">{{ record.code }}</span>
          <span :class="{ 'summary-name': record.childCount }">{{ record.name }}</span>
          <span v-if="record.childCount" class="muted small">　汇总 · {{ record.childCount }} 个子节点</span>
          <a-tag v-if="record.alertLevel" :color="levelColor(record.alertLevel)">W9 {{ record.alertLevel === 'RED' ? '红' : '黄' }}</a-tag>
        </span>
        <div v-if="record.note" class="muted node-note" :class="`lv${levelOf(record as PlanNodeRow)}`">{{ record.note }}</div>
      </template>
      <template v-else-if="column.key === 'preds'">
        <span v-if="record.childCount" class="muted" title="汇总行：日期由子节点算，看子节点的前置">按子节点</span>
        <span v-else-if="!record.preds.length" class="muted">{{ record.customDeps ? '无' : '—' }}</span>
        <span v-else :class="{ muted: !record.customDeps }" :title="predsTitle(record as PlanNodeRow)">
          {{ predsText(record as PlanNodeRow) }}
        </span>
      </template>
      <template v-else-if="column.key === 'plan'">
        {{ record.planDate }}
        <div v-if="record.startDate" class="muted">开始 {{ record.startDate }}</div>
        <div v-if="record.childCount" class="muted small">子节点汇总</div>
        <div v-if="record.baselineDate && record.baselineDate !== record.planDate" class="muted">基线 <span class="changed">{{ record.baselineDate }}</span></div>
        <div v-else-if="published && !record.baselineDate" class="muted">发布后新增</div>
      </template>
      <template v-else-if="column.key === 'expected'">
        <template v-if="record.done">
          <UiStatusTag tone="done">完成 {{ record.actualDate?.slice(5) }}</UiStatusTag>
          <div class="muted" :class="{ late: record.actualDate > record.planDate }">{{ record.doneBy === 'MANUAL' ? `${record.manualDoneByName ?? ''} 手动标记` : record.childCount ? '子节点全部完成' : '任务全部完成' }}</div>
        </template>
        <template v-else>
          <span :class="{ late: record.delayDays > 0 }">{{ record.expectedDate }}</span>
          <div v-if="record.delayDays > 0" class="late small">晚 {{ record.delayDays }} 天<template v-if="record.source && DRIVER_TEXT[record.driver] && record.driver !== 'prev'">（{{ DRIVER_TEXT[record.driver] }}）</template></div>
          <div v-if="record.source && record.upstream" class="late small">其中自身晚 {{ record.selfDelayDays }} 天</div>
          <div v-if="record.source && record.affects.length" class="late small" :title="affectsText(record as PlanNodeRow)">影响后续 {{ record.affects.length }} 个节点</div>
          <a-tag v-if="record.upstream && !record.source" color="default" class="small" :title="record.pushedBy ? `被 #${record.pushedBy.code} ${record.pushedBy.name} 推后` : ''">{{ pushedText(record as PlanNodeRow) }}</a-tag>
          <div v-if="record.slackDays != null">
            <UiStatusTag v-if="record.critical" tone="primary">关键</UiStatusTag>
            <span v-else class="muted">余量 {{ record.slackDays }} 天</span>
          </div>
        </template>
      </template>
      <template v-else-if="column.key === 'exec'">
        <template v-if="record.childCount">
          <span v-if="published" class="muted">子节点已接收 {{ childSummary(record as PlanNodeRow).accepted }}/{{ childSummary(record as PlanNodeRow).total }}</span>
          <span v-else class="muted">按子节点</span>
        </template>
        <span v-else-if="!record.confirmStatus" class="muted">{{ published ? '—' : '发布后由部门接收' }}</span>
        <template v-else>
          <UiStatusTag :tone="CONFIRM_TONE[record.confirmStatus as keyof typeof CONFIRM_TONE]">{{ record.confirmText }}<template v-if="record.confirmStatus === 'CONFIRMED' && record.confirmedByName"> · {{ record.confirmedByName }}</template></UiStatusTag>
          <a-tag v-if="record.confirmAlertLevel" :color="levelColor(record.confirmAlertLevel)">超时</a-tag>
          <div v-if="record.confirmStatus === 'REJECTED' && record.rejectReason" class="late small">{{ record.confirmedByName }}：{{ record.rejectReason }}</div>
          <div v-if="record.taskCount" class="small">
            {{ record.taskCount }} 项任务 · {{ record.doneCount }}/{{ record.taskCount }} 完成
            <span v-if="record.overdueCount" class="late">· 逾期 {{ record.overdueCount }}</span>
            <span v-if="record.lateCount" class="late">· 晚于节点 {{ record.lateCount }}</span>
          </div>
          <div v-else-if="record.confirmStatus === 'CONFIRMED' && !record.done" class="small">
            <UiStatusTag :tone="record.splitAlertLevel ? 'risk' : 'none'">未分解</UiStatusTag>
          </div>
        </template>
      </template>
      <template v-else-if="column.key === 'ops'">
        <a-space wrap size="small">
          <template v-if="data.canEdit">
            <a-button size="small" @click="emit('edit', record as PlanNodeRow)">调整</a-button>
            <a-button v-if="!record.parentId" size="small" @click="emit('addChild', record as PlanNodeRow)">加子节点</a-button>
            <a-button size="small" danger @click="emit('remove', record as PlanNodeRow)">删除</a-button>
          </template>
        </a-space>
      </template>
    </template>
    <template #expandedRowRender="{ record }">
      <div v-if="data?.network" class="affects small">
        <template v-if="record.affects.length">晚了会影响 {{ record.affects.length }} 个节点：<span class="muted">{{ affectsText(record as PlanNodeRow) }}</span></template>
        <span v-else class="muted">晚了不影响其他节点</span>
      </div>
      <div v-if="record.childCount" class="muted">汇总行：任务挂在下面的子节点上</div>
      <PlanNodeWork v-else :node="record as PlanNodeRow" :wo="wo" :can-create="data!.canCreate" view-only @changed="emit('changed')" />
    </template>
  </a-table>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.small { font-size: 12px; }
.late { color: var(--ft-late); }
.warn { color: var(--ft-upstream); }
.changed { text-decoration: line-through; color: var(--ft-text-3); }
:deep(.late-row) td:first-child { box-shadow: inset 3px 0 0 var(--ft-late); }
:deep(.focus-row) td { background: var(--ft-risk-bg) !important; }
:deep(.phase-row) td { background: var(--ft-fill) !important; }
.phase-name { font-weight: 600; color: var(--ft-text); margin-right: 8px; }
.phase-line { display: inline-flex; align-items: baseline; white-space: nowrap; }
/* 大纲分级：阶段行 1 级（灰底粗体），节点 2 级，子节点 3 级（再缩进、虚线分隔）；折叠按钮占固定宽度，编号对齐 */
.fold { width: 18px; height: 18px; padding: 0; margin-right: 4px; border: 0; background: none; color: var(--ft-text-2); cursor: pointer; font-size: 14px; line-height: 18px; border-radius: 4px; }
.fold:focus-visible { outline: 2px solid var(--ft-primary); }
.code { display: inline-block; min-width: 40px; margin-right: 6px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
:deep(.phase-row) td { font-weight: 600; }
.node-name { display: inline-flex; align-items: center; flex-wrap: wrap; }
.lv1 { padding-left: 0; }
.lv2 { padding-left: 22px; }
.lv3 { padding-left: 52px; }
.node-name:not(:has(.fold)) .code { margin-left: 22px; }
.node-note { margin-left: 62px; }
.summary-name { font-weight: 600; }
:deep(.child-row) td { border-top: 1px dashed var(--ft-border); }
.affects { margin: 0 0 8px; line-height: 1.6; }
</style>
