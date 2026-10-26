<script setup lang="ts">
/**
 * 工件与工序链：选工单 → 工件列表 → 行内编辑工序链；可从同类工件复制。
 * 权限方案 R13：建/改/删工件和工序、导入 BOM、套模板、复制路线 —— 生产部、外协专员、该工单项目经理、管理员；
 * 开工/完工/发出/补登返厂 —— 生产部、外协专员、该工序责任人、管理员。其他人只读（后端同样拦）。
 * R14：每道工序可选"所属总计划节点"（工单总计划已发布时手工添加的工序必选；BOM 导入、套模板、复制路线生成的不强制）。
 */
const route = useRoute()
const router = useRouter()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const workOrderNumber = ref<string | undefined>((route.query.wo as string) || undefined)
watch(workOrders, (list) => {
  if (!workOrderNumber.value && list.length) workOrderNumber.value = list[0]!.workOrderNumber
}, { immediate: true })
// 选中的工单记在地址栏，刷新后不丢
watch(workOrderNumber, (wo) => {
  if (import.meta.client) router.replace({ query: wo ? { wo } : {} })
})

const { data: parts, pending, refresh } = await useFetch('/api/parts', {
  query: { workOrderNumber },
  default: () => [],
  immediate: !!workOrderNumber.value,
  watch: [workOrderNumber],
})
type PartRow = (typeof parts.value)[number]
type StepRow = PartRow['steps'][number]

const processOptions = computed(() => master.value.processes.map((p) => ({ value: p.id, label: p.name })))
const supplierOptions = computed(() => master.value.suppliers.map((s) => ({ value: s.id, label: s.label })))
const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: u.name })))
const modeOptions = Object.entries(MODE_TEXT).map(([value, label]) => ({ value, label }))

async function call(fn: () => unknown, ok?: string) {
  try {
    const r = (await fn()) as { planWarning?: string | null } | undefined
    if (ok) message.success(ok)
    if (r?.planWarning) message.warning(r.planWarning)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    await refresh()
    eventsCache.clear()
  }
}

// ───── 工件 ─────
const partForm = reactive({ open: false, id: '' as string, name: '', drawingNo: '', revision: '', quantity: 1, qmsPartId: '' })
function editPart(p?: PartRow) {
  Object.assign(partForm, p
    ? { open: true, id: p.id, name: p.name, drawingNo: p.drawingNo ?? '', revision: p.revision ?? '', quantity: p.quantity, qmsPartId: p.qmsPartId ?? '' }
    : { open: true, id: '', name: '', drawingNo: '', revision: '', quantity: 1, qmsPartId: '' })
}
async function savePart() {
  const body = { name: partForm.name, drawingNo: partForm.drawingNo || null, revision: partForm.revision || null, quantity: partForm.quantity, qmsPartId: partForm.qmsPartId || null }
  if (!body.name.trim()) return message.warning('请填写工件名称')
  const id = partForm.id
  await call(async () => {
    if (id) await $fetch(`/api/parts/${id}`, { method: 'PATCH', body })
    else await $fetch('/api/parts', { method: 'POST', body: { ...body, workOrderNumber: workOrderNumber.value } })
  }, '已保存')
  partForm.open = false
}
function removePart(p: PartRow) {
  Modal.confirm({
    title: `删除工件"${p.name}"及其工序链？`,
    okType: 'danger',
    onOk: async () => {
      await call(() => $fetch(`/api/parts/${p.id}`, { method: 'DELETE' }), '已删除')
    },
  })
}

// ───── 复制工序链 ─────
const copyForm = reactive({ open: false, targetId: '', fromWo: undefined as string | undefined, fromPartId: undefined as string | undefined })
const { data: copyParts } = await useFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: copyForm.fromWo })),
  default: () => [],
  immediate: false,
  watch: [() => copyForm.fromWo],
})
function openCopy(p: PartRow) {
  Object.assign(copyForm, { open: true, targetId: p.id, fromWo: workOrderNumber.value, fromPartId: undefined })
}
async function doCopy() {
  if (!copyForm.fromPartId) return message.warning('请选择来源工件')
  await call(() => $fetch(`/api/parts/${copyForm.targetId}/copy-route`, { method: 'POST', body: { fromPartId: copyForm.fromPartId } }), '已复制')
  copyForm.open = false
}

