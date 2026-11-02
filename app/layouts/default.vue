<script setup lang="ts">
const { data: me } = await useMe()
// 页头跟随已确认的导航立即更新；Nuxt useRoute 会等异步页面就绪才同步。
const route = useRouter().currentRoute
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
      // 项目日历（zhao 10-21）：所有人都能看，不分权限
      { key: '/calendar', label: '项目日历' },
      // 前端改版第二轮：预警列表、异常列表合并为"风险"（旧地址 /alerts、/issues 重定向到 /risks 对应页签）
      { key: '/risks', label: '预警与异常处理' },
    ]) },
    // 功能重复梳理第一批：领导总览并入项目总览（有权限的人在项目总览汇总下方多看到一块），
    // "工单详情"入口页去掉（项目总览顶部搜工单、卡片点进详情）；旧地址 /overview、/wo 跳项目总览；/templates 不在菜单里但保留（非管理员只读查看）
    { title: '项目', items: show([
      { key: '/board', label: '项目总览' },
      // 项目计划（zhao 10-22 测试后定）：总计划从工单详情里拿出来单独成页，所有人可见（编辑按权限）
      { key: '/plan', label: '项目计划' },
    ]) },
    { title: '部门工作台', items: show([
      // 部门计划（zhao 10-23）：项目计划发布后，各部门在这里接收本部门节点、分解任务、委派责任人
      { key: '/dept-plan', label: '部门计划', sections: ['deptPlan'] },
      { key: '/drawings', label: '设计任务', sections: ['tech'] },
      // 工艺（zhao 10-27）：按部件跟踪料单、工艺状态；工艺部改，技术部、生产部、项目经理、领导只读
      { key: '/process', label: '工艺', sections: ['process'] },
      { key: '/releases', label: '发放签收', sections: ['tech', 'releases'] },
      { key: '/purchase-plans', label: '采购计划下发', sections: ['tech', 'purchase'] },
      { key: '/purchases', label: '采购到货', sections: ['purchase'] },
      { key: '/payments', label: '付款申请', sections: ['purchase', 'payments'] },
      { key: '/kitting', label: '齐套', sections: ['production', 'kitting'] },
      // 生产管理重设计（zhao 10-26）：按任务拆成 生产调度（开工完工、超期、卡住）/ 工序编排（排工序链）/ 外协（发出、在外、待确认匹配）；
      // 旧地址 /workshop、/unmatched 跳到对应页面
      { key: '/production', label: '生产调度', sections: ['production'] },
      { key: '/parts', label: '工序编排', sections: ['production'] },
      { key: '/outsource', label: '外协', sections: ['production'] },
    ]) },
    { title: '其他', items: [
      // 项目部负责人（总计划模板）、生产部（班组长）也能进设置页，只看到各自那一页
      ...(me.value?.isAdmin || me.value?.can?.planTemplate || me.value?.can?.teamLeader ? [{ key: '/settings', label: '设置' }] : []),
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
watch(() => route.value.path, () => {
  if (broken.value) collapsed.value = true
  contentEl.value?.scrollTo({ top: 0 })
})
/** 没有单独菜单项的页面算到哪一项下：工单详情 /wo/:no 属于项目总览；工序路线模板 /templates 属于工序编排 */
const MENU_ALIAS: Record<string, string> = { '/wo': '/board', '/templates': '/parts', '/workshop': '/production', '/unmatched': '/outsource' }
const selected = computed(() => {
  const alias = Object.keys(MENU_ALIAS).find((k) => route.value.path === k || route.value.path.startsWith(`${k}/`))
  const path = alias ? MENU_ALIAS[alias]! : route.value.path
  const match = menu.value.find((m) => path === m.key || (m.key !== '/' && path.startsWith(`${m.key}/`)))
  return match ? [match.key] : []
})
// 标题取决于路由本身，不能因用户没有对应菜单权限而回落到工作台。
const ROUTE_TITLES: Record<string, string> = {
  '/': '工作台', '/calendar': '项目日历', '/risks': '预警与异常处理',
  '/board': '项目总览', '/plan': '项目计划', '/dept-plan': '部门计划',
  '/drawings': '设计任务', '/process': '工艺', '/releases': '发放签收',
  '/purchase-plans': '采购计划下发', '/purchases': '采购到货', '/payments': '付款申请', '/kitting': '齐套',
  '/production': '生产调度', '/parts': '工序编排', '/outsource': '外协',
  '/settings': '设置', '/dev': '演示工具', '/templates': '工序路线模板',
  '/wo': '工单详情', '/overview': '项目总览', '/issues': '预警与异常处理',
  '/alerts': '预警与异常处理', '/workshop': '生产调度', '/unmatched': '外协',
}
const current = computed(() => {
  const path = route.value.path
  const key = Object.keys(ROUTE_TITLES).find((key) => path === key || (key !== '/' && path.startsWith(`${key}/`)))
  return key ? { key, label: ROUTE_TITLES[key] } : undefined
})

// ───── 菜单"工作台"未读角标（前端改版第二轮）：独立的 key（不和首页 reminders 冲突），随下面的 60 秒轮询一起刷新 ─────
const { data: unread, refresh: refreshUnread } = useUnreadCount()
const badgeText = (n: number) => (n > 99 ? '99+' : n ? String(n) : '')
const unreadText = computed(() => badgeText(unread.value?.unread ?? 0))
/** 部门计划：本人待接收的计划节点数 */
const planPendingText = computed(() => badgeText(unread.value?.planPending ?? 0))
const userInitial = computed(() => me.value?.name?.trim()?.charAt(0)?.toUpperCase() || 'U')
const userRoleSub = computed(() => {
  const m = me.value
  if (!m) return ''
  if (m.businessDeptName && m.department && m.businessDeptName !== m.department) return `${m.department} · ${m.businessDeptName}`
  return m.department || m.businessDeptName || m.roleName || '在线'
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

function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && broken.value && !collapsed.value) collapsed.value = true
}

onMounted(() => {
  poll()
  timer = setInterval(poll, POLL_MS)
  window.addEventListener('keydown', onEscape)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('keydown', onEscape)
})
</script>

<template>
  <a-layout class="ft-app">
    <a-layout class="frame" has-sider>
    <div v-if="broken && !collapsed" class="sider-mask" aria-hidden="true" @click="collapsed = true" />
    <a-layout-sider v-model:collapsed="collapsed" :trigger="null" :width="212" breakpoint="lg" :collapsed-width="0" class="sider" @breakpoint="onBreakpoint">
      <div class="sider-inner" :inert="collapsed || undefined">
        <div class="brand-bar">
          <NuxtLink to="/" class="brand">
            <span class="brand-mark">
              <img class="logo" src="/brand/tolian-logo.png" width="24" height="20" alt="通联 TOLIAN">
            </span>
            <span class="brand-title">通联履约<span class="brand-dot">.</span></span>
          </NuxtLink>
          <button
            type="button"
            class="icon-btn collapse-btn"
            aria-label="收起侧边栏"
            title="收起侧边栏"
            @click="collapsed = true"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2.5" stroke="currentColor" stroke-width="1.4" />
              <path d="M6.2 2.5v11" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
        </div>

        <nav class="sider-scroll" aria-label="主菜单">
          <div v-for="g in groups" :key="g.title" class="group">
            <div class="group-title">{{ g.title }}</div>
            <NuxtLink v-for="m in g.items" :key="m.key" :to="m.key" class="item" :class="{ active: selected[0] === m.key }" :aria-current="selected[0] === m.key ? 'page' : undefined">
              <span class="item-ico"><UiNavIcon :name="m.key" /></span>
              <span class="item-label">{{ m.label }}</span>
              <span v-if="m.key === '/' && unreadText" class="badge" :aria-label="`未读提醒 ${unreadText} 条`">{{ unreadText }}</span>
              <span v-if="m.key === '/dept-plan' && planPendingText" class="badge" :aria-label="`待接收计划节点 ${planPendingText} 个`">{{ planPendingText }}</span>
            </NuxtLink>
          </div>
        </nav>

        <div v-if="me" class="user-card">
          <span class="avatar" aria-hidden="true">{{ userInitial }}</span>
          <div class="user-meta">
            <div class="user-name" :title="me.name">{{ me.name }}</div>
            <div class="user-dept" :title="userRoleSub">{{ userRoleSub }}</div>
          </div>
          <button type="button" class="icon-btn logout-btn" aria-label="退出或切换账号" title="退出 / 切换账号" @click="logout">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.2 2.5H4.5A2 2 0 0 0 2.5 4.5v7a2 2 0 0 0 2 2h1.7M10.5 11.2 13.7 8l-3.2-3.2M6.2 8h7.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </a-layout-sider>
    <a-layout class="main" :class="{ 'main-full': collapsed || broken }">
      <a-layout-header class="header">
        <span class="left">
          <button
            v-if="collapsed"
            type="button"
            :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
            :aria-expanded="!collapsed"
            title="展开侧边栏"
            class="icon-btn nav-toggle"
            @click="collapsed = false"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2.5" stroke="currentColor" stroke-width="1.4" />
              <path d="M6.2 2.5v11" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </button>
          <span v-if="current" class="page-name">
            <span class="page-ico"><UiNavIcon :name="current.key" /></span>
            <span>{{ current.label }}</span>
          </span>
        </span>
        <div class="header-right">
          <GlobalSearch class="search" />
          <NuxtLink to="/" class="top-action" :aria-label="unreadText ? `未读提醒 ${unreadText} 条，点击查看工作台` : '查看工作台提醒'" title="待办与未读提醒">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.1c0 .7-.25 1.38-.7 1.9L2.8 10.8h10.4l-.7-.8a2.9 2.9 0 0 1-.7-1.9V6A3.8 3.8 0 0 0 8 2.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              <path d="M6.5 12.4a1.6 1.6 0 0 0 3 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span v-if="unreadText" class="bell-dot" aria-hidden="true" />
          </NuxtLink>
        </div>
      </a-layout-header>
      <div ref="contentEl" class="content ft-content">
        <slot />
      </div>
    </a-layout>
    </a-layout>
  </a-layout>
</template>

<style scoped>
/* Ember 式抽屉壳层：左侧浅冷灰融底导航 + 底部白卡名片，右侧 16px 圆角纯白独立工作台画板 */
.ft-app { height: 100vh; height: 100dvh; padding: 0; overflow: hidden; background: var(--ft-page-bg); }
.frame { position: relative; height: 100%; background: var(--ft-page-bg); overflow: hidden; }
.sider { height: 100%; background: transparent !important; border-right: none; }
.sider-mask { position: absolute; inset: 0; z-index: 15; background: color-mix(in srgb, var(--ft-text) 22%, transparent); }
.sider-inner { height: 100%; display: flex; flex-direction: column; background: var(--ft-page-bg); overflow: hidden; }

.brand-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 12px 8px 14px; }
.brand { display: inline-flex; align-items: center; gap: 9px; min-width: 0; color: var(--ft-text); white-space: nowrap; }
.brand:hover { color: var(--ft-text); }
.brand-mark { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; background: var(--card-keycap-surface); background-clip: padding-box; border: 1px solid var(--card-hairline); border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom); box-shadow: var(--card-keycap-shadow); }
.logo { display: block; width: 20px; height: 17px; object-fit: contain; }
.brand-title { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; color: var(--ft-text); }
.brand-dot { color: var(--ft-primary); margin-left: 1px; }

