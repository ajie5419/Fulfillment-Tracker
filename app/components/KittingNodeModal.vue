<script setup lang="ts">
/**
 * 新建 / 编辑装配节点（R12）：工单、名称、需求日、所属总计划节点（R14，工单总计划已发布时必选）、负责人（不选 = 生产经理）、排序、备注，
 * 以及节点清单：需要的工件（可多选）和关键物料（同一工单，可多选）。同一工件 / 物料可以挂在多个节点上。
 */
const props = defineProps<{ open: boolean; node: KitNode | null; workOrderNumber?: string }>()
const emit = defineEmits<{ close: []; done: [id: string] }>()

const { data: workOrders } = await useWorkOrders()
const { data: master } = await useMaster()

const empty = () => ({
  workOrderNumber: undefined as string | undefined,
  name: '',
  needDate: undefined as string | undefined,
  planNodeId: null as string | null | undefined,
  ownerId: undefined as string | undefined,
  sortOrder: undefined as number | undefined,
  note: '',
  partIds: [] as string[],
  purchaseIds: [] as string[],
})
const form = reactive(empty())
const saving = ref(false)
const editing = computed(() => !!props.node)

type Options = { parts: { id: string; label: string; ready: boolean }[]; purchases: { id: string; label: string; status: 'OPEN' | 'ARRIVED' | 'CANCELLED'; statusText: string }[] }
const options = ref<Options>({ parts: [], purchases: [] })
const loadingOptions = ref(false)
async function loadOptions(wo: string | undefined) {
  options.value = { parts: [], purchases: [] }
  if (!wo) return
  loadingOptions.value = true
  try {
    const get = $fetch as unknown as (u: string, o: { query: object }) => Promise<Options>
    const r = await get('/api/kitting/options', { query: { workOrderNumber: wo } })
    // 打开期间又换了工单：丢掉旧结果
    if (form.workOrderNumber === wo) options.value = r
  } catch (e) {
    message.error(apiError(e))
  } finally {
    loadingOptions.value = false
  }
}

/** 打开时装入的工单：工单 watch 碰到它不清清单（编辑、预填时要保留原来的工件和物料） */
let loadedWo: string | undefined | null = null
watch(
  () => props.open,
  (open) => {
    if (!open) return
    const n = props.node
    Object.assign(
      form,
      n
        ? {
            workOrderNumber: n.workOrderNumber,
            name: n.name,
            needDate: dayText(n.needDate),
            planNodeId: n.planNodeId,
            ownerId: n.ownerId ?? undefined,
            sortOrder: n.sortOrder as number | undefined,
            note: n.note ?? '',
            partIds: [...n.partIds],
            purchaseIds: [...n.purchaseIds],
          }
        : { ...empty(), workOrderNumber: props.workOrderNumber },
    )
    loadedWo = form.workOrderNumber
    loadOptions(form.workOrderNumber)
  },
)
watch(
  () => form.workOrderNumber,
  (wo) => {
    if (wo === loadedWo) {
      loadedWo = null
      return
    }
    loadedWo = null
    form.partIds = []
    form.purchaseIds = []
    form.planNodeId = null
    loadOptions(wo)
  },
)

const partOptions = computed(() => options.value.parts.map((p) => ({ value: p.id, label: `${p.label}${p.ready ? '（已完成）' : ''}` })))
/** 已取消的物料不计入齐套率：新选时不列出，原来就选着的保留并标出来 */
const purchaseOptions = computed(() =>
  options.value.purchases
    .filter((p) => p.status !== 'CANCELLED' || form.purchaseIds.includes(p.id))
    .map((p) => ({ value: p.id, label: `${p.label}（${p.statusText}）` })),
)
/** 生产部的人排前面（按部门对照换算出的业务部门，如对到生产部的班组） */
const ownerOptions = computed(() =>
  [...master.value.users]
    .sort((a, b) => Number(b.businessDept === 'PRODUCTION') - Number(a.businessDept === 'PRODUCTION'))
    .map((u) => ({ value: u.id, label: `${u.name}（${u.department || '无部门'}）` })),
)

