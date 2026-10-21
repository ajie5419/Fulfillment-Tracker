<script setup lang="ts">
/**
 * 部门记录（设计任务 / 采购行 / 工序 / 装配节点）的"所属总计划节点"下拉（R14）：只列同一工单的节点。
 * 工单的总计划已发布时必选（后端校验，这里只提示）；记录日期晚于节点计划日时提示（照样能保存，总计划页标红）。
 * 选中节点时抛出 pick(planDate)，父组件可以拿来给空着的日期字段填默认值。
 */
interface Opt { id: string; seq: number; name: string; deptText: string; planDate: string }

const props = withDefaults(
  defineProps<{
    workOrderNumber?: string | null
    /** 记录的日期（YYYY-MM-DD 或 Dayjs / Date），用来提示"晚于节点" */
    recordDate?: string | Date | { format: (f: string) => string } | null
    size?: 'small' | 'middle'
    /** 只要下拉框，不显示提示文字（表格行内用） */
    bare?: boolean
  }>(),
  { workOrderNumber: null, recordDate: null, size: 'middle', bare: false },
)
const value = defineModel<string | null | undefined>('value')
const emit = defineEmits<{ pick: [planDate: string] }>()

const get = $fetch as unknown as <T>(url: string, opts?: { query?: object }) => Promise<T>
const opts = ref<{ published: boolean; nodes: Opt[] }>({ published: false, nodes: [] })
async function load() {
  const wo = props.workOrderNumber
  if (!wo) {
    opts.value = { published: false, nodes: [] }
    return
  }
  let next: { published: boolean; nodes: Opt[] }
  try {
    next = await get('/api/plan/options', { query: { workOrderNumber: wo } })
  } catch {
    next = { published: false, nodes: [] }
  }
  // 连续切换工单时，只采用当前工单的结果，避免先发后到的旧响应覆盖
  if (wo === props.workOrderNumber) opts.value = next
}
watch(() => props.workOrderNumber, load, { immediate: true })

const options = computed(() => opts.value.nodes.map((n) => ({ value: n.id, label: `${n.seq}. ${n.name}（${n.deptText}，${n.planDate}）` })))
const selected = computed(() => opts.value.nodes.find((n) => n.id === value.value) ?? null)
const recordDay = computed(() => {
  const d = props.recordDate
  if (!d) return null
  if (typeof d === 'string') return d.slice(0, 10)
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return d.format('YYYY-MM-DD')
})
const late = computed(() => !!selected.value && !!recordDay.value && recordDay.value > selected.value.planDate)
function onChange(v: unknown) {
  value.value = (v as string | undefined) ?? null
  const n = opts.value.nodes.find((x) => x.id === v)
  if (n) emit('pick', n.planDate)
}
defineExpose({ published: computed(() => opts.value.published) })
</script>

<template>
  <div>
    <a-select
      :value="value ?? undefined"
      :options="options"
      :size="size"
      allow-clear
      show-search
      option-filter-prop="label"
      :placeholder="!workOrderNumber ? '先选工单' : !opts.nodes.length ? '该工单还没有总计划' : opts.published ? '请选择（已发布，必选）' : '可不选'"
      :disabled="!workOrderNumber || (!opts.nodes.length && !value)"
      :status="late ? 'warning' : undefined"
      style="width: 100%"
      @change="onChange"
    />
    <template v-if="!bare">
      <div v-if="late" class="warn">晚于节点计划日 {{ selected?.planDate }}，可以保存，总计划页会标红</div>
      <div v-else-if="opts.published && !value" class="warn">该工单总计划已发布，新建记录必须选所属节点</div>
    </template>
  </div>
</template>

<style scoped>
.warn { color: var(--ft-upstream-text); font-size: 12px; margin-top: 2px; }
</style>