.icon-btn { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ft-text-3); cursor: pointer; transition: background-color 0.15s, color 0.15s, border-color 0.15s; }
.icon-btn:hover { color: var(--ft-text); background: color-mix(in srgb, var(--ft-text) 5%, transparent); }
.icon-btn:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 1px; }

.sider-scroll { flex: 1; overflow-y: auto; padding: 4px 10px 10px 12px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--ft-text) 15%, transparent) transparent; }
.sider-scroll::-webkit-scrollbar { width: 5px; }
.sider-scroll::-webkit-scrollbar-track { background: transparent; }
.sider-scroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ft-text) 14%, transparent); border-radius: 999px; }
.sider-scroll:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ft-text) 24%, transparent); }
.group + .group { margin-top: 6px; }
.group-title { padding: 10px 10px 4px; font-size: 11px; font-weight: 500; letter-spacing: 0.01em; color: var(--ft-text-3); }
.item { display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 10px; margin: 1px 0; border-radius: 9px; color: var(--ft-text-2); font-size: 13.5px; white-space: nowrap; overflow: hidden; transition: background-color 0.12s, color 0.12s; }
.item-ico { flex: none; display: inline-flex; align-items: center; color: var(--ft-text-3); transition: color 0.12s; }
.item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* Ember 式纯白细描边数字小方牌 */
.badge { flex: none; box-sizing: border-box; min-width: 20px; height: 19px; padding: 0 5px; border-radius: 6px; background: var(--card-keycap-surface); background-clip: padding-box; border: 1px solid var(--card-hairline); border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom); box-shadow: var(--card-keycap-shadow); color: var(--ft-text-2); font-size: 11px; line-height: 17px; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
.item:hover { color: var(--ft-text); background: color-mix(in srgb, var(--ft-text) 4.5%, transparent); }
.item:hover .item-ico { color: var(--ft-text-2); }
/* 选中项：柔和浅灰圆角条 + 深墨字 + 品牌色图标，克制不刺眼 */
.item.active { color: var(--ft-text); background: color-mix(in srgb, var(--ft-text) 5.5%, var(--ft-card-bg)); font-weight: 600; }
.item.active .item-ico { color: var(--ft-primary); }
.item.active .badge { border-color: var(--card-hairline-hover); color: var(--ft-text); }
.item:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: -2px; }

