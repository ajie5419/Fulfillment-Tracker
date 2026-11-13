<script setup lang="ts">
/**
 * BRICK 极致极简工程协同风格 Demo 预览页。
 * 1:1 还原 BRICK 参考图视觉体系：
 *   1. 纯白画布 + 顶部极简底线页签与微操作栏
 *   2. 双栏悬浮「焦点迷你清单卡」（STARTS TODAY / NEEDS ATTENTION）
 *   3. 浅灰大圆角托盘（#F9F9F9，实测 sRGB 0.977 纯中性灰）
 *   4. 托盘顶栏信息提纯（工单/项目经理/阶段/交期/完成度单行整合）
 *   5. 纯白内嵌卡片（#FFFFFF，左 4 列极简大纲表 + 右双色调日历甘特图）
 */

useHead({ title: 'BRICK 风格计划工作台 Demo · 通联履约' })

const activeTab = ref<'timeline' | 'calendar' | 'gantt'>('gantt')
const collapsed = ref<Record<string, boolean>>({
  'DEMO-001': false,
  'DEMO-002': false,
})

function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key]
}

// 模拟真实项目计划节点
const project1 = {
  wo: 'DEMO-001',
  name: '重型特种车载装备',
  customer: '中铁十八局（铁路局）',
  manager: '赵工（测试项目经理）',
  delivery: '2027-02-11',
  statusText: '已发布',
  progress: '2 / 7 已完成',
  progressPct: 28,
  nodes: [
    { id: 'n1', code: '1.1', name: '开工通知及技术协议确认', owner: '项目部 · 赵工', av: '赵', avColor: 'av-blue', progress: 100, dates: '11-09 ~ 11-09', status: 'done', barStart: 1, barLen: 2, delay: 0 },
    { id: 'n2', code: '2.1', name: '结构与总成图纸编制', owner: '技术部 · 王工', av: '王', avColor: 'av-purple', progress: 100, dates: '11-10 ~ 11-10', status: 'done', barStart: 2, barLen: 2, delay: 0 },
    { id: 'n3', code: '2.2', name: '关键原材料与型材采购', owner: '采购部 · 李工', av: '李', avColor: 'av-amber', progress: 0, dates: '11-10 ~ 11-15', status: 'late', barStart: 2, barLen: 5, delay: 2, alert: 'late', alertText: '已延误 2 天 · 11-15 需求日', pred: '← 1.1' },
    { id: 'n4', code: '2.3', name: '主要外购件采购计划', owner: '采购部 · 李工', av: '李', avColor: 'av-amber', progress: 0, dates: '11-10 ~ 11-12', status: 'warn', barStart: 2, barLen: 3, delay: 1, alert: 'warn', alertText: '排期冲突 · 11-12 节点', pred: '← 1.1' },
    { id: 'n5', code: '2.4', name: '电气元器件与线束采购', owner: '采购部 · 张工', av: '张', avColor: 'av-amber', progress: 0, dates: '11-10 ~ 11-19', status: 'open', barStart: 2, barLen: 8, delay: 0, pred: '← 1.1' },
    { id: 'n6', code: '3.1', name: '车桥、轮辋与底盘组装', owner: '生产部 · 孙工', av: '孙', avColor: 'av-green', progress: 0, dates: '11-23 ~ 01-24', status: 'open', barStart: 12, barLen: 5, delay: 0, pred: '← 2.2' },
    { id: 'n7', code: '3.2', name: '整机总装调试与出厂检验', owner: '品质部 · 周工', av: '周', avColor: 'av-pink', progress: 0, dates: '01-25 ~ 02-11', status: 'open', barStart: 14, barLen: 3, delay: 0, pred: '← 3.1' },
  ],
}

const project2 = {
  wo: 'DEMO-002',
  name: '高铁客专轨道智能检测车',
  customer: '中铁二十三局装备分公司',
  manager: '孙工（项目经理）',
  delivery: '2027-03-20',
  statusText: '已发布',
  progress: '4 / 8 已完成',
  progressPct: 50,
  nodes: [
    { id: 'm1', code: '1.1', name: '图纸深化设计与专家会审', owner: '技术部 · 陈工', av: '陈', avColor: 'av-purple', progress: 100, dates: '11-02 ~ 11-06', status: 'done', barStart: 0, barLen: 4, delay: 0 },
    { id: 'm2', code: '1.2', name: '电气控制柜元器件采购', owner: '采购部 · 李工', av: '李', avColor: 'av-amber', progress: 100, dates: '11-05 ~ 11-10', status: 'done', barStart: 1, barLen: 4, delay: 0 },
    { id: 'm3', code: '2.1', name: '检测车体结构件数控下料', owner: '生产部 · 孙工', av: '孙', avColor: 'av-green', progress: 75, dates: '11-08 ~ 11-14', status: 'open', barStart: 3, barLen: 6, delay: 0, progressFill: 75 },
    { id: 'm4', code: '2.2', name: '精密传感器组装与标定', owner: '技术部 · 王工', av: '王', avColor: 'av-purple', progress: 0, dates: '11-15 ~ 11-22', status: 'warn', barStart: 8, barLen: 5, delay: 0, alert: 'warn', alertText: '待接收确认', pred: '← 2.1' },
  ],
}

