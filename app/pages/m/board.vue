<script setup lang="ts">
definePageMeta({ layout: 'mobile' })
const route = useRoute()
const router = useRouter()
const view = computed({
  get: () => route.query.view === 'orders' ? 'orders' : route.query.view === 'panorama' ? 'panorama' : 'tracking',
  set: value => { void router.replace({ query: { ...route.query, view: value }, hash: '' }) },
})
</script>

<template>
  <div>
    <van-nav-bar title="项目总览" left-text="工作台" left-arrow @click-left="navigateTo('/m')" />
    <van-tabs v-model:active="view">
      <van-tab name="tracking" title="工单进展" />
      <van-tab name="panorama" title="全盘统计" />
      <van-tab v-if="view === 'orders' || route.query.metric" name="orders" title="工单清单" />
    </van-tabs>
    <div class="m-list"><BoardOrderDirectory v-if="view === 'tracking'" mobile /><BoardPanorama v-else mobile :list-only="view === 'orders'" /></div>
    <div class="m-foot" />
  </div>
</template>
