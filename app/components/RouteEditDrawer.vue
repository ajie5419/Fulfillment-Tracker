<script setup lang="ts">
/**
 * 编排抽屉（生产管理重设计第一批）：工序编排页每个工件的"编排"按钮打开。原工件页表格里每格可改的下拉、日期框都搬到这里，列表只读。
 *   工序链：每道改工序 / 方式 / 班组或外协厂 / 负责人 / 应开工 / 要求完成 / 所属总计划节点，上移、下移、删除；末尾加一道；
 *           没工序时套用模板，有工序时另存为模板（管理员）；从其他工件复制。
 *   工件信息：名称、图号、版号、数量、QMS 物料 ID；删除工件。
 * 规则与原来一样（后端最终判断）：已有流转记录的工序不能删、不能调顺序、不能改工序；发出 / 开工后不能改方式。
 * 权限：route（生产部、工艺部、外协专员、该工单项目经理、管理员），没有权限只读。
 */
type PlanOpts = { published: boolean; nodes: { id: string; seq: number; name: string; deptText: string; planDate: string }[] }
interface StepRow {
  id: string
  partId: string
  seq: number
  processId: string
  processName: string
  mode: StepModeKey
  supplierId: string | null
  ownerId: string | null
  planStartDate: string | Date | null
  dueDate: string | Date | null
  promisedReturnDate: string | Date | null
  planNodeId: string | null
  status: StepStatusKey
  needsFill: boolean
  holdReleaseId: string | null
  eventCount: number
  returnedQty: number
}
interface PartRow {
  id: string
  name: string
  drawingNo: string | null
  revision: string | null
  quantity: number
  qmsPartId: string | null
  steps: StepRow[]
}
const props = defineProps<{ part: PartRow | null; workOrderNumber: string; planOpts: PlanOpts; canRoute: boolean }>()
const emit = defineEmits<{ close: []; changed: []; deleted: [] }>()

const { data: master } = await useMaster()
const { data: me } = await useMe()
const { data: workOrders } = await useWorkOrders()
const tab = ref<'route' | 'info'>('route')
watch(() => props.part?.id, () => { tab.value = 'route' })

const processOptions = computed(() => master.value.processes.map((p) => ({ value: p.id, label: p.name })))
const supplierOptions = computed(() => master.value.suppliers.map((s) => ({ value: s.id, label: s.label })))
const teamOptions = computed(() => master.value.suppliers.filter((s) => s.kind === 'TEAM').map((s) => ({ value: s.id, label: s.name })))
const supplierOptionsFor = (mode: string) => (mode === 'SELF' ? teamOptions.value : supplierOptions.value)
const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: u.name })))
const modeOptions = Object.entries(MODE_TEXT).map(([value, label]) => ({ value, label }))
const planNodeOptions = computed(() => props.planOpts.nodes.map((n) => ({ value: n.id, label: `${n.seq}. ${n.name}（${n.planDate}）` })))
const planDayOf = (id: string | null | undefined) => props.planOpts.nodes.find((n) => n.id === id)?.planDate ?? null
const startLate = (s: StepRow) => s.status === 'PENDING' && !!s.planStartDate && dayText(s.planStartDate) < dayAfter(0)
const stepLateNode = (s: StepRow) => {
  const node = planDayOf(s.planNodeId)
  const d = dayText(s.mode === 'EXTERNAL_OUTSOURCE' && s.promisedReturnDate ? s.promisedReturnDate : s.dueDate)
  return s.status !== 'DONE' && !!node && !!d && d > node
}

async function call(fn: () => unknown, ok?: string) {
  try {
    const r = (await fn()) as { planWarning?: string | null } | undefined
    if (ok) message.success(ok)
    if (r?.planWarning) message.warning(r.planWarning)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    emit('changed')
  }
}
const patchStep = (s: StepRow, body: Record<string, unknown>) => call(() => $fetch(`/api/steps/${s.id}`, { method: 'PATCH', body }))
const moveStep = (s: StepRow, direction: 'up' | 'down') => call(() => $fetch(`/api/steps/${s.id}/move`, { method: 'POST', body: { direction } }))
const removeStep = (s: StepRow) => call(() => $fetch(`/api/steps/${s.id}`, { method: 'DELETE' }), '已删除')

