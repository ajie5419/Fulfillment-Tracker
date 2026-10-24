<script setup lang="ts">
/**
 * 图纸发放单上的"BOM 表"一栏：选 CAD 导出的 BOM（.xlsx）→ 服务端预览（读表、对照该工单已有工件）→ 显示要建几个工件。
 * 真正建工件在点"发放"时（和发放单同一个事务）：每个新图号建一个工件（名称、图号、版号、数量），不建工序，
 * 自制还是外协由生产识别后再排；已有同图号的工件不重复建，一并关联到发放单；螺栓螺母（辅材）、没有图号的外购件不建。
 * 有行不对、或已有工件的版号变了（应走设计变更）时，blocked = true，发放按钮要拦下。
 */
const props = defineProps<{ workOrderNumber?: string }>()
/** 选中的文件；清空 = 不附 BOM */
const file = defineModel<File | null>('file', { default: null })
/** 预览不通过（行错误 / 版号变了 / 还在读），父组件据此拦住发放 */
const blocked = defineModel<boolean>('blocked', { default: false })

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
interface Preview { rows: number; lines: Line[]; errors: { row: number; messages: string[] }[]; blocking: number }

const preview = ref<Preview | null>(null)
const loading = ref(false)
const detailOpen = ref(false)
const showSkipped = ref(false)

/** 已有工件版号变了 = 拦下；没记版号的发放时补上 */
const isConflict = (l: Line) => l.status === 'revisionChanged' && !!l.existing?.revision
const statusOf = (l: Line): { text: string; tone: 'primary' | 'none' | 'risk' | 'late' } => {
  if (l.status === 'new') return { text: '新建', tone: 'primary' }
  if (l.status === 'exists') return { text: '已有，关联', tone: 'none' }
  if (l.status === 'revisionChanged') return isConflict(l) ? { text: '版号变了', tone: 'late' } : { text: '已有，补版号', tone: 'risk' }
  if (l.status === 'fastener') return { text: '辅材，不建', tone: 'none' }
  return { text: '外购件，不建', tone: 'none' }
}

let seq = 0
async function load() {
  const f = file.value
  const wo = props.workOrderNumber
  preview.value = null
  if (!f || !wo) {
    blocked.value = false
    return
  }
  const my = ++seq
  blocked.value = true
  loading.value = true
  try {
    const form = new FormData()
    form.append('workOrderNumber', wo)
    form.append('file', f, f.name || 'bom.xlsx')
    const send = $fetch as unknown as (u: string, o: { method: 'POST'; body: FormData }) => Promise<Preview>
    const r = await send('/api/bom/excel', { method: 'POST', body: form })
    if (my !== seq) return
    preview.value = r
    blocked.value = r.errors.length > 0 || r.blocking > 0
  } catch (e) {
    if (my !== seq) return
    message.error(apiError(e))
    file.value = null
    blocked.value = false
  } finally {
    if (my === seq) loading.value = false
  }
}
// 换文件、换工单都重新预览（工单变了，"已有工件"跟着变）
watch([file, () => props.workOrderNumber], load)

function beforeUpload(f: File) {
  if (f.size > 5 * 1024 * 1024) {
    message.error('BOM 表不能超过 5MB')
    return false
  }
  file.value = f
  return false // 不让组件自己上传，发放时再传
}

const counts = computed(() => {
  const c = { new: 0, link: 0, fill: 0, conflict: 0, skip: 0 }
  for (const l of preview.value?.lines ?? []) {
    if (l.status === 'new') c.new++
    else if (l.status === 'exists') c.link++
    else if (l.status === 'revisionChanged') isConflict(l) ? c.conflict++ : c.fill++
    else c.skip++
  }
  return c
})
const shown = computed(() => (preview.value?.lines ?? []).filter((l) => showSkipped.value || (l.status !== 'fastener' && l.status !== 'noDrawing')))
const rowKey = (l: Line) => `row-${l.rows[0]}`

