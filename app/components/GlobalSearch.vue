<script setup lang="ts">
/**
 * 页头全局搜索（10-26 借鉴 ERPNext"搜索一切"）：输入 2 个字以上，按工单 / 工件图号 / 采购物料 / 外协厂班组分组列出，选中就跳过去。
 * 只搜可见工单（后端拦）；不做假搜索：没结果就说没结果。
 */
type Hit = { type: 'workOrder' | 'part' | 'purchase' | 'supplier'; id: string; title: string; sub: string; link: string }
const GROUP_TEXT = { workOrder: '工单', part: '工件 / 图号', purchase: '采购物料', supplier: '外协厂 / 班组' } as const

const q = ref('')
const hits = ref<Hit[]>([])
const loading = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

function onSearch(v: string) {
  clearTimeout(timer)
  // 一输入就让旧结果和还在路上的旧请求失效，避免选到上一个词的结果
  const my = ++seq
  hits.value = []
  if (v.trim().length < 2) {
    loading.value = false
    return
  }
  loading.value = true
  timer = setTimeout(async () => {
    try {
      const r = await $fetch('/api/search', { query: { q: v.trim() } })
      if (my === seq) hits.value = r
    } catch {
      if (my === seq) hits.value = []
    } finally {
      if (my === seq) loading.value = false
    }
  }, 250)
}
onBeforeUnmount(() => clearTimeout(timer))

const options = computed(() => {
  if (q.value.trim().length < 2) return []
  if (!hits.value.length) return loading.value ? [] : [{ value: '__none', label: '没有找到', disabled: true }]
  return (Object.keys(GROUP_TEXT) as Hit['type'][])
    .map((t) => ({ t, rows: hits.value.filter((h) => h.type === t) }))
    .filter((g) => g.rows.length)
    .map((g) => ({ label: GROUP_TEXT[g.t], options: g.rows.map((h) => ({ value: `${h.type}:${h.id}`, hit: h })) }))
})

async function onSelect(value: unknown) {
  const hit = hits.value.find((h) => `${h.type}:${h.id}` === value)
  q.value = ''
  hits.value = []
  if (hit) await navigateTo(hit.link)
}
</script>

<template>
  <a-auto-complete
    v-model:value="q"
    :options="options"
    :default-active-first-option="true"
    :popup-match-select-width="420"
    class="global-search"
    @search="onSearch"
    @select="onSelect"
  >
    <template #option="opt">
      <div v-if="opt.hit" class="opt">
        <span class="opt-title">{{ opt.hit.title }}</span>
        <span class="opt-sub">{{ opt.hit.sub }}</span>
      </div>
      <span v-else class="opt-sub">{{ opt.label }}</span>
    </template>
    <a-input placeholder="搜工单号、图号、工件、物料、外协厂" aria-label="全局搜索">
      <template #prefix>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class="ico"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </template>
    </a-input>
  </a-auto-complete>
</template>

<style scoped>
.global-search { width: 100%; }
.ico { display: block; color: var(--ft-text-2); }
.opt { display: flex; flex-direction: column; line-height: 1.4; }
.opt-title { color: var(--ft-text); }
.opt-sub { font-size: 12px; color: var(--ft-text-2); }
</style>
