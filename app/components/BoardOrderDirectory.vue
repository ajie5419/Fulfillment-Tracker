<script setup lang="ts">
import { DELIVERY_HORIZON_DAYS, DIRECTORY_PAGE_SIZE, DIRECTORY_SEARCH_LIMIT, type DeliveryFilter } from '#shared/board-directory'
import { PLAN_STATUS_TEXT } from '#shared/plan'

const props = defineProps<{ mobile?: boolean }>()
const route = useRoute()
const router = useRouter()
const params = computed((previous?: { page: number; pageSize: number; q: string; delivery: DeliveryFilter; mine: '1' | '0' }) => {
  const query = route.query
  const page = Number(query.p)
  const delivery: DeliveryFilter = query.delivery === 'late' || query.delivery === 'soon' ? query.delivery : 'all'
  const next = {
    page: Number.isSafeInteger(page * DIRECTORY_PAGE_SIZE) && page > 0 && Number.isInteger(page) ? page : 1,
    pageSize: DIRECTORY_PAGE_SIZE, q: typeof query.q === 'string' ? query.q.slice(0, DIRECTORY_SEARCH_LIMIT).trim() : '',
    delivery, mine: query.mine === '1' ? '1' as const : '0' as const,
  }
  // Selection lives in the same URL. Keep the fetch options stable when only the selected order changes.
  return previous && previous.page === next.page && previous.q === next.q && previous.mine === next.mine && previous.delivery === next.delivery ? previous : next
})
const { data, status, error, refresh } = useApiFetch('/api/board-directory', {
  query: params, key: computed(() => 'board-directory:' + JSON.stringify(params.value)),
})
const ready = computed(() => status.value === 'success' && data.value?.page === params.value.page)
const pages = computed(() => Math.ceil((data.value?.total ?? 0) / DIRECTORY_PAGE_SIZE))
const rows = computed(() => ready.value ? data.value?.rows ?? [] : [])
const detailOpen = computed(() => route.query.dir !== '1' && Boolean(route.query.wo || route.query.edge))
const index = computed(() => {
  const pos = rows.value.findIndex(r => r.workOrderNumber === route.query.wo)
  return pos >= 0 ? pos : route.query.edge === 'last' ? rows.value.length - 1 : 0
})
const selected = computed(() => rows.value[index.value])
const absoluteIndex = computed(() => (params.value.page - 1) * DIRECTORY_PAGE_SIZE + index.value)
const list = ref<HTMLElement>()
const workspace = ref<HTMLElement>()
const tree = ref<{ refresh: () => unknown }>()
const search = ref(params.value.q)
watch(() => params.value.q, value => { search.value = value })
function update(changes: Record<string, string | undefined>) {
  return router.replace({ query: { ...route.query, ...changes }, hash: route.hash })
}
function filter(changes: Record<string, string | undefined>) {
  return update({ p: undefined, wo: undefined, edge: undefined, dir: undefined, ...changes })
}
let timer: ReturnType<typeof setTimeout> | undefined
function searchNow() {
  clearTimeout(timer)
  if (search.value.trim() !== params.value.q) void filter({ q: search.value.trim() || undefined })
}
function scheduleSearch() { clearTimeout(timer); timer = setTimeout(searchNow, 250) }
onBeforeUnmount(() => clearTimeout(timer))
function turn(page: number, edge?: 'first' | 'last') {
  return update({ p: page > 1 ? String(page) : undefined, wo: undefined, edge, dir: undefined })
}
function select(wo: string) {
  const query = { ...route.query, wo, edge: undefined, dir: undefined }
  return props.mobile && !detailOpen.value ? router.push({ query }) : router.replace({ query })
}
function advance(step: -1 | 1) {
  const next = rows.value[index.value + step]
  if (next) return select(next.workOrderNumber)
  return turn(params.value.page + step, step > 0 ? 'first' : 'last')
}
watch([ready, pages], () => {
  if (ready.value && params.value.page > Math.max(1, pages.value)) void turn(Math.max(1, pages.value))
})
watch(() => JSON.stringify(params.value), () => { if (list.value) list.value.scrollTop = 0 })
watch(() => selected.value?.workOrderNumber, async () => {
  await nextTick()
  if (workspace.value) workspace.value.scrollTop = 0
  const row = list.value?.querySelector<HTMLElement>('[aria-pressed="true"]')
  if (list.value && row && list.value.clientHeight > 0) {
    const delta = row.getBoundingClientRect().top - list.value.getBoundingClientRect().top
    if (delta < 0) list.value.scrollTop += delta
    else if (delta + row.offsetHeight > list.value.clientHeight) list.value.scrollTop += delta + row.offsetHeight - list.value.clientHeight
  }
})
defineExpose({ refresh: () => Promise.all([refresh(), tree.value?.refresh()]) })
</script>

