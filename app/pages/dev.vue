<script setup lang="ts">
/** 演示工具（仅 NUXT_DEV_TOOLS=1）：写入/清除演示数据，模拟 QMS 返厂报检 */
const { data: me } = useMe()
const { data: workOrders, refresh: refreshWo } = useWorkOrders()
const { data: master, refresh: refreshMaster } = useMaster()
const { data: transit, refresh: refreshTransit } = useFetch('/api/transit', { default: () => [] })
type TransitRow = (typeof transit.value)[number]

const busy = ref(false)
const lastResult = ref<string>('')

async function run(path: string, label: string) {
  busy.value = true
  try {
    const r = await $fetch(path, { method: 'POST' })
    lastResult.value = `${label}：${JSON.stringify(r)}`
    message.success(`${label}完成`)
    await Promise.all([refreshWo(), refreshMaster(), refreshTransit(), refreshNuxtData(['todos', 'me'])])
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

const form = reactive({
  workOrderNumber: undefined as string | undefined,
  partId: '',
  partName: '',
  processId: undefined as string | undefined,
  processName: '',
  supplierId: undefined as string | undefined,
  quantity: 1,
})
const fillFrom = ref<string | undefined>()

/** 按在途步骤填写：能对上的报检 */
function fill(stepId: unknown) {
  const s = transit.value.find((t: TransitRow) => t.stepId === stepId)
  if (!s) return
  Object.assign(form, {
    workOrderNumber: s.workOrderNumber,
    partId: s.qmsPartId ?? '',
    partName: s.partName,
    processId: s.processId,
    processName: s.processName,
    supplierId: s.supplierId ?? undefined,
    quantity: Math.max(s.quantity - s.returnedQty, 1),
  })
}
/** 改成对不上的：去掉物料 ID，名称写错 */
function breakIt() {
  form.partId = ''
  form.partName = `${form.partName || '某工件'}（名称写错）`
}

async function submit() {
  if (!form.workOrderNumber) return message.warning('请选择工单')
  busy.value = true
  try {
    const r = await $fetch('/api/dev/inspections', {
      method: 'POST',
      body: {
        workOrderNumber: form.workOrderNumber,
        partId: form.partId || null,
        partName: form.partName || null,
        processId: form.processId ?? null,
        processName: form.processName || null,
        supplierId: form.supplierId ?? null,
        quantity: form.quantity,
      },
    })
    const res = r.result
    lastResult.value =
      res?.status === 'matched'
        ? `已自动匹配：步骤${res.stepDone ? '已完成' : '部分返回'}${res.todoCreated ? '，已给下一道生成待办' : ''}`
        : res?.status === 'unmatched'
          ? `没匹配上（${REASON_TEXT[res.reason]}），已进入"待确认匹配"`
          : `结果：${JSON.stringify(res)}`
    message.info(lastResult.value)
    await Promise.all([refreshTransit(), refreshNuxtData('todos')])
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <a-result v-if="me && !me.devTools" status="404" title="演示工具未开启" sub-title="设置环境变量 NUXT_DEV_TOOLS=1 后重启" />
  <a-space v-else direction="vertical" size="large" style="width: 100%">
    <a-card title="演示数据">
      <p class="muted">R2（QMS 同步）完成前，用演示数据走通外协主链路。所有演示数据的 ID 带 DEMO- 前缀；清除只删这些数据及引用它们的工件、步骤、流转记录、待办和待确认记录。</p>
      <a-space>
        <a-button type="primary" :loading="busy" @click="run('/api/dev/seed', '写入演示数据')">写入演示数据</a-button>
        <a-button :loading="busy" @click="run('/api/dev/match', '执行一轮匹配')">执行一轮报检匹配</a-button>
        <a-popconfirm title="清除所有演示数据？" @confirm="run('/api/dev/reset', '清除演示数据')">
          <a-button danger :loading="busy">清除演示数据</a-button>
        </a-popconfirm>
      </a-space>
      <a-alert v-if="lastResult" :message="lastResult" type="info" style="margin-top: 16px" />
    </a-card>

    <a-card title="模拟 QMS 返厂报检">
      <a-form layout="horizontal" :label-col="{ span: 4 }" :wrapper-col="{ span: 14 }">
        <a-form-item label="按在途步骤填写">
          <a-space>
            <a-select
              v-model:value="fillFrom"
              style="width: 420px"
              placeholder="选一个在外加工的步骤，自动填出能对上的报检"
              :options="transit.map((t) => ({ value: t.stepId, label: `${t.workOrderNumber} · ${t.partName} · ${t.processName}（${t.supplierName ?? '—'}）` }))"
              @change="fill"
            />
            <a-button @click="breakIt">改成对不上的</a-button>
          </a-space>
        </a-form-item>
        <a-form-item label="工单" required>
          <a-select v-model:value="form.workOrderNumber" :options="workOrders.map((w) => ({ value: w.workOrderNumber, label: `${w.workOrderNumber}　${w.projectName ?? ''}` }))" />
        </a-form-item>
        <a-form-item label="物料 ID"><a-input v-model:value="form.partId" placeholder="QMS BOM 物料 ID，可空" /></a-form-item>
        <a-form-item label="物料名称"><a-input v-model:value="form.partName" /></a-form-item>
        <a-form-item label="工序">
          <a-select v-model:value="form.processId" allow-clear :options="master.processes.map((p) => ({ value: p.id, label: p.name }))" @change="(v: unknown) => (form.processName = master.processes.find((p) => p.id === v)?.name ?? form.processName)" />
        </a-form-item>
        <a-form-item label="工序名称"><a-input v-model:value="form.processName" placeholder="工序为空时按名称匹配" /></a-form-item>
        <a-form-item label="外协厂">
          <a-select v-model:value="form.supplierId" allow-clear :options="master.suppliers.map((s) => ({ value: s.id, label: s.name }))" />
        </a-form-item>
        <a-form-item label="数量"><a-input-number v-model:value="form.quantity" :min="0" /></a-form-item>
        <a-form-item :wrapper-col="{ offset: 4 }">
          <a-button type="primary" :loading="busy" @click="submit">提交报检并匹配</a-button>
        </a-form-item>
      </a-form>
    </a-card>
  </a-space>
</template>

<style scoped>
.muted { color: #999; }
</style>
