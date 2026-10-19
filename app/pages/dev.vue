<script setup lang="ts">
/** 演示工具（仅 NUXT_DEV_TOOLS=1）：立即同步 QMS，写入/清除演示数据，模拟 QMS 返厂报检和检验结论，预警扫描，每日汇总 */
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
    await Promise.all([refreshWo(), refreshMaster(), refreshTransit(), refreshInspections(), refreshPurchases(), refreshNuxtData(['todos', 'me'])])
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

// ───── QMS 同步 ─────
type SyncRes = { resource: string; status: 'ok' | 'partial' | 'failed' | 'skipped'; rows: number; error?: string }
type SyncJob = {
  skipped?: 'not-configured' | 'running'
  sync?: { resources: SyncRes[]; alerted: number }
  match?: { matched: number; unmatched: number; other: number } | { error: string }
  nonconforming?: { created: number; existed: number } | { error: string }
}
const SYNC_STATUS_TEXT = { ok: '成功', partial: '未追平', failed: '失败', skipped: '跳过' } as const
async function syncNow() {
  busy.value = true
  try {
    const r = await ($fetch as unknown as (u: string, o: { method: 'POST' }) => Promise<SyncJob>)('/api/dev/sync', { method: 'POST' })
    if (r.skipped === 'not-configured') lastResult.value = '未配置 QMS 同步（NUXT_QMS_SYNC_ENABLED=0，或 QMS 地址、客户端凭据为空）'
    else if (r.skipped === 'running') lastResult.value = '另一轮同步正在进行，本次跳过'
    else {
      const res = (r.sync?.resources ?? []).map((x) => `${x.resource} ${SYNC_STATUS_TEXT[x.status]} ${x.rows} 行${x.error ? `（${x.error}）` : ''}`).join('；')
      const m = r.match && 'matched' in r.match ? `；匹配 ${r.match.matched} 条、待确认 ${r.match.unmatched} 条` : ''
      const n = r.nonconforming && 'created' in r.nonconforming ? `；不合格转异常 ${r.nonconforming.created} 条` : ''
      lastResult.value = `同步完成：${res}${m}${n}`
    }
    const failed = r.sync?.resources.some((x) => x.status === 'failed')
    if (failed) message.warning('同步有失败的资源，详见下方和设置页"QMS 同步状态"')
    else message.success('同步完成')
    await Promise.all([refreshWo(), refreshMaster(), refreshTransit(), refreshInspections(), refreshNuxtData(['todos', 'me', 'reminders'])])
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

// ───── 模拟进货检验（R10）─────
const { data: openPurchases, refresh: refreshPurchases } = await useFetch('/api/purchases', { query: { view: 'open' }, default: () => ({ rows: [] as PurchaseRow[], total: 0, stats: null }) })
const openLines = computed(() => openPurchases.value.rows as PurchaseRow[])
const incomingLine = ref<string | undefined>()
const incomingName = ref('')
watch(incomingLine, (id) => (incomingName.value = openLines.value.find((l) => l.id === id)?.materialName ?? ''))
async function submitIncoming() {
  const l = openLines.value.find((x) => x.id === incomingLine.value)
  if (!l) return
  busy.value = true
  try {
    const send = $fetch as unknown as (u: string, o: { method: 'POST'; body: object }) => Promise<{ incoming: { result: string } | null }>
    const r = await send('/api/dev/inspections', {
      method: 'POST',
      body: { workOrderNumber: l.workOrderNumber, partName: incomingName.value || l.materialName, supplierId: l.supplierId, quantity: Math.max(1, Math.round(l.quantity ?? 1)), category: 'INCOMING' },
    })
    const res = r.incoming?.result
    lastResult.value = res === 'MATCHED' ? `已自动确认到货：${l.materialName}` : res === 'MULTIPLE' ? '对上多项，没有自动确认（请手工确认）' : '没对上采购行，没有自动确认（请手工确认）'
    message.info(lastResult.value)
    incomingLine.value = undefined
    await Promise.all([refreshPurchases(), refreshInspections(), refreshNuxtData('todos')])
  } catch (e) {
    message.error(apiError(e))
  } finally {
    busy.value = false
  }
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
    <a-card title="QMS 同步">
      <p class="muted">定时任务每 5 分钟按游标增量同步一次 QMS（工单、外协单位、工序、部门、用户、报检），然后做返厂匹配和不合格转异常。这里立即跑一轮；各类资源的同步状态见设置页"QMS 同步状态"。</p>
      <a-button type="primary" :loading="busy" @click="syncNow">立即同步一次</a-button>
    </a-card>

    <a-card title="演示数据">
      <p class="muted">不连 QMS 时用演示数据走通外协主链路。所有演示数据的 ID 带 DEMO- 前缀，可与同步来的真实数据共存；配置了 QMS 同步时不写演示用户（u-001 等，用户以 QMS 为准）。清除只删 DEMO- 数据及引用它们的工件、步骤、流转记录、待办、待确认记录、预警和提醒，并清掉演示的通知对象、工单项目经理、演示路线模板，阈值恢复默认；同步来的真实数据不动。</p>
      <p class="muted">试发放签收（R9）：写入演示数据后有两张发放单——主梁结构件图纸（u-001、u-002、u-003 待签收）和支腿设计变更（下料在加工 → u-001、u-002 收到"确认变更影响"，机加标"等变更"）。发放人是 u-008 测试设计员。"快进 1 天 / 2 天扫描"可看 W5 未签收黄 / 红。</p>
      <p class="muted">试采购到货（R10）：写入演示数据后"采购到货"里有 5 项关键物料——钢板（超期、卡交期预付款待付、原因"付款"）、液压马达（5 天后要用还没承诺日）、回转支承（等到货）、减速机（晚到）、加热管；扫描后钢板 W6 红、液压马达 W6 黄。下面"模拟进货检验"选回转支承可自动确认到货；钢板也到了、且主梁结构件的出图任务完成并发放以后（R11），主梁结构件的第一道（组焊）给 u-001 发"可以开工"。采购部负责人 u-009，财务 u-010（标记已付）。</p>
      <p class="muted">试出图任务（R11）：写入演示数据后"出图任务"里有 4 个任务——主梁结构件总图（已过计划完成日未出图 → W7 红，挡着主梁结构件的"可以开工"）、支腿零件图（明天到期 → W7 黄）、液压系统原理图（已出图、客户确认超期 3 天 → W7 黄）、模具加热系统布置图（DEMO-WO-002，不预警）。用 u-008 测试设计员登录可在手机"我的出图任务"标记已出图，电脑端"一键发放"生成图纸发放单；技术部负责人 u-011。</p>
      <p class="muted">试总计划（R14）：写入演示数据后"总计划"页选 DEMO-WO-001——已发布，设计出图（主梁总图、液压原理图逾期）预计晚 2 天、关键物料到货（回转支承承诺日晚于节点）预计晚 4 天，后续节点顺延（标"受上游影响"，不单独报警），预计交期拖期 4 天（看板"拖期天数"、领导总览"预计拖期工单"）；扫描后两个源头节点 W9 黄 / 红，另有一条工单级 W9 红（交期风险），部门负责人"我的待办"里有"确认总计划节点"，机加节点已被生产部退回（项目经理收到提醒）。在出图 / 采购 / 工序 / 装配里新建记录时必须选所属节点。</p>
      <p class="muted">试齐套（R12）：写入演示数据后"齐套"页选 DEMO-WO-001 有 3 个装配节点——回转机构部装（回转底座已完工 + 减速机已到货 → 100% 齐套）、主梁总装（3 天后要装，主梁结构件图纸未完成、钢板超承诺日、回转支承待到货 → 0%，扫描后 W8 黄，"快进 3 天扫描"变红）、支腿部装（20 天后，支腿在制、液压马达无承诺日 → 缺件但还没到预警窗口）。生产经理 u-002 可新建、编辑节点，手机"齐套 / 缺件"看自己负责的节点；"模拟进货检验"选回转支承到货后齐套率随之上升。</p>
      <p class="muted">试 BOM 导入：写入演示数据后到"工件与工序链"选 DEMO-WO-002，点"从 QMS BOM 导入"（演示 BOM 不连 QMS）；试模板：到"工序路线模板"看演示模板，或给没有工序的工件"套用模板"。</p>
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
        <a-button :loading="busy" @click="scan(1)">快进 1 天扫描</a-button>
        <a-button :loading="busy" @click="scan(2)">快进 2 天扫描</a-button>
        <a-button :loading="busy" @click="digest">立即生成今日汇总</a-button>
      </a-space>
      <p class="muted" style="margin-top: 8px">红色预警自动转为异常；每日汇总平时由定时任务在 07:30（北京时间）后生成。</p>
    </a-card>

    <a-card title="模拟 QMS 检验结论">
      <p class="muted">按 QMS 的实际行为模拟判不合格：检验结论改为"不合格"并关联一张 QMS 问题单，报检状态仍是"检验中"（复检合格后 QMS 会改成已关闭 + 合格，已生成的异常不撤销）。系统随即生成"外协-质量"异常（责任方是该外协单位），关联的步骤显示"有异常"。</p>
      <a-space wrap>
        <a-select
          v-model:value="verdict.id"
          style="width: 520px"
          placeholder="选择一条模拟报检"
          :options="inspections.map((i) => ({ value: i.id, label: `${i.workOrderNumber} · ${i.partName} · ${i.processName}（${i.supplierName ?? '—'}，${i.quantity} 件）${i.inspectionResult === 'FAIL' || i.linkedIssueNo ? '　已判不合格' : i.status === 'CLOSED' ? '　已判合格' : ''}${i.matched ? '' : '　未关联'}` }))"
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
          <a-select v-model:value="form.supplierId" allow-clear :options="master.suppliers.map((s) => ({ value: s.id, label: s.label }))" />
        </a-form-item>
        <a-form-item label="数量"><a-input-number v-model:value="form.quantity" :min="0" /></a-form-item>
        <a-form-item :wrapper-col="{ offset: 4 }">
          <a-button type="primary" :loading="busy" @click="submit">提交报检并匹配</a-button>
        </a-form-item>
      </a-form>
    </a-card>

    <a-card title="模拟 QMS 进货检验（R10）">
      <p class="muted">模拟 QMS 新增一条进货检验（分类 INCOMING，工序"进货检验"），物料名称、供应商、工单取自所选采购行，然后立即跑一轮"进货检验确认到货"：同工单、同物料名称（两边都有 QMS 供应商时还要同供应商）、报检不早于登记日，恰好一条就自动确认到货。</p>
      <a-space wrap>
        <a-select v-model:value="incomingLine" show-search option-filter-prop="label" placeholder="选一项未到货的关键物料" style="width: 420px" :options="openLines.map((l) => ({ value: l.id, label: `${l.workOrderNumber} · ${l.materialName}（${l.supplierName ?? '未填供应商'}）` }))" />
        <a-input v-model:value="incomingName" placeholder="物料名称（可改成对不上的）" style="width: 200px" />
        <a-button type="primary" :loading="busy" :disabled="!incomingLine" @click="submitIncoming">模拟进货检验</a-button>
      </a-space>
    </a-card>
  </a-space>
</template>

<style scoped>
.muted { color: #999; }
</style>
