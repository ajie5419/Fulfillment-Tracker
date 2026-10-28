<script setup lang="ts">
/**
 * 发出登记：选工单 → 选工件（自动选中第一个待发出的厂外外协步骤）→ 外协厂（默认工序链里计划的或上次用的）
 * → 承诺返回日（常用天数一点即选）→ 提交。默认值都对时只需 4 次点击（方案 7.2）。
 * 从待办进来时带 ?stepId=，直接预填。
 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const workOrderNumber = ref<string>('')
const partId = ref<string>('')
const stepId = ref<string>('')
const supplierId = ref<string>('')
const promisedReturnDate = ref<string>('')
/** 随件发料（外协带料） */
const note = ref('')
const lastSupplierId = ref<string | null>(null)

const fetchParts = (wo: string) => $fetch('/api/parts', { query: { workOrderNumber: wo } })
type PartRow = Awaited<ReturnType<typeof fetchParts>>[number]
const parts = ref<PartRow[]>([])
let partsSeq = 0
let selectionVersion = 0
async function refreshParts() {
  const seq = ++partsSeq
  const wo = workOrderNumber.value
  if (!wo) return false
  try {
    const result = await fetchParts(wo)
    if (seq !== partsSeq || wo !== workOrderNumber.value) return false
    parts.value = result
    return true
  } catch (e) {
    if (seq === partsSeq && wo === workOrderNumber.value) showFailToast(apiError(e))
    return false
  }
}
const pendingSteps = (p: PartRow) => p.steps.filter((s) => s.mode === 'EXTERNAL_OUTSOURCE' && s.status === 'PENDING')
const sendableParts = computed(() => parts.value.filter((p) => pendingSteps(p).length))
const part = computed(() => parts.value.find((p) => p.id === partId.value && p.workOrderNumber === workOrderNumber.value))
const step = computed(() => part.value?.steps.find((s) => s.id === stepId.value))
const supplierName = computed(() => master.value.suppliers.find((s) => s.id === supplierId.value)?.label ?? '')
const workOrder = computed(() => workOrders.value.find((w) => w.workOrderNumber === workOrderNumber.value))

onMounted(async () => {
  const version = selectionVersion
  try {
    lastSupplierId.value = (await $fetch('/api/last-supplier')).supplierId
  } catch (e) {
    if (version === selectionVersion) showFailToast(apiError(e))
  }
  if (version !== selectionVersion) return
  const fromTodo = route.query.stepId
  if (typeof fromTodo === 'string' && fromTodo) {
    try {
      const s = await $fetch(`/api/steps/${encodeURIComponent(fromTodo)}`)
      if (version !== selectionVersion) return
      workOrderNumber.value = s.part.workOrderNumber
      if (await refreshParts() && version === selectionVersion) choosePart(s.partId, s.id)
    } catch (e) {
      if (version === selectionVersion) showFailToast(apiError(e))
    }
  }
})

function chooseWorkOrder(wo: string) {
  selectionVersion++
  partsSeq++
  workOrderNumber.value = wo
  parts.value = []
  choosePart('')
  if (wo) void refreshParts()
}

function choosePart(id: string, preferStepId?: string) {
  selectionVersion++
  partId.value = id
  const p = parts.value.find((x) => x.id === id)
  const steps = p ? pendingSteps(p) : []
  const s = steps.find((x) => x.id === preferStepId) ?? steps[0]
  chooseStep(s?.id ?? '')
}

function chooseStep(id: string) {
  if (id && id === stepId.value) return
  selectionVersion++
  // Dates and material notes belong to this step, never the previous selection.
  promisedReturnDate.value = ''
  note.value = ''
  showCalendar.value = false
  showSupplier.value = false
  const s = part.value && pendingSteps(part.value).find((x) => x.id === id)
  stepId.value = s?.id ?? ''
  supplierId.value = s ? s.supplierId ?? lastSupplierId.value ?? '' : ''
}

const quickDays = [3, 7, 10, 15]
const showCalendar = ref(false)
const showSupplier = ref(false)
const supplierColumns = computed(() => master.value.suppliers.map((s) => ({ text: s.label, value: s.id })))
function onCalendar(d: Date) {
  promisedReturnDate.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  showCalendar.value = false
}
function onSupplier({ selectedValues }: { selectedValues: (string | number)[] }) {
  supplierId.value = String(selectedValues[0] ?? '')
  showSupplier.value = false
}

