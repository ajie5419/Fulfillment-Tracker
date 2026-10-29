<script setup lang="ts">
const requestFetch = useRequestFetch()
/**
 * 批量编排（生产管理重设计第一批，zhao 10-26 同意放第一批）：工序编排页勾选多个工件后——
 *   template：一次套用模板（只给还没有工序的工件套，已有工序链的跳过）；
 *   fields：一次给这些工件的工序设负责人、班组 / 外协厂、应开工日、要求完成日、所属总计划节点（只填要改的；可只改某一道工序）。
 * 一个事务，规则与单道修改一样；有一道不合规整批不改，提示是哪个工件的哪一道。
 */
type PlanOpts = { published: boolean; nodes: { id: string; seq: number; name: string; planDate: string }[] }
const props = defineProps<{ open: boolean; mode: 'template' | 'fields'; partIds: string[]; planOpts: PlanOpts }>()
const emit = defineEmits<{ close: []; done: [] }>()

const { data: master } = await useMaster()
interface TemplateRow { id: string; name: string; steps: { processName: string }[] }
const templates = ref<TemplateRow[]>([])
const form = reactive({
  templateId: undefined as string | undefined,
  startDate: undefined as string | undefined,
  processId: undefined as string | undefined,
  ownerId: undefined as string | undefined,
  supplierId: undefined as string | undefined,
  planStartDate: undefined as string | undefined,
  dueDate: undefined as string | undefined,
  planNodeId: undefined as string | undefined,
})
const saving = ref(false)
watch(
  () => props.open,
  async (o) => {
    if (!o) return
    for (const k of Object.keys(form) as (keyof typeof form)[]) form[k] = undefined
    if (props.mode === 'template') {
      try {
        templates.value = await requestFetch<TemplateRow[]>('/api/templates')
      } catch (e) {
        message.error(apiError(e))
      }
    }
  },
  { immediate: true },
)
const processOptions = computed(() => master.value.processes.map((p) => ({ value: p.id, label: p.name })))
const supplierOptions = computed(() => [
  ...master.value.suppliers.filter((s) => s.kind === 'TEAM').map((s) => ({ value: s.id, label: `${s.name}（班组）` })),
  ...master.value.suppliers.filter((s) => s.kind !== 'TEAM').map((s) => ({ value: s.id, label: s.label })),
])
const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: u.name })))
const nodeOptions = computed(() => props.planOpts.nodes.map((n) => ({ value: n.id, label: `${n.seq}. ${n.name}（${n.planDate}）` })))
const templateOptions = computed(() => templates.value.map((t) => ({ value: t.id, label: `${t.name}（${t.steps.map((s) => s.processName).join(' → ')}）` })))

async function submit() {
  saving.value = true
  try {
    if (props.mode === 'template') {
      if (!form.templateId) return message.warning('请选择模板')
      const r = await $fetch('/api/parts/batch-template', { method: 'POST', body: { partIds: props.partIds, templateId: form.templateId, startDate: form.startDate || null } })
      message.success(`已给 ${r.applied} 个工件套用"${r.template || '模板'}"${r.skipped ? `；${r.skipped} 个已有工序链，跳过` : ''}`)
    } else {
      const set = Object.fromEntries(
        (['ownerId', 'supplierId', 'planStartDate', 'dueDate', 'planNodeId'] as const).filter((k) => form[k]).map((k) => [k, form[k]]),
      )
      if (!Object.keys(set).length) return message.warning('请至少填一项要设置的内容')
      const r = await $fetch('/api/parts/batch-steps', { method: 'POST', body: { partIds: props.partIds, processId: form.processId ?? null, set } })
      message.success(`已改 ${r.updated} 道工序${r.skipped ? `；${r.skipped} 道方式不合（班组只设到自制工序，外协厂只设到外协工序），没设班组 / 外协厂` : ''}`)
      if (r.planWarning) message.warning(r.planWarning)
    }
    emit('done')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-modal :open="open" :title="mode === 'template' ? `批量套用模板（已选 ${partIds.length} 个工件）` : `批量设置工序（已选 ${partIds.length} 个工件）`" :confirm-loading="saving" ok-text="确定" @ok="submit" @cancel="emit('close')">
    <a-form layout="vertical">
      <template v-if="mode === 'template'">
        <p class="muted">只给还没有工序的工件套用；已有工序链的跳过。负责人默认是你，套完再批量改。</p>
        <a-form-item label="模板" required><a-select v-model:value="form.templateId" :options="templateOptions" show-search option-filter-prop="label" placeholder="选择模板" /></a-form-item>
        <a-form-item label="开工日" extra="给了开工日时，按模板的默认工期推算各道的要求完成日"><UiDatePicker v-model:value="form.startDate" style="width: 100%" /></a-form-item>
      </template>
      <template v-else>
        <p class="muted">只填要改的项，空着的不动；只改还没完成的工序。</p>
        <a-form-item label="只改这道工序" extra="不选 = 这些工件上全部没完成的工序"><a-select v-model:value="form.processId" allow-clear show-search option-filter-prop="label" placeholder="全部工序" :options="processOptions" /></a-form-item>
        <a-form-item label="负责人"><a-select v-model:value="form.ownerId" allow-clear show-search option-filter-prop="label" placeholder="不改" :options="userOptions" /></a-form-item>
        <a-form-item label="班组 / 外协厂" extra="班组只设到自制工序上，外协厂只设到外协工序上"><a-select v-model:value="form.supplierId" allow-clear show-search option-filter-prop="label" placeholder="不改" :options="supplierOptions" /></a-form-item>
        <div class="two">
          <a-form-item label="应开工日"><UiDatePicker v-model:value="form.planStartDate" placeholder="不改" style="width: 100%" /></a-form-item>
          <a-form-item label="要求完成日"><UiDatePicker v-model:value="form.dueDate" placeholder="不改" style="width: 100%" /></a-form-item>
        </div>
        <a-form-item v-if="nodeOptions.length" label="所属总计划节点"><a-select v-model:value="form.planNodeId" allow-clear show-search option-filter-prop="label" placeholder="不改" :options="nodeOptions" /></a-form-item>
      </template>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
</style>
