<script setup lang="ts">
/**
 * 设计任务四阶段看板视图（R11）：
 * 按「设计中 → 待客户确认 → 待图纸发放 → 已发放完成」四列并排展示。
 * 遵循前端设计规范：单层白底卡片 + 1px 中性灰细边框，不用左侧色条与多余彩色底块，用文字颜色表达临期/逾期状态。
 */
const props = defineProps<{
  rows: DrawingRow[]
  loading?: boolean
  canEditTask: boolean
  canRelease: boolean
}>()

const emit = defineEmits<{
  edit: [row: DrawingRow]
  act: [row: DrawingRow, kind: 'drawn' | 'confirm']
  release: [row: DrawingRow]
  undo: [row: DrawingRow, kind: 'drawn' | 'confirm']
  cancel: [row: DrawingRow]
}>()

type StageKey = 'PENDING' | 'CONFIRM' | 'RELEASE' | 'DONE'

const STAGES: { key: StageKey; title: string; emptyText: string }[] = [
  { key: 'PENDING', title: '设计中', emptyText: '暂无设计中的任务' },
  { key: 'CONFIRM', title: '待客户确认', emptyText: '完成需确认的设计后流转至此' },
  { key: 'RELEASE', title: '待图纸发放', emptyText: '设计完成 / 客户确认后在此发放' },
  { key: 'DONE', title: '已发放完成', emptyText: '暂无已发放完成的任务' },
]

function stageOf(r: DrawingRow): StageKey | null {
  if (r.status === 'CANCELLED') return null
  if (r.status === 'PENDING') return 'PENDING'
  if (r.status === 'DONE') return 'DONE'
  if (r.needsCustomerConfirm && !r.customerConfirmedDate) return 'CONFIRM'
  return 'RELEASE'
}

function sortStageRows(list: DrawingRow[]): DrawingRow[] {
  return [...list].sort((a, b) => {
    const ua = a.overdue ? 2 : a.alertLevel === 'YELLOW' ? 1 : 0
    const ub = b.overdue ? 2 : b.alertLevel === 'YELLOW' ? 1 : 0
    if (ua !== ub) return ub - ua
    const da = dayText(a.planDate)
    const db = dayText(b.planDate)
    if (da !== db) return da.localeCompare(db)
    const ca = a.planNode?.code ?? String(a.planNode?.seq ?? '')
    const cb = b.planNode?.code ?? String(b.planNode?.seq ?? '')
    return ca.localeCompare(cb, undefined, { numeric: true })
  })
}

const columns = computed(() => {
  const buckets: Record<StageKey, DrawingRow[]> = {
    PENDING: [],
    CONFIRM: [],
    RELEASE: [],
    DONE: [],
  }
  for (const r of props.rows) {
    const s = stageOf(r)
    if (s) buckets[s].push(r)
  }
  return STAGES.map((st) => ({
    ...st,
    items: sortStageRows(buckets[st.key]),
  }))
})

function scheduleLabel(r: DrawingRow, stage: StageKey): string {
  if (stage === 'DONE') {
    return r.drawnDate ? `${shortDayText(r.drawnDate)} 已发放` : '已发放'
  }
  if (stage === 'CONFIRM' && r.customerPlanDate) {
    return `确认计划 ${shortDayText(r.customerPlanDate)}`
  }
  if (r.drawnDate) {
    return `${shortDayText(r.drawnDate)} 完成设计`
  }
  return `${shortDayText(r.planDate)} 止`
}

function hasMenu(r: DrawingRow): boolean {
  return Boolean(props.canEditTask || props.canRelease || r.permissions.undoDrawn)
}
</script>

