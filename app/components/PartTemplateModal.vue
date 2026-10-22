<script setup lang="ts">
/**
 * 工件上的模板操作（R8）：
 *   apply：给还没有工序的工件套用模板（复制步骤；之后改模板不影响这个工件）。给了开工日时按默认工期推算各道要求完成日。
 *   save：把工件当前的工序链另存为模板（仅管理员）。
 */
const props = defineProps<{ target: { partId: string; partName: string; mode: 'apply' | 'save' } | null }>()
const emit = defineEmits<{ close: []; done: [] }>()

interface TemplateRow { id: string; name: string; description: string | null; steps: { processName: string; mode: StepModeKey; supplierName: string | null; defaultDays: number | null }[] }
const get = $fetch as unknown as (url: string) => Promise<TemplateRow[]>
const post = $fetch as unknown as (url: string, opts: { method: 'POST'; body: object }) => Promise<{ copied?: number }>

const templates = ref<TemplateRow[]>([])
const form = reactive({ templateId: undefined as string | undefined, startDate: undefined as string | undefined, name: '', description: '' })
const saving = ref(false)

watch(
  () => props.target,
  async (t) => {
    if (!t) return
    Object.assign(form, { templateId: undefined, startDate: undefined, name: '', description: '' })
    if (t.mode === 'apply') {
      try {
        templates.value = await get('/api/templates')
      } catch (e) {
        message.error(apiError(e))
      }
    } else form.name = `${t.partName} 路线`
  },
  { immediate: true },
)

const chosen = computed(() => templates.value.find((t) => t.id === form.templateId))

async function submit() {
  const t = props.target
  if (!t) return
  saving.value = true
  try {
    if (t.mode === 'apply') {
      if (!form.templateId) return message.warning('请选择模板')
      const r = await post(`/api/parts/${t.partId}/apply-template`, { method: 'POST', body: { templateId: form.templateId, startDate: form.startDate || null } })
      message.success(`已套用，生成 ${r.copied} 道工序`)
    } else {
      if (!form.name.trim()) return message.warning('请填写模板名称')
      await post(`/api/parts/${t.partId}/save-template`, { method: 'POST', body: { name: form.name, description: form.description || null } })
      message.success('已另存为模板')
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
  <a-modal
    :open="!!target"
    :title="target?.mode === 'save' ? `另存为模板：${target.partName}` : `套用模板：${target?.partName ?? ''}`"
    :ok-text="target?.mode === 'save' ? '保存' : '套用'"
    :confirm-loading="saving"
    @ok="submit"
    @cancel="emit('close')"
  >
    <a-form v-if="target?.mode === 'apply'" layout="vertical">
      <p class="muted">把模板的工序、方式、外协厂复制到这个工件上，负责人默认是你。复制后与模板无关：以后改模板不影响这个工件。</p>
      <a-form-item label="模板" required>
        <a-select v-model:value="form.templateId" show-search option-filter-prop="label" :options="templates.map((t) => ({ value: t.id, label: t.name }))" :not-found-content="'还没有模板'" />
      </a-form-item>
      <div v-if="chosen" class="preview">
        <span v-for="(s, i) in chosen.steps" :key="i">
          <span v-if="i" class="muted"> → </span>{{ s.processName }}<span class="muted">（{{ MODE_TEXT[s.mode] }}{{ s.supplierName ? ` · ${s.supplierName}` : '' }}{{ s.defaultDays != null ? ` · ${s.defaultDays} 天` : '' }}）</span>
        </span>
      </div>
      <a-form-item label="开工日（可不填）" extra="填了就按模板的默认工期逐道推算要求完成日（日历天）；不填则不设要求完成日。">
        <a-date-picker v-model:value="form.startDate" value-format="YYYY-MM-DD" style="width: 100%" />
      </a-form-item>
    </a-form>
    <a-form v-else layout="vertical">
      <p class="muted">保存工序、方式和外协厂；不保存负责人和日期。默认工期可到"设置 → 工序路线模板"补（管理员）。</p>
      <a-form-item label="模板名称" required><a-input v-model:value="form.name" /></a-form-item>
      <a-form-item label="说明"><a-textarea v-model:value="form.description" :rows="2" /></a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.preview { margin: -8px 0 16px; line-height: 2; }
</style>
