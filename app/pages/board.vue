<script setup lang="ts">
import { BOARD_VIEWS, resolveBoardView, type BoardView } from '#shared/board-cockpit'

const route = useRoute()
const router = useRouter()
const { data: me } = await useMe()
const view = computed(() => resolveBoardView(!!me.value?.can.overview, route.query.view))
function changeView(value: BoardView) { void router.replace({ query: { ...route.query, view: resolveBoardView(!!me.value?.can.overview, value) }, hash: route.hash }) }
const syncNotice = ref<{ refresh: () => unknown } | null>(null)
const activePanel = ref<{ refresh: () => unknown } | null>(null)
async function refreshAll() { await Promise.all([syncNotice.value?.refresh(), activePanel.value?.refresh()]) }
const createOpen = ref(false)
async function onCreated(no: string) {
  createOpen.value = false
  // 工单下拉、看板一起刷新（回到总览时能看到新工单）；全站下拉的缓存也刷新
  await Promise.all([refreshAll(), refreshNuxtData('work-orders')])
  await navigateTo(`/wo/${encodeURIComponent(no)}`)
  Modal.confirm({
    title: '是否现在套模板生成总计划？',
    content: `工单 ${no} 已建好。点“生成”去项目计划页，选模板后按模板生成。`,
    okText: '生成',
    cancelText: '稍后',
    onOk: () => navigateTo({ path: '/plan', query: { wo: no } }),
  })
}
</script>
<template>
  <div class="page">
    <div class="page-head">
      <div v-if="me?.can.overview" class="head-left">
        <a-segmented :value="view" :options="BOARD_VIEWS" aria-label="项目总览视图" @change="changeView($event as BoardView)" />
      </div>
      <div class="tools">
        <UiRefreshButton @click="refreshAll()" />
        <a-button v-if="me?.can.workOrder" type="primary" @click="createOpen = true">新建工单</a-button>
      </div>
    </div>
    <BoardSyncNotice ref="syncNotice" />
    <BoardCockpit v-if="view === 'cockpit'" ref="activePanel" />
    <BoardOrderDirectory v-else ref="activePanel" />
    <WorkOrderEditModal v-if="me?.can.workOrder" :open="createOpen" :work-order="null" @close="createOpen = false" @done="onCreated" />
  </div>
</template>
<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 16px; }
.head-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: auto; }
</style>