<template>
  <a-spin :spinning="!!loading">
    <div class="kanban-board">
      <div v-for="col in columns" :key="col.key" class="board-col">
        <div class="col-head">
          <span class="col-title">{{ col.title }}</span>
          <span class="col-count">{{ col.items.length }}</span>
        </div>

        <div v-if="!col.items.length" class="col-empty">
          {{ col.emptyText }}
        </div>

        <div v-else class="col-cards">
          <div v-for="r in col.items" :key="r.id" class="k-card">
            <div class="k-top">
              <div class="k-title-wrap">
                <button
                  v-if="canEditTask"
                  type="button"
                  class="k-name-btn"
                  @click="emit('edit', r)"
                >
                  {{ r.componentName }}
                </button>
                <span v-else class="k-name-text">{{ r.componentName }}</span>
                <UiAlertMark :level="r.overdue ? 'late' : r.alertLevel === 'YELLOW' ? 'risk' : null" />
                <span v-if="r.parts.length" class="k-parts-count" :title="r.parts.map((p) => p.name).join('、')">
                  · {{ r.parts.length }} 件
                </span>
              </div>
              <div class="k-top-right">
                <WoLink :no="r.workOrderNumber" />
                <a-dropdown v-if="hasMenu(r)" placement="bottomRight">
                  <button type="button" class="k-more-btn" aria-label="更多操作">···</button>
                  <template #overlay>
                    <a-menu>
                      <a-menu-item v-if="canEditTask" key="edit" @click="emit('edit', r)">编辑任务</a-menu-item>
                      <a-menu-item v-if="r.status === 'DRAWN' && col.key === 'CONFIRM' && canRelease" key="rel-early" @click="emit('release', r)">一键发放图纸</a-menu-item>
                      <a-menu-item v-if="r.permissions.release && r.status !== 'DRAWN' && canRelease" key="rel-again" @click="emit('release', r)">再发一版</a-menu-item>
                      <a-menu-item v-if="r.permissions.undoDrawn" key="undo-drawn" @click="emit('undo', r, 'drawn')">撤销设计完成</a-menu-item>
                      <a-menu-item v-if="r.customerConfirmedDate && canEditTask" key="undo-confirm" @click="emit('undo', r, 'confirm')">撤销客户确认</a-menu-item>
                      <a-menu-item v-if="canEditTask" key="cancel" :danger="r.status !== 'CANCELLED'" @click="emit('cancel', r)">
                        {{ r.status === 'CANCELLED' ? '恢复任务' : '取消任务' }}
                      </a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
              </div>
            </div>

            <div v-if="r.planNode" class="k-sub">
              <PlanNodeCell :work-order-number="r.workOrderNumber" :node="r.planNode" />
            </div>

            <div class="k-foot">
              <div class="k-meta">
                <div class="k-meta-line">
                  <UiUserChip :name="r.ownerText" :muted="!r.ownerId" />
                  <span> · {{ scheduleLabel(r, col.key) }}</span>
                </div>
                <div
                  v-if="col.key !== 'DONE' && (r.presentation.designWarning || r.needsCustomerConfirm)"
                  class="k-meta-sub"
                >
                  <span
                    v-if="r.presentation.designWarning"
                    :class="r.presentation.designOverdue ? 'text-late' : 'text-risk'"
                  >
                    {{ r.presentation.designWarning.replace(/^设计\s*/, '') }}
                  </span>
                  <span
                    v-if="r.presentation.designWarning && r.needsCustomerConfirm"
                    class="k-sep"
                  >·</span>
                  <span
                    v-if="r.needsCustomerConfirm && !r.customerConfirmedDate"
                    :class="{ 'text-late': r.presentation.customerOverdue }"
                  >
                    {{ r.presentation.customerOverdue ? r.presentation.customerText : `需确认${r.customerPlanDate ? ` ${shortDayText(r.customerPlanDate)}` : ''}` }}
                  </span>
                  <span v-else-if="r.customerConfirmedDate" class="text-done">
                    已确认 {{ shortDayText(r.customerConfirmedDate) }}
                  </span>
                </div>
              </div>

              <a-button
                v-if="col.key === 'PENDING' && r.permissions.markDrawn"
                size="small"
                @click="emit('act', r, 'drawn')"
              >
                完成设计
              </a-button>
              <a-button
                v-else-if="col.key === 'CONFIRM' && r.permissions.confirm && canEditTask"
                size="small"
                @click="emit('act', r, 'confirm')"
              >
                客户确认
              </a-button>
              <a-button
                v-else-if="col.key === 'RELEASE' && r.status === 'DRAWN' && canRelease"
                size="small"
                @click="emit('release', r)"
              >
                一键发放
              </a-button>
              <span v-else-if="col.key === 'DONE'" class="text-done">
                已完成
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </a-spin>
</template>

<style scoped>
.kanban-board {
  display: grid;
  grid-template-columns: repeat(4, minmax(240px, 1fr));
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.board-col {
  background: var(--ft-tray-bg);
  border: 1px solid var(--ft-tray-border);
  border-radius: var(--card-radius);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 360px;
  min-width: 0;
}

.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ft-text);
}

.col-title {
  color: var(--ft-text);
}

.col-count {
  font-size: 12px;
  padding: 0 7px;
  height: 20px;
  line-height: 18px;
  border-radius: 999px;
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  color: var(--ft-text-2);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.col-empty {
  flex: 1;
  border: 1px dashed var(--ft-border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
  text-align: center;
  color: var(--ft-text-3);
  font-size: 12px;
}

.col-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.k-card {
  background: var(--ft-card-bg);
  border: 1px solid var(--ft-border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  transition: border-color 0.15s ease;
}

.k-card:hover {
  border-color: var(--ft-border-hover);
}

.k-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.k-title-wrap {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.k-name-btn {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ft-text);
  text-align: left;
  cursor: pointer;
}

.k-name-btn:hover {
  color: var(--ft-primary);
  text-decoration: underline;
}

.k-name-text {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ft-text);
}

.k-parts-count {
  font-size: 12px;
  color: var(--ft-text-3);
  white-space: nowrap;
}

.k-top-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 12px;
}

.k-more-btn {
  width: 22px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ft-text-3);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.k-more-btn:hover {
  background: var(--ft-fill);
  border-color: var(--ft-border);
  color: var(--ft-text);
}

.k-sub {
  display: flex;
  align-items: center;
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
}

.k-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--card-border-subtle);
  font-size: 12px;
  color: var(--ft-text-2);
  min-width: 0;
}

.k-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}

.k-meta-line,
.k-meta-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0 4px;
  line-height: 18px;
}

.k-meta-sub {
  color: var(--ft-text-3);
}

.k-sep {
  color: var(--ft-text-3);
}

.k-meta .is-unassigned {
  color: var(--ft-text-3);
}

.text-risk {
  color: var(--ft-risk-text);
}

.text-late {
  color: var(--ft-late-text);
}

.text-done {
  color: var(--ft-done-text);
  white-space: nowrap;
  flex-shrink: 0;
}

@media (max-width: 960px) {
  .kanban-board {
    grid-template-columns: repeat(2, minmax(240px, 1fr));
  }
}

@media (max-width: 600px) {
  .kanban-board {
    grid-template-columns: 1fr;
  }
  .board-col {
    min-height: 180px;
  }
}
</style>