const submitting = ref(false)
const canSubmit = computed(() => !!workOrder.value && !!part.value && step.value?.mode === 'EXTERNAL_OUTSOURCE' && step.value.status === 'PENDING' && !!supplierId.value && !!promisedReturnDate.value)
async function submit() {
  if (submitting.value) return
  if (!canSubmit.value) return showToast('请选好工件、外协厂和承诺返回日')
  const version = selectionVersion
  const submittedSupplier = supplierId.value
  submitting.value = true
  try {
    await $fetch(`/api/steps/${stepId.value}/send`, {
      method: 'POST',
      body: { supplierId: supplierId.value, promisedReturnDate: promisedReturnDate.value, note: note.value || null, source: 'MOBILE' },
    })
    lastSupplierId.value = submittedSupplier
    if (version !== selectionVersion) return
    showSuccessToast('已登记发出')
    choosePart('')
    await Promise.all([refreshParts(), refreshNuxtData('todos')])
  } catch (e) {
    if (version === selectionVersion) showFailToast(apiError(e))
  } finally {
    submitting.value = false
  }
}
onBeforeUnmount(() => {
  selectionVersion++
  partsSeq++
})
</script>

<template>
  <div class="page">
    <van-nav-bar title="发出登记" />

    <van-cell-group inset title="1. 工单">
      <van-cell v-if="workOrderNumber" :title="workOrderNumber" :label="workOrder?.projectName ?? ''" is-link value="换一个" @click="chooseWorkOrder('')" />
      <template v-else>
        <van-empty v-if="!workOrders.length" description="没有工单" image-size="60" />
        <van-cell
          v-for="w in workOrders"
          :key="w.workOrderNumber"
          :title="w.workOrderNumber"
          :label="`${w.projectName ?? w.customerName}　交期 ${dayText(w.deliveryDate)}`"
          is-link
          @click="chooseWorkOrder(w.workOrderNumber)"
        />
      </template>
    </van-cell-group>

    <van-cell-group v-if="workOrderNumber" inset title="2. 工件（只列有待发出外协的）">
      <van-cell v-if="part" :title="part.name" :label="`数量 ${part.quantity}`" is-link value="换一个" @click="choosePart('')" />
      <template v-else>
        <van-empty v-if="!sendableParts.length" description="这个工单没有待发出的外协工序" image-size="60" />
        <van-cell
          v-for="p in sendableParts"
          :key="p.id"
          :title="p.name"
          :label="`待发出：${pendingSteps(p).map((s) => s.processName).join('、')}`"
          is-link
          @click="choosePart(p.id)"
        />
      </template>
      <div v-if="part && pendingSteps(part).length > 1" class="chips">
        <van-tag
          v-for="s in pendingSteps(part)"
          :key="s.id"
          size="large"
          :type="s.id === stepId ? 'primary' : 'default'"
          :plain="s.id !== stepId"
          @click="chooseStep(s.id)"
        >
          {{ s.seq }}. {{ s.processName }}
        </van-tag>
      </div>
      <van-cell v-else-if="step" title="工序" :value="`${step.seq}. ${step.processName}`" />
    </van-cell-group>

    <van-cell-group v-if="step" inset title="3. 外协厂与承诺返回日">
      <van-cell title="外协厂" :value="supplierName || '请选择'" is-link @click="showSupplier = true" />
      <div class="chips">
        <van-tag
          v-for="d in quickDays"
          :key="d"
          size="large"
          :type="promisedReturnDate === dayAfter(d) ? 'primary' : 'default'"
          :plain="promisedReturnDate !== dayAfter(d)"
          @click="promisedReturnDate = dayAfter(d)"
        >
          {{ d }} 天后
        </van-tag>
        <van-tag size="large" plain @click="showCalendar = true">选日期</van-tag>
      </div>
      <van-cell title="承诺返回日" :value="promisedReturnDate || '未选'" />
      <van-field v-model="note" label="随件发料" placeholder="供料时写发了什么，不供料空着" maxlength="200" />
    </van-cell-group>

    <div class="m-submit">
      <van-button type="primary" block round :disabled="!canSubmit" :loading="submitting" @click="submit">提交发出</van-button>
    </div>

    <van-calendar v-model:show="showCalendar" :show-confirm="false" :min-date="new Date()" @confirm="onCalendar" />
    <van-popup v-model:show="showSupplier" position="bottom" round>
      <van-picker title="选择外协厂" :columns="supplierColumns" :model-value="supplierId ? [supplierId] : []" @confirm="onSupplier" @cancel="showSupplier = false" />
    </van-popup>
  </div>
</template>

<style scoped>
.page { padding-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; background: var(--ft-card-bg); }
.chips :deep(.van-tag) { cursor: pointer; }
</style>