// ───── 步骤 ─────
const newStep = reactive<Record<string, { processId?: string; mode: StepModeKey; supplierId?: string; ownerId?: string; dueDate?: string; planNodeId?: string }>>({})
const draftOf = (partId: string) => (newStep[partId] ??= { mode: 'EXTERNAL_OUTSOURCE' })
async function addStep(p: PartRow) {
  const d = draftOf(p.id)
  if (!d.processId) return message.warning('请选择工序')
  if (planOpts.value.published && !d.planNodeId) return message.warning('该工单已发布总计划，请选择所属总计划节点')
  await call(() => $fetch(`/api/parts/${p.id}/steps`, { method: 'POST', body: { ...d, supplierId: d.mode === 'SELF' ? null : d.supplierId ?? null, planNodeId: d.planNodeId ?? null } }))
  newStep[p.id] = { mode: d.mode, planNodeId: d.planNodeId }
}
// 表格插槽里的 record 类型是 Record<string, any>，这里只要求用到的字段
type StepRef = Pick<StepRow, 'id' | 'processName'>
const patchStep = (s: Pick<StepRow, 'id'>, body: Record<string, unknown>) => call(() => $fetch(`/api/steps/${s.id}`, { method: 'PATCH', body }))
const moveStep = (s: Pick<StepRow, 'id'>, direction: 'up' | 'down') => call(() => $fetch(`/api/steps/${s.id}/move`, { method: 'POST', body: { direction } }))
const removeStep = (s: Pick<StepRow, 'id'>) => call(() => $fetch(`/api/steps/${s.id}`, { method: 'DELETE' }), '已删除')
const startStep = (s: Pick<StepRow, 'id'>) => call(() => $fetch(`/api/steps/${s.id}/start`, { method: 'POST', body: { source: 'PC' } }), '已开工')
function finishStep(s: StepRef) {
  Modal.confirm({ title: `确认"${s.processName}"完工？`, onOk: async () => {
    await call(() => $fetch(`/api/steps/${s.id}/finish`, { method: 'POST', body: { source: 'PC' } }), '已完工')
  } })
}

const sending = ref<{ id: string; supplierId: string | null; title: string } | null>(null)
/** 上报异常：带上当前工单和工件 */
const reportingPartId = ref<string | null>(null)
/** 上报后跳到异常列表并打开刚报的那条 */
function onReported(issue: { id: string }) {
  reportingPartId.value = null
  navigateTo({ path: '/issues', query: { id: issue.id } })
}
const returning = reactive({ open: false, step: null as StepRef | null, qty: 1, partName: '' })
function openReturn(p: PartRow, s: StepRef & Pick<StepRow, 'returnedQty'>) {
  Object.assign(returning, { open: true, step: s, qty: Math.max(p.quantity - s.returnedQty, 1), partName: p.name })
}
async function doReturn() {
  await call(() => $fetch(`/api/steps/${returning.step!.id}/return`, { method: 'POST', body: { qty: returning.qty, source: 'PC' } }), '已补登返厂')
  returning.open = false
}

// ───── 流转记录（展开行时按工件加载） ─────
type EventRow = Awaited<ReturnType<typeof loadEvents>>[number]
const eventsCache = reactive(new Map<string, EventRow[]>())
async function loadEvents(partId: string) {
  return $fetch(`/api/parts/${partId}/events`)
}
async function onExpand(expanded: boolean, s: Pick<StepRow, 'partId'>) {
  if (expanded && !eventsCache.has(s.partId)) eventsCache.set(s.partId, await loadEvents(s.partId))
}

