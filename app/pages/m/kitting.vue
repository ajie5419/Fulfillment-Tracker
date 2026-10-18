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
const tagType = (n: KitNode) => (n.alertLevel === 'RED' ? 'danger' : n.alertLevel === 'YELLOW' ? 'warning' : n.incomplete ? 'primary' : 'success')
const tagText = (n: KitNode) => (n.percent == null ? '清单空' : `${n.percent}%`)
</script>

<template>
  <div>
    <van-nav-bar title="齐套 / 缺件" left-arrow @click-left="navigateTo('/m')" />
    <template v-if="focusId">
      <van-notice-bar v-if="focusError" color="#ee0a24" background="#fff1f0" :text="`提醒里的节点打不开：${focusError}`" />
      <template v-else-if="focus">
        <div class="section">提醒的节点<span class="link" @click="clearFocus">收起</span></div>
        <van-collapse :model-value="[focus.id]" class="group">
          <van-collapse-item :name="focus.id" :is-link="false" readonly>
            <template #title>
              <van-tag :type="tagType(focus)" class="tag">{{ tagText(focus) }}</van-tag><span class="name">{{ focus.name }}</span>
              <div class="desc">{{ focus.workOrderNumber }}　需求日 {{ dayText(focus.needDate) }}（{{ daysLeftText(focus.daysLeft) }}）　{{ focus.ownerText }}</div>
            </template>
            <KittingShortageList :node="focus" />
          </van-collapse-item>
        </van-collapse>
      </template>
    </template>
    <van-tabs v-model:active="tab">
      <van-tab title="我负责的" name="mine" />
      <van-tab :title="`全部未齐套${data.stats?.incomplete ? `（${data.stats.incomplete}）` : ''}`" name="all" />
    </van-tabs>
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'mine' ? '没有我负责的装配节点' : '没有未齐套的装配节点'" image-size="80" />
    <van-collapse v-else v-model="opened" class="group">
      <van-collapse-item v-for="n in rows" :key="n.id" :name="n.id">
        <template #title>
          <van-tag :type="tagType(n)" class="tag">{{ tagText(n) }}</van-tag><span class="name">{{ n.name }}</span>
          <div class="desc">
            {{ n.workOrderNumber }}　需求日 {{ dayText(n.needDate) }}（<span :class="{ warn: n.incomplete && n.daysLeft <= (data.stats?.windowDays ?? 5) }">{{ daysLeftText(n.daysLeft) }}</span>）
          </div>
        </template>
        <template #value>
          <span v-if="n.shortages.length" class="warn">缺 {{ n.shortages.length }}</span>
          <span v-else-if="n.total" class="ok">已齐</span>
        </template>
        <KittingShortageList :node="n" />
      </van-collapse-item>
    </van-collapse>
    <p class="muted foot">新建、编辑装配节点请到电脑端"齐套"。</p>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.group { margin: 8px 0; }
.tag { margin-right: 6px; }
.name { font-weight: 600; }
.desc { color: #646566; font-size: 12px; margin-top: 2px; }
.warn { color: #ee0a24; }
.ok { color: #07c160; }
.muted { color: #969799; font-size: 12px; }
.foot { padding: 12px 16px; }
.section { color: #646566; font-size: 13px; padding: 12px 16px 6px; display: flex; justify-content: space-between; }
.link { color: #1989fa; }
</style>
