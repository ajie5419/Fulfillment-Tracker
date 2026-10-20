<script setup lang="ts">
import { toneOfVant } from '#shared/mobile-todo'

/** 手机：到货确认（R10）。未到货的关键物料（缺料、超期的在前）/ 已到货；点一条进入确认页。仓库、使用部门、采购都可以确认 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const tab = ref<'open' | 'arrived'>(route.query.tab === 'arrived' ? 'arrived' : 'open')
watch(tab, (t) => router.replace({ query: { ...route.query, tab: t } }))
const keyword = ref('')
const q = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => (q.value = v.trim()), 300)
})
const { data, pending } = await useFetch('/api/purchases', {
  query: computed(() => ({ view: tab.value, q: q.value || undefined })),
  default: () => ({ rows: [] as PurchaseRow[], total: 0, stats: null }),
})
const rows = computed(() => data.value.rows as PurchaseRow[])
</script>

<template>
  <div>
    <van-nav-bar title="到货确认" left-arrow @click-left="navigateTo('/m')" />
    <van-tabs v-model:active="tab">
      <van-tab title="未到货" name="open" />
      <van-tab title="已到货" name="arrived" />
    </van-tabs>
    <van-search v-model="keyword" placeholder="物料、规格、供应商、工单" shape="round" />
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'open' ? '没有未到货的关键物料' : '还没有到货记录'" image-size="80" />
    <div v-else class="m-list">
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
    <div class="m-foot" />
  </div>
</template>

<style scoped>
.name { margin-top: 6px; }
.late { font-size: 12px; font-weight: 600; }
.desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
