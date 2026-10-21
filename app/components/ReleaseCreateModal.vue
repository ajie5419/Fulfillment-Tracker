<script setup lang="ts">
/**
 * 新建发放单（R9）：类型、工单、关联工件（可多选，可不选）、版本号、说明、附件（PDF/照片，可选），
 * 接收人按人选，或按"部门 + 角色"选（提交时展开成人）。纸质图纸照旧下发，这里登记并要求签收。
 * prefill（R11 出图任务一键发放）：预填类型、工单、关联工件、说明，并记下 drawingTaskId；打开时装入的工单不清掉预填的工件。
 */
import type { UploadFile } from 'ant-design-vue'

const props = defineProps<{ open: boolean; workOrderNumber?: string; prefill?: ReleasePrefill | null }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const form = reactive({
  type: 'DRAWING' as ReleaseTypeKey,
  workOrderNumber: undefined as string | undefined,
  partIds: [] as string[],
  version: '',
  description: '',
  userIds: [] as string[],
  groups: [] as { department?: string; role: string }[],
})
const files = ref<UploadFile[]>([])
const submitting = ref(false)

/** 打开时装入的工单：工单 watch 碰到它就不清工件（预填的工件要留着）；用户之后改工单照常清空 */
let loadedWo: string | undefined | null = null
watch(
  () => props.open,
  (open) => {
    if (!open) return
    const p = props.prefill
    Object.assign(form, {
      type: p?.type ?? 'DRAWING',
      workOrderNumber: p?.workOrderNumber ?? props.workOrderNumber,
      partIds: [...(p?.partIds ?? [])],
      version: '',
      description: p?.description ?? '',
      userIds: [],
      groups: [],
    })
    files.value = []
    loadedWo = form.workOrderNumber
    if (form.workOrderNumber) refreshParts()
  },
)

const { data: parts, refresh: refreshParts } = await useFetch('/api/parts', {
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

function beforeUpload(file: File) {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    message.error(`${file.name} 超过 20MB`)
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
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.description.trim()) return message.warning('请填写说明')
  const groups = form.groups.filter((g) => g.department || g.role).map((g) => ({ department: g.department || null, role: g.role || null }))
  if (!form.userIds.length && !groups.length) return message.warning('请选择接收人')
  submitting.value = true
  try {
    const attachmentIds = await uploadAttachments(files.value.map((f) => f.originFileObj as File).filter(Boolean))
    const r = await releasePost<{ id: string; releaseNo: string; recipients: number; impact: { started: number; held: number; confirmers: string[] }; drawing: { status: string; readySent: number } | null }>('/api/releases', {
      type: form.type,
      workOrderNumber: form.workOrderNumber,
      partIds: form.partIds,
      version: form.version.trim() || null,
      description: form.description.trim(),
      attachmentIds,
      userIds: form.userIds,
      groups,
      drawingTaskId: props.prefill?.drawingTaskId ?? null,
    })
    const extra =
      form.type === 'CHANGE' && (r.impact.started || r.impact.held)
        ? `；${r.impact.started ? `${r.impact.started} 道工序已在加工/在外，已通知确认变更影响` : ''}${r.impact.started && r.impact.held ? '，' : ''}${r.impact.held ? `${r.impact.held} 道未开工工序标"等变更"` : ''}`
        : ''
    const drawing = r.drawing ? `；出图任务${r.drawing.status === 'DONE' ? '已完成' : r.drawing.status === 'CUSTOMER_PENDING' ? '待客户确认' : '已更新'}${r.drawing.readySent ? `，${r.drawing.readySent} 个工件已通知"可以开工"` : ''}` : ''
    message.success(`已发放 ${r.releaseNo}，${r.recipients} 人待签收${extra}${drawing}`, 6)
    emit('done', r.id)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <a-modal :open="open" :title="prefill?.label ? `新建发放单（${prefill.label}）` : '新建发放单'" ok-text="发放" :confirm-loading="submitting" width="720px" @ok="submit" @cancel="emit('close')">
    <a-form layout="horizontal" :label-col="{ span: 4 }" :wrapper-col="{ span: 19 }">
      <a-form-item label="类型" required>
        <a-radio-group v-model:value="form.type">
          <a-radio-button v-for="(label, key) in RELEASE_TYPE_TEXT" :key="key" :value="key">{{ label }}</a-radio-button>
        </a-radio-group>
        <div v-if="form.type === 'CHANGE'" class="muted">关联工件已在加工/在外协的，会通知生产经理和外协专员确认变更影响；还没开工的工序标"等变更"，暂停转序/逾期预警计时。</div>
      </a-form-item>
      <a-form-item label="工单" required>
        <a-select
          v-model:value="form.workOrderNumber"
          :disabled="!!prefill?.drawingTaskId"
          show-search
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))"
        />
      </a-form-item>
      <a-form-item label="关联工件">
        <a-select v-model:value="form.partIds" mode="multiple" allow-clear option-filter-prop="label" :placeholder="form.workOrderNumber ? '可多选，可不选' : '先选工单'" :options="partOptions" />
      </a-form-item>
      <a-form-item label="版本号"><a-input v-model:value="form.version" :maxlength="64" placeholder="如 A、B、V2，可空" /></a-form-item>
      <a-form-item label="说明" required>
        <a-textarea v-model:value="form.description" :rows="3" :maxlength="2000" show-count placeholder="发的是什么、改了什么，如：支腿连接板安装孔由 Φ22 改为 Φ26" />
      </a-form-item>
      <a-form-item label="附件">
        <a-upload :file-list="files" :before-upload="beforeUpload" accept=".pdf,image/jpeg,image/png,image/webp" multiple @remove="removeFile">
          <a-button size="small">选择 PDF / 照片</a-button>
        </a-upload>
        <div class="muted">可选，纸质图纸照旧下发；每个 ≤ 20MB，最多 {{ MAX_ATTACHMENTS }} 个</div>
      </a-form-item>
      <a-form-item label="接收人（按人）">
        <a-select v-model:value="form.userIds" mode="multiple" show-search option-filter-prop="label" placeholder="选择人员" :options="userOptions" />
      </a-form-item>
      <a-form-item label="按部门 + 角色">
        <div v-for="(g, i) in form.groups" :key="i" class="group-row">
          <a-select v-model:value="g.department" allow-clear placeholder="部门（可空）" style="width: 180px" :options="deptOptions" />
          <a-select v-model:value="g.role" style="width: 150px" :options="RECIPIENT_ROLE_OPTIONS.map((o) => ({ ...o }))" />
          <a-button size="small" type="link" danger @click="form.groups.splice(i, 1)">删除</a-button>
        </div>
        <a-button size="small" @click="form.groups.push({ department: undefined, role: '' })">+ 添加部门 / 角色</a-button>
        <div class="muted">发放时展开成人（不含你自己），每人一条签收待办；只选部门 = 该部门全部人员</div>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.group-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
</style>
