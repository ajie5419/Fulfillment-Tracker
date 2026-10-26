<script setup lang="ts">
/**
 * 手机"生产"页签（生产管理重设计第一批，zhao 10-26 确认）：原"加工中""外协在途"和发出入口合成一页，一张卡一个按钮。
 *   能开工：可以开工的工序（口径同电脑端生产调度）——自制 / 厂内外协点"开工"，厂外外协点"发出"（进发出登记页）；
 *   在做：已开工的自制 / 厂内外协，点"完工"（可部分完工、报废）；
 *   在外：厂外外协已发出没全部返回的，QMS 漏报检时点"登记返厂"。
 * 默认"我的"（我负责的），可切"全部"。地址栏 ?seg=ready|working|out、?mine=1|0、?stepId=（提醒跳过来定位到那一道，默认"全部"；用户切范围时清掉）、?wo=。
 * 能否操作与电脑端一致：生产部、外协专员、该工序负责人、管理员（后端同样拦）。
 */
definePageMeta({ layout: 'mobile' })
const { data: me } = await useMe()
const route = useRoute()
const router = useRouter()

type Seg = 'ready' | 'working' | 'out'
const SEGS: Seg[] = ['ready', 'working', 'out']
const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
const segOf = (v: string): Seg => ((SEGS as string[]).includes(v) ? (v as Seg) : 'ready')
// 地址栏是唯一来源（返回 / 前进、点提醒再进来都跟着变）：页签、范围都从 query 算，用户操作只改 query。
// 范围：?mine=1 我的、?mine=0 全部；没写时带 stepId / wo（从提醒、工单跳来）默认"全部"，否则"我的"
const focusId = computed(() => q('stepId'))
const wo = computed(() => q('wo'))
const seg = computed<Seg>(() => segOf(q('seg')))
const scope = computed<'mine' | 'all'>(() => {
  const m = q('mine')
  if (m === '1') return 'mine'
  if (m === '0') return 'all'
  return q('stepId') || q('wo') ? 'all' : 'mine'
})
function setSeg(s: Seg) {
  router.replace({ query: { ...route.query, seg: s } })
}
/** 用户自己切了范围：一次性的 stepId（定位用）一并清掉，不然它会把范围又拉回"全部" */
function setScope(m: 'mine' | 'all') {
  const { stepId: _drop, ...rest } = route.query
  router.replace({ query: { ...rest, mine: m === 'mine' ? '1' : '0' } })
}

const { data, pending, refresh } = await useFetch('/api/production', {
  query: computed(() => ({ mine: scope.value === 'mine' ? '1' : '0', wo: wo.value || undefined })),
  default: () => ({ rows: [], unroutedParts: 0 }),
})
type Row = (typeof data.value.rows)[number]
const COLUMN_OF: Record<Seg, Row['column']> = { ready: 'ready', working: 'working', out: 'out' }
const rowsOf = (s: Seg) => data.value.rows.filter((r) => r.column === COLUMN_OF[s])
const list = computed(() => {
  const l = rowsOf(seg.value)
  return focusId.value ? [...l].sort((a, b) => Number(b.stepId === focusId.value) - Number(a.stepId === focusId.value)) : l
})
const segTitle = (s: Seg) => `${{ ready: '能开工', working: '在做', out: '在外' }[s]} ${rowsOf(s).length}`
const canStep = (r: Row) => canDo(me.value, 'stepAction', { workOrderNumber: r.workOrderNumber, ownerId: r.ownerId })
const late = (r: Row) => r.overdueDays > 0 || r.startLateDays > 0

async function after() {
  await Promise.all([refresh(), refreshNuxtData('todos')])
}

// ───── 开工 / 发出 ─────
async function start(r: Row) {
  if (r.mode === 'EXTERNAL_OUTSOURCE') return navigateTo(`/m/send?stepId=${encodeURIComponent(r.stepId)}`)
  try {
    await showConfirmDialog({ title: '确认开工', message: `${r.partName} · ${r.processName}` })
  } catch {
    return // 取消
  }
  try {
    await $fetch(`/api/steps/${r.stepId}/start`, { method: 'POST', body: { source: 'MOBILE' } })
    showSuccessToast('已开工，完工时到"在做"点完工')
    await after()
  } catch (e) {
    showFailToast(apiError(e))
  }
}

