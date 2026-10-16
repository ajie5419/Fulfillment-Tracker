<script setup lang="ts">
/** 演示工具（仅 NUXT_DEV_TOOLS=1）：写入/清除演示数据，模拟 QMS 返厂报检和检验结论，预警扫描，每日汇总 */
const { data: me } = await useMe()
const { data: workOrders, refresh: refreshWo } = await useWorkOrders()
const { data: master, refresh: refreshMaster } = await useMaster()
const { data: transit, refresh: refreshTransit } = await useFetch('/api/transit', { default: () => [] })
type TransitRow = (typeof transit.value)[number]
const { data: inspections, refresh: refreshInspections } = await useFetch('/api/dev/inspections', { default: () => [] })

const busy = ref(false)
const lastResult = ref<string>('')

async function run(path: string, label: string) {
  busy.value = true
  try {
    const r = await $fetch(path, { method: 'POST' })
    lastResult.value = `${label}：${JSON.stringify(r)}`
    message.success(`${label}完成`)
    await Promise.all([refreshWo(), refreshMaster(), refreshTransit(), refreshInspections(), refreshNuxtData(['todos', 'me'])])
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

/** 预警扫描；plusDays 把时钟往后拨，演示 Q12（返厂后第 3 天黄、第 5 天红） */
async function scan(plusDays: number) {
  busy.value = true
  try {
    const r = await $fetch('/api/dev/scan', { method: 'POST', body: { plusDays } })
    lastResult.value = r.skipped
      ? '另一轮扫描正在进行，本次跳过'
      : `扫描完成（按 ${timeText(r.now)} 计）：新建 ${r.created}、升级 ${r.escalated}、消除 ${r.cleared}，写入提醒 ${r.reminders} 条，活动预警 ${r.active} 条，红色转异常 ${r.converted} 条，QMS 不合格转异常 ${r.nonconforming} 条`
    message.success(lastResult.value)
    await refreshNuxtData('reminders')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

// ───── 模拟 QMS 检验结论（不合格）→ 自动生成"外协-质量"异常（验收 A7） ─────
const verdict = reactive({ id: undefined as string | undefined, unqualifiedQuantity: 1 })
async function fail() {
  if (!verdict.id) return message.warning('请选择报检')
  busy.value = true
  try {
    const send = $fetch as unknown as (u: string, o: { method: 'POST'; body: object }) => Promise<{ nonconforming: { created: { issueNo: string }[] } }>
    const r = await send(`/api/dev/inspections/${encodeURIComponent(verdict.id)}/verdict`, { method: 'POST', body: { unqualifiedQuantity: verdict.unqualifiedQuantity } })
    const nos = r.nonconforming.created.map((c) => c.issueNo)
    lastResult.value = nos.length ? `已判不合格，生成异常 ${nos.join('、')}（步骤置为"有异常"）` : '已判不合格；该报检还没关联到步骤（先在"待确认匹配"里关联），或异常已经生成过'
    message.info(lastResult.value)
    await refreshInspections()
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
}

/** 立即生成今日汇总（不看 07:30） */
async function digest() {
  busy.value = true
  try {
    const r = await ($fetch as unknown as (u: string, o: { method: 'POST' }) => Promise<{ day: string; recipients: number; created: number }>)('/api/dev/digest', { method: 'POST' })
    lastResult.value = `今日汇总（${r.day}）：收件人 ${r.recipients} 人，新生成 ${r.created} 条（同人同日只一条）`
    message.success(lastResult.value)
    await refreshNuxtData('reminders')
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
    await Promise.all([refreshTransit(), refreshInspections(), refreshNuxtData('todos')])
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
      <p class="muted">R2（QMS 同步）完成前，用演示数据走通外协主链路。所有演示数据的 ID 带 DEMO- 前缀；清除只删这些数据及引用它们的工件、步骤、流转记录、待办、待确认记录、预警和提醒，并清掉演示的通知对象、工单项目经理，阈值恢复默认。</p>
      <a-space>
        <a-button type="primary" :loading="busy" @click="run('/api/dev/seed', '写入演示数据')">写入演示数据</a-button>
        <a-button :loading="busy" @click="run('/api/dev/match', '执行一轮匹配')">执行一轮报检匹配</a-button>
        <a-popconfirm title="清除所有演示数据？" @confirm="run('/api/dev/reset', '清除演示数据')">
          <a-button danger :loading="busy">清除演示数据</a-button>
        </a-popconfirm>
      </a-space>
      <a-alert v-if="lastResult" :message="lastResult" type="info" style="margin-top: 16px" />
    </a-card>

    <a-card title="预警扫描">
      <p class="muted">定时任务每 15 分钟扫描一次。"快进"只是用 当前时间 + N 天 判定一轮（不改数据），用来演示返厂后不安排下一道：第 3 天 W2 黄、第 5 天 W2 红。</p>
      <a-space>
        <a-button type="primary" :loading="busy" @click="scan(0)">立即扫描</a-button>
        <a-button :loading="busy" @click="scan(3)">快进 3 天扫描</a-button>
        <a-button :loading="busy" @click="scan(5)">快进 5 天扫描</a-button>
        <a-button :loading="busy" @click="digest">立即生成今日汇总</a-button>
      </a-space>
      <p class="muted" style="margin-top: 8px">红色预警自动转为异常；每日汇总平时由定时任务在 07:30（北京时间）后生成。</p>
    </a-card>

    <a-card title="模拟 QMS 检验结论">
      <p class="muted">把一条模拟报检改为"已关闭 + 不合格"，系统随即生成"外协-质量"异常（责任方是该外协单位），关联的步骤显示"有异常"。</p>
      <a-space wrap>
        <a-select
          v-model:value="verdict.id"
          style="width: 520px"
          placeholder="选择一条模拟报检"
          :options="inspections.map((i) => ({ value: i.id, label: `${i.workOrderNumber} · ${i.partName} · ${i.processName}（${i.supplierName ?? '—'}，${i.quantity} 件）${i.status === 'CLOSED' ? `　已判${i.inspectionResult === 'FAIL' ? '不合格' : '合格'}` : ''}${i.matched ? '' : '　未关联'}` }))"
        />
        <span>不合格数量</span>
        <a-input-number v-model:value="verdict.unqualifiedQuantity" :min="0" />
        <a-button type="primary" danger :loading="busy" @click="fail">判不合格</a-button>
      </a-space>
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