// 模拟双栏焦点清单
const startsToday = [
  { id: 's1', title: '2.2 原材料与型材采购', meta: 'DEMO-001 · 重型车载', owner: '李工', av: '李', avColor: 'av-amber', dueText: '计划 11-15' },
  { id: 's2', title: '2.3 主要外购件采购计划', meta: 'DEMO-001 · 重型车载', owner: '李工', av: '李', avColor: 'av-amber', dueText: '计划 11-12' },
  { id: 's3', title: '2.1 检测车体结构件下料', meta: 'DEMO-002 · 轨道检测车', owner: '孙工', av: '孙', avColor: 'av-green', dueText: '进行中 75%' },
]

const needsAttention = [
  { id: 'a1', title: '2.2 原材料采购计划', meta: 'DEMO-001 · 采购部', owner: '李工', av: '李', avColor: 'av-amber', alertText: '已延误 2 天 · 11-15 需求日 · 已完 0%', level: 'late' },
  { id: 'a2', title: '2.3 主要外购件采购', meta: 'DEMO-001 · 采购部', owner: '李工', av: '李', avColor: 'av-amber', alertText: '排期冲突 · 11-12 节点前置未齐', level: 'risk' },
  { id: 'a3', title: '2.2 传感器组装与标定', meta: 'DEMO-002 · 技术部', owner: '王工', av: '王', avColor: 'av-purple', alertText: '待接收确认 · 计划 11-15 启动', level: 'risk' },
  { id: 'a4', title: '液压阀组到货复检', meta: 'DEMO-001 · 品质部', owner: '周工', av: '周', avColor: 'av-pink', alertText: '关键物料卡付款审批', level: 'risk' },
]

// 日历天数表头（以 2026年 11月 为例，第 8 到 22 日共 15 列，12 日为今日）
const calendarDays = [
  { dayName: 'SU', dateNum: 8, isWeekend: true, isToday: false },
  { dayName: 'MO', dateNum: 9, isWeekend: false, isToday: false },
  { dayName: 'TU', dateNum: 10, isWeekend: false, isToday: false },
  { dayName: 'WE', dateNum: 11, isWeekend: false, isToday: false },
  { dayName: 'TH', dateNum: 12, isWeekend: false, isToday: true }, // 今日
  { dayName: 'FR', dateNum: 13, isWeekend: false, isToday: false },
  { dayName: 'SA', dateNum: 14, isWeekend: true, isToday: false },
  { dayName: 'SU', dateNum: 15, isWeekend: true, isToday: false },
  { dayName: 'MO', dateNum: 16, isWeekend: false, isToday: false },
  { dayName: 'TU', dateNum: 17, isWeekend: false, isToday: false },
  { dayName: 'WE', dateNum: 18, isWeekend: false, isToday: false },
  { dayName: 'TH', dateNum: 19, isWeekend: false, isToday: false },
  { dayName: 'FR', dateNum: 20, isWeekend: false, isToday: false },
  { dayName: 'SA', dateNum: 21, isWeekend: true, isToday: false },
  { dayName: 'SU', dateNum: 22, isWeekend: true, isToday: false },
]
</script>

