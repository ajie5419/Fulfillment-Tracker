<script setup lang="ts">
/**
 * 新建发放单（R9）：类型、工单、关联工件（可多选，可不选）、版本号、说明、附件（PDF/照片，可选），
 * 接收人按人选，或按"部门 + 角色"选（提交时展开成人）。纸质图纸照旧下发，这里登记并要求签收。
 * prefill（R11 设计任务一键发放）：预填类型、工单、关联工件、说明，并记下 drawingTaskId；打开时装入的工单不清掉预填的工件。
 * 图纸发放单可附 BOM 表（ReleaseBomField）：发放时按图号建工件、关联到发放单（从设计任务发放时也挂到该任务）。
 */
import type { ClientOptions } from '../utils/transport'
import type { UploadFile } from 'ant-design-vue'
import { formatUploadLimit } from '#shared/upload-policy'

const props = defineProps<{ open: boolean; workOrderNumber?: string; prefill?: ReleasePrefill | null }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders, error: workOrdersError, refresh: refreshWorkOrders } = await useWorkOrders()
const { data: master, error: masterError, refresh: refreshMaster } = await useMaster()
const { data: me } = await useMe()
/** 工艺部只能发工艺文件 */
const processOnly = computed(() => !!me.value?.can.releaseProcessOnly)
const typeEntries = computed(() => Object.entries(RELEASE_TYPE_TEXT).filter(([k]) => processOnly.value ? k === 'PROCESS' : !props.prefill?.drawingTaskId || k !== 'PROCESS') as [ReleaseTypeKey, string][])

const form = reactive({
  type: 'DRAWING' as ReleaseTypeKey,
  workOrderNumber: undefined as string | undefined,
  partIds: [] as string[],
  version: '',
  description: '',
  userIds: [] as string[],
  groups: [] as { department?: string; role: NonNullable<NonNullable<ClientOptions<'/api/releases', 'POST'>['body']['groups']>[number]['role']> | '' }[],
})
const files = ref<UploadFile[]>([])
const bomAttached = ref(false)
const bomBlocked = ref(false)
const bomField = ref<{ prepare: () => Promise<string | null> } | null>(null)
/** 每次打开换一个 key：BOM 栏（选的文件、粘的明细）跟着清空 */
const openSeq = ref(0)
const submitting = ref(false)
const showExistingParts = ref(false)

/** 打开时装入的工单：工单 watch 碰到它就不清工件（预填的工件要留着）；用户之后改工单照常清空 */
let loadedWo: string | undefined | null = null
watch(
  () => props.open,
  (open) => {
    if (!open) return
    const p = props.prefill
    Object.assign(form, {
      type: processOnly.value ? 'PROCESS' : (p?.type ?? 'DRAWING'),
      workOrderNumber: p?.workOrderNumber ?? props.workOrderNumber,
      partIds: [...(p?.partIds ?? [])],
      version: '',
      description: p?.description ?? '',
      userIds: [],
      groups: [],
    })
    files.value = []
    showExistingParts.value = !!p?.partIds?.length
    bomAttached.value = false
    bomBlocked.value = false
    openSeq.value++
    loadedWo = form.workOrderNumber
    if (form.workOrderNumber) refreshParts()
  },
)

const { data: parts, error: partsError, refresh: refreshParts } = await useApiFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: form.workOrderNumber })),
  default: () => [],
  immediate: false,
  watch: false,
})
watch(
  () => form.workOrderNumber,
  (wo) => {
    if (wo === loadedWo) {
      loadedWo = null
      return // 打开弹窗时装入的（含预填），上面已刷新工件
    }
    loadedWo = null
    form.partIds = []
    if (wo) refreshParts()
  },
)

const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })))
const deptOptions = computed(() => [...new Set(master.value.users.map((u) => u.department).filter(Boolean))].sort().map((d) => ({ value: d, label: d })))
const partOptions = computed(() => (form.workOrderNumber ? parts.value : []).map((p) => ({ value: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name })))