// ───── 完工：默认剩余全部；数量不够时选"剩下的还在做"（部分完工）或"报废了"（自动转异常，生产经理安排补料）─────
const finishing = ref<Row | null>(null)
const finishQty = ref(0)
const rest = ref<'CONTINUE' | 'SCRAP'>('CONTINUE')
const scrapNote = ref('')
const saving = ref(false)
const remainingOf = (r: Row) => Math.max(r.quantity - r.doneQty, 0)
const short = computed(() => (finishing.value ? remainingOf(finishing.value) - finishQty.value : 0))
function openFinish(r: Row) {
  finishing.value = r
  finishQty.value = remainingOf(r)
  rest.value = 'CONTINUE'
  scrapNote.value = ''
}
async function doFinish() {
  const r = finishing.value
  if (!r) return
  if (short.value > 0 && rest.value === 'CONTINUE' && finishQty.value === 0) return showToast('部分完工至少 1 件')
  saving.value = true
  try {
    const body = short.value > 0 ? { source: 'MOBILE', qty: finishQty.value, rest: rest.value, note: rest.value === 'SCRAP' ? scrapNote.value || null : null } : { source: 'MOBILE' }
    const res = await $fetch(`/api/steps/${r.stepId}/finish`, { method: 'POST', body })
    showSuccessToast(short.value <= 0 ? '已完工' : rest.value === 'CONTINUE' ? `已报完工 ${finishQty.value} 件` : `已完工，报废已转异常 ${res.issueNo ?? ''}`)
    finishing.value = null
    await after()
  } catch (e) {
    showFailToast(apiError(e))
  } finally {
    saving.value = false
  }
}

// ───── 登记返厂（QMS 漏报检时）─────
const returning = ref<Row | null>(null)
const returnQty = ref(1)
function openReturn(r: Row) {
  returning.value = r
  returnQty.value = Math.max(r.quantity - r.doneQty, 1)
}
async function doReturn() {
  const r = returning.value
  if (!r) return
  try {
    await $fetch(`/api/steps/${r.stepId}/return`, { method: 'POST', body: { qty: returnQty.value, source: 'MOBILE' } })
    showSuccessToast('已登记返厂')
    returning.value = null
    await after()
  } catch (e) {
    showFailToast(apiError(e))
  }
}

const percent = (r: Row) => (r.quantity > 0 ? Math.min(100, Math.round((r.doneQty / r.quantity) * 100)) : 0)
const where = (r: Row) => (r.mode === 'SELF' ? `自制${r.supplierName ? ` · ${r.supplierName}` : ''}` : r.supplierName ?? (r.mode === 'IN_PLANT_OUTSOURCE' ? '厂内外协' : '未选外协厂'))
function dateLine(r: Row) {
  if (r.column === 'out') return r.promisedReturnDate ? (r.overdueDays ? `承诺返回已超 ${r.overdueDays} 天` : `承诺 ${dayText(r.promisedReturnDate)} 返回`) : '未填承诺返回日'
  if (r.column === 'ready') {
    if (r.startLateDays) return `应开工已过 ${r.startLateDays} 天`
    return r.planStartDate ? `应开工 ${dayText(r.planStartDate)}` : r.dueDate ? `要求 ${dayText(r.dueDate)} 完成` : '未定日期'
  }
  if (r.overdueDays) return `要求完成已超 ${r.overdueDays} 天`
  return r.dueDate ? `要求 ${dayText(r.dueDate)} 完成` : '未定要求完成日'
}
const EMPTY: Record<Seg, string> = { ready: '没有能开工的工序', working: '没有在做的工序', out: '没有在外的工件' }
</script>