<template>
  <div class="brick-demo-wrap">
    <!-- 顶部横幅提示：对比通道 -->
    <div class="demo-banner">
      <div class="banner-left">
        <span class="badge-tag">BRICK 1:1 风格预览</span>
        <span class="banner-text">这是纯正现代工程协同风格效果。注意观察：<strong>纯白画布</strong> → <strong>浅灰大托盘 (#F9F9F9)</strong> → <strong>纯白内嵌精密卡 (#FFFFFF)</strong> 的物理层级。</span>
      </div>
      <div class="banner-right">
        <NuxtLink to="/plan?wo=DEMO-OO1" class="switch-link">‹ 返回原版计划页对比</NuxtLink>
      </div>
    </div>

    <!-- 顶部主操作栏 (Page Topbar) -->
    <header class="brick-page-head">
      <div class="head-left">
        <h1 class="page-title">项目履约推进 <span class="title-en">Projects</span></h1>
        <span class="sub-link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          协同排期视图说明
        </span>
      </div>
      <div class="head-actions">
        <button type="button" class="btn-action">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>
          排序 <span>⌄</span>
        </button>
        <button type="button" class="btn-action">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          筛选 <span>⌄</span>
        </button>
        <button type="button" class="btn-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新增节点
        </button>
      </div>
    </header>

    <!-- 极简底线页签 (Underline Tabs) -->
    <nav class="brick-tabs" aria-label="视图切换">
      <button
        type="button"
        class="tab-item"
        :class="{ active: activeTab === 'timeline' }"
        @click="activeTab = 'timeline'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        时间线 Timeline
      </button>
      <button
        type="button"
        class="tab-item"
        :class="{ active: activeTab === 'calendar' }"
        @click="activeTab = 'calendar'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        日历 Calendar
      </button>
      <button
        type="button"
        class="tab-item"
        :class="{ active: activeTab === 'gantt' }"
        @click="activeTab = 'gantt'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h14"/></svg>
        甘特图 Gantt
        <span class="pill-badge">Beta</span>
      </button>
    </nav>

    <!-- 模块 1：双栏独立悬浮焦点卡 (Spotlight Grid) -->
    <section class="spotlight-grid" aria-label="关键动态焦点">
      <!-- 左卡：今日与近期启动 -->
      <div class="spotlight-card">
        <div class="card-head">
          <span class="card-title">今日与近期节点 STARTS TODAY</span>
          <span class="count-pill">{{ startsToday.length }}</span>
        </div>
        <div class="card-body">
          <div v-for="item in startsToday" :key="item.id" class="sp-row">
            <div class="row-left">
              <span class="av-circle" :class="item.avColor">{{ item.av }}</span>
              <span class="item-title">{{ item.title }}</span>
              <span class="item-meta">{{ item.owner }} · {{ item.meta }}</span>
            </div>
            <div class="row-right">
              <span class="text-due">{{ item.dueText }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右卡：需要关注与延误 -->
      <div class="spotlight-card">
        <div class="card-head">
          <span class="card-title">需要关注 / 延误与排期 NEEDS ATTENTION</span>
          <span class="count-pill danger">{{ needsAttention.length }}</span>
        </div>
        <div class="card-body">
          <div v-for="item in needsAttention" :key="item.id" class="sp-row">
            <div class="row-left">
              <span class="av-circle" :class="item.avColor">{{ item.av }}</span>
              <span class="item-title">{{ item.title }}</span>
              <span class="item-meta">{{ item.owner }} · {{ item.meta }}</span>
            </div>
            <div class="row-right">
              <span class="alert-mark" :class="item.level">
                <i>⟐</i>
              </span>
              <span class="text-alert" :class="item.level">{{ item.alertText }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 模块 2：工单大托盘 (Project Tray 1: DEMO-001) -->
    <article class="project-tray">
      <!-- 托盘顶栏：信息高度提纯，单行流式排开 -->
      <div class="tray-header">
        <div class="tray-title-group">
          <button
            type="button"
            class="chevron-btn"
            :aria-label="collapsed['DEMO-001'] ? '展开工单' : '收起工单'"
            @click="toggleCollapse('DEMO-001')"
          >
            <span class="chevron" :class="{ open: !collapsed['DEMO-001'] }"></span>
          </button>
          <span class="av-circle av-blue">赵</span>
          <span class="tray-manager">{{ project1.manager }}</span>
          <span class="tray-sep">/</span>
          <span class="tray-project">{{ project1.name }}</span>
          <span class="tray-tag">阶段：结构与采购 ⌄</span>
        </div>

        <div class="tray-meta-group">
          <span class="meta-item">合同交期 <strong>{{ project1.delivery }}</strong></span>
          <span class="meta-sep">·</span>
          <span class="meta-progress">
            <span class="prog-track"><i class="prog-fill" :style="{ width: `${project1.progressPct}%` }"></i></span>
            <span>{{ project1.progress }}</span>
          </span>
          <span class="tray-actions" aria-hidden="true">
            <span title="图纸附档">📷</span>
            <span title="单据归档">📄</span>
            <span title="快速编辑">✏️</span>
            <span title="全屏查看">⛶</span>
          </span>
        </div>
      </div>

      <!-- 纯白内嵌卡片：左 4 列紧凑大纲表 + 右日历甘特图一体化 -->
      <div v-show="!collapsed['DEMO-001']" class="inset-card">
        <!-- 左侧 4 列大纲表 -->
        <div class="split-table">
          <div class="st-head">
            <span class="col-task">TASK</span>
            <span class="col-user">ASSIGNED</span>
            <span class="col-prog">PROGRESS</span>
            <span class="col-date">DATES</span>
          </div>

          <div class="st-body">
            <div v-for="node in project1.nodes" :key="node.id" class="st-row">
              <div class="col-task">
                <span class="code-num">{{ node.code }}</span>
                <span class="task-name" :title="node.name">{{ node.name }}</span>
                <span v-if="node.alert" class="diamond-icon" :class="node.alert">⟐</span>
              </div>
              <div class="col-user">
                <span class="user-chip">
                  <span class="av-mini" :class="node.avColor">{{ node.av }}</span>
                  <span class="user-text">{{ node.owner.split('·')[1]?.trim() ?? node.owner }}</span>
                </span>
              </div>
              <div class="col-prog" :class="{ done: node.progress === 100 }">
                {{ node.progress }}%
              </div>
              <div class="col-date" :class="{ danger: node.status === 'late', warn: node.status === 'warn' }">
                {{ node.dates }}
              </div>
            </div>
          </div>
        </div>

        <!-- 右侧日历甘特图时间轴 -->
        <div class="split-gantt">
          <!-- 月份与日期表头 -->
          <div class="gt-head">
            <div class="gt-month">November 2026</div>
            <div class="gt-days-bar">
              <div
                v-for="d in calendarDays"
                :key="d.dateNum"
                class="day-cell"
                :class="{ weekend: d.isWeekend, today: d.isToday }"
              >
                <span class="week-name">{{ d.dayName }}</span>
                <span class="date-num">{{ d.dateNum }}</span>
              </div>
            </div>
          </div>

          <!-- 横道区域与背景网格 -->
          <div class="gt-body">
            <!-- 垂直网格线背景层（含周末浅灰底色带 + 今日高光细蓝线） -->
            <div class="gt-grid-bg" aria-hidden="true">
              <div
                v-for="d in calendarDays"
                :key="d.dateNum"
                class="grid-col"
                :class="{ weekend: d.isWeekend, 'today-col': d.isToday }"
              ></div>
            </div>

            <!-- 任务横道行 -->
            <div class="gt-rows">
              <div v-for="node in project1.nodes" :key="node.id" class="gt-row">
                <!-- 已完成横道 -->
                <div
                  v-if="node.status === 'done'"
                  class="gantt-bar done"
                  :style="{
                    left: `${(node.barStart / 15) * 100}%`,
                    width: `${(node.barLen / 15) * 100}%`,
                  }"
                >
                  <span class="bar-label">已完工</span>
                </div>

                <!-- 延误横道与文字 -->
                <div
                  v-else-if="node.status === 'late'"
                  class="gantt-bar-wrap"
                  :style="{ left: `${(node.barStart / 15) * 100}%` }"
                >
                  <div
                    class="gantt-bar late"
                    :style="{ width: `${(node.barLen / 15) * 100}%` }"
                  >
                    <span class="bar-stripe"></span>
                  </div>
                  <span class="out-range-text late">‹ 已延误 2天 · 计划 11-15</span>
                  <span v-if="node.pred" class="pred-tag">{{ node.pred }}</span>
                </div>

                <!-- 排期预警横道 -->
                <div
                  v-else-if="node.status === 'warn'"
                  class="gantt-bar-wrap"
                  :style="{ left: `${(node.barStart / 15) * 100}%` }"
                >
                  <div
                    class="gantt-bar warn"
                    :style="{ width: `${(node.barLen / 15) * 100}%` }"
                  ></div>
                  <span class="out-range-text warn">‹ 排期冲突 · 11-12</span>
                  <span v-if="node.pred" class="pred-tag">{{ node.pred }}</span>
                </div>

                <!-- 正常在途或后续任务 -->
                <div
                  v-else
                  class="gantt-bar-wrap"
                  :style="{ left: `${(node.barStart / 15) * 100}%` }"
                >
                  <div
                    class="gantt-bar active"
                    :style="{ width: `${(node.barLen / 15) * 100}%` }"
                  ></div>
                  <span v-if="node.pred" class="pred-tag">{{ node.pred }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>

    <!-- 模块 3：第二个工单托盘 (Project Tray 2: DEMO-002 展示并列层次) -->
    <article class="project-tray">
      <div class="tray-header">
        <div class="tray-title-group">
          <button
            type="button"
            class="chevron-btn"
            :aria-label="collapsed['DEMO-002'] ? '展开工单' : '收起工单'"
            @click="toggleCollapse('DEMO-002')"
          >
            <span class="chevron" :class="{ open: !collapsed['DEMO-002'] }"></span>
          </button>
          <span class="av-circle av-purple">孙</span>
          <span class="tray-manager">{{ project2.manager }}</span>
          <span class="tray-sep">/</span>
          <span class="tray-project">{{ project2.name }}</span>
          <span class="tray-tag">阶段：深化设计与结构 ⌄</span>
        </div>

        <div class="tray-meta-group">
          <span class="meta-item">合同交期 <strong>{{ project2.delivery }}</strong></span>
          <span class="meta-sep">·</span>
          <span class="meta-progress">
            <span class="prog-track"><i class="prog-fill" :style="{ width: `${project2.progressPct}%` }"></i></span>
            <span>{{ project2.progress }}</span>
          </span>
          <span class="tray-actions" aria-hidden="true">
            <span title="图纸附档">📷</span>
            <span title="单据归档">📄</span>
            <span title="快速编辑">✏️</span>
            <span title="全屏查看">⛶</span>
          </span>
        </div>
      </div>

      <div v-show="!collapsed['DEMO-002']" class="inset-card">
        <div class="split-table">
          <div class="st-head">
            <span class="col-task">TASK</span>
            <span class="col-user">ASSIGNED</span>
            <span class="col-prog">PROGRESS</span>
            <span class="col-date">DATES</span>
          </div>
          <div class="st-body">
            <div v-for="node in project2.nodes" :key="node.id" class="st-row">
              <div class="col-task">
                <span class="code-num">{{ node.code }}</span>
                <span class="task-name" :title="node.name">{{ node.name }}</span>
                <span v-if="node.alert" class="diamond-icon" :class="node.alert">⟐</span>
              </div>
              <div class="col-user">
                <span class="user-chip">
                  <span class="av-mini" :class="node.avColor">{{ node.av }}</span>
                  <span class="user-text">{{ node.owner.split('·')[1]?.trim() ?? node.owner }}</span>
                </span>
              </div>
              <div class="col-prog" :class="{ done: node.progress === 100 }">
                {{ node.progress }}%
              </div>
              <div class="col-date" :class="{ warn: node.status === 'warn' }">
                {{ node.dates }}
              </div>
            </div>
          </div>
        </div>

        <div class="split-gantt">
          <div class="gt-head">
            <div class="gt-month">November 2026</div>
            <div class="gt-days-bar">
              <div
                v-for="d in calendarDays"
                :key="d.dateNum"
                class="day-cell"
                :class="{ weekend: d.isWeekend, today: d.isToday }"
              >
                <span class="week-name">{{ d.dayName }}</span>
                <span class="date-num">{{ d.dateNum }}</span>
              </div>
            </div>
          </div>
          <div class="gt-body">
            <div class="gt-grid-bg" aria-hidden="true">
              <div
                v-for="d in calendarDays"
                :key="d.dateNum"
                class="grid-col"
                :class="{ weekend: d.isWeekend, 'today-col': d.isToday }"
              ></div>
            </div>
            <div class="gt-rows">
              <div v-for="node in project2.nodes" :key="node.id" class="gt-row">
                <div
                  v-if="node.status === 'done'"
                  class="gantt-bar done"
                  :style="{
                    left: `${(node.barStart / 15) * 100}%`,
                    width: `${(node.barLen / 15) * 100}%`,
                  }"
                >
                  <span class="bar-label">已完工</span>
                </div>
                <div
                  v-else-if="node.progressFill"
                  class="gantt-bar-wrap"
                  :style="{ left: `${(node.barStart / 15) * 100}%` }"
                >
                  <div
                    class="gantt-bar active with-fill"
                    :style="{ width: `${(node.barLen / 15) * 100}%` }"
                  >
                    <div class="bar-fill" :style="{ width: `${node.progressFill}%` }"></div>
                  </div>
                </div>
                <div
                  v-else
                  class="gantt-bar-wrap"
                  :style="{ left: `${(node.barStart / 15) * 100}%` }"
                >
                  <div
                    class="gantt-bar warn outline"
                    :style="{ width: `${(node.barLen / 15) * 100}%` }"
                  ></div>
                  <span class="out-range-text warn">‹ 待接收</span>
                  <span v-if="node.pred" class="pred-tag">{{ node.pred }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
@import '~/assets/brick-demo.css';
</style>
