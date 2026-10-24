<script setup lang="ts">
/**
 * 导入技术部 BOM（CAD 导出的 Excel）：选文件 → 预览（服务端读表、对照已有工件）→ 勾选 → 导入。
 * 每个图号建一个工件（名称、图号、版号、数量），不建工序：自制还是外协由生产识别后再排。
 * 螺栓螺母（辅材）、没有图号的行（外购件，走采购计划）不建；已有同图号的工件跳过。
 */
const props = defineProps<{ open: boolean; workOrderNumber?: string }>()
const emit = defineEmits<{ close: []; done: [] }>()

type Status = 'new' | 'exists' | 'revisionChanged' | 'fastener' | 'noDrawing'
interface Line {
  rows: number[]
  drawingNo: string | null
  revision: string | null
  name: string
  quantity: number
  status: Status
  existing?: { id: string; name: string; revision: string | null }
  notes: string[]
}
interface Preview { rows: number; lines: Line[]; errors: { row: number; messages: string[] }[] }
interface ImportResult { created: number; skipped: number; rows: number; errors: { row: number; messages: string[] }[] }

const STATUS: Record<Status, { text: string; tone: 'primary' | 'none' | 'risk' }> = {
  new: { text: '新建', tone: 'primary' },
  exists: { text: '已有，跳过', tone: 'none' },
  revisionChanged: { text: '版号不同', tone: 'risk' },
  fastener: { text: '辅材，不建', tone: 'none' },
  noDrawing: { text: '外购件，不建', tone: 'none' },
}

const file = ref<File | null>(null)
const preview = ref<Preview | null>(null)
const selected = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const showSkipped = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    file.value = null
    preview.value = null
    selected.value = []
    showSkipped.value = false
  },
)

const send = $fetch as unknown as <T>(u: string, o: { method: 'POST'; body: FormData }) => Promise<T>
function form(mode: 'preview' | 'import') {
  const f = new FormData()
  f.append('workOrderNumber', props.workOrderNumber ?? '')
  f.append('mode', mode)
  if (mode === 'import') f.append('drawingNos', JSON.stringify(selected.value))
  f.append('file', file.value!, file.value!.name || 'bom.xlsx')
  return f
}

async function beforeUpload(f: File) {
  if (f.size > 5 * 1024 * 1024) {
    message.error('文件不能超过 5MB')
    return false
  }
  file.value = f
  preview.value = null
  loading.value = true
  try {
    preview.value = await send<Preview>('/api/bom/excel', { method: 'POST', body: form('preview') })
    selected.value = preview.value.lines.filter((l) => l.status === 'new').map((l) => l.drawingNo!)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    loading.value = false
  }
  return false // 不让组件自己上传
}

async function submit() {
  if (!selected.value.length) return message.warning('请勾选要导入的工件')
  saving.value = true
  try {
    const r = await send<ImportResult>('/api/bom/excel', { method: 'POST', body: form('import') })
    if (r.errors.length) {
      preview.value = { ...preview.value!, errors: r.errors }
      return message.error('文件里有行不对，整批没有导入')
    }
    message.success(`已建 ${r.created} 个工件。工序待生产识别自制、外协后再排`)
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}

const counts = computed(() => {
  const c: Record<Status, number> = { new: 0, exists: 0, revisionChanged: 0, fastener: 0, noDrawing: 0 }
  for (const l of preview.value?.lines ?? []) c[l.status]++
  return c
})
const shown = computed(() => (preview.value?.lines ?? []).filter((l) => showSkipped.value || l.status === 'new' || l.status === 'revisionChanged'))
const rowSelection = computed(() => ({
  selectedRowKeys: selected.value,
  onChange: (keys: (string | number)[]) => (selected.value = keys.map(String)),
  getCheckboxProps: (l: Line) => ({ disabled: l.status !== 'new' }),
}))
// 只有"新建"行按图号勾选（同图号已合并成一行）；其他行图号可能重复，用 Excel 行号
const rowKey = (l: Line) => (l.status === 'new' ? l.drawingNo! : `row-${l.rows[0]}`)

const columns = [
  { title: '行', key: 'rows', width: 70 },
  { title: '图号', dataIndex: 'drawingNo', width: 160 },
  { title: '版号', dataIndex: 'revision', width: 70 },
  { title: '部件名称', dataIndex: 'name', width: 180 },
  { title: '数量', dataIndex: 'quantity', width: 70 },
  { title: '', key: 'status', width: 110 },
  { title: '说明', key: 'notes' },
]
const errorColumns = [
  { title: 'Excel 行号', dataIndex: 'row', width: 100 },
  { title: '问题', key: 'messages' },
]
</script>

<template>
  <a-modal
    :open="open"
    :title="`导入技术部 BOM：${workOrderNumber ?? ''}`"
    width="1000px"
    :ok-text="`建 ${selected.length} 个工件`"
    :ok-button-props="{ disabled: !selected.length || !!preview?.errors.length }"
    :confirm-loading="saving"
    @ok="submit"
    @cancel="emit('close')"
  >
    <p class="muted">
      选 CAD 导出的 BOM（.xlsx），要有 图号、部件名称、数量 三列，版号可选。每个图号建一个工件，不建工序，自制还是外协由生产识别后再排。
      螺栓、螺母（生产辅材）和没有图号的外购件（走采购计划）不建；工单里已有同图号的工件跳过。
      QMS 里品质人员录完后，再点"从 QMS BOM 导入"，会按图号关联到这里建的工件，不会重复建。
    </p>
    <a-space style="margin-bottom: 12px">
      <a-upload :before-upload="beforeUpload" :show-upload-list="false" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <a-button :loading="loading">{{ file ? '换一个文件' : '选择 BOM 文件' }}</a-button>
      </a-upload>
      <span v-if="file">{{ file.name }}</span>
    </a-space>

    <template v-if="preview">
      <template v-if="preview.errors.length">
        <a-alert type="error" show-icon class="gap" :message="`${preview.errors.length} 行有问题，改好后重新选文件`" description="有任何一行不对整批不导入" />
        <a-table :columns="errorColumns" :data-source="preview.errors" row-key="row" size="small" :pagination="{ pageSize: 10, hideOnSinglePage: true }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'messages'">{{ record.messages.join('；') }}</template>
          </template>
        </a-table>
      </template>
      <template v-else>
        <div class="gap summary">
          <span class="muted">共 {{ preview.rows }} 行：新建 {{ counts.new }}，已有 {{ counts.exists }}，版号不同 {{ counts.revisionChanged }}，辅材 {{ counts.fastener }}，外购件 {{ counts.noDrawing }}</span>
          <a-checkbox v-model:checked="showSkipped">显示不建的行</a-checkbox>
        </div>
        <a-alert v-if="counts.revisionChanged" type="warning" show-icon class="gap" :message="`${counts.revisionChanged} 个图号的版号和已有工件不一样`" description="导入不会改已有工件，请走设计变更" />
        <a-table :columns="columns" :data-source="shown" :row-key="rowKey" size="small" :pagination="false" :scroll="{ y: 400 }" :row-selection="rowSelection">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'rows'">{{ (record as Line).rows.join('、') }}</template>
            <template v-else-if="column.key === 'status'">
              <UiStatusTag :tone="STATUS[(record as Line).status].tone">{{ STATUS[(record as Line).status].text }}</UiStatusTag>
            </template>
            <template v-else-if="column.key === 'notes'"><span class="muted">{{ (record as Line).notes.join('；') }}</span></template>
          </template>
        </a-table>
      </template>
    </template>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.gap { margin-bottom: 8px; }
.summary { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
</style>