const recipientOptions = computed(() => [
  { label: '人员', options: userOptions.value.map(o => ({ ...o, value: `user:${o.value}` })) },
  { label: '部门全部人员', options: deptOptions.value.map(o => ({ label: `${o.label} · 全部人员`, value: `dept:${o.value}` })) },
  { label: '角色', options: RECIPIENT_ROLE_OPTIONS.filter(o => o.value).map(o => ({ label: o.label, value: `role:${o.value}` })) },
])
const recipientSelection = computed<string[]>({
  get: () => [...form.userIds.map(id => `user:${id}`), ...form.groups.map(g => g.role ? `role:${g.role}` : `dept:${g.department}`)],
  set: values => {
    form.userIds = values.filter(v => v.startsWith('user:')).map(v => v.slice(5))
    form.groups = values.filter(v => !v.startsWith('user:')).map(v => v.startsWith('dept:')
      ? { department: v.slice(5), role: '' }
      : { role: v.slice(5) as (typeof form.groups)[number]['role'] })
  },
})
const recipientCount = ref<number | null>(null)
const recipientError = ref('')
const recipientLoading = ref(false)
let recipientSeq = 0
async function previewRecipients() {
  const seq = ++recipientSeq
  recipientCount.value = null
  recipientError.value = ''
  recipientLoading.value = false
  if (!props.open || !form.workOrderNumber || !recipientSelection.value.length) return
  recipientLoading.value = true
  try {
    const result = await clientRequest('/api/releases/recipients-preview', { method: 'POST', body: {
      workOrderNumber: form.workOrderNumber, type: form.type, userIds: form.userIds,
      groups: form.groups.map(g => ({ department: g.department || null, role: g.role || null })),
    } })
    if (seq === recipientSeq) recipientCount.value = result.count
  } catch (error) {
    if (seq === recipientSeq) recipientError.value = apiError(error)
  } finally {
    if (seq === recipientSeq) recipientLoading.value = false
  }
}
watch([() => props.open, () => form.workOrderNumber, () => form.type, recipientSelection], previewRecipients)

function beforeUpload(file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    message.error(`${file.name} 超过 ${formatUploadLimit(MAX_ATTACHMENT_BYTES)}`)
    return false
  }
  if (files.value.length >= MAX_ATTACHMENTS) {
    message.warning(`附件最多 ${MAX_ATTACHMENTS} 个`)
    return false
  }
  files.value = [...files.value, { uid: `${Date.now()}-${file.name}`, name: file.name, originFileObj: file as UploadFile['originFileObj'], status: 'done' }]
  return false // 不自动上传，提交时再传
}
function removeFile(f: UploadFile) {
  files.value = files.value.filter((x) => x.uid !== f.uid)
}

