<script setup lang="ts">
/**
 * 新建发放单（R9）：类型、工单、关联工件（可多选，可不选）、版本号、说明、附件（PDF/照片，可选），
 * 接收人按人选，或按"部门 + 角色"选（提交时展开成人）。纸质图纸照旧下发，这里登记并要求签收。
 * prefill（R11 设计任务一键发放）：预填类型、工单、关联工件、说明，并记下 drawingTaskId；打开时装入的工单不清掉预填的工件。
 * 图纸发放单可附 BOM 表（ReleaseBomField）：发放时按图号建工件、关联到发放单（从设计任务发放时也挂到该任务）。
 */
import type { ClientOptions } from '../utils/transport'
import type { UploadFile } from 'ant-design-vue'

const props = defineProps<{ open: boolean; workOrderNumber?: string; prefill?: ReleasePrefill | null }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const { data: me } = await useMe()
/** 工艺部只能发工艺文件 */
const processOnly = computed(() => !!me.value?.can.releaseProcessOnly)
const typeEntries = computed(() => Object.entries(RELEASE_TYPE_TEXT).filter(([k]) => !processOnly.value || k === 'PROCESS') as [ReleaseTypeKey, string][])

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
    openSeq.value++
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
  if (form.groups.some(g => !g.department && !g.role) && !form.userIds.length && !groups.length) return message.warning('空部门行不代表全部人员，请选择部门或角色')
  if (!form.userIds.length && !groups.length) return message.warning('请选择接收人')
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
  <a-modal :open="open" :title="prefill?.label ? `新建发放单（${prefill.label}）` : '新建发放单'" ok-text="发放" :confirm-loading="submitting" width="720px" @ok="submit" @cancel="emit('close')">
    <a-form layout="horizontal" :label-col="{ span: 4 }" :wrapper-col="{ span: 19 }">
      <a-form-item label="类型" required>
        <a-radio-group v-model:value="form.type">
          <a-radio-button v-for="[key, label] in typeEntries" :key="key" :value="key">{{ label }}</a-radio-button>
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
      <a-form-item v-if="form.type === 'DRAWING'" label="BOM 表">
        <ReleaseBomField :key="openSeq" ref="bomField" v-model:attached="bomAttached" v-model:blocked="bomBlocked" :work-order-number="form.workOrderNumber" />
      </a-form-item>
      <a-form-item label="关联工件">
        <a-select v-model:value="form.partIds" mode="multiple" allow-clear option-filter-prop="label" :placeholder="form.workOrderNumber ? (bomAttached && form.type === 'DRAWING' ? 'BOM 里的工件发放时自动关联，这里可不选' : '可多选，可不选') : '先选工单'" :options="partOptions" />
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
      <a-form-item label="接收范围（按人或按部门 + 角色，至少选一项）" required>
        <a-select v-model:value="form.userIds" mode="multiple" show-search option-filter-prop="label" placeholder="选择人员" :options="userOptions" />
      </a-form-item>
      <a-form-item label="按部门 + 角色（与按人任选其一）">
        <div v-for="(g, i) in form.groups" :key="i" class="group-row">
          <a-select v-model:value="g.department" allow-clear placeholder="部门（只选全部人员时必填）" style="width: 180px" :options="deptOptions" />
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
