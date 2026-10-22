<script setup lang="ts">
/**
 * 设置 →"总计划模板"（R14）：节点名称、顺序、责任部门、交期前天数。项目部负责人、管理员可维护（接口也校验）。
 * 改模板不影响已经生成的总计划（生成时复制）。
 */
import { BUSINESS_DEPT_OPTIONS } from '#shared/business-depts'

interface TplNode { name: string; dept: string; daysBeforeDelivery: number }
interface Tpl { id: string; name: string; description: string | null; createdByName: string | null; updatedAt: string; nodes: (TplNode & { seq: number; deptText: string })[] }

const DEPTS = BUSINESS_DEPT_OPTIONS

const { data, refresh, pending } = await useFetch<Tpl[]>('/api/plan/templates', { default: () => [] })
const send = $fetch as unknown as (url: string, opts: { method: 'POST' | 'PUT' | 'DELETE'; body?: object }) => Promise<unknown>

const open = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)
const form = reactive<{ name: string; description: string; nodes: TplNode[] }>({ name: '', description: '', nodes: [] })

function edit(t: Tpl | null) {
  editingId.value = t?.id ?? null
  form.name = t?.name ?? ''
  form.description = t?.description ?? ''
  form.nodes = t ? t.nodes.map((n) => ({ name: n.name, dept: n.dept, daysBeforeDelivery: n.daysBeforeDelivery })) : [{ name: '', dept: 'PROJECT', daysBeforeDelivery: 0 }]
  open.value = true
}
const addRow = (i: number) => form.nodes.splice(i + 1, 0, { name: '', dept: form.nodes[i]?.dept ?? 'PROJECT', daysBeforeDelivery: form.nodes[i]?.daysBeforeDelivery ?? 0 })
const removeRow = (i: number) => form.nodes.splice(i, 1)
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= form.nodes.length) return
  const [x] = form.nodes.splice(i, 1)
  form.nodes.splice(j, 0, x!)
}

async function save() {
  if (!form.name.trim()) return message.warning('请填写模板名称')
  if (!form.nodes.length) return message.warning('模板至少要有一个节点')
  if (form.nodes.some((n) => !n.name.trim())) return message.warning('请填写每个节点的名称')
  saving.value = true
  try {
    const body = { name: form.name, description: form.description || null, nodes: form.nodes }
    if (editingId.value) await send(`/api/plan/templates/${editingId.value}`, { method: 'PUT', body })
    else await send('/api/plan/templates', { method: 'POST', body })
    message.success('已保存')
    open.value = false
    await refresh()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = false
  }
}

function remove(t: Tpl) {
  Modal.confirm({
    title: `删除模板"${t.name}"？`,
    content: '已经按这个模板生成的总计划不受影响',
    okType: 'danger',
    onOk: async () => {
      try {
        await send(`/api/plan/templates/${t.id}`, { method: 'DELETE' })
        message.success('已删除')
      } catch (e) {
        message.error(apiError(e))
      } finally {
        await refresh()
      }
    },
  })
}

const columns = [
  { title: '模板', key: 'name', width: 200 },
  { title: '节点（交期前天数）', key: 'nodes' },
  { title: '', key: 'ops', width: 130 },
]
</script>

<template>
  <div>
    <p class="muted">
      工单详情的"总计划"页签"按模板生成"时，每个节点的计划日 = 工单交期 − 交期前天数；生成后可以逐个调整。改模板不影响已经生成的总计划。
    </p>
    <a-button type="primary" size="small" style="margin-bottom: 12px" @click="edit(null)">新建模板</a-button>
    <a-table :columns="columns" :data-source="data" :loading="pending" row-key="id" size="small" :pagination="false">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          {{ record.name }}
          <div v-if="record.description" class="muted">{{ record.description }}</div>
        </template>
        <template v-else-if="column.key === 'nodes'">
          <a-tag v-for="n in record.nodes" :key="n.seq" class="node-tag">{{ n.seq }}. {{ n.name }}（{{ n.deptText }}，{{ n.daysBeforeDelivery }} 天）</a-tag>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space>
            <a-button size="small" @click="edit(record as Tpl)">编辑</a-button>
            <a-button size="small" danger @click="remove(record as Tpl)">删除</a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <a-modal v-model:open="open" :title="editingId ? '编辑总计划模板' : '新建总计划模板'" width="720px" :confirm-loading="saving" @ok="save">
      <a-form layout="vertical">
        <a-form-item label="模板名称" required><a-input v-model:value="form.name" :maxlength="191" /></a-form-item>
        <a-form-item label="说明"><a-input v-model:value="form.description" :maxlength="500" /></a-form-item>
        <a-form-item label="节点（按顺序；交期前天数可以为负 = 交期后）">
          <div v-for="(n, i) in form.nodes" :key="i" class="node-row">
            <span class="seq">{{ i + 1 }}</span>
            <a-input v-model:value="n.name" placeholder="节点名称" style="width: 200px" :maxlength="191" />
            <a-select v-model:value="n.dept" :options="DEPTS" style="width: 110px" />
            <a-input-number v-model:value="n.daysBeforeDelivery" :min="-365" :max="2000" :precision="0" style="width: 90px" />
            <span class="muted">天</span>
            <a-button size="small" :disabled="i === 0" @click="move(i, -1)">↑</a-button>
            <a-button size="small" :disabled="i === form.nodes.length - 1" @click="move(i, 1)">↓</a-button>
            <a-button size="small" @click="addRow(i)">+</a-button>
            <a-button size="small" danger :disabled="form.nodes.length === 1" @click="removeRow(i)">−</a-button>
          </div>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
.node-tag { margin-bottom: 4px; }
.node-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.seq { width: 20px; text-align: right; color: var(--ft-text-3); }
</style>
