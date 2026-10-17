<script setup lang="ts">
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
    <van-loading v-if="pending" class="center" />
    <van-empty v-else-if="!rows.length" :description="tab === 'pending' ? '没有待签收的发放单' : '还没有处理过的发放单'" image-size="80" />
    <van-cell-group v-else inset class="list">
      <van-cell v-for="r in rows" :key="r.receiptId" is-link center @click="navigateTo(`/m/release?id=${encodeURIComponent(r.releaseId)}`)">
        <template #title>
          <van-tag :type="r.type === 'CHANGE' ? 'danger' : 'primary'" plain class="tag">{{ r.typeText }}</van-tag>
          <span class="no">{{ r.releaseNo }}</span>
          <van-tag v-if="tab === 'done'" :type="RECEIPT_STATUS_TYPE[r.status as ReceiptStatusKey]" class="tag">{{ r.statusText }}</van-tag>
          <div class="desc">{{ r.parts.length ? `${r.parts.join('、')}：` : '' }}{{ r.description }}</div>
        </template>
        <template #label>{{ r.workOrderNumber }}{{ r.version ? `　版本 ${r.version}` : '' }}　{{ r.issuerName }} 发放　{{ timeText(r.createdAt) }}</template>
      </van-cell>
    </van-cell-group>
  </div>
</template>

<style scoped>
.center { display: flex; justify-content: center; padding: 32px; }
.list { margin-top: 12px; }
.no { font-weight: 600; margin-right: 6px; }
.tag { margin-right: 4px; }
.desc { color: #323233; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
