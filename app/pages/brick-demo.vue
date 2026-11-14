<script setup lang="ts">
/** Static fixtures keep the visual preview independent of authenticated business data. */
definePageMeta({ layout: false })

useHead({ title: 'BRICK 风格计划工作台 Demo · 通联履约' })

const collapsed = ref<Record<string, boolean>>({
  'DEMO-001': false,
  'DEMO-002': false,
})

function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key]
}

interface PreviewNode {
  id: string; code: string; name: string; owner: string; av: string; avColor: string
  progress: number; dates: string; status: string; barStart: number; barLen: number; delay: number
  alert?: string; alertText?: string; pred?: string; progressFill?: number
}
interface PreviewProject {
  wo: string; name: string; customer: string; manager: string; delivery: string
  statusText: string; progress: string; progressPct: number; nodes: PreviewNode[]
}
// Synthetic project fixtures are never used as production work-order identifiers.
const project1: PreviewProject = {
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

const project2: PreviewProject = {
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

const projects = [project1, project2]
const selection = ref('')
const recentItems = startsToday.map(item => ({
  id: item.id, title: item.title, meta: item.meta, ownerName: item.owner, rightText: item.dueText,
}))
const attentionItems = needsAttention.map(item => ({
  id: item.id, title: item.title, meta: item.meta, ownerName: item.owner, rightText: item.alertText,
  level: item.level === 'late' ? 'late' as const : 'risk' as const,
}))
function selectItem(item: { title: string; rightText: string }) {
  selection.value = `${item.title} · ${item.rightText}`
}
function barStyle(node: PreviewNode) {
  return { left: `${node.barStart / calendarDays.length * 100}%`, width: `${node.barLen / calendarDays.length * 100}%` }
}
</script>

<template>
  <main class="brick-demo-wrap">
    <header class="preview-head">
      <div>
        <h1>BRICK 计划工作台预览</h1>
        <p>以下为示例数据，用于比较布局；实际工单请返回项目计划查看。</p>
      </div>
      <NuxtLink to="/plan" class="return-link">返回项目计划</NuxtLink>
    </header>

    <UiSpotlightGrid
      left-title="今日与近期节点" :left-items="recentItems"
      right-title="需要关注" :right-items="attentionItems"
      @select="selectItem"
      @click-left-head="selection = '今日与近期节点：' + recentItems.map(item => item.title).join('、')"
      @click-right-head="selection = '需要关注：' + attentionItems.map(item => item.title).join('、')"
    />
    <p v-if="selection" role="status" class="preview-selection">{{ selection }}</p>

    <article v-for="project in projects" :key="project.wo" class="ft-wo-group preview-project">
      <UiWoGroupHead
        :no="project.wo" :done="project.nodes.filter(node => node.progress === 100).length"
        :total="project.nodes.length" label="已完成" :count="project.nodes.length" unit="节点"
      >
        <template #leading>
          <button type="button" class="fold-button" :aria-expanded="!collapsed[project.wo]"
            :aria-label="`${collapsed[project.wo] ? '展开' : '收起'} ${project.wo}`"
            @click="toggleCollapse(project.wo)">{{ collapsed[project.wo] ? '＋' : '−' }}</button>
        </template>
        <template #workOrder><span>{{ project.wo }} · 示例</span></template>
      </UiWoGroupHead>
      <div class="project-context">
        <strong>{{ project.name }}</strong>
        <UiUserChip :name="project.manager" />
        <span>合同交期 {{ project.delivery }}</span>
      </div>
      <section v-show="!collapsed[project.wo]" class="preview-plan" :aria-label="`${project.wo} 甘特图`">
        <div class="plan-heading plan-row">
          <div class="node-info"><span>节点 / 任务</span><span>责任人</span><span>进度</span><span>计划起止</span></div>
          <div class="timeline-heading">
            <span>2026 年 11 月 · 局部时间窗口</span>
            <div class="calendar-days"><span v-for="day in calendarDays" :key="day.dateNum">{{ day.dateNum }}</span></div>
          </div>
        </div>
        <div v-for="node in project.nodes" :key="node.id" class="plan-row" :data-node="node.id">
          <div class="node-info">
            <span class="node-title"><span class="node-code">{{ node.code }}</span>{{ node.name }}</span>
            <UiUserChip :name="node.owner" />
            <span>{{ node.progress }}%</span>
            <span class="node-dates">{{ node.dates }}</span>
          </div>
          <div class="timeline-cell">
            <div class="timeline-track" :aria-label="`${node.name}：${node.dates}，完成 ${node.progress}%`">
              <div class="calendar-grid" aria-hidden="true">
                <span v-for="day in calendarDays" :key="day.dateNum" :class="{ weekend: day.isWeekend, today: day.isToday }" />
              </div>
              <div class="gantt-bar" :class="node.status" :style="barStyle(node)">
                <span class="bar-fill" :style="{ width: `${node.progress}%` }" />
              </div>
            </div>
            <span class="node-note" :class="{ late: node.status === 'late', risk: node.status === 'warn' }">
              <UiAlertMark v-if="node.alert" :level="node.status === 'late' ? 'late' : 'risk'" />
              {{ node.alertText || (node.status === 'done' ? '已完成' : '进行中') }}
              <span v-if="node.pred">前置 {{ node.pred }}</span>
            </span>
          </div>
        </div>
      </section>
    </article>
  </main>
</template>

<style scoped src="~/assets/brick-demo.css"></style>
