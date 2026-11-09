<script setup lang="ts">
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


const isCollapsed = (id: string) => props.collapsed.includes(id)
/** 缩进层级：有阶段时 节点 = 2 级、子节点 = 3 级；没阶段时 节点 = 1 级、子节点 = 2 级 */
const levelOf = (n: PlanNodeRow) => (n.parentId ? 3 : 2) - (props.hasPhase ? 0 : 1)
const affectsText = (n: PlanNodeRow) => n.affects.map((p) => `${p.code} ${p.name}`).join('、')
const predsText = (n: PlanNodeRow) => n.preds.map((p) => p.code).join(' ')
const predsTitle = (n: PlanNodeRow) =>
  [...n.preds.map((p) => `${p.code} ${p.name}`), ...(n.customDeps ? [] : ['（默认：上一个节点）'])].join('\n')

const columns = [
  { title: '编号 / 节点', key: 'name', width: 300 },
  { title: '责任部门', dataIndex: 'deptText', width: 92 },
  { title: '前置', key: 'preds', width: 104 },
  { title: '计划开始日期', key: 'start', width: 132 },
  { title: '计划完成日期', key: 'plan', width: 132 },
  { title: '', key: 'ops', width: 176, align: 'right' as const, fixed: 'right' as const },
]
const rowClass = (n: TableRow) =>
  isPhaseRow(n) ? 'phase-row' : [n.id === props.focusNode ? 'focus-row' : '', !n.done && n.delayDays > 0 ? 'late-row' : '', n.parentId ? 'child-row' : '', n.childCount ? 'summary-row' : ''].join(' ')
const levelColor = (l: string | null) => (l === 'RED' ? 'red' : l === 'YELLOW' ? 'orange' : l === 'REMIND' ? 'blue' : undefined)
</script>

