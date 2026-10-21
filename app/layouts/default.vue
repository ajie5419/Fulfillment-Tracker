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
      // 前端改版第二轮：预警列表、异常列表合并为"风险"（旧地址 /alerts、/issues 重定向到 /risks 对应页签）
      { key: '/risks', label: '风险' },
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
/** 内容区是独立滚动的（整页大白框固定在视口里），换页时手动回到顶部 */
const contentEl = ref<HTMLElement | null>(null)
watch(() => route.path, () => {
  if (broken.value) collapsed.value = true
  contentEl.value?.scrollTo({ top: 0 })
})
const selected = computed(() => [menu.value.find((m) => m.key !== '/' && route.path.startsWith(m.key))?.key ?? '/'])
/** 页头左侧显示当前所在菜单（图标 + 名称），和参考图一致 */
const current = computed(() => menu.value.find((m) => m.key === selected.value[0]))

// ───── 菜单"工作台"未读角标（前端改版第二轮）：独立的 key（不和首页 reminders 冲突），随下面的 60 秒轮询一起刷新 ─────
const { data: unread, refresh: refreshUnread } = useUnreadCount()
const unreadText = computed(() => {
  const n = unread.value?.unread ?? 0
  return n > 99 ? '99+' : n ? String(n) : ''
})

// ───── 新的黄、红预警在右上角弹出（方案 6.3）：每 60 秒轮询一次 ─────
// 第一次只取服务器时间作为起点，不把旧提醒全弹一遍；弹过的按 id 记住，不重复弹
const POLL_MS = 60_000
let since: string | null = null
const shown = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

async function poll() {
  refreshUnread().catch(() => {})
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
          await refreshReminders()
          if (i.link) await navigateTo(i.link)
        },
      })
    }
    await refreshReminders()
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
  <a-layout class="ft-app">
    <a-layout class="frame" has-sider>
    <a-layout-sider v-model:collapsed="collapsed" :trigger="null" :width="188" breakpoint="lg" :collapsed-width="0" class="sider" @breakpoint="onBreakpoint">
      <div class="sider-inner">
        <NuxtLink to="/" class="brand">
          <span class="logo" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <span class="brand-text"><span class="brand-name">项目履约</span><span class="brand-sub">项目履约与异常管理</span></span>
        </NuxtLink>
        <nav class="sider-scroll" aria-label="主菜单" :inert="collapsed || undefined">
          <div v-for="g in groups" :key="g.title" class="group">
            <div class="group-title">{{ g.title }}</div>
            <NuxtLink v-for="m in g.items" :key="m.key" :to="m.key" class="item" :class="{ active: selected[0] === m.key }" :aria-current="selected[0] === m.key ? 'page' : undefined">
              <UiNavIcon :name="m.key" />
              <span class="item-label">{{ m.label }}</span>
              <span v-if="m.key === '/' && unreadText" class="badge" :aria-label="`未读提醒 ${unreadText} 条`">{{ unreadText }}</span>
            </NuxtLink>
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
          <span v-if="current" class="page-name"><UiNavIcon :name="current.key" /><span>{{ current.label }}</span></span>
        </span>
        <span v-if="me" class="user">
          {{ me.name }}<template v-if="me.department"> · {{ me.department }}</template><template v-if="me.businessDeptName && me.businessDeptName !== me.department">（{{ me.businessDeptName }}）</template>
          <a-button type="link" size="small" @click="logout">退出 / 切换账号</a-button>
        </span>
      </a-layout-header>
      <div ref="contentEl" class="content ft-content">
        <slot />
      </div>
    </a-layout>
    </a-layout>
  </a-layout>
</template>

<style scoped>
/* 设计改版（参考图）：整页是一个固定在视口里的大白框，左边灰色侧栏面板，右边带细边框的内容面板；
   内容面板里页头固定、下面内容独立滚动，所以滚动时内容不会从页头上下露出来，四角也天然是圆的 */
.ft-app { height: 100vh; padding: 10px; overflow: hidden; }
.frame { height: 100%; gap: 8px; padding: 8px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 22px; overflow: hidden; }
.sider { height: 100%; background: transparent !important; }
.sider-inner { height: 100%; display: flex; flex-direction: column; background: var(--ft-fill); border-radius: 16px; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 14px 12px; color: var(--ft-text); white-space: nowrap; }
.brand:hover { color: var(--ft-text); }
.logo { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 9px; background: var(--ft-primary); }
.brand-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.brand-name { font-weight: 600; font-size: 16px; }
.brand-sub { font-size: 12px; color: var(--ft-text-2); }
.sider-scroll { flex: 1; overflow-y: auto; padding: 2px 8px 16px; }
/* 参考图的分组标题更浅，但 --ft-text-3 在浅灰底上达不到 4.5:1，这里用 --ft-text-2 */
.group-title { padding: 12px 10px 4px; font-size: 12px; color: var(--ft-text-2); }
/* 菜单项高 36px（含间距 38px），15 项在 900 高的屏幕上一屏放下 */
.item { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 10px; margin: 2px 0; border-radius: 10px; color: var(--ft-text-2); font-size: 14px; white-space: nowrap; overflow: hidden; }
.item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* 未读角标：白底胶囊，数字多时变宽 */
.badge { flex: none; min-width: 22px; height: 20px; padding: 0 7px; border-radius: 10px; background: var(--ft-card-bg); border: 1px solid var(--ft-border); color: var(--ft-text); font-size: 12px; line-height: 18px; text-align: center; font-weight: 600; }
.item:hover { color: var(--ft-text); background: var(--ft-border); }
/* 选中项：黑底白字（参考图） */
.item.active { color: var(--ft-card-bg); background: var(--ft-text); font-weight: 500; }
.item.active .badge { border-color: transparent; }
.item:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }
.main { min-width: 0; height: 100%; display: flex; flex-direction: column; background: var(--ft-card-bg); border: 1px solid var(--ft-border); border-radius: 16px; overflow: hidden; }
.header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 56px; line-height: 56px; margin: 0 16px; padding: 0; background: transparent; border-bottom: 1px solid var(--ft-border); }
.left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.page-name { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; color: var(--ft-text); white-space: nowrap; }
.user { color: var(--ft-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* 框架四周留白控制在原来的宽度附近（侧栏 188 + 留白），各页面表格可用宽度基本不变 */
.content { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
@media (max-width: 991px) {
  /* 窄屏侧栏收起时不留空隙 */
  .frame { gap: 0; }
}
@media (max-width: 575px) {
  .ft-app { padding: 0; }
  .frame { padding: 0; border: none; border-radius: 0; }
  .main { border: none; border-radius: 0; }
  .header { margin: 0 12px; }
  .content { padding: 12px; }
}
</style>
