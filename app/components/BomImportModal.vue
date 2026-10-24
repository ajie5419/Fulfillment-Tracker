<script setup lang="ts">
/**
 * 从 QMS BOM 导入（R8）：打开时从 QMS 实时读本工单的 BOM（服务端读，浏览器不碰 QMS 凭据）→ 勾选 → 导入。
 * 已导入过的行不能勾；工序在履约查不到的会跳过（灰色并说明原因）。导入的步骤默认"自制"、不带负责人，回到工件页按"待补充"补。
 * 工单里已有同图号的工件（一般是技术部发放图纸时随 BOM 建的）只关联、不新建；两边图号对不上的列出来，方便查录入差异。
 */
const props = defineProps<{ open: boolean; workOrderNumber?: string }>()
const emit = defineEmits<{ close: []; done: [] }>()

interface BomProcess { processId: string | null; processName: string; problem: string | null }
interface BomRow {
  bomId: string
  partName: string
  partNumber: string | null
  partId: string | null
  material: string | null
  quantity: number
  unit: string | null
  imported: boolean
  linkTo: { partId: string; name: string; hasSteps: boolean } | null
  notInTechBom: boolean
  duplicateOf: string | null
  processes: BomProcess[]
}
interface Preview { items: BomRow[]; hasTechBom: boolean; missingInQms: { name: string; drawingNo: string | null }[] }
interface ImportResult { created: number; linked: number; steps: number; skipped: number; missing: number; warnings: string[] }
// 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"）
const get = $fetch as unknown as (url: string, opts: { query: object }) => Promise<Preview>
const post = $fetch as unknown as (url: string, opts: { method: 'POST'; body: object }) => Promise<ImportResult>

const rows = ref<BomRow[]>([])
const missingInQms = ref<Preview['missingInQms']>([])
const selected = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')

async function load() {
  if (!props.workOrderNumber) return
  loading.value = true
  loadError.value = ''
  rows.value = []
  missingInQms.value = []
  selected.value = []
  try {
    const p = await get('/api/bom/preview', { query: { workOrderNumber: props.workOrderNumber } })
    rows.value = p.items
    missingInQms.value = p.missingInQms
    // 默认勾上所有还没导入的
    selected.value = rows.value.filter((r) => !r.imported && !r.duplicateOf).map((r) => r.bomId)
  } catch (e) {
    loadError.value = apiError(e)
  } finally {
    loading.value = false
  }
}
watch(() => props.open, (open) => open && load(), { immediate: true })

const pendingCount = computed(() => rows.value.filter((r) => !r.imported && !r.duplicateOf).length)
const rowSelection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (string | number)[]) => (selected.value = keys.map(String)),
  // 同图号已有关联 QMS 的工件：导入时会跳过，不让勾
  getCheckboxProps: (r: BomRow) => ({ disabled: r.imported || !!r.duplicateOf }),
}))