<template>
  <div class="directory" :class="{ mobile, detail: detailOpen }">
    <aside aria-label="工单目录">
      <div class="filters">
        <div class="line"><strong>在执行工单</strong><small v-if="ready">{{ data?.total }} / {{ data?.available }}</small></div>
        <input v-model="search" type="search" aria-label="搜索工单" placeholder="搜工单号、项目或客户" :maxlength="DIRECTORY_SEARCH_LIMIT" @input="scheduleSearch" @keydown.enter="searchNow">
        <div class="line">
          <select :value="params.delivery" aria-label="交期筛选" @change="filter({ delivery: ($event.target as HTMLSelectElement).value })">
            <option value="all">全部交期</option><option value="late">预计拖期</option><option value="soon">{{ DELIVERY_HORIZON_DAYS }} 天内交付</option>
          </select>
          <label title="我担任项目经理的工单"><input type="checkbox" :checked="params.mine === '1'" @change="filter({ mine: params.mine === '1' ? undefined : '1' })"> 我负责的</label>
        </div>
      </div>
      <div ref="list" class="orders">
        <p v-if="error" role="alert">目录加载失败 · {{ apiError(error) }} <button @click="refresh()">重试</button></p>
        <p v-else-if="!ready">正在读取工单…</p>
        <button v-for="r in rows" :key="r.workOrderNumber" class="order" :aria-pressed="r.workOrderNumber === selected?.workOrderNumber" @click="select(r.workOrderNumber)">
          <span class="line"><b>{{ r.projectName || r.workOrderNumber }}</b>
            <small v-if="(r.delayDays ?? 0) > 0" class="late">预计晚 {{ r.delayDays }} 天</small>
            <small v-else-if="r.dueSoon">即将交付</small>
            <small v-else-if="r.review">交期待核实</small>
            <small v-else>{{ r.expectedDelivery ? '预计按期' : PLAN_STATUS_TEXT[r.status] }}</small>
          </span>
          <small>{{ [r.workOrderNumber, r.customerName].filter(Boolean).join(' · ') }}</small>
        </button>
        <p v-if="ready && !rows.length">没有匹配的工单</p>
      </div>
      <nav class="line pager" aria-label="目录分页">
        <button :disabled="!ready || params.page <= 1" @click="turn(params.page - 1)">上一页</button>
        <small>{{ ready ? (pages ? params.page : 0) + ' / ' + pages : '—' }}</small>
        <button :disabled="!ready || params.page >= pages" @click="turn(params.page + 1)">下一页</button>
      </nav>
    </aside>
    <section ref="workspace" class="workspace" aria-label="工单进展">
      <div class="line toolbar">
        <small class="caption">工单进展</small><button class="back" @click="update({ dir: '1' })">‹ 工单目录</button>
        <div><button :disabled="!selected || absoluteIndex <= 0" @click="advance(-1)">上一单</button>
          <button :disabled="!selected || absoluteIndex + 1 >= (data?.total ?? 0)" @click="advance(1)">下一单</button></div>
      </div>
      <BoardOrderPlan v-if="selected && (!props.mobile || detailOpen)" :key="selected.workOrderNumber" ref="tree" :wo="selected.workOrderNumber" :mobile="mobile" />
      <p v-else-if="error" role="alert">工单目录加载失败。<button @click="refresh()">重试</button></p>
      <p v-else-if="!ready">正在读取工单…</p>
      <p v-else>当前筛选下没有工单。</p>
    </section>
  </div>
</template>

<style scoped>
.directory { display:grid; grid-template-columns:clamp(245px,23%,345px) minmax(0,1fr); height:clamp(350px,calc(100dvh - 170px),100dvh); border:1px solid var(--ft-border); border-radius:12px; overflow:hidden; background:var(--ft-fill); }
aside { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--ft-border); background:var(--ft-card-bg); }
.filters,.pager { padding:12px 14px; }
.line { display:flex; align-items:center; justify-content:space-between; gap:8px; }
button,select,input[type=search] { font:inherit; color:var(--ft-text); background:var(--ft-card-bg); border:1px solid var(--ft-border); border-radius:5px; padding:4px 9px; }
button,select,label { cursor:pointer; }
button:disabled { opacity:.45; cursor:default; }
input[type=search] { width:100%; margin:10px 0; padding:6px 9px; }
small,.orders p,.workspace > p { color:var(--ft-text-3); }
label,small { font-size:12px; }
.orders { flex:1; min-height:0; overflow:auto; }
.orders p,.workspace > p { padding:12px; }
.order { width:100%; text-align:left; border:0; border-top:1px solid var(--ft-border); border-radius:0; padding:10px 14px; }
.order:hover { background:var(--ft-fill); }
.order[aria-pressed=true] { background:var(--ft-primary-bg); box-shadow:inset 3px 0 var(--ft-primary); }
.order b { overflow-wrap:anywhere; }.order .line small { flex-shrink:0; }.late { color:var(--ft-late-text); }
.pager { border-top:1px solid var(--ft-border); }
.workspace { min-width:0; overflow:auto; padding:16px clamp(12px,2vw,32px) 32px; }
.toolbar { margin-bottom:18px; }.toolbar button+button { margin-left:5px; }.back { display:none; }
.mobile { display:block; height:calc(100dvh - 165px); min-height:320px; }
.mobile aside,.mobile .workspace { height:100%; }.mobile .workspace,.mobile.detail aside,.mobile .caption { display:none; }
.mobile.detail .workspace,.mobile .back { display:block; }
@media(max-width:700px) {
  .directory { display:block; } aside,.workspace { height:100%; }
  .workspace,.detail aside,.caption { display:none; }.detail .workspace,.back { display:block; }
}
</style>
