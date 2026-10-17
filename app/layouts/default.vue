<script setup lang="ts">
const { data: me } = await useMe()
const route = useRoute()
const menu = computed(() => [
  { key: '/', label: '我的提醒' },
  { key: '/alerts', label: '预警列表' },
  { key: '/issues', label: '异常列表' },
  { key: '/board', label: '看板' },
  { key: '/parts', label: '工件与工序链' },
  { key: '/unmatched', label: '待确认匹配' },
  ...(me.value?.isAdmin ? [{ key: '/settings', label: '设置' }] : []),
  ...(me.value?.devTools ? [{ key: '/dev', label: '演示工具' }] : []),
])
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
      <span class="brand">项目履约</span>
      <a-menu theme="dark" mode="horizontal" :selected-keys="selected" class="menu">
        <a-menu-item v-for="m in menu" :key="m.key"><NuxtLink :to="m.key">{{ m.label }}</NuxtLink></a-menu-item>
      </a-menu>
      <span v-if="me" class="user">
        {{ me.name }}<template v-if="me.department"> · {{ me.department }}</template>
        <a-button type="link" size="small" @click="logout">退出</a-button>
      </span>
    </a-layout-header>
    <a-layout-content class="content">
      <slot />
    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.header { display: flex; align-items: center; gap: 24px; padding: 0 24px; }
.brand { color: #fff; font-weight: 600; font-size: 16px; }
.menu { flex: 1; }
.user { color: rgba(255, 255, 255, 0.85); }
.content { padding: 24px; }
</style>