// ───── 加一道 ─────
const draft = reactive<{ processId?: string; mode: StepModeKey; supplierId?: string; ownerId?: string; planStartDate?: string; dueDate?: string; planNodeId?: string }>({ mode: 'SELF' })
async function addStep() {
  if (!props.part) return
  if (!draft.processId) return message.warning('请选择工序')
  if (props.planOpts.published && !draft.planNodeId) return message.warning('该工单已发布总计划，请选择所属总计划节点')
  await call(() => $fetch(`/api/parts/${props.part!.id}/steps`, { method: 'POST', body: { ...draft, supplierId: draft.supplierId ?? null, planStartDate: draft.planStartDate ?? null, planNodeId: draft.planNodeId ?? null } }))
  Object.assign(draft, { processId: undefined, supplierId: undefined, ownerId: undefined, planStartDate: undefined, dueDate: undefined })
}

// ───── 模板、复制 ─────
const templateTarget = ref<{ partId: string; partName: string; mode: 'apply' | 'save' } | null>(null)
const copyForm = reactive({ open: false, fromWo: undefined as string | undefined, fromPartId: undefined as string | undefined })
const { data: copyParts, error: copyPartsError } = await useFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: copyForm.fromWo })),
  default: () => [],
  immediate: false,
  watch: [() => copyForm.fromWo],
})
function openCopy() {
  Object.assign(copyForm, { open: true, fromWo: props.workOrderNumber, fromPartId: undefined })
}
async function doCopy() {
  if (!props.part || !copyForm.fromPartId) return message.warning('请选择来源工件')
  await call(() => $fetch(`/api/parts/${props.part!.id}/copy-route`, { method: 'POST', body: { fromPartId: copyForm.fromPartId } }), '已复制')
  copyForm.open = false
}

// 换了工件或工单：加一道的草稿、复制弹窗、模板弹窗都清掉（总计划节点只属于原工单，不能带到别的工单上）
watch([() => props.part?.id, () => props.workOrderNumber], () => {
  for (const k of Object.keys(draft) as (keyof typeof draft)[]) if (k !== 'mode') draft[k] = undefined
  draft.mode = 'SELF'
  Object.assign(copyForm, { open: false, fromWo: undefined, fromPartId: undefined })
  templateTarget.value = null
})

// ───── 工件信息 ─────
const info = reactive({ name: '', drawingNo: '', revision: '', quantity: 1, qmsPartId: '' })
watch(() => props.part, (p) => {
  if (p) Object.assign(info, { name: p.name, drawingNo: p.drawingNo ?? '', revision: p.revision ?? '', quantity: p.quantity, qmsPartId: p.qmsPartId ?? '' })
}, { immediate: true })
async function saveInfo() {
  if (!props.part) return
  if (!info.name.trim()) return message.warning('请填写工件名称')
  await call(() => $fetch(`/api/parts/${props.part!.id}`, { method: 'PATCH', body: { name: info.name, drawingNo: info.drawingNo || null, revision: info.revision || null, quantity: info.quantity, qmsPartId: info.qmsPartId || null } }), '已保存')
}
function removePart() {
  const p = props.part
  if (!p) return
  Modal.confirm({
    title: `删除工件"${p.name}"及其工序链？`,
    content: '已有流转记录的工件不能删除。',
    okType: 'danger',
    onOk: async () => {
      try {
        await $fetch(`/api/parts/${p.id}`, { method: 'DELETE' })
        message.success('已删除')
        emit('deleted')
      } catch (e) {
        message.error(apiError(e))
      }
    },
  })
}
</script>

