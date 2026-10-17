<script setup lang="ts">
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
    <van-search v-model="keyword" placeholder="物料、规格、供应商、工单" />
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'open' ? '没有未到货的关键物料' : '还没有到货记录'" image-size="80" />
    <van-cell-group v-else inset>
      <van-cell v-for="r in rows" :key="r.id" is-link center @click="navigateTo(`/m/arrival?id=${encodeURIComponent(r.id)}`)">
        <template #title>
          <van-tag :type="PURCHASE_PROGRESS_TYPE[r.progressText] ?? 'default'" class="tag">{{ r.progressText }}</van-tag>
          <span class="name">{{ r.materialName }}</span>
          <van-tag v-if="r.blockedByPayment && r.status === 'OPEN'" type="primary" plain class="tag">卡付款</van-tag>
          <div class="desc">{{ [r.spec, qtyText(r), r.supplierName].filter(Boolean).join(' · ') }}</div>
        </template>
        <template #label>
          {{ r.workOrderNumber }}　需求 {{ dayText(r.needDate) }}{{ r.promisedDate ? `　承诺 ${dayText(r.promisedDate)}` : '　未承诺' }}{{ r.arrivedDate ? `　到货 ${dayText(r.arrivedDate)}` : '' }}
        </template>
      </van-cell>
    </van-cell-group>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.tag { margin-right: 6px; }
.name { font-weight: 600; margin-right: 6px; }
.desc { color: #323233; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
