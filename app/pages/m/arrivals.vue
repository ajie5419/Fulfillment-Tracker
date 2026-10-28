<script setup lang="ts">
import { toneOfVant } from '#shared/mobile-todo'

/** 手机：到货确认（R10）。未到货的关键物料（缺料、超期的在前）/ 已到货；点一条进入确认页。仓库、使用部门、采购都可以确认 */
definePageMeta({ layout: 'mobile', keepalive: true })
const route = useRoute()
const router = useRouter()
const tab = computed({
  get: () => route.query.tab === 'arrived' ? 'arrived' : 'open',
  set: (value: string) => { void router.replace({ query: { ...route.query, tab: value } }) },
})
const keyword = ref(typeof route.query.q === 'string' ? route.query.q : '')
const q = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { if (v.trim() !== q.value) void router.replace({ query: { ...route.query, q: v.trim() || undefined } }) }, 300)
})
watch(q, (value) => { keyword.value = value })
onBeforeUnmount(() => clearTimeout(timer))
const list = usePagedList<PurchaseRow>('/api/purchases', {
  key: 'purchase-mobile', mode: 'append', pageSize: ref(20),
  query: computed(() => ({ view: tab.value, q: q.value || undefined })),
})
await list.ready
const { rows, pending, error, total, finished, next } = list
const scroll = ref(0)
onBeforeRouteLeave(() => { scroll.value = window.scrollY })
onActivated(() => nextTick(() => window.scrollTo(0, scroll.value)))
</script>

<template>
  <div>
    <van-nav-bar title="到货确认" left-arrow @click-left="navigateTo('/m')" />
    <van-tabs v-model:active="tab">
      <van-tab title="未到货" name="open" />
      <van-tab title="已到货" name="arrived" />
    </van-tabs>
    <van-search v-model="keyword" placeholder="物料、规格、供应商、工单" shape="round" />
    <van-loading v-if="pending && !rows.length" class="m-center" />
    <van-empty v-else-if="error && !rows.length" image="error" description="加载失败，请重试" image-size="80"><van-button size="small" @click="next()">重试</van-button></van-empty>
    <van-empty v-else-if="!rows.length" :description="tab === 'open' ? '没有未到货的关键物料' : '还没有到货记录'" image-size="80" />
    <UiLoadMoreList v-else :loading="pending" :finished="finished" :error="!!error" :loaded="rows.length" :total="total" @load="next()">
    <div class="m-list">
      <MCard v-for="r in rows" :key="r.id" :tone="toneOfVant(PURCHASE_PROGRESS_TYPE[r.progressText])" link @click="navigateTo(`/m/arrival?id=${encodeURIComponent(r.id)}`)">
        <div class="m-row">
          <van-tag :type="PURCHASE_PROGRESS_TYPE[r.progressText] ?? 'default'">{{ r.progressText }}</van-tag>
          <van-tag v-if="r.blockedByPayment && r.status === 'OPEN'" type="primary" plain>卡付款</van-tag>
          <span v-if="r.lateDays" class="late m-text-late">晚 {{ r.lateDays }} 天</span>
        </div>
        <div class="m-title name">{{ r.materialName }}</div>
        <div v-if="[r.spec, qtyText(r), r.supplierName].filter(Boolean).length" class="m-desc desc">{{ [r.spec, qtyText(r), r.supplierName].filter(Boolean).join(' · ') }}</div>
        <div class="m-meta">
          <span>{{ r.workOrderNumber }}</span>
          <span>需求 {{ dayText(r.needDate) }}</span>
          <span>{{ r.promisedDate ? `承诺 ${dayText(r.promisedDate)}` : '未承诺' }}</span>
          <span v-if="r.arrivedDate" class="m-text-done">到货 {{ dayText(r.arrivedDate) }}</span>
        </div>
      </MCard>
    </div>
    </UiLoadMoreList>
    <div class="m-foot" />
  </div>
</template>

<style scoped>
.name { margin-top: 6px; }
.late { font-size: 12px; font-weight: 600; }
.desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