<template>
  <a-drawer :open="!!part" :title="part ? `编排：${part.name}` : ''" :width="760" destroy-on-close @close="emit('close')">
    <a-segmented v-model:value="tab" :options="[{ value: 'route', label: `工序链 ${part?.steps.length ?? 0}` }, { value: 'info', label: '工件信息' }]" class="tabs" />

    <template v-if="part && tab === 'route'">
      <p v-if="!canRoute" class="muted">只读：只有生产部、工艺部、外协专员、该工单项目经理或管理员可以修改工序。</p>
      <p v-if="!part.steps.length" class="muted">还没有工序。可以套用模板、从其他工件复制，或在下面一道一道加。</p>
      <ol class="steps">
        <li v-for="(s, i) in part.steps" :key="s.id" class="step" :class="{ fill: s.needsFill }">
          <div class="step-head">
            <span class="seq">{{ s.seq }}</span>
            <UiStatusTag :tone="s.status === 'DONE' ? 'done' : s.status === 'BLOCKED' ? 'late' : s.status === 'PENDING' ? 'none' : 'primary'">{{ STATUS_TEXT[s.status] }}</UiStatusTag>
            <UiStatusTag v-if="s.needsFill" tone="risk">待补充</UiStatusTag>
            <UiStatusTag v-if="s.holdReleaseId && s.status === 'PENDING'" tone="upstream">等变更</UiStatusTag>
            <span v-if="s.returnedQty" class="muted">已完成 {{ s.returnedQty }}/{{ part.quantity }}</span>
            <span class="sp" />
            <template v-if="canRoute">
              <a-button size="small" :disabled="i === 0 || s.eventCount > 0" @click="moveStep(s, 'up')">上移</a-button>
              <a-button size="small" :disabled="i === part.steps.length - 1 || s.eventCount > 0" @click="moveStep(s, 'down')">下移</a-button>
              <a-button size="small" danger :disabled="s.eventCount > 0" @click="removeStep(s)">删除</a-button>
            </template>
          </div>
          <div class="grid">
            <label><span>工序</span><a-select :value="s.processId" :options="processOptions" show-search option-filter-prop="label" :disabled="!canRoute || s.eventCount > 0" @change="(v: unknown) => patchStep(s, { processId: v })" /></label>
            <label><span>方式</span><a-select :value="s.mode" :options="modeOptions" :disabled="!canRoute || s.status !== 'PENDING'" @change="(v: unknown) => patchStep(s, { mode: v })" /></label>
            <label><span>{{ s.mode === 'SELF' ? '派工班组' : '外协厂' }}</span>
              <a-select :value="s.supplierId ?? undefined" allow-clear show-search option-filter-prop="label" :options="supplierOptionsFor(s.mode)" :disabled="!canRoute" :placeholder="s.mode === 'SELF' ? '可空' : '选择外协厂'" @change="(v: unknown) => patchStep(s, { supplierId: v ?? null })" />
            </label>
            <label><span>负责人</span><a-select :value="s.ownerId ?? undefined" show-search option-filter-prop="label" placeholder="待补充" :options="userOptions" :disabled="!canRoute" @change="(v: unknown) => patchStep(s, { ownerId: v })" /></label>
            <label><span>应开工</span><a-date-picker :value="dayText(s.planStartDate) || undefined" value-format="YYYY-MM-DD" :status="startLate(s) ? 'warning' : undefined" :disabled="!canRoute" @change="(v: unknown) => patchStep(s, { planStartDate: v || null })" /></label>
            <label><span>要求完成</span><a-date-picker :value="dayText(s.dueDate) || undefined" value-format="YYYY-MM-DD" :disabled="!canRoute" @change="(v: unknown) => patchStep(s, { dueDate: v || null })" /></label>
            <label class="wide"><span>总计划节点</span>
              <a-select :value="s.planNodeId ?? undefined" :allow-clear="!planOpts.published" show-search option-filter-prop="label" :options="planNodeOptions" :disabled="!canRoute || !planNodeOptions.length" :status="stepLateNode(s) ? 'warning' : undefined" :placeholder="planNodeOptions.length ? '未挂' : '无总计划'" @change="(v: unknown) => patchStep(s, { planNodeId: v ?? null })" />
            </label>
          </div>
          <div v-if="startLate(s) || stepLateNode(s) || (s.status === 'OUT' && s.promisedReturnDate)" class="hint">
            <span v-if="startLate(s)">应开工日已过</span>
            <span v-if="stepLateNode(s)">晚于节点 {{ planDayOf(s.planNodeId) }}</span>
            <span v-if="s.status === 'OUT' && s.promisedReturnDate">承诺 {{ dayText(s.promisedReturnDate) }} 返回</span>
          </div>
        </li>
      </ol>

      <div v-if="canRoute" class="ft-well add">
        <div class="add-title">加一道</div>
        <div class="grid">
          <label><span>工序</span><a-select v-model:value="draft.processId" placeholder="选择工序" show-search option-filter-prop="label" :options="processOptions" /></label>
          <label><span>方式</span><a-select v-model:value="draft.mode" :options="modeOptions" @change="draft.supplierId = undefined" /></label>
          <label><span>{{ draft.mode === 'SELF' ? '派工班组' : '外协厂' }}</span><a-select v-model:value="draft.supplierId" :placeholder="draft.mode === 'SELF' ? '可空' : '选择外协厂'" allow-clear show-search option-filter-prop="label" :options="supplierOptionsFor(draft.mode)" /></label>
          <label><span>负责人</span><a-select v-model:value="draft.ownerId" placeholder="默认我" allow-clear show-search option-filter-prop="label" :options="userOptions" /></label>
          <label><span>应开工</span><a-date-picker v-model:value="draft.planStartDate" value-format="YYYY-MM-DD" /></label>
          <label><span>要求完成</span><a-date-picker v-model:value="draft.dueDate" value-format="YYYY-MM-DD" /></label>
          <label v-if="planNodeOptions.length" class="wide"><span>总计划节点{{ planOpts.published ? '（必选）' : '' }}</span>
            <a-select v-model:value="draft.planNodeId" allow-clear show-search option-filter-prop="label" :options="planNodeOptions" @change="(v: unknown) => { const d = planDayOf(v as string); if (d && !draft.dueDate) draft.dueDate = d }" />
          </label>
        </div>
        <div class="add-actions">
          <a-button type="primary" @click="addStep">加这一道</a-button>
          <a-button v-if="!part.steps.length" @click="templateTarget = { partId: part.id, partName: part.name, mode: 'apply' }">套用模板</a-button>
          <a-button @click="openCopy">从其他工件复制</a-button>
          <a-button v-if="part.steps.length && me?.isAdmin" @click="templateTarget = { partId: part.id, partName: part.name, mode: 'save' }">另存为模板</a-button>
        </div>
      </div>
    </template>

    <template v-else-if="part && tab === 'info'">
      <a-form layout="vertical" :disabled="!canRoute">
        <a-form-item label="工件名称" required><a-input v-model:value="info.name" /></a-form-item>
        <a-form-item label="图号"><a-input v-model:value="info.drawingNo" /></a-form-item>
        <a-form-item label="版号"><a-input v-model:value="info.revision" placeholder="可空，如 A" /></a-form-item>
        <a-form-item label="数量" required><a-input-number v-model:value="info.quantity" :min="1" style="width: 100%" /></a-form-item>
        <a-form-item label="QMS BOM 物料 ID" extra="填了以后，QMS 报检按物料 ID 自动匹配；不填则按名称和工序匹配"><a-input v-model:value="info.qmsPartId" /></a-form-item>
      </a-form>
      <a-space v-if="canRoute">
        <a-button type="primary" @click="saveInfo">保存</a-button>
        <a-button danger @click="removePart">删除工件</a-button>
      </a-space>
    </template>

    <a-modal :open="copyForm.open" title="从其他工件复制工序链" ok-text="复制" @ok="doCopy" @cancel="copyForm.open = false">
      <p class="muted">复制工序、方式、外协厂和负责人，追加到当前工序链末尾；不复制日期和状态。</p>
      <a-form layout="vertical">
        <a-form-item label="来源工单">
          <a-select v-model:value="copyForm.fromWo" show-search option-filter-prop="label" :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))" @change="copyForm.fromPartId = undefined" />
        </a-form-item>
        <a-form-item label="来源工件">
          <a-select
            v-model:value="copyForm.fromPartId"
            :not-found-content="copyPartsError ? `工件加载失败：${apiError(copyPartsError)}` : undefined"
            :options="copyParts.filter((x) => x.id !== part?.id).map((x) => ({ value: x.id, label: `${x.name}（${x.steps.map((s) => s.processName).join(' → ') || '无工序'}）` }))"
          />
        </a-form-item>
      </a-form>
    </a-modal>
    <PartTemplateModal :target="templateTarget" @close="templateTarget = null" @done="templateTarget = null; emit('changed')" />
  </a-drawer>
</template>

<style scoped>
.tabs { margin-bottom: 16px; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.steps { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.step { padding: 10px 12px; border: 1px solid var(--ft-border); border-radius: 10px; }
.step.fill { border-color: var(--ft-risk); }
.step-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.seq { font-weight: 600; min-width: 18px; }
.sp { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; }
.grid label { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 12px; color: var(--ft-text-2); }
.grid label.wide { grid-column: span 3; }
.grid :deep(.ant-select), .grid :deep(.ant-picker) { width: 100%; }
.hint { display: flex; gap: 12px; margin-top: 6px; font-size: 12px; color: var(--ft-upstream-text); }
.add { display: flex; flex-direction: column; gap: 10px; }
.add-title { font-weight: 600; }
.add-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 600px) { .grid { grid-template-columns: 1fr; } .grid label.wide { grid-column: auto; } }
</style>
