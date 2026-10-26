<script setup lang="ts">
import { toneOfVant } from '#shared/mobile-todo'

/** 手机：我的签收（R9）。待签收 / 已处理；点一条进入签收页 */
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const tab = ref<'pending' | 'done'>(route.query.tab === 'done' ? 'done' : 'pending')
watch(tab, (t) => router.replace({ query: { ...route.query, tab: t } }))
const { data: rows, pending } = await useFetch('/api/receipts', { query: computed(() => ({ tab: tab.value })), default: () => [] })
</script>

<template>
  <div>
    <van-nav-bar title="我的签收" />
    <van-tabs v-model:active="tab">
      <van-tab title="待签收" name="pending" />
      <van-tab title="已处理" name="done" />
    </van-tabs>
    <van-loading v-if="pending" class="m-center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'pending' ? '没有待签收的发放单' : '还没有处理过的发放单'" image-size="80" />
    <div v-else class="m-list">
      <MCard
        v-for="r in rows"
        :key="r.receiptId"
        :tone="tab === 'pending' ? 'risk' : toneOfVant(RECEIPT_STATUS_TYPE[r.status as ReceiptStatusKey])"
        link
        @click="navigateTo(`/m/release?id=${encodeURIComponent(r.releaseId)}`)"
      >
        <div class="m-row">
          <van-tag :type="r.type === 'CHANGE' ? 'danger' : 'primary'" plain>{{ r.typeText }}</van-tag>
          <van-tag v-if="tab === 'done'" :type="RECEIPT_STATUS_TYPE[r.status as ReceiptStatusKey]">{{ r.statusText }}</van-tag>
          <van-tag v-else type="warning">待我签收</van-tag>
        </div>
        <div class="m-title no">{{ r.releaseNo }}<span v-if="r.version" class="ver">版本 {{ r.version }}</span></div>
        <div class="m-desc clamp">{{ r.parts.length ? `${partsText(r.parts)}：` : '' }}{{ r.description }}</div>
        <div class="m-meta">
          <span>{{ r.workOrderNumber }}</span>
          <span>{{ r.issuerName }} 发放</span>
          <span>{{ timeText(r.createdAt) }}</span>
        </div>
      </MCard>
    </div>
    <div class="m-foot" />
  </div>
</template>

<style scoped>
.no { margin-top: 6px; }
.ver { margin-left: 8px; font-size: 13px; font-weight: 400; color: var(--ft-text-2); }
</style>