const columns = [
  { title: '行', key: 'rows', width: 70 },
  { title: '图号', dataIndex: 'drawingNo', width: 170 },
  { title: '版号', dataIndex: 'revision', width: 70 },
  { title: '部件名称', dataIndex: 'name', width: 180 },
  { title: '数量', dataIndex: 'quantity', width: 70 },
  { title: '', key: 'status', width: 120 },
  { title: '说明', key: 'notes' },
]
const errorColumns = [
  { title: 'Excel 行号', dataIndex: 'row', width: 100 },
  { title: '问题', key: 'messages' },
]
</script>

<template>
  <div>
    <a-space wrap>
      <a-upload :before-upload="beforeUpload" :show-upload-list="false" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
        <a-button size="small" :loading="loading">{{ file ? '换一个文件' : '选择 BOM 表（.xlsx）' }}</a-button>
      </a-upload>
      <template v-if="file">
        <span>{{ file.name }}</span>
        <a-button size="small" type="link" danger @click="file = null">不附</a-button>
      </template>
    </a-space>
    <div v-if="!file" class="muted">
      CAD 导出的 BOM，要有 图号、部件名称、数量 三列，版号可选。发放时按图号建工件，生产、工艺签收时就能看到；分批发图纸的每批附自己那部分。
    </div>
    <template v-else-if="preview">
      <div v-if="preview.errors.length" class="line">
        <UiStatusTag tone="late">{{ preview.errors.length }} 行有问题</UiStatusTag>
        <span class="muted">改好后重新选文件，有任何一行不对都不能发放</span>
        <a-button size="small" type="link" @click="detailOpen = true">查看</a-button>
      </div>
      <template v-else>
        <div class="line">
          <span>共 {{ preview.rows }} 行：新建 <b>{{ counts.new }}</b> 个工件，已有 {{ counts.link + counts.fill }} 个一并关联<template v-if="counts.fill">（{{ counts.fill }} 个补版号）</template>，不建 {{ counts.skip }} 行</span>
          <a-button size="small" type="link" @click="detailOpen = true">查看明细</a-button>
        </div>
        <div v-if="counts.conflict" class="line">
          <UiStatusTag tone="late">{{ counts.conflict }} 个图号版号变了</UiStatusTag>
          <span class="muted">已有工件的版号和表里不一样，不能随图纸发放，请改发"设计变更"，或把这几行从表里去掉</span>
        </div>
        <div v-else class="muted">工件不建工序：自制还是外协由生产识别后再排。记得把生产部、工艺部加进接收人。</div>
      </template>
    </template>

    <a-modal v-model:open="detailOpen" :title="`BOM 明细：${file?.name ?? ''}`" width="1000px" :footer="null">
      <template v-if="preview?.errors.length">
        <a-table :columns="errorColumns" :data-source="preview.errors" row-key="row" size="small" :pagination="{ pageSize: 10, hideOnSinglePage: true }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'messages'">{{ record.messages.join('；') }}</template>
          </template>
        </a-table>
      </template>
      <template v-else-if="preview">
        <div class="line">
          <span class="muted">螺栓、螺母（生产辅材）和没有图号的外购件（走采购计划）不建工件</span>
          <a-checkbox v-model:checked="showSkipped">显示不建的行</a-checkbox>
        </div>
        <a-table :columns="columns" :data-source="shown" :row-key="rowKey" size="small" :pagination="false" :scroll="{ y: 460 }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'rows'">{{ (record as Line).rows.join('、') }}</template>
            <template v-else-if="column.key === 'status'">
              <UiStatusTag :tone="statusOf(record as Line).tone">{{ statusOf(record as Line).text }}</UiStatusTag>
            </template>
            <template v-else-if="column.key === 'notes'"><span class="muted">{{ (record as Line).notes.join('；') }}</span></template>
          </template>
        </a-table>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
</style>