// ───── R8：从 QMS BOM 导入、路线模板 ─────
const { data: me } = await useMe()
const canRoute = computed(() => canDo(me.value, 'route', { workOrderNumber: workOrderNumber.value }))
const canStep = (s: { ownerId: string | null }) => canDo(me.value, 'stepAction', { ownerId: s.ownerId })
const bomImportOpen = ref(false)
const templateTarget = ref<{ partId: string; partName: string; mode: 'apply' | 'save' } | null>(null)
const fillCount = (p: PartRow) => p.steps.filter((s) => s.needsFill).length
function afterR8() {
  bomImportOpen.value = false
  templateTarget.value = null
  refresh()
  eventsCache.clear()
}

// ───── R14：所属总计划节点（同一工单的节点，整页取一次）─────
type PlanOpts = { published: boolean; nodes: { id: string; seq: number; name: string; deptText: string; planDate: string }[] }
const { data: planOpts } = await useFetch<PlanOpts>('/api/plan/options', {
  query: { workOrderNumber },
  default: () => ({ published: false, nodes: [] }),
  immediate: !!workOrderNumber.value,
  watch: [workOrderNumber],
})
const planNodeOptions = computed(() => planOpts.value.nodes.map((n) => ({ value: n.id, label: `${n.seq}. ${n.name}（${n.planDate}）` })))
const planDayOf = (id: string | null | undefined) => planOpts.value.nodes.find((n) => n.id === id)?.planDate ?? null
/** 工序日期（外协看承诺返回日，否则要求完成日）晚于节点计划日：标红（照样保存） */
const stepLate = (s: { planNodeId: string | null; dueDate: string | Date | null; promisedReturnDate: string | Date | null; mode: string; status: string }) => {
  const node = planDayOf(s.planNodeId)
  const d = dayText(s.mode === 'EXTERNAL_OUTSOURCE' && s.promisedReturnDate ? s.promisedReturnDate : s.dueDate)
  return s.status !== 'DONE' && !!node && !!d && d > node
}

const columns = [
  { title: '序', dataIndex: 'seq', width: 48 },
  { title: '工序', key: 'process', width: 140 },
  { title: '方式', key: 'mode', width: 120 },
  { title: '外协厂', key: 'supplier', width: 160 },
  { title: '负责人', key: 'owner', width: 130 },
  { title: '要求完成日', key: 'dueDate', width: 150 },
  { title: '总计划节点', key: 'planNode', width: 170 },
  { title: '状态', key: 'status', width: 150 },
  { title: '操作', key: 'actions' },
]
</script>