<template>
  <a-table
    v-model:expanded-row-keys="expanded"
    class="ft-table plan-node-table"
    :columns="columns"
    :data-source="tableRows"
    :loading="loading"
    row-key="id"
    size="small"
    :pagination="false"
    :row-class-name="(r: TableRow) => rowClass(r)"
    :row-expandable="(r: TableRow) => !isPhaseRow(r) && r.tasks.length > 0"
    :show-expand-column="false"
    :scroll="{ x: 936 }"
  >
    <template #emptyText><a-empty :description="data.canEdit ? '还没有节点：选模板“按模板生成”，或“新增节点”' : '还没有编制总计划'" /></template>
    <template #bodyCell="{ column, record }">
      <template v-if="isPhaseRow(record as TableRow)">
        <template v-if="column.key === 'name'">
          <span class="phase-line">
            <button type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}阶段 ${record.phase}`" @click="emit('toggleCollapse', record.id)">
              <span class="chevron" :class="{ open: !isCollapsed(record.id) }" aria-hidden="true" />
            </button>
            <span class="phase-code">{{ record.code }}</span>
            <span class="phase-name">{{ record.phase }}</span>
            <span class="muted">{{ record.count }} 个节点</span>
          </span>
        </template>
        <template v-else-if="column.key === 'start'">{{ record.start }}</template>
        <template v-else-if="column.key === 'plan'">{{ record.end }}</template>
      </template>
      <template v-else-if="column.key === 'name'">
        <div class="node-name" :class="`lv${levelOf(record as PlanNodeRow)}`">
          <button v-if="record.childCount" type="button" class="fold" :aria-expanded="!isCollapsed(record.id)" :aria-label="`${isCollapsed(record.id) ? '展开' : '收起'}子节点`" @click="emit('toggleCollapse', record.id)">
            <span class="chevron" :class="{ open: !isCollapsed(record.id) }" aria-hidden="true" />
          </button>
          <button v-else-if="record.tasks.length" type="button" class="fold" :aria-expanded="expanded.includes(record.id)" :aria-label="`${expanded.includes(record.id) ? '收起' : '展开'}节点 ${record.name} 的部门记录`" @click="expanded = expanded.includes(record.id) ? expanded.filter(id => id !== record.id) : [...expanded, record.id]">
            <span class="chevron" :class="{ open: expanded.includes(record.id) }" aria-hidden="true" />
          </button>
          <span v-else-if="!record.parentId" class="fold-placeholder" aria-hidden="true" />
          <span class="code">{{ record.code }}</span>
          <span class="node-main">
            <span :class="{ 'summary-name': record.childCount }">{{ record.name }}</span>
            <span v-if="record.childCount" class="muted">{{ record.childCount }} 个子节点</span>
            <a-tag v-if="record.alertLevel" :color="levelColor(record.alertLevel)">W9 {{ record.alertLevel === 'RED' ? '红' : '黄' }}</a-tag>
          </span>
        </div>
        <div v-if="record.note" class="muted node-note" :class="`lv${levelOf(record as PlanNodeRow)}`">{{ record.note }}</div>
      </template>
      <template v-else-if="column.key === 'preds'">
        <span v-if="record.childCount" class="muted" title="汇总行：日期由子节点算，看子节点的前置">—</span>
        <span v-else-if="!record.preds.length" class="muted">{{ record.customDeps ? '无' : '—' }}</span>
        <span v-else class="preds-text" :class="{ muted: !record.customDeps }" :title="predsTitle(record as PlanNodeRow)">
          {{ predsText(record as PlanNodeRow) }}
        </span>
      </template>
      <template v-else-if="column.key === 'start'">{{ record.startDate ?? '—' }}</template>
      <template v-else-if="column.key === 'plan'">
        {{ record.planDate }}
        <div v-if="record.baselineDate && record.baselineDate !== record.planDate" class="muted">基线 <span class="changed">{{ record.baselineDate }}</span></div>
        <div v-else-if="published && !record.baselineDate" class="muted">发布后新增</div>
      </template>
      <template v-else-if="column.key === 'ops'">
        <div v-if="data.canEdit" class="row-ops">
          <a-button size="small" @click="emit('edit', record as PlanNodeRow)">调整</a-button>
          <a-button v-if="!record.parentId" size="small" @click="emit('addChild', record as PlanNodeRow)">加子节点</a-button>
          <a-button size="small" class="op-del" @click="emit('remove', record as PlanNodeRow)">删除</a-button>
        </div>
      </template>
    </template>
    <template #expandedRowRender="{ record }">
      <div v-if="record.childCount" class="muted">汇总行：任务挂在下面的子节点上</div>
      <PlanNodeWork v-else-if="record.tasks.length" :node="record as PlanNodeRow" :wo="wo" :can-create="data!.canCreate" view-only @changed="emit('changed')" />
    </template>
  </a-table>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; font-weight: 400; }
.small { font-size: 12px; }
.late { color: var(--ft-late); }
.warn { color: var(--ft-upstream); }
.changed { text-decoration: line-through; color: var(--ft-text-3); }
:deep(.late-row) td:first-child { box-shadow: inset 3px 0 0 var(--ft-late); }
:deep(.focus-row) td { background: var(--ft-risk-bg) !important; }
:deep(.phase-row) td { background: var(--ft-fill) !important; font-weight: 600; }
.phase-code { color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.phase-name { font-weight: 600; color: var(--ft-text); margin-right: 4px; }
.phase-line { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 28px; }
/* 大纲分级：阶段行 1 级（灰底粗体），节点 2 级，子节点 3 级（贯通树形引导线 + 缩进）；折叠按钮占固定宽度，编号对齐 */
.fold { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 20px; width: 20px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--ft-text-2); cursor: pointer; border-radius: 4px; }
.fold-placeholder { flex: 0 0 20px; width: 20px; }
.fold:hover { background: var(--ft-fill); color: var(--ft-primary); }
.chevron { width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 0.15s; }
.chevron.open { transform: rotate(45deg); }
.fold:focus-visible { outline: 2px solid var(--ft-primary); }
.code { flex: 0 0 auto; min-width: 28px; color: var(--ft-text-2); font-variant-numeric: tabular-nums; }
.node-name { display: flex; align-items: center; gap: 6px; min-height: 28px; }
.node-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lv1 { padding-left: 0; }
.lv2 { padding-left: 20px; }
.lv3 { padding-left: 48px; }
/* 子节点连续树形线：沿上级节点折叠箭头中心轴垂直贯通，末尾子节点平齐收尾 */
:deep(.child-row) td:first-child { position: relative; --tree-x: 42px; }
:deep(.child-row:has(.lv2)) td:first-child { --tree-x: 22px; }
:deep(.child-row) td:first-child::before { content: ""; position: absolute; left: var(--tree-x); top: 0; bottom: 0; border-left: 1px solid var(--ft-border-hover); pointer-events: none; }
:deep(.child-row:not(:has(+ .child-row))) td:first-child::before { bottom: 50%; }
:deep(.child-row) td:first-child::after { content: ""; position: absolute; left: var(--tree-x); top: 50%; width: 12px; border-top: 1px solid var(--ft-border-hover); pointer-events: none; }
:deep(.child-row) td { border-top: 1px dashed var(--ft-border); }
.node-note { margin-left: 54px; }
.node-note.lv3 { margin-left: 82px; }
.summary-name { font-weight: 600; }
.preds-text { font-variant-numeric: tabular-nums; word-spacing: 4px; }
.row-ops { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; white-space: nowrap; }
.op-del { color: var(--ft-text-2); }
.op-del:hover, .op-del:focus-visible { color: var(--ft-late-text) !important; border-color: var(--ft-late) !important; background: var(--ft-late-bg) !important; }
.affects { margin: 0 0 8px; line-height: 1.6; }
</style>
