<script setup lang="ts">
/**
 * 电脑端上报异常弹窗，与手机端 /m/issue-new 同字段、同接口：
 * 工单 → 可选工件 → 分类（系统按分类默认责任部门和责任人；外协类可选外协单位）→ 一句话 + 照片（最多 3 张）→ 要求解决日。
 * 校验与业务规则都在服务端（POST /api/uploads、POST /api/issues），这里只做选择时的提示。
 */
import type { UploadFile } from 'ant-design-vue'
import type { Dayjs } from 'dayjs'

const props = defineProps<{ open: boolean; workOrderNumber?: string; partId?: string }>()
const emit = defineEmits<{ close: []; done: [issue: { id: string; issueNo: string }] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const { data: options } = await useIssueOptions()

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const form = reactive({
  workOrderNumber: undefined as string | undefined,
  partId: undefined as string | undefined,
  category: undefined as IssueCategoryKey | undefined,
  description: '',
  supplierId: undefined as string | undefined,
  dueDate: undefined as string | undefined,
})
const photos = ref<UploadFile[]>([])
const submitting = ref(false)

const { data: parts, refresh: refreshParts } = await useFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: form.workOrderNumber })),
  default: () => [],
  immediate: false,
  watch: false, // 换工单时手动刷新
})

// 每次打开都从头填；从工件页进来时带上工单和工件
watch(
  () => props.open,
  (open) => {
    if (!open) return
    Object.assign(form, {
      workOrderNumber: props.workOrderNumber || undefined,
      partId: props.partId || undefined,
      category: undefined,
      description: '',
      supplierId: undefined,
      dueDate: undefined,
    })
    photos.value = []
    if (form.workOrderNumber) refreshParts()
  },
  { immediate: true },
)

function onWorkOrder() {
  form.partId = undefined
  if (form.workOrderNumber) refreshParts()
}

const cat = computed(() => options.value.categories.find((c) => c.value === form.category))
const workOrderOptions = computed(() =>
  workOrders.value.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName ?? ''}` })),
)
const partOptions = computed(() => parts.value.map((p) => ({ value: p.id, label: p.drawingNo ? `${p.name}（${p.drawingNo}）` : p.name })))
const supplierOptions = computed(() => master.value.suppliers.map((s) => ({ value: s.id, label: s.label })))

/** 选照片时先拦一道（与手机端一致），不自动上传，提交时一起传 */
function beforeUpload(file: File) {
  if (!PHOTO_TYPES.includes(file.type)) {
    message.error('只能上传 JPG、PNG、WebP 照片')
    return false
  }
  if (file.size > MAX_PHOTO_BYTES) {
    message.error('每张照片不能超过 8MB')
    return false
  }
  if (photos.value.length >= MAX_PHOTOS) {
    message.error(`照片最多 ${MAX_PHOTOS} 张`)
    return false
  }
  photos.value = [...photos.value, { uid: `${Date.now()}-${file.name}`, name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] }]
  return false
}
/** 与手机端一致：只能选今天及以后 */
const pastDay = (d: Dayjs) => d.isBefore(new Date(), 'day')

function removePhoto(file: UploadFile) {
  photos.value = photos.value.filter((p) => p.uid !== file.uid)
}

async function submit() {
  if (submitting.value) return
  if (!form.workOrderNumber || !form.category || !form.description.trim()) return message.warning('请选工单、分类，并写一句话描述')
  // 先把这次要提交的内容定下来，上传照片期间表单再变也不影响这一条
  const body = {
    workOrderNumber: form.workOrderNumber,
    partId: form.partId || null,
    category: form.category,
    description: form.description.trim(),
    dueDate: form.dueDate || null,
    responsibleSupplierId: cat.value?.supplier ? form.supplierId || null : null,
  }
  const files = photos.value.map((p) => p.originFileObj).filter((f): f is NonNullable<typeof f> => !!f) as File[]
  submitting.value = true
  try {
    const photoIds = await uploadPhotos(files)
    const send = clientRequest
    const r = await send('/api/issues', { method: 'POST', body: { ...body, photoIds } })
    message.success(`已上报 ${r.issueNo}`)
    emit('done', r)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    submitting.value = false
  }
}

/** 提交中不能关闭，避免关掉后又开一张新的 */
function close() {
  if (!submitting.value) emit('close')
}
</script>

<template>
  <a-modal
    :open="open"
    title="上报异常"
    :confirm-loading="submitting"
    ok-text="提交异常"
    width="560px"
    :closable="!submitting"
    :mask-closable="!submitting"
    :keyboard="!submitting"
    :cancel-button-props="{ disabled: submitting }"
    @ok="submit"
    @cancel="close"
  >
    <a-form layout="vertical">
      <a-form-item label="工单" required>
        <a-select
          v-model:value="form.workOrderNumber"
          show-search
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrderOptions"
          @change="onWorkOrder"
        />
      </a-form-item>
      <a-form-item label="工件（可不选）">
        <a-select v-model:value="form.partId" allow-clear :disabled="!form.workOrderNumber" placeholder="不选工件" :options="partOptions" />
      </a-form-item>
      <a-form-item label="分类" required :extra="cat ? `默认责任部门：${cat.deptName}` : undefined">
        <a-radio-group v-model:value="form.category" size="small">
          <a-radio-button v-for="c in options.categories" :key="c.value" :value="c.value" style="margin-bottom: 6px">{{ c.label }}</a-radio-button>
        </a-radio-group>
      </a-form-item>
      <a-form-item v-if="cat?.supplier" label="外协单位（可不指定）">
        <a-select v-model:value="form.supplierId" allow-clear show-search option-filter-prop="label" placeholder="不指定" :options="supplierOptions" />
      </a-form-item>
      <a-form-item label="一句话描述" required>
        <a-textarea v-model:value="form.description" :rows="2" :maxlength="500" show-count placeholder="发生了什么？如：涂装件返回有流挂，需返修" />
      </a-form-item>
      <a-form-item :label="`照片（最多 ${MAX_PHOTOS} 张，每张不超过 8MB）`">
        <a-upload
          :file-list="photos"
          list-type="picture-card"
          accept="image/jpeg,image/png,image/webp"
          multiple
          :before-upload="beforeUpload"
          @remove="removePhoto"
        >
          <div v-if="photos.length < MAX_PHOTOS">+ 选择照片</div>
        </a-upload>
      </a-form-item>
      <a-form-item label="要求解决日（可不填，受理时默认 +3 天）">
        <UiDatePicker v-model:value="form.dueDate" :disabled-date="pastDay" style="width: 100%" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