<template>
  <a-card>
    <a-space wrap>
      <span>工单</span>
      <a-select
        v-model:value="workOrderNumber"
        style="width: 360px"
        show-search
        option-filter-prop="label"
        placeholder="选择工单"
        :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}　交期 ${dayText(w.deliveryDate)}` }))"
      />
      <WoLink v-if="workOrderNumber" :no="workOrderNumber" text="工单详情" />
      <template v-if="canRoute">
        <a-button type="primary" :disabled="!workOrderNumber" @click="editPart()">新建工件</a-button>
        <a-button :disabled="!workOrderNumber" @click="bomImportOpen = true">从 QMS BOM 导入</a-button>
      </template>
    </a-space>
  </a-card>

  <a-spin :spinning="pending">
    <a-empty v-if="workOrderNumber && !parts.length" description="这个工单还没有工件：技术部发放图纸时附上 BOM 表，会按图号自动建好" style="margin-top: 48px" />
    <a-card v-for="p in parts" :key="p.id" class="part" size="small">
      <template #title>
        {{ p.name }}
        <span class="muted">　图号 {{ p.drawingNo || '—' }}{{ p.revision ? `（${p.revision} 版）` : '' }}　数量 {{ p.quantity }}　BOM 物料 ID {{ p.qmsPartId || '—' }}</span>
        <a-tag v-if="p.status === 'DONE'" color="success" style="margin-left: 8px">已完成</a-tag>
        <UiStatusTag v-if="p.fromTechBom" tone="none" style="margin-left: 8px">来自图纸 BOM</UiStatusTag>
        <a-tag v-if="p.qmsBomId && !p.fromTechBom" style="margin-left: 8px">来自 QMS BOM</a-tag>
        <UiStatusTag v-if="p.qmsBomId && p.fromTechBom" tone="done" style="margin-left: 8px">已关联 QMS</UiStatusTag>
        <a-tooltip v-else-if="p.fromTechBom" title="QMS 里品质人员录完这个图号后，点“从 QMS BOM 导入”按图号关联，报检才能自动匹配">
          <UiStatusTag tone="risk" style="margin-left: 8px">未关联 QMS</UiStatusTag>
        </a-tooltip>
        <a-tooltip v-if="fillCount(p)" title="还没开工、但缺负责人，或外协没选外协厂的工序；从 BOM 导入的工序默认自制，请确认方式">
          <a-tag color="warning">{{ fillCount(p) }} 道待补充</a-tag>
        </a-tooltip>
      </template>
      <template #extra>
        <a-space>
          <a-button v-if="canRoute" size="small" @click="editPart(p)">编辑</a-button>
          <a-button v-if="canRoute" size="small" @click="openCopy(p)">复制工序链</a-button>
          <a-button size="small" danger @click="reportingPartId = p.id">上报异常</a-button>
          <a-button v-if="canRoute" size="small" danger @click="removePart(p)">删除</a-button>
        </a-space>
      </template>

      <a-table :columns="columns" :data-source="p.steps" row-key="id" size="small" :pagination="false" @expand="onExpand">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'process'">
            <a-select :value="record.processId" style="width: 100%" :options="processOptions" :disabled="!canRoute || record.eventCount > 0" @change="(v: unknown) => patchStep(record as StepRow, { processId: v })" />
          </template>
          <template v-else-if="column.key === 'mode'">
            <a-select :value="record.mode" style="width: 100%" :options="modeOptions" :disabled="!canRoute || record.status !== 'PENDING'" @change="(v: unknown) => patchStep(record as StepRow, { mode: v })" />
          </template>
          <template v-else-if="column.key === 'supplier'">
            <a-select
              :value="record.supplierId ?? undefined"
              style="width: 100%"
              allow-clear
              show-search
              option-filter-prop="label"
              :options="supplierOptions"
              :disabled="!canRoute || record.mode === 'SELF'"
              :placeholder="record.mode === 'SELF' ? '—' : '选择外协厂'"
              @change="(v: unknown) => patchStep(record as StepRow, { supplierId: v ?? null })"
            />
          </template>
          <template v-else-if="column.key === 'owner'">
            <a-select :value="record.ownerId ?? undefined" style="width: 100%" show-search option-filter-prop="label" placeholder="待补充" :options="userOptions" :disabled="!canRoute" @change="(v: unknown) => patchStep(record as StepRow, { ownerId: v })" />
          </template>
          <template v-else-if="column.key === 'dueDate'">
            <a-date-picker :value="dayText(record.dueDate) || undefined" value-format="YYYY-MM-DD" style="width: 100%" :disabled="!canRoute" @change="(v: unknown) => patchStep(record as StepRow, { dueDate: v || null })" />
          </template>
          <template v-else-if="column.key === 'planNode'">
            <a-select
              :value="record.planNodeId ?? undefined"
              style="width: 100%"
              :allow-clear="!planOpts.published"
              show-search
              option-filter-prop="label"
              :options="planNodeOptions"
              :disabled="!canRoute || !planNodeOptions.length"
              :status="stepLate(record as StepRow) ? 'warning' : undefined"
              :placeholder="planNodeOptions.length ? '未挂' : '无总计划'"
              @change="(v: unknown) => patchStep(record as StepRow, { planNodeId: v ?? null })"
            />
            <div v-if="stepLate(record as StepRow)" class="late-node">晚于节点 {{ planDayOf(record.planNodeId) }}</div>
            <WoLink v-if="record.planNodeId" :no="workOrderNumber" :node="record.planNodeId" text="看节点" class="node-link" />
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="STATUS_COLOR[record.status as StepStatusKey]">{{ STATUS_TEXT[record.status as StepStatusKey] }}</a-tag>
            <a-tag v-if="record.needsFill" color="warning">待补充</a-tag>
            <NuxtLink v-if="record.holdReleaseId" :to="`/releases?id=${encodeURIComponent(record.holdReleaseId)}`" title="设计变更还没确认影响，转序/逾期预警暂停计时"><a-tag color="purple">等变更</a-tag></NuxtLink>
            <div v-if="record.issues?.length">
              <NuxtLink v-for="i in record.issues" :key="i.id" :to="`/issues?id=${encodeURIComponent(i.id)}`" class="issue-link">{{ i.issueNo }}</NuxtLink>
            </div>
            <span v-if="record.returnedQty" class="muted">{{ record.returnedQty }}/{{ p.quantity }}</span>
            <div v-if="record.status === 'OUT' && record.promisedReturnDate" class="muted">承诺 {{ dayText(record.promisedReturnDate) }}</div>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space size="small" wrap>
              <template v-if="canRoute">
                <a-button size="small" :disabled="record.eventCount > 0" @click="moveStep(record as StepRow, 'up')">上移</a-button>
                <a-button size="small" :disabled="record.eventCount > 0" @click="moveStep(record as StepRow, 'down')">下移</a-button>
                <a-button size="small" danger :disabled="record.eventCount > 0" @click="removeStep(record as StepRow)">删除</a-button>
              </template>
              <template v-if="canStep(record as StepRow) && record.mode === 'EXTERNAL_OUTSOURCE' && record.status === 'PENDING'">
                <a-button size="small" type="primary" @click="sending = { id: record.id, supplierId: record.supplierId, title: `${p.name} · ${record.processName}` }">发出</a-button>
              </template>
              <template v-if="canStep(record as StepRow) && record.mode !== 'EXTERNAL_OUTSOURCE' && record.status === 'PENDING'">
                <a-button size="small" type="primary" @click="startStep(record as StepRow)">开工</a-button>
              </template>
              <template v-if="canStep(record as StepRow) && record.mode !== 'EXTERNAL_OUTSOURCE' && (record.status === 'PENDING' || record.status === 'IN_PROGRESS')">
                <a-button size="small" @click="finishStep(record as StepRow)">完工</a-button>
              </template>
              <template v-if="canStep(record as StepRow) && (record.status === 'OUT' || (record.mode === 'IN_PLANT_OUTSOURCE' && record.status === 'IN_PROGRESS'))">
                <a-button size="small" @click="openReturn(p, record as StepRow)">补登返厂</a-button>
              </template>
            </a-space>
          </template>
        </template>
        <template #expandedRowRender="{ record }">
          <a-spin v-if="!eventsCache.has(record.partId)" size="small" />
          <a-empty v-else-if="!eventsCache.get(record.partId)!.some((e) => e.stepId === record.id)" description="还没有流转记录" :image="null" />
          <a-timeline v-else style="margin-top: 8px">
            <a-timeline-item v-for="e in eventsCache.get(record.partId)!.filter((x) => x.stepId === record.id)" :key="e.id">
              {{ timeText(e.occurredAt) }}　{{ EVENT_TEXT[e.type] }} {{ e.qty }} 件　<span class="muted">来源：{{ SOURCE_TEXT[e.source] }}{{ e.actorName ? `，${e.actorName}` : '' }}{{ e.qmsInspectionId ? `，报检 ${e.qmsInspectionId}` : '' }}</span>
            </a-timeline-item>
          </a-timeline>
        </template>
      </a-table>

      <a-space v-if="canRoute" class="add" wrap>
        <a-select v-model:value="draftOf(p.id).processId" placeholder="工序" style="width: 120px" :options="processOptions" />
        <a-select v-model:value="draftOf(p.id).mode" style="width: 120px" :options="modeOptions" />
        <a-select v-model:value="draftOf(p.id).supplierId" placeholder="外协厂" style="width: 160px" allow-clear show-search option-filter-prop="label" :options="supplierOptions" :disabled="draftOf(p.id).mode === 'SELF'" />
        <a-select v-model:value="draftOf(p.id).ownerId" placeholder="负责人（默认我）" style="width: 150px" allow-clear show-search option-filter-prop="label" :options="userOptions" />
        <a-date-picker v-model:value="draftOf(p.id).dueDate" placeholder="要求完成日" value-format="YYYY-MM-DD" />
        <a-select
          v-if="planNodeOptions.length"
          v-model:value="draftOf(p.id).planNodeId"
          :placeholder="planOpts.published ? '总计划节点（必选）' : '总计划节点'"
          style="width: 190px"
          allow-clear
          show-search
          option-filter-prop="label"
          :options="planNodeOptions"
          @change="(v: unknown) => { const d = planDayOf(v as string); if (d && !draftOf(p.id).dueDate) draftOf(p.id).dueDate = d }"
        />
        <a-button @click="addStep(p)">添加工序</a-button>
        <a-button v-if="!p.steps.length" @click="templateTarget = { partId: p.id, partName: p.name, mode: 'apply' }">套用模板</a-button>
        <a-button v-if="p.steps.length && me?.isAdmin" @click="templateTarget = { partId: p.id, partName: p.name, mode: 'save' }">另存为模板</a-button>
      </a-space>
    </a-card>
  </a-spin>

  <a-modal :open="partForm.open" :title="partForm.id ? '编辑工件' : '新建工件'" ok-text="保存" @ok="savePart" @cancel="partForm.open = false">
    <a-form layout="vertical">
      <a-form-item label="工件名称" required><a-input v-model:value="partForm.name" placeholder="如：主梁结构件" /></a-form-item>
      <a-form-item label="图号"><a-input v-model:value="partForm.drawingNo" /></a-form-item>
      <a-form-item label="版号"><a-input v-model:value="partForm.revision" placeholder="可空，如 A" /></a-form-item>
      <a-form-item label="数量" required><a-input-number v-model:value="partForm.quantity" :min="1" style="width: 100%" /></a-form-item>
      <a-form-item label="QMS BOM 物料 ID" extra="填了以后，QMS 报检按物料 ID 自动匹配；不填则按名称和工序匹配">
        <a-input v-model:value="partForm.qmsPartId" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal :open="copyForm.open" title="从其他工件复制工序链" ok-text="复制" @ok="doCopy" @cancel="copyForm.open = false">
    <p class="muted">复制工序、方式、外协厂和负责人，追加到当前工序链末尾；不复制日期和状态。</p>
    <a-form layout="vertical">
      <a-form-item label="来源工单">
        <a-select v-model:value="copyForm.fromWo" show-search option-filter-prop="label" :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))" @change="copyForm.fromPartId = undefined" />
      </a-form-item>
      <a-form-item label="来源工件">
        <a-select
          v-model:value="copyForm.fromPartId"
          :options="copyParts.filter((x) => x.id !== copyForm.targetId).map((x) => ({ value: x.id, label: `${x.name}（${x.steps.map((s) => s.processName).join(' → ') || '无工序'}）` }))"
        />
      </a-form-item>
    </a-form>
  </a-modal>

  <BomImportModal :open="bomImportOpen" :work-order-number="workOrderNumber" @close="bomImportOpen = false" @done="afterR8" />
  <PartTemplateModal :target="templateTarget" @close="templateTarget = null" @done="afterR8" />

  <a-modal :open="returning.open" :title="`补登返厂：${returning.partName} · ${returning.step?.processName ?? ''}`" ok-text="补登" @ok="doReturn" @cancel="returning.open = false">
    <p class="muted">QMS 漏报检时使用。数量全部返回后步骤自动完成。</p>
    <a-input-number v-model:value="returning.qty" :min="1" addon-after="件" />
  </a-modal>

  <SendStepModal :step="sending" @close="sending = null" @done="sending = null; refresh(); eventsCache.clear()" />
  <IssueReportModal
    :open="!!reportingPartId"
    :work-order-number="workOrderNumber"
    :part-id="reportingPartId ?? undefined"
    @close="reportingPartId = null"
    @done="onReported"
  />
</template>

<style scoped>
.part { margin-top: 16px; }
.muted { color: var(--ft-text-2); font-size: 12px; font-weight: normal; }
.add { margin-top: 12px; }
.issue-link { color: var(--ft-late); font-size: 12px; margin-right: 6px; }
.late-node { color: var(--ft-upstream); font-size: 12px; }
.node-link { font-size: 12px; }
</style>
