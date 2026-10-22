<script setup lang="ts">
/**
 * 设置 →"总计划模板"（R14）：节点名称、顺序、责任部门、交期前天数；10-22 加阶段、工期、前置节点（按真实 MS Project 计划，多条线并行）。项目部负责人、管理员可维护（接口也校验）。
 * 改模板不影响已经生成的总计划（生成时复制）。
 */
import { BUSINESS_DEPT_OPTIONS } from '#shared/business-depts'

interface TplNode { name: string; dept: string; daysBeforeDelivery: number; phase: string | null; durationDays: number | null; preds: number[] | null }
interface Tpl { id: string; name: string; description: string | null; createdByName: string | null; updatedAt: string; nodes: (TplNode & { seq: number; deptText: string })[] }
/** 编辑中的行：key 稳定（上下移动、删行时前置关系跟着行走，不按位置错位）；preds 存行 key，NONE = 没有前置 */
interface EditRow { key: number; name: string; dept: string; daysBeforeDelivery: number; phase: string; durationDays: number | undefined; preds: number[] }
const NONE = -1

const DEPTS = BUSINESS_DEPT_OPTIONS

const { data, refresh, pending } = await useFetch<Tpl[]>('/api/plan/templates', { default: () => [] })
const send = $fetch as unknown as (url: string, opts: { method: 'POST' | 'PUT' | 'DELETE'; body?: object }) => Promise<unknown>

const open = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)
const form = reactive<{ name: string; description: string; nodes: EditRow[] }>({ name: '', description: '', nodes: [] })
let nextKey = 1
const blank = (from?: EditRow): EditRow => ({ key: nextKey++, name: '', dept: from?.dept ?? 'PROJECT', daysBeforeDelivery: from?.daysBeforeDelivery ?? 0, phase: from?.phase ?? '', durationDays: undefined, preds: [] })

function edit(t: Tpl | null) {
  editingId.value = t?.id ?? null
  form.name = t?.name ?? ''
  form.description = t?.description ?? ''
  if (!t) form.nodes = [blank()]
  else {
    const keys = t.nodes.map(() => nextKey++)
    form.nodes = t.nodes.map((n, i) => ({
      key: keys[i]!,
      name: n.name,
      dept: n.dept,
      daysBeforeDelivery: n.daysBeforeDelivery,
      phase: n.phase ?? '',
      durationDays: n.durationDays ?? undefined,
      preds: n.preds == null ? [] : n.preds.length ? n.preds.map((seq) => keys[seq - 1]!).filter((k) => k != null) : [NONE],
    }))
  }
  open.value = true
}
const addRow = (i: number) => form.nodes.splice(i + 1, 0, blank(form.nodes[i]))
function removeRow(i: number) {
  const [gone] = form.nodes.splice(i, 1)
  for (const n of form.nodes) n.preds = n.preds.filter((k) => k !== gone!.key)
}
/** 前置下拉：其他行（按当前顺序号显示），外加"无前置" */
const predOptions = (row: EditRow) => [
  { value: NONE, label: '无前置' },
  ...form.nodes.filter((n) => n.key !== row.key).map((n) => ({ value: n.key, label: `#${form.nodes.indexOf(n) + 1} ${n.name || '（未命名）'}` })),
]
/** 选了"无前置"就只留它；选了别的就去掉"无前置" */
function onPreds(row: EditRow, v: number[]) {
  row.preds = v.at(-1) === NONE ? [NONE] : v.filter((k) => k !== NONE)
}
const phaseOptions = computed(() => [...new Set(form.nodes.map((n) => n.phase.trim()).filter(Boolean))].map((value) => ({ value })))
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
    const pos = new Map(form.nodes.map((n, i) => [n.key, i + 1]))
    const nodes = form.nodes.map((n) => ({
      name: n.name,
      dept: n.dept,
      daysBeforeDelivery: n.daysBeforeDelivery,
      phase: n.phase.trim() || null,
      durationDays: n.durationDays || null,
      // 没选 = 默认上一个；"无前置" = []；其余换成当前顺序号
      preds: !n.preds.length ? null : n.preds[0] === NONE ? [] : n.preds.map((k) => pos.get(k)!).filter(Boolean),
    }))
    const body = { name: form.name, description: form.description || null, nodes }
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
  { title: '节点（交期前天数 / 工期 / 前置）', key: 'nodes' },
  { title: '', key: 'ops', width: 130 },
]
</script>

