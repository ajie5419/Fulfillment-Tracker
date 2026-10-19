<script setup lang="ts">
const { data: me } = await useMe()
const route = useRoute()
// 左侧竖向菜单，按岗位分组；条目多了也能纵向排下，窄屏（< lg）收起，点左侧把手展开。
// 按角色只显示相关分组（权限方案 R13 第二节，me.menu 由后端算，多角色取并集）；页面本身不拦，从提醒链接点进去仍能只读查看。
// sections：条目属于哪些菜单分区，有任一分区可见就显示；没写的人人可见
interface MenuItem {
  key: string
  label: string
  sections?: string[]
}
const groups = computed(() => {
  const visible = new Set(me.value?.menu ?? [])
  const show = (items: MenuItem[]) => items.filter((i) => !i.sections || i.sections.some((s) => visible.has(s)))
  // 前端改版第一轮：按"我的工作 / 项目 / 部门工作台 / 其他"分组；各条目的 sections 与原来一致
  return [
    { title: '我的工作', items: show([
      { key: '/', label: '工作台' },
      // 第二轮并进工作台，这一轮先保留
      { key: '/alerts', label: '预警列表' },
      { key: '/issues', label: '异常列表' },
    ]) },
    { title: '项目', items: show([
      { key: '/board', label: '项目总览' },
      { key: '/wo', label: '工单详情' },
      { key: '/overview', label: '领导总览', sections: ['overview'] },
      { key: '/plan', label: '总计划' },
    ]) },
    { title: '部门工作台', items: show([
      { key: '/drawings', label: '出图任务', sections: ['tech'] },
      { key: '/releases', label: '发放签收', sections: ['tech', 'releases'] },
      { key: '/purchases', label: '采购到货', sections: ['purchase'] },
      { key: '/payments', label: '付款申请', sections: ['purchase', 'payments'] },
      { key: '/kitting', label: '齐套', sections: ['production', 'kitting'] },
      { key: '/parts', label: '工件与工序链', sections: ['production'] },
      { key: '/templates', label: '路线模板', sections: ['production'] },
      { key: '/unmatched', label: '待确认匹配', sections: ['production'] },
    ]) },
    { title: '其他', items: [
      // 项目部负责人（总计划模板）也能进设置页，只看到"总计划模板"一页
      ...(me.value?.isAdmin || me.value?.can?.planTemplate ? [{ key: '/settings', label: '设置' }] : []),
      ...(me.value?.devTools ? [{ key: '/dev', label: '演示工具' }] : []),
    ] },
  ].filter((g) => g.items.length)
})
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
        description: '到"工作台"查看全部',
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
  <a-layout class="ft-app" style="min-height: 100vh">
    <a-layout-sider v-model:collapsed="collapsed" :trigger="null" :width="200" breakpoint="lg" :collapsed-width="0" class="sider" @breakpoint="onBreakpoint">
      <div class="sider-inner">
        <NuxtLink to="/" class="brand">
          <span class="logo" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          项目履约
        </NuxtLink>
        <nav class="sider-scroll" aria-label="主菜单">
          <div v-for="g in groups" :key="g.title" class="group">
            <div class="group-title">{{ g.title }}</div>
            <NuxtLink v-for="m in g.items" :key="m.key" :to="m.key" class="item" :class="{ active: selected[0] === m.key }" :aria-current="selected[0] === m.key ? 'page' : undefined">{{ m.label }}</NuxtLink>
          </div>
        </nav>
      </div>
    </a-layout-sider>
    <a-layout class="main">
      <a-layout-header class="header">
        <span class="left">
          <a-button
            v-if="broken"
            size="small"
            :aria-label="collapsed ? '展开菜单' : '收起菜单'"
            :aria-expanded="!collapsed"
            class="nav-toggle"
            @click="collapsed = !collapsed"
          >菜单</a-button>
          <span v-if="broken" class="brand-mini">项目履约</span>
        </span>
        <span v-if="me" class="user">
          {{ me.name }}<template v-if="me.department"> · {{ me.department }}</template><template v-if="me.businessDeptName && me.businessDeptName !== me.department">（{{ me.businessDeptName }}）</template>
          <a-button type="link" size="small" @click="logout">退出 / 切换账号</a-button>
        </span>
      </a-layout-header>
      <a-layout-content class="content">
        <slot />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.sider { position: sticky; top: 0; height: 100vh; z-index: 11; background: var(--ft-sider-bg) !important; }
.sider-inner { height: 100%; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 10px; padding: 20px 22px 12px; color: #fff; font-weight: 600; font-size: 16px; white-space: nowrap; }
.brand:hover { color: #fff; }
.logo { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: var(--ft-primary); }
.sider-scroll { flex: 1; overflow-y: auto; padding: 4px 12px 24px; }
.group-title { padding: 14px 10px 6px; font-size: 12px; color: #8a96a8; }
/* 菜单项：圆角，选中项浅色高亮；14 项在 800 高的屏幕上也能一屏放下 */
.item { display: block; padding: 7px 10px; margin: 2px 0; border-radius: 8px; color: #d5dbe5; font-size: 14px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
.item.active { color: #fff; background: #2b3a50; font-weight: 500; }
.item:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 1px; }
.main { min-width: 0; background: var(--ft-page-bg); }
.header { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 52px; line-height: 52px; padding: 0 24px; position: sticky; top: 0; z-index: 10; background: rgba(238, 241, 245, 0.92); backdrop-filter: blur(6px); }
.left { display: flex; align-items: center; gap: 12px; }
.brand-mini { font-weight: 600; color: var(--ft-text); white-space: nowrap; }
.user { color: var(--ft-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.content { padding: 4px 24px 24px; min-width: 0; }
@media (max-width: 575px) {
  .header { padding: 0 12px; }
  .content { padding: 4px 12px 16px; }
}
</style>
