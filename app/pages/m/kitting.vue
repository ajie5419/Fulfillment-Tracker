<script setup lang="ts">
/**
 * 手机：齐套 / 缺件（R12，只读）。给节点负责人看：
 *   "我负责的"：负责人是我（没指定负责人的节点归生产经理），不受工单可见范围限制；
 *   "全部未齐套"：可见工单上未齐套的节点，按需求日从近到远。
 * 每个节点显示齐套率和缺件（卡在哪一步）。新建、编辑请到电脑端"齐套"。
 * 从 W8 提醒点进来时带 ?id=：顶部单独展示这个节点（按能否看到该工单判权限，负责人本人也能看）。
 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const tab = ref<'mine' | 'all'>(route.query.tab === 'all' ? 'all' : 'mine')
watch(tab, (t) => router.replace({ query: { ...route.query, tab: t } }))
const { data, pending } = await useFetch('/api/kitting', {
  query: computed(() => (tab.value === 'mine' ? { mine: '1' } : { incomplete: '1' })),
  default: (): KitList => ({ rows: [], total: 0, stats: null, canCreate: false }),
})
const focusId = computed(() => (typeof route.query.id === 'string' && route.query.id ? route.query.id : ''))
const focus = ref<KitNode | null>(null)
const focusError = ref('')
async function loadFocus() {
  focusError.value = ''
  if (!focusId.value) return void (focus.value = null)
  try {
    focus.value = await fetchKitNode(focusId.value)
  } catch (e) {
    focus.value = null
    focusError.value = apiError(e)
  }
}
watch(focusId, loadFocus)
onMounted(loadFocus)
function clearFocus() {
  const { id: _id, ...rest } = route.query
  router.replace({ query: rest })
}
const rows = computed(() => (data.value.rows as KitNode[]).filter((r) => r.id !== focus.value?.id))
const opened = ref<string[]>([])
/** 展开 / 收起缺件明细 */
const toggle = (id: string) => (opened.value = opened.value.includes(id) ? opened.value.filter((x) => x !== id) : [...opened.value, id])
</script>

<template>
  <div>
    <van-nav-bar title="齐套 / 缺件" left-arrow @click-left="navigateTo('/m')" />
    <template v-if="focusId">
      <div v-if="focusError" class="m-hint late"><UiStatusIcon kind="alert" :size="14" />提醒里的节点打不开：{{ focusError }}</div>
      <template v-else-if="focus">
        <div class="m-section">提醒的节点<span class="m-section-extra link" role="button" @click="clearFocus">收起</span></div>
        <div class="m-list focus"><MKitCard :node="focus" :window-days="data.stats?.windowDays ?? 5" open fixed /></div>
      </template>
    </template>
    <van-tabs v-model:active="tab">
      <van-tab title="我负责的" name="mine" />
      <van-tab :title="`全部未齐套${data.stats?.incomplete ? `（${data.stats.incomplete}）` : ''}`" name="all" />
    </van-tabs>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'mine' ? '没有我负责的装配节点' : '没有未齐套的装配节点'" image-size="80" />
    <div v-else class="m-list">
      <MKitCard v-for="n in rows" :key="n.id" :node="n" :window-days="data.stats?.windowDays ?? 5" :open="opened.includes(n.id)" @toggle="toggle(n.id)" />
    </div>
    <p class="m-foot">新建、编辑装配节点请到电脑端"齐套"。</p>
  </div>
</template>

<style scoped>
.link { color: var(--ft-primary); }
.focus { padding-bottom: 12px; }
</style>
