<script setup lang="ts">
/**
 * 手机快速上报异常（方案 7.2，≤ 1 分钟）：选工单 → 可选工件 → 选分类 → 一句话 + 拍照/相册（最多 3 张）→ 提交。
 * 系统按分类默认责任部门和责任人；外协类可选外协单位。从工件页等处进来时可带 ?wo=&partId=。
 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()
const { data: options } = await useIssueOptions()

const workOrderNumber = ref<string>((route.query.wo as string) || '')
const partId = ref<string>((route.query.partId as string) || '')
const category = ref<IssueCategoryKey | ''>('')
const title = ref('')
const description = ref('')
const supplierId = ref('')
const dueDate = ref('')
const photos = ref<{ file?: File; content?: string }[]>([])

const { data: parts, refresh: refreshParts } = await useFetch('/api/parts', {
  query: computed(() => ({ workOrderNumber: workOrderNumber.value })),
  default: () => [],
  immediate: !!workOrderNumber.value,
  watch: false, // 换工单时手动刷新
})
const workOrder = computed(() => workOrders.value.find((w) => w.workOrderNumber === workOrderNumber.value))
const part = computed(() => parts.value.find((p) => p.id === partId.value))
const cat = computed(() => options.value.categories.find((c) => c.value === category.value))
const supplierName = computed(() => master.value.suppliers.find((s) => s.id === supplierId.value)?.label ?? '')

function chooseWorkOrder(wo: string) {
  workOrderNumber.value = wo
  partId.value = ''
  if (wo) refreshParts()
}

const showParts = ref(false)
const partActions = computed(() => [{ name: '不选工件', id: '' }, ...parts.value.map((p) => ({ name: p.name, subname: p.drawingNo ?? '', id: p.id }))])
const onPart = (a: { id: string }) => (partId.value = a.id)
const showSupplier = ref(false)
const supplierColumns = computed(() => [{ text: '不指定', value: '' }, ...master.value.suppliers.map((s) => ({ text: s.label, value: s.id }))])
function onSupplier({ selectedValues }: { selectedValues: (string | number)[] }) {
  supplierId.value = String(selectedValues[0] ?? '')
  showSupplier.value = false
}
const showCalendar = ref(false)
function onCalendar(d: Date) {
  dueDate.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  showCalendar.value = false
}
function onOversize() {
  showFailToast('每张照片不能超过 8MB')
}

const submitting = ref(false)
const canSubmit = computed(() => !!workOrderNumber.value && !!category.value && !!title.value.trim() && !!description.value.trim())
async function submit() {
  if (!canSubmit.value) return showToast('请选工单、分类，并填写标题和说明')
  submitting.value = true
  try {
    const files = photos.value.map((p) => p.file).filter((f): f is File => !!f)
    const photoIds = await uploadPhotos(files)
    const send = $fetch as unknown as (url: string, opts: { method: 'POST'; body: object }) => Promise<{ id: string; issueNo: string }>
    const r = await send('/api/issues', {
      method: 'POST',
      body: {
        workOrderNumber: workOrderNumber.value,
        partId: partId.value || null,
        category: category.value,
        title: title.value.trim(),
        description: description.value.trim(),
        photoIds,
        dueDate: dueDate.value || null,
        responsibleSupplierId: cat.value?.supplier ? supplierId.value || null : null,
      },
    })
    showSuccessToast(`已上报 ${r.issueNo}`)
    await navigateTo(`/m/issues?tab=reported&id=${encodeURIComponent(r.id)}`, { replace: true })
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="上报异常" left-arrow left-text="返回" @click-left="navigateTo('/m/issues')" />

    <van-cell-group inset title="1. 工单">
      <van-cell v-if="workOrderNumber" :title="workOrderNumber" :label="workOrder?.projectName ?? ''" is-link value="换一个" @click="chooseWorkOrder('')" />
      <template v-else>
        <van-empty v-if="!workOrders.length" description="没有工单" image-size="60" />
        <van-cell
          v-for="w in workOrders"
          :key="w.workOrderNumber"
          :title="w.workOrderNumber"
          :label="w.projectName ?? w.customerName"
          is-link
          @click="chooseWorkOrder(w.workOrderNumber)"
        />
      </template>
    </van-cell-group>

    <template v-if="workOrderNumber">
      <van-cell-group inset title="2. 工件（可不选）">
        <van-cell title="工件" :value="part?.name ?? '不选'" is-link @click="showParts = true" />
      </van-cell-group>

      <van-cell-group inset title="3. 分类">
        <div class="chips">
          <van-tag
            v-for="c in options.categories"
            :key="c.value"
            size="large"
            :type="category === c.value ? 'primary' : 'default'"
            :plain="category !== c.value"
            @click="category = c.value as IssueCategoryKey"
          >
            {{ c.label }}
          </van-tag>
        </div>
        <van-cell v-if="cat" title="默认责任部门" :value="cat.deptName" />
        <van-cell v-if="cat?.supplier" title="外协单位" :value="supplierName || '不指定'" is-link @click="showSupplier = true" />
      </van-cell-group>

      <van-cell-group inset title="4. 标题、说明与照片">
        <van-field v-model="title" label="标题" required maxlength="100" show-word-limit placeholder="简要概括异常" />
        <van-field label="说明" required v-model="description" type="textarea" rows="2" autosize maxlength="500" show-word-limit placeholder="发生了什么？如：涂装件返回有流挂，需返修" />
        <div class="uploader">
          <van-uploader v-model="photos" :max-count="MAX_PHOTOS" :max-size="MAX_PHOTO_BYTES" accept="image/jpeg,image/png,image/webp" multiple @oversize="onOversize" />
          <div class="muted">拍照或从相册选，最多 3 张，每张不超过 8MB</div>
        </div>
        <van-cell title="要求解决日（可不填）" :value="dueDate || '受理时默认 +3 天'" is-link @click="showCalendar = true" />
      </van-cell-group>
    </template>

    <div class="m-submit">
      <van-button type="danger" block round :disabled="!canSubmit" :loading="submitting" loading-text="提交中…" @click="submit">提交异常</van-button>
    </div>

    <van-action-sheet
      v-model:show="showParts"
      :actions="partActions"
      cancel-text="取消"
      close-on-click-action
      @select="onPart"
    />
    <van-popup v-model:show="showSupplier" position="bottom" round>
      <van-picker title="外协单位" :columns="supplierColumns" :model-value="[supplierId]" @confirm="onSupplier" @cancel="showSupplier = false" />
    </van-popup>
    <van-calendar v-model:show="showCalendar" :show-confirm="false" :min-date="new Date()" @confirm="onCalendar" />
  </div>
</template>

<style scoped>
.page { padding-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; background: var(--ft-card-bg); }
.chips :deep(.van-tag) { cursor: pointer; }
.uploader { padding: 12px 16px 4px; background: var(--ft-card-bg); }
.muted { color: var(--ft-text-3); font-size: 12px; padding-bottom: 8px; }
</style>