<template>
  <div>
    <p class="muted">
      "项目计划"页"按模板生成"时，每个节点的计划日 = 工单交期 − 交期前天数；生成后可以逐个调整。改模板不影响已经生成的总计划。
    </p>
    <a-button type="primary" size="small" style="margin-bottom: 12px" @click="edit(null)">新建模板</a-button>
    <a-table :columns="columns" :data-source="data" :loading="pending" row-key="id" size="small" :pagination="false">
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          {{ record.name }}
          <div v-if="record.description" class="muted">{{ record.description }}</div>
        </template>
        <template v-else-if="column.key === 'nodes'">
          <template v-for="(n, i) in record.nodes" :key="n.seq">
            <div v-if="n.phase && n.phase !== record.nodes[i - 1]?.phase" class="phase">{{ n.phase }}</div>
            <a-tag class="node-tag">
              {{ n.seq }}. {{ n.name }}（{{ n.deptText }}，交期前 {{ n.daysBeforeDelivery }} 天<template v-if="n.durationDays">，工期 {{ n.durationDays }} 天</template><template v-if="n.preds">，前置 {{ n.preds.length ? n.preds.map((p: number) => `#${p}`).join(' ') : '无' }}</template>）
            </a-tag>
          </template>
        </template>
        <template v-else-if="column.key === 'ops'">
          <a-space>
            <a-button size="small" @click="edit(record as Tpl)">编辑</a-button>
            <a-button size="small" danger @click="remove(record as Tpl)">删除</a-button>
          </a-space>
        </template>
      </template>
    </a-table>

    <a-modal v-model:open="open" :title="editingId ? '编辑总计划模板' : '新建总计划模板'" width="1040px" :confirm-loading="saving" @ok="save">
      <a-form layout="vertical">
        <a-form-item label="模板名称" required><a-input v-model:value="form.name" :maxlength="191" /></a-form-item>
        <a-form-item label="说明"><a-input v-model:value="form.description" :maxlength="500" /></a-form-item>
        <a-form-item label="节点（按顺序）">
          <p class="muted">完成日 = 交期 − 交期前天数（可以为负 = 交期后）；填了工期的，开始日 = 完成日 − 工期 + 1。前置不选 = 默认上一个节点。</p>
          <div class="node-row head muted">
            <span class="seq">#</span><span style="width: 140px">阶段</span><span style="width: 170px">节点名称</span><span style="width: 100px">责任部门</span>
            <span style="width: 84px">交期前天数</span><span style="width: 72px">工期</span><span style="width: 200px">前置节点</span>
          </div>
          <div v-for="(n, i) in form.nodes" :key="n.key" class="node-row">
            <span class="seq">{{ i + 1 }}</span>
            <a-auto-complete v-model:value="n.phase" :options="phaseOptions" placeholder="阶段" style="width: 140px" :maxlength="64" />
            <a-input v-model:value="n.name" placeholder="节点名称" style="width: 170px" :maxlength="191" />
            <a-select v-model:value="n.dept" :options="DEPTS" style="width: 100px" />
            <a-input-number v-model:value="n.daysBeforeDelivery" :min="-365" :max="2000" :precision="0" style="width: 84px" aria-label="交期前天数" />
            <a-input-number v-model:value="n.durationDays" :min="1" :max="2000" :precision="0" placeholder="天" style="width: 72px" aria-label="工期（天）" />
            <a-select
              :value="n.preds"
              mode="multiple"
              :options="predOptions(n)"
              option-filter-prop="label"
              :max-tag-count="2"
              placeholder="上一个"
              style="width: 200px"
              aria-label="前置节点"
              @change="(v: unknown) => onPreds(n, v as number[])"
            />
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
.phase { font-size: 12px; font-weight: 600; color: var(--ft-text-2); margin: 4px 0 2px; }
.node-row.head { margin-bottom: 2px; flex-wrap: nowrap; }
.node-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
.seq { width: 20px; text-align: right; color: var(--ft-text-3); }
</style>