async function submit() {
  if (submitting.value) return
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.description.trim()) return message.warning('请填写说明')
  const groups = form.groups.filter((g) => g.department || g.role).map((g) => ({ department: g.department || null, role: g.role || null }))
  if (form.groups.some(g => !g.department && !g.role) && !form.userIds.length && !groups.length) return message.warning('空部门行不代表全部人员，请选择部门或角色')
  if (!form.userIds.length && !groups.length) return message.warning('请选择接收人')
  if (recipientLoading.value || recipientCount.value === null || recipientError.value) return message.warning('请先确认接收范围预览成功')
  const withBom = form.type === 'DRAWING' && bomAttached.value
  if (withBom && bomBlocked.value) return message.warning('BOM 表还没识别好或有问题，看 BOM 表一栏的提示；不附的话点"不附"或"清空"')
  submitting.value = true
  try {
    const attachmentIds = await uploadAttachments(files.value.map((f) => f.originFileObj as File).filter(Boolean))
    const bomFileId = withBom ? ((await bomField.value?.prepare()) ?? null) : null
    const r = await releasePost('/api/releases', {
      type: form.type,
      workOrderNumber: form.workOrderNumber,
      partIds: form.partIds,
      version: form.version.trim() || null,
      description: form.description.trim(),
      attachmentIds,
      userIds: form.userIds,
      groups,
      drawingTaskId: props.prefill?.drawingTaskId ?? null,
      bomFileId,
    })
    const extra =
      form.type === 'CHANGE' && (r.impact.started || r.impact.held)
        ? `；${r.impact.started ? `${r.impact.started} 道工序已在加工/在外，已通知确认变更影响` : ''}${r.impact.started && r.impact.held ? '，' : ''}${r.impact.held ? `${r.impact.held} 道未开工工序标"等变更"` : ''}`
        : ''
    const drawing = r.drawing ? `；设计任务${r.drawing.status === 'DONE' ? '已完成' : r.drawing.status === 'CUSTOMER_PENDING' ? '待客户确认' : '已更新'}${r.drawing.readySent ? `，${r.drawing.readySent} 个工件已通知"可以开工"` : ''}` : ''
    const bom = !r.bom ? '' : r.bom.created ? `；按 BOM 新建 ${r.bom.created} 个工件${r.bom.matched ? `，关联已有 ${r.bom.matched} 个` : ''}` : r.bom.matched ? `；BOM 里的 ${r.bom.matched} 个工件都已有，已关联` : '；BOM 本次没有关联工件'
    const purchasePlan = r.bom?.purchasePlanItems ? `；另有 ${r.bom.purchasePlanItems} 项外购件已生成采购计划草稿` : ''
    const route = r.bom?.unrouted
      ? `；${r.bom.unrouted} 个工件还没有工序链，${r.bom.unroutedNotified ? '已提醒生产经理排工序' : '但还没设生产部负责人、没人收到提醒，请到"设置→人员与角色"指定'}`
      : ''
    const material = r.material?.revising
      ? `；${r.material.revising} 个部件的料单已下发，已改为"修改中"${r.material.notified ? '并提醒工艺部负责人' : '（还没设工艺部负责人，没人收到提醒，请到"设置→人员与角色"指定）'}`
      : ''
    message.success(`已发放 ${r.releaseNo}，${r.recipients} 人待签收${bom}${purchasePlan}${route}${extra}${drawing}${material}`, 6)
    emit('done', r.id)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <a-modal :open="open" title="新建发放单" ok-text="确认发放" :confirm-loading="submitting" width="760px" :style="{ top: '24px' }" :body-style="{ maxHeight: 'calc(100dvh - 160px)', overflowY: 'auto', paddingRight: '4px' }" @ok="submit" @cancel="emit('close')">
    <a-form layout="vertical" class="release-form">
      <UiSectionCard flat title="发放内容">
        <p v-if="prefill?.label" class="task-context">{{ prefill.label }}</p>
        <div class="field-grid">
          <a-form-item label="工单" required>
            <a-select v-model:value="form.workOrderNumber" :disabled="!!prefill?.drawingTaskId || !!workOrdersError" show-search option-filter-prop="label" placeholder="选择工单" :options="workOrders.map(w => ({ value: w.workOrderNumber, label: w.workOrderNumber + '　' + (w.projectName ?? w.customerName) }))" />
            <div v-if="workOrdersError" class="error">工单加载失败 <a-button type="link" size="small" @click="refreshWorkOrders()">重试</a-button></div>
          </a-form-item>
          <a-form-item label="发放类型" required>
            <a-segmented v-model:value="form.type" :options="typeEntries.map(([value, label]) => ({ value, label }))" />
          </a-form-item>
        </div>
        <p v-if="form.type === 'CHANGE'" class="muted">已开工工件将通知相关人员确认变更影响；未开工工序将暂停并等待变更确认。</p>
        <a-form-item label="图纸 / 文件版本"><a-input v-model:value="form.version" :maxlength="64" placeholder="如 A、B、V2（可选）" /></a-form-item>
        <a-form-item label="发放说明" required><a-textarea v-model:value="form.description" :rows="2" :maxlength="2000" show-count placeholder="说明发放内容；设计变更请注明修改位置与内容" /></a-form-item>
        <a-form-item label="图纸 / 文件附件（可选）">
          <a-upload :file-list="files" :before-upload="beforeUpload" accept=".pdf,image/jpeg,image/png,image/webp" multiple @remove="removeFile"><a-button>上传 PDF / 照片</a-button></a-upload>
          <div class="muted">纸质图纸可直接登记发放。每个附件不超过 {{ formatUploadLimit(MAX_ATTACHMENT_BYTES) }}，最多 {{ MAX_ATTACHMENTS }} 个。</div>
        </a-form-item>
      </UiSectionCard>
      <UiSectionCard flat :title="form.type === 'DRAWING' ? '生产明细（BOM）' : '关联生产工件'">
        <template v-if="form.type === 'DRAWING'">
          <p class="muted">可选。发放后按 BOM 创建或匹配生产工件；原理图、技术协议等可不附 BOM。</p>
          <ReleaseBomField :key="openSeq" ref="bomField" v-model:attached="bomAttached" v-model:blocked="bomBlocked" :work-order-number="form.workOrderNumber" />
        </template>
        <a-checkbox v-if="form.type === 'DRAWING'" v-model:checked="showExistingParts" class="existing-toggle">补充关联已有工件（补发图纸时使用）</a-checkbox>
        <a-form-item v-if="showExistingParts || form.type !== 'DRAWING'" label="已有工件（可选）">
          <a-select v-model:value="form.partIds" mode="multiple" allow-clear option-filter-prop="label" :disabled="!form.workOrderNumber || !!partsError" placeholder="选择本次发放涉及的已有工件" :options="partOptions" />
          <div v-if="partsError" class="error">工件加载失败 <a-button type="link" size="small" @click="refreshParts()">重试</a-button></div>
        </a-form-item>
        <p v-else-if="form.partIds.length" class="muted">已关联 {{ form.partIds.length }} 个已有工件，展开后可调整。</p>
      </UiSectionCard>
      <UiSectionCard flat title="接收范围">
        <a-form-item label="接收人员 / 部门 / 角色" required>
          <a-select v-model:value="recipientSelection" mode="multiple" show-search option-filter-prop="label" :disabled="!!masterError" placeholder="搜索并选择人员、部门或角色，可组合选择" :options="recipientOptions" />
          <div v-if="masterError" class="error">人员加载失败 <a-button type="link" size="small" @click="refreshMaster()">重试</a-button></div>
        </a-form-item>
        <div class="release-summary" aria-live="polite">
          <span v-if="recipientLoading">正在核对接收范围…</span>
          <span v-else-if="recipientError" class="error">{{ recipientError }} <a-button type="link" size="small" @click="previewRecipients">重试</a-button></span>
          <span v-else-if="recipientCount !== null">本次发放：{{ recipientCount }} 人待签收<span v-if="form.partIds.length">，另选 {{ form.partIds.length }} 个已有工件</span>。</span>
          <span v-else>选择接收范围后显示实际签收人数。</span>
          <div class="muted">重复人员只生成一条签收待办；按部门或角色选择时不包含发放人本人。</div>
          <div v-if="form.type === 'DRAWING' && !bomAttached" class="muted">未附 BOM，本次不会创建生产工件。</div>
        </div>
      </UiSectionCard>
    </a-form>
  </a-modal>
</template>

<style scoped>
.release-form { display: grid; gap: 12px; }
.release-form :deep(.ant-form-item) { margin-bottom: 14px; }
.release-form :deep(.ft-section + .ft-section) { border-top: 1px solid var(--ft-border); padding-top: 12px; }
.field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.field-grid > * { min-width: 0; }
.task-context { margin: 0 0 16px; font-weight: 600; }
.muted { color: var(--ft-text-2); font-size: 12px; line-height: 1.6; }
.error { color: var(--ft-late-text); }
.existing-toggle { margin: 16px 0; }
.release-summary { padding: 12px; background: var(--ft-fill); border-radius: 8px; line-height: 1.8; }
@media (max-width: 600px) { .field-grid { grid-template-columns: minmax(0, 1fr); gap: 0; } }
</style>