<template>
  <div>
    <van-nav-bar title="生产" />
    <van-tabs :active="scope" shrink @update:active="(v: string | number) => setScope(v === 'all' ? 'all' : 'mine')">
      <van-tab title="我的" name="mine" />
      <van-tab title="全部" name="all" />
    </van-tabs>
    <div class="segs" role="tablist">
      <button v-for="s in SEGS" :key="s" type="button" role="tab" :aria-selected="seg === s" class="seg" :class="{ on: seg === s }" @click="setSeg(s)">{{ segTitle(s) }}</button>
    </div>
    <div v-if="me?.can.mobileSend && seg !== 'working'" class="send-any">
      <span class="m-muted">上一道还没回来也要先发出？</span>
      <van-button size="mini" plain type="primary" to="/m/send">手工登记发出</van-button>
    </div>
    <div v-if="wo" class="m-hint">只看工单 {{ wo }} <van-button size="mini" plain @click="router.replace({ query: { ...route.query, wo: undefined } })">看全部工单</van-button></div>

    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!list.length" :description="scope === 'mine' ? `${EMPTY[seg]}（我负责的）` : EMPTY[seg]" image-size="80">
      <van-button v-if="scope === 'mine'" size="small" plain @click="setScope('all')">看全部</van-button>
    </van-empty>
    <div v-else class="m-list">
      <MCard v-for="r in list" :key="r.stepId" :tone="late(r) ? 'late' : 'primary'" :class="{ focus: r.stepId === focusId }">
        <div class="m-row">
          <van-tag v-if="late(r)" type="danger">{{ r.column === 'ready' ? '已过应开工日' : '已超期' }}</van-tag>
          <van-tag v-else type="primary">{{ r.column === 'ready' ? (r.mode === 'EXTERNAL_OUTSOURCE' ? '待发出' : '可以开工') : r.column === 'working' ? '加工中' : '在外加工' }}</van-tag>
          <span class="wo">{{ r.workOrderNumber }}</span>
        </div>
        <div class="m-title name">{{ r.partName }} · {{ r.processName }}</div>
        <div class="m-meta">
          <span>{{ where(r) }} · {{ r.quantity }} 件</span>
          <span :class="{ 'm-text-late': late(r) }">{{ dateLine(r) }}</span>
        </div>
        <div class="m-meta"><span>负责人 {{ r.ownerName ?? '未指定' }}</span></div>
        <div v-if="r.doneQty" class="m-progress">
          <van-progress :percentage="percent(r)" :show-pivot="false" :class="late(r) ? 'm-progress-late' : 'm-progress-primary'" />
          <span class="m-progress-text">{{ r.column === 'out' ? '已回' : '已完成' }} {{ r.doneQty }}/{{ r.quantity }}</span>
        </div>
        <div v-if="canStep(r)" class="m-foot-row">
          <span class="m-spacer" />
          <van-button v-if="r.column === 'ready'" size="small" type="primary" @click="start(r)">{{ r.mode === 'EXTERNAL_OUTSOURCE' ? '发出' : '开工' }}</van-button>
          <van-button v-else-if="r.column === 'working'" size="small" type="primary" @click="openFinish(r)">完工</van-button>
          <van-button v-else size="small" :type="r.overdueDays > 0 ? 'danger' : 'primary'" plain @click="openReturn(r)">登记返厂</van-button>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />

    <van-dialog :show="!!finishing" title="完工" show-cancel-button :confirm-button-text="short > 0 && rest === 'CONTINUE' ? '报部分完工' : '确认完工'" :confirm-button-disabled="saving" @confirm="doFinish" @cancel="finishing = null">
      <div v-if="finishing" class="dialog">
        <p>{{ finishing.partName }} · {{ finishing.processName }}</p>
        <p class="m-muted tip">共 {{ finishing.quantity }} 件{{ finishing.doneQty ? `，已完成 ${finishing.doneQty} 件` : '' }}，本次完成：</p>
        <van-stepper v-model="finishQty" :min="0" :max="remainingOf(finishing)" integer />
        <template v-if="short > 0">
          <p class="tip short">还差 {{ short }} 件，剩下的：</p>
          <van-radio-group v-model="rest" direction="horizontal" class="rest">
            <van-radio name="CONTINUE">还在做（含返修）</van-radio>
            <van-radio name="SCRAP">报废了</van-radio>
          </van-radio-group>
          <van-field v-if="rest === 'SCRAP'" v-model="scrapNote" placeholder="报废原因（可空）" maxlength="200" class="note" />
          <p class="m-muted tip">{{ rest === 'CONTINUE' ? '工序继续加工，下一道先收到待办' : '本工序完成，报废的自动转异常，生产经理安排补料重做' }}</p>
        </template>
        <p v-else class="m-muted tip">完工后自动给下一道工序发待办</p>
      </div>
    </van-dialog>

    <van-dialog :show="!!returning" title="登记返厂" show-cancel-button @confirm="doReturn" @cancel="returning = null">
      <div class="dialog">
        <p>{{ returning?.partName }} · {{ returning?.processName }}</p>
        <p class="m-muted tip">QMS 漏报检时使用；全部返回后这道自动完成</p>
        <van-stepper v-model="returnQty" :min="1" integer />
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.segs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 10px 12px 0; padding: 3px; border-radius: 10px; background: var(--ft-fill); }
.seg { padding: 6px 0; border: none; border-radius: 8px; background: none; color: var(--ft-text-2); font-size: 14px; }
.seg.on { background: var(--ft-card-bg); color: var(--ft-text); font-weight: 600; box-shadow: 0 0 0 1px var(--ft-border); }
.seg:focus-visible { outline: 2px solid var(--ft-primary); }
.send-any { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 16px 0; font-size: 12px; }
.wo { font-size: 13px; color: var(--ft-text-2); font-weight: 500; }
.name { margin-top: 6px; }
.focus { border-color: var(--ft-primary); }
.dialog { padding: 12px 24px 20px; text-align: center; }
.tip { font-size: 12px; margin: 8px 0; }
.short { color: var(--ft-text); font-size: 13px; margin-top: 14px; }
.rest { justify-content: center; }
.note { margin-top: 8px; border: 1px solid var(--ft-border); border-radius: 8px; }
</style>