async function submit() {
  if (!selected.value.length) return message.warning('请勾选要导入的零件')
  saving.value = true
  try {
    const r = await post('/api/bom/import', { method: 'POST', body: { workOrderNumber: props.workOrderNumber, bomIds: selected.value } })
    const parts = [r.linked ? `新建 ${r.created} 个、按图号关联 ${r.linked} 个工件，建 ${r.steps} 道工序` : `已导入 ${r.created} 个工件、${r.steps} 道工序`]
    if (r.skipped) parts.push(`${r.skipped} 个之前已导入，跳过`)
    if (r.missing) parts.push(`${r.missing} 个在 QMS 里已经没有了`)
    const summary = parts.join('；')
    if (r.warnings.length) {
      Modal.warning({ title: summary, content: h('div', [h('p', '以下工序没有建步骤，需要时在工件上手工添加：'), ...r.warnings.map((w) => h('div', w))]), width: 560 })
    } else message.success(summary)
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}

const columns = [
  { title: '零件名称', dataIndex: 'partName', width: 160 },
  { title: '图号', dataIndex: 'partNumber', width: 140 },
  { title: '材质', dataIndex: 'material', width: 90 },
  { title: '数量', key: 'quantity', width: 80 },
  { title: '必经工序（按顺序）', key: 'processes' },
  { title: '', key: 'state', width: 150 },
]
</script>

<template>
  <a-modal
    :open="open"
    :title="`从 QMS BOM 导入：${workOrderNumber ?? ''}`"
    width="960px"
    :ok-text="`导入 ${selected.length} 个`"
    :ok-button-props="{ disabled: !selected.length }"
    :confirm-loading="saving"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="muted">
      每个零件建一个工件（名称、图号、数量、QMS 零件 ID 带过来，报检按零件 ID 自动匹配），必经工序按顺序建成工序链，方式默认"自制"、不带负责人——导入后在工件页把标着"待补充"的工序补上方式、外协厂和负责人。已导入过的零件不会重复导入。工单里已有同图号的工件（技术部发放图纸时随 BOM 建的）不新建，只补上 QMS 零件 ID，还没有工序的按 QMS 建工序。
    </p>
    <a-alert v-if="loadError" type="error" :message="loadError" show-icon style="margin-bottom: 12px">
      <template #action><a-button size="small" @click="load">重试</a-button></template>
    </a-alert>
    <a-alert
      v-if="missingInQms.length"
      type="warning"
      show-icon
      style="margin-bottom: 12px"
      :message="`技术部 BOM 里有 ${missingInQms.length} 个图号，QMS 里还没录`"
      :description="missingInQms.slice(0, 20).map((p) => `${p.drawingNo}（${p.name}）`).join('、') + (missingInQms.length > 20 ? ' 等' : '') + '。这些工件报检暂时不能自动匹配'"
    />
    <a-table
      :columns="columns"
      :data-source="rows"
      row-key="bomId"
      size="small"
      :loading="loading"
      :pagination="false"
      :scroll="{ y: 420 }"
      :row-selection="rowSelection"
      :locale="{ emptyText: loading ? '正在读取 QMS BOM…' : loadError ? '读取失败' : 'QMS 里这个工单还没有 BOM' }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'quantity'">{{ record.quantity }} {{ record.unit ?? '' }}</template>
        <template v-else-if="column.key === 'processes'">
          <span v-if="!record.processes.length" class="muted">（没有工序，只建工件）</span>
          <template v-for="(p, i) in (record as BomRow).processes" :key="i">
            <span v-if="i" class="muted"> → </span>
            <a-tooltip v-if="p.problem" :title="`${p.problem}，导入时跳过这道`">
              <a-tag class="skip">{{ p.processName || '未命名' }}</a-tag>
            </a-tooltip>
            <a-tag v-else>{{ p.processName }}</a-tag>
          </template>
        </template>
        <template v-else-if="column.key === 'state'">
          <a-tag v-if="record.imported" color="success">已导入</a-tag>
          <a-tooltip v-else-if="record.linkTo" :title="record.linkTo.hasSteps ? '补上 QMS 零件 ID，已有工序不动' : '补上 QMS 零件 ID 和工序'">
            <UiStatusTag tone="primary">关联：{{ record.linkTo.name }}</UiStatusTag>
          </a-tooltip>
          <a-tooltip v-else-if="record.duplicateOf" :title="`同图号的工件「${record.duplicateOf}」已关联过 QMS，导入时这行跳过，不重复建`">
            <UiStatusTag tone="none">图号已有工件</UiStatusTag>
          </a-tooltip>
          <a-tooltip v-else-if="record.notInTechBom" title="技术部 BOM 里没有这个图号，导入会新建工件；请核对图号是否录错">
            <UiStatusTag tone="risk">技术 BOM 没有</UiStatusTag>
          </a-tooltip>
        </template>
      </template>
    </a-table>
    <div v-if="rows.length" class="muted" style="margin-top: 8px">共 {{ rows.length }} 个零件，{{ pendingCount }} 个未导入；灰色删除线的工序在履约查不到，导入时跳过。</div>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.skip { text-decoration: line-through; color: var(--ft-text-3); }
</style>
