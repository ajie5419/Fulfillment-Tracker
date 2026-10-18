<script setup lang="ts">
const { data: me } = await useMe()
const route = useRoute()
// 左侧竖向菜单，按岗位分组；条目多了也能纵向排下，窄屏（< lg）收起，点左侧把手展开
const groups = computed(() => [
  { title: '每日', items: [
    { key: '/', label: '我的提醒' },
    { key: '/alerts', label: '预警列表' },
    { key: '/issues', label: '异常列表' },
    { key: '/board', label: '看板' },
  ] },
  { title: '技术', items: [
    { key: '/drawings', label: '出图任务' },
    { key: '/releases', label: '发放签收' },
  ] },
  { title: '采购', items: [
    { key: '/purchases', label: '采购到货' },
    { key: '/payments', label: '付款申请' },
  ] },
  { title: '生产', items: [
    { key: '/kitting', label: '齐套' },
    { key: '/parts', label: '工件与工序链' },
    { key: '/templates', label: '路线模板' },
    { key: '/unmatched', label: '待确认匹配' },
  ] },
  { title: '系统', items: [
    ...(me.value?.isAdmin ? [{ key: '/settings', label: '设置' }] : []),
    ...(me.value?.devTools ? [{ key: '/dev', label: '演示工具' }] : []),
  ] },
].filter((g) => g.items.length))
const menu = computed(() => groups.value.flatMap((g) => g.items))
const collapsed = ref(false)
/** 窄屏（< lg）时菜单收起，由页头的"菜单"按钮展开（键盘可达）；宽屏始终展开 */
const broken = ref(false)
function onBreakpoint(b: boolean) {
  broken.value = b
  collapsed.value = b
}
watch(() => route.path, () => {
  if (broken.value) collapsed.value = true
})
const selected = computed(() => [menu.value.find((m) => m.key !== '/' && route.path.startsWith(m.key))?.key ?? '/'])

// ───── 新的黄、红预警在右上角弹出（方案 6.3）：每 60 秒轮询一次 ─────
// 第一次只取服务器时间作为起点，不把旧提醒全弹一遍；弹过的按 id 记住，不重复弹
const POLL_MS = 60_000
let since: string | null = null
const shown = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

async function poll() {
  try {
    const r = await $fetch('/api/reminders/new', { query: since ? { since } : {} })
    const first = since === null
    since = new Date(r.now).toISOString()
    const fresh = r.items.filter((i) => !shown.has(i.id))
    for (const i of fresh) shown.add(i.id)
    if (first || !fresh.length) return
    // 一次最多弹 3 条（红色优先），其余合并成一条，避免满屏
    const sorted = [...fresh].sort((a, b) => (a.level === b.level ? 0 : a.level === 'RED' ? -1 : 1))
    const rest = sorted.length - 3
    if (rest > 0) {
      notification.info({
        key: 'reminders-more',
        message: `另有 ${rest} 条新预警`,
        description: '到"我的提醒"查看全部',
        placement: 'topRight',
        duration: 0,
        style: { cursor: 'pointer' },
        onClick: async () => {
          notification.close('reminders-more')
          await navigateTo('/')
        },
      })
    }
    for (const i of sorted.slice(0, 3)) {
      const open = notification[i.level === 'RED' ? 'error' : 'warning']
      open({
        key: i.id,
        message: i.level === 'RED' ? '红色预警' : '黄色预警',
        description: i.title,
        placement: 'topRight',
        duration: 0, // 不自动关，避免人不在座位时错过
        style: { cursor: i.link ? 'pointer' : 'default' },
        onClick: async () => {
          notification.close(i.id)
          await $fetch(`/api/reminders/${i.id}/read`, { method: 'POST' }).catch(() => {})
          await refreshNuxtData('reminders')
          if (i.link) await navigateTo(i.link)
        },
      })
    }
    await refreshNuxtData('reminders')
  } catch {
    // 网络抖动时下一轮再试；401 由 api-401 插件处理
  }
}

onMounted(() => {
  poll()
  timer = setInterval(poll, POLL_MS)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <a-layout style="min-height: 100vh">
    <a-layout-header class="header">
      <span class="left">
        <a-button
          v-if="broken"
          size="small"
          ghost
          :aria-label="collapsed ? '展开菜单' : '收起菜单'"
          :aria-expanded="!collapsed"
          class="nav-toggle"
          @click="collapsed = !collapsed"
        >菜单</a-button>
        <span class="brand">项目履约</span>
      </span>
      <span v-if="me" class="user">
        {{ me.name }}<template v-if="me.department"> · {{ me.department }}</template>
        <a-button type="link" size="small" @click="logout">退出 / 切换账号</a-button>
      </span>
    </a-layout-header>
    <a-layout>
      <a-layout-sider v-model:collapsed="collapsed" :trigger="null" theme="dark" :width="148" breakpoint="lg" :collapsed-width="0" class="sider" @breakpoint="onBreakpoint">
        <div class="sider-scroll">
          <a-menu theme="dark" mode="inline" :selected-keys="selected">
            <a-menu-item-group v-for="g in groups" :key="g.title" :title="g.title">
              <a-menu-item v-for="m in g.items" :key="m.key"><NuxtLink :to="m.key">{{ m.label }}</NuxtLink></a-menu-item>
            </a-menu-item-group>
          </a-menu>
        </div>
      </a-layout-sider>
      <a-layout-content class="content">
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 24px; position: sticky; top: 0; z-index: 10; }
.left { display: flex; align-items: center; gap: 12px; }
.brand { color: #fff; font-weight: 600; font-size: 16px; white-space: nowrap; }
.user { color: rgba(255, 255, 255, 0.85); white-space: nowrap; }
.sider { position: sticky; top: 64px; height: calc(100vh - 64px); z-index: 9; }
.sider-scroll { height: 100%; overflow-y: auto; }
/* 收紧行高和缩进，14 项在 800 高的屏幕上也能一屏放下 */
.sider-scroll :deep(.ant-menu-item-group-title) { padding: 8px 16px 2px; font-size: 12px; }
.sider-scroll :deep(.ant-menu-item) { height: 34px; line-height: 34px; margin-block: 2px; padding-left: 24px !important; }
.content { padding: 24px; min-width: 0; }
</style>