async function submit() {
  if (!form.workOrderNumber) return message.warning('请选择工单')
  if (!form.name.trim()) return message.warning('请填写节点名称')
  if (!form.needDate) return message.warning('请选择需求日')
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    needDate: form.needDate,
    planNodeId: form.planNodeId ?? null,
    ownerId: form.ownerId ?? null,
    sortOrder: form.sortOrder ?? null,
    note: form.note.trim() || null,
    partIds: form.partIds,
    purchaseIds: form.purchaseIds,
  }
  saving.value = true
  try {
    if (props.node) {
      const r = await kittingSend<{ id: string; percent: number | null; ready: number; total: number; planWarning?: string | null }>(`/api/kitting/${props.node.id}`, 'PATCH', body)
      message.success(r.total ? `已保存，齐套 ${r.ready}/${r.total}（${r.percent}%）` : '已保存（清单为空）')
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', props.node.id)
    } else {
      const r = await kittingSend<{ id: string; planWarning?: string | null }>('/api/kitting', 'POST', { ...body, workOrderNumber: form.workOrderNumber })
      message.success('已新建装配节点')
      if (r.planWarning) message.warning(r.planWarning)
      emit('done', r.id)
    }
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="open" :title="editing ? '编辑装配节点' : '新建装配节点'" ok-text="保存" :confirm-loading="saving" width="760px" @ok="submit" @cancel="emit('close')">
    <a-form layout="horizontal" :label-col="{ span: 4 }" :wrapper-col="{ span: 19 }">
      <a-form-item label="工单" required>
        <a-select
          v-model:value="form.workOrderNumber"
          :disabled="editing"
          show-search
          option-filter-prop="label"
          placeholder="选择工单"
          :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? w.customerName}` }))"
        />
      </a-form-item>
      <a-form-item label="节点名称" required><a-input v-model:value="form.name" :maxlength="191" placeholder="如 主梁总装、回转机构部装" /></a-form-item>
      <a-form-item label="需求日" required>
        <a-date-picker v-model:value="form.needDate" value-format="YYYY-MM-DD" />
        <div class="muted">需求日前 5 天（可在设置里改）还没齐套黄色预警，前 1 天或已过红色</div>
      </a-form-item>
      <a-form-item label="所属总计划节点">
        <PlanNodeSelect v-model:value="form.planNodeId" :work-order-number="form.workOrderNumber" :record-date="form.needDate" @pick="(d) => (form.needDate ||= d)" />
      </a-form-item>
      <a-form-item label="负责人">
        <a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" placeholder="不选 = 生产经理（生产部负责人）" :options="ownerOptions" />
      </a-form-item>
      <a-form-item label="需要的工件">
        <a-select
          v-model:value="form.partIds"
          mode="multiple"
          allow-clear
          option-filter-prop="label"
          :loading="loadingOptions"
          :placeholder="form.workOrderNumber ? '可多选；同一工件可以挂在多个节点上' : '先选工单'"
          :options="partOptions"
        />
        <div class="muted">工件完成（最后一道工序完成）才算就绪</div>
      </a-form-item>
      <a-form-item label="关键物料">
        <a-select
          v-model:value="form.purchaseIds"
          mode="multiple"
          allow-clear
          option-filter-prop="label"
          :loading="loadingOptions"
          :placeholder="form.workOrderNumber ? '来自“采购到货”，只限本工单' : '先选工单'"
          :options="purchaseOptions"
        />
        <div class="muted">已到货才算就绪；已取消的物料不计入齐套率</div>
      </a-form-item>
      <a-form-item label="排序"><a-input-number v-model:value="form.sortOrder" :min="-100000" :max="100000" placeholder="不填排最后" style="width: 160px" /></a-form-item>
      <a-form-item label="备注"><a-input v-model:value="form.note" :maxlength="500" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
</style>