/* 侧栏底部个人名片白卡：恢复纵向高度与字号，仅收窄左右宽度（左右各留 24px），居中且避开右侧滚动条 */
.user-card { flex: none; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: calc(100% - 48px); margin: 4px auto 10px; padding: 7px 8px; background: var(--card-surface-sheen); background-clip: padding-box; border: 1px solid var(--card-hairline); border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom); border-radius: 11px; box-shadow: var(--ft-card-shadow); min-width: 0; }
.avatar { flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--ft-primary-bg); color: var(--ft-primary-text); border: 1px solid color-mix(in srgb, var(--ft-primary) 18%, transparent); font-size: 12.5px; font-weight: 600; }
.user-meta { flex: 1; min-width: 0; line-height: 1.26; }
.user-name { font-size: 13px; font-weight: 600; color: var(--ft-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-dept { margin-top: 1px; font-size: 11.5px; color: var(--ft-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.logout-btn { width: 26px; height: 26px; }

/* 右侧独立圆角白瓷工作台画板（与内部纯白高光卡片拉开微亮度层级，保留顶部 1px 内高光） */
.main { min-width: 0; height: calc(100% - 16px); margin: 8px 8px 8px 0; display: flex; flex-direction: column; background: var(--card-sheet-bg); background-clip: padding-box; border: 1px solid var(--card-hairline); border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom); border-radius: 16px; box-shadow: var(--card-sheet-shadow); overflow: hidden; }
.main.main-full { margin-left: 8px; }
.header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 50px; line-height: 1.4; margin: 0; padding: 0 22px; background: transparent; border-bottom: 1px solid var(--card-border-subtle); }
.left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.page-name { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 500; color: var(--ft-text); white-space: nowrap; }
.page-ico { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; background: var(--card-keycap-surface); background-clip: padding-box; border: 1px solid var(--card-hairline); box-shadow: var(--card-keycap-shadow); color: var(--ft-text-2); }
.header-right { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; height: 32px; }
.search { display: flex; align-items: center; width: 290px; max-width: 42vw; height: 32px; }
.top-action { position: relative; flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--card-keycap-surface); background-clip: padding-box; border: 1px solid var(--card-hairline); border-color: var(--card-hairline-top) var(--card-hairline) var(--card-hairline-bottom); box-shadow: var(--card-keycap-shadow); color: var(--ft-text-2); transition: border-color 0.15s, color 0.15s, box-shadow 0.15s; }
.top-action:hover { color: var(--ft-text); border-color: var(--card-hairline-hover-top) var(--card-hairline-hover) var(--card-hairline-hover-bottom); }
.top-action:focus-visible { outline: 2px solid var(--ft-primary); outline-offset: 1px; }
.bell-dot { position: absolute; top: 6px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--ft-late); box-shadow: 0 0 0 1.5px var(--ft-card-bg); }

.content { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 26px 30px; }
@media (max-width: 991px) {
  .sider { position: absolute !important; inset: 0 auto 0 0; z-index: 20; height: 100%; box-shadow: var(--card-shadow-hover); border-right: 1px solid var(--ft-border); }
}
@media (max-width: 575px) {
  .main, .main.main-full { height: 100%; margin: 0; border-radius: 0; border: none; }
  .header { padding: 0 14px; }
  .search { display: none; }
  .content { padding: 14px; }
}
</style>
