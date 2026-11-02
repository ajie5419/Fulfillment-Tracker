<script setup lang="ts">
/**
 * 工序路线模板（R8）：常用工序链 = 一串工序 + 每道的执行方式、默认外协厂、默认工期。
 * 管理员维护（接口也校验）；在"生产管理"页给没有工序的工件"套用模板"（弹窗里能看到完整工序链）。
 * 套用是复制：改模板、删模板都不影响已经套用的工件。
 * 功能重复梳理第一批：管理员在"设置"页签维护（菜单少一项）；/templates 页也用这个组件，给非管理员只读查看。
 */
const { data: me } = await useMe()
const { data: master } = await useMaster()

interface TemplateStep { processId: string; processName: string; mode: StepModeKey; supplierId: string | null; supplierName: string | null; defaultDays: number | null }
interface TemplateRow { id: string; name: string; description: string | null; createdByName: string | null; updatedAt: string; steps: TemplateStep[] }
// 绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"）
const send = clientRequest

// useFetch 在服务端渲染时会带上登录 Cookie（直接 $fetch 不会）
const { data: templates, pending, refresh } = await useFetch<TemplateRow[]>('/api/templates', { key: 'route-templates', default: () => [] })
const admin = computed(() => !!me.value?.isAdmin)

const processOptions = computed(() => master.value.processes.map((p) => ({ value: p.id, label: p.name })))
const supplierOptions = computed(() => master.value.suppliers.map((s) => ({ value: s.id, label: s.label })))
/** 自制工序只能派给厂内班组 */
const teamOptions = computed(() => master.value.suppliers.filter((s) => s.kind === 'TEAM').map((s) => ({ value: s.id, label: s.name })))
const modeOptions = Object.entries(MODE_TEXT).map(([value, label]) => ({ value, label }))

// ───── 编辑 ─────
type DraftStep = { processId?: string; mode: StepModeKey; supplierId?: string; defaultDays?: number }
const form = reactive({ open: false, id: '', name: '', description: '', steps: [] as DraftStep[] })
const saving = ref(false)
function edit(t?: TemplateRow) {
  Object.assign(form, t
    ? { open: true, id: t.id, name: t.name, description: t.description ?? '', steps: t.steps.map((s) => ({ processId: s.processId, mode: s.mode, supplierId: s.supplierId ?? undefined, defaultDays: s.defaultDays ?? undefined })) }
    : { open: true, id: '', name: '', description: '', steps: [{ mode: 'SELF' }] })
}
function moveDraft(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= form.steps.length) return
  const [x] = form.steps.splice(i, 1)
  form.steps.splice(j, 0, x!)
}
async function save() {
  if (!form.name.trim()) return message.warning('请填写模板名称')
  if (!form.steps.length || form.steps.some((s) => !s.processId)) return message.warning('每一道都要选工序')
  const body = {
    name: form.name,
    description: form.description || null,
    steps: form.steps.map((s) => ({ processId: s.processId ?? '', mode: s.mode, supplierId: s.supplierId ?? null, defaultDays: s.defaultDays ?? null })),
  }
  saving.value = true
  try {
    if (form.id) await send(`/api/templates/${form.id}`, { method: 'PUT', body })
    else await send('/api/templates', { method: 'POST', body })
    message.success('已保存')
    form.open = false
    await refresh()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}
function remove(t: TemplateRow) {
  Modal.confirm({
    title: `删除模板"${t.name}"？`,
    content: '已经套用了这个模板的工件不受影响。',
    okType: 'danger',
    onOk: async () => {
      try {
        await send(`/api/templates/${t.id}`, { method: 'DELETE' })
        message.success('已删除')
      } catch (e) {
        message.error(apiError(e))
      } finally {
        await refresh()
      }
    },
  })
}
</script>

<template>
  <div>
    <div class="head">
      <p class="muted">
      常用工序链存成模板，在"生产管理"页给还没有工序的工件"套用模板"，也可以把某个工件的工序链"另存为模板"。套用是复制：以后改模板、删模板都不影响已经套用的工件。{{ admin ? '' : '模板由管理员维护。' }}
      </p>
      <a-button v-if="admin" type="primary" @click="edit()">新建模板</a-button>
    </div>
    <a-spin :spinning="pending">
      <a-empty v-if="!templates.length" description="还没有模板" />
      <a-list v-else :data-source="templates" item-layout="vertical">
        <template #renderItem="{ item }">
          <a-list-item :key="item.id">
            <template v-if="admin" #actions>
              <a @click="edit(item)">编辑</a>
              <a class="danger" @click="remove(item)">删除</a>
            </template>
            <a-list-item-meta :title="item.name" :description="item.description || undefined" />
            <div class="chain">
              <span v-for="(s, i) in (item as TemplateRow).steps" :key="i">
                <span v-if="i" class="muted"> → </span>
                <a-tag>{{ s.processName }}</a-tag><span class="muted">{{ MODE_TEXT[s.mode] }}{{ s.supplierName ? ` · ${s.supplierName}` : '' }}{{ s.defaultDays != null ? ` · ${s.defaultDays} 天` : '' }}</span>
              </span>
            </div>
            <div class="muted">{{ item.createdByName ? `${item.createdByName} 创建，` : '' }}最后修改 {{ timeText(item.updatedAt) }}</div>
          </a-list-item>
        </template>
      </a-list>
    </a-spin>
  </div>

  <a-modal :open="form.open" :title="form.id ? '编辑模板' : '新建模板'" width="860px" ok-text="保存" :confirm-loading="saving" @ok="save" @cancel="form.open = false">
    <a-form layout="vertical">
      <a-form-item label="模板名称" required><a-input v-model:value="form.name" placeholder="如：结构件 下料 → 组焊 → 涂装" /></a-form-item>
      <a-form-item label="说明"><a-textarea v-model:value="form.description" :rows="2" /></a-form-item>
      <a-form-item label="工序（按顺序）" required>
        <div v-for="(s, i) in form.steps" :key="i" class="step">
          <span class="seq">{{ i + 1 }}</span>
          <a-select v-model:value="s.processId" placeholder="工序" style="width: 150px" show-search option-filter-prop="label" :options="processOptions" />
          <a-select v-model:value="s.mode" style="width: 110px" :options="modeOptions" @change="s.supplierId = undefined" />
          <a-select v-model:value="s.supplierId" :placeholder="s.mode === 'SELF' ? '默认班组（可空）' : '默认外协厂（可空）'" style="width: 190px" allow-clear show-search option-filter-prop="label" :options="s.mode === 'SELF' ? teamOptions : supplierOptions" />
          <a-input-number v-model:value="s.defaultDays" :min="0" :max="365" placeholder="工期" addon-after="天" style="width: 120px" />
          <a-button size="small" :disabled="i === 0" @click="moveDraft(i, -1)">上移</a-button>
          <a-button size="small" :disabled="i === form.steps.length - 1" @click="moveDraft(i, 1)">下移</a-button>
          <a-button size="small" danger :disabled="form.steps.length === 1" @click="form.steps.splice(i, 1)">删除</a-button>
        </div>
        <a-button size="small" @click="form.steps.push({ mode: 'SELF' })">添加一道</a-button>
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.head .muted { margin: 0; }
.muted { color: var(--ft-text-2); font-size: 12px; }
.danger { color: var(--ft-late); }
.chain { margin: 4px 0 8px; line-height: 2; }
.step { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.seq { width: 20px; color: var(--ft-text-3); }
</style>
