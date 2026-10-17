<script setup lang="ts">
/** 设置（仅管理员）：阈值、停工日、通知对象、工单项目经理、QMS 同步状态。接口也校验管理员，这里只是不给非管理员看 */
import dayjs, { type Dayjs } from 'dayjs'

const { data: me } = await useMe()
const { data: master } = await useMaster()
const { data, refresh, error } = await useFetch('/api/settings', { immediate: !!me.value?.isAdmin })
// ?tab=sync 直接打开"QMS 同步状态"（同步失败提醒的跳转）
const route = useRoute()
const tab = ref(typeof route.query.tab === 'string' ? route.query.tab : 'thresholds')

// ───── QMS 同步状态 ─────
const { data: sync, refresh: refreshSync, pending: syncPending } = await useFetch('/api/settings/sync', { immediate: !!me.value?.isAdmin })
const syncColumns = [
  { title: '资源', key: 'label', width: 100 },
  { title: '最后同步成功', key: 'lastSyncedAt', width: 170 },
  { title: '游标（updatedAt / key）', key: 'cursor' },
  { title: '最近尝试', key: 'lastRunAt', width: 170 },
  { title: '连续失败', key: 'failCount', width: 90, align: 'center' as const },
  { title: '最近错误', key: 'lastError' },
]

const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` })))

/** 设置页的写接口都只看成功与否；绕开 Nitro 路由类型推导（路由多了以后会"类型递归过深"） */
const send = $fetch as unknown as (url: string, opts: { method: 'POST' | 'PUT' | 'DELETE'; body?: object }) => Promise<unknown>

async function call(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: object, ok = '已保存') {
  try {
    await send(url, { method, body })
    message.success(ok)
  } catch (e) {
    message.error(apiError(e))
  } finally {
    await refresh()
  }
}

// ───── 阈值 ─────
// W3 的"提醒"在表里存的是承诺返回日前多少小时，页面上按天编辑
type Row = { rule: 'W1' | 'W2' | 'W3' | 'W4'; remind: number | null; yellowDays: number; redDays: number }
const rows = ref<Row[]>([])
watch(
  () => data.value?.thresholds,
  (list) => {
    rows.value = (list ?? []).map((t) => ({
      rule: t.rule,
      remind: t.remindHours == null ? null : t.rule === 'W3' ? t.remindHours / 24 : t.remindHours,
      yellowDays: t.yellowDays,
      redDays: t.redDays,
    }))
  },
  { immediate: true },
)
const REMIND_LABEL = { W1: '小时后提醒', W2: '（不提醒）', W3: '天前提醒（承诺返回日前）', W4: '（不提醒）' } as const
const YELLOW_LABEL = { W1: '天', W2: '天', W3: '天（超期）', W4: '天（待受理 / 超期）' } as const
const RED_LABEL = { W1: '天', W2: '天', W3: '天（超期）', W4: '天（超要求解决日）' } as const
function saveThreshold(r: Row) {
  const remindHours = r.rule === 'W2' || r.rule === 'W4' || r.remind == null ? null : r.rule === 'W3' ? Math.round(r.remind * 24) : r.remind
  const url = `/api/settings/thresholds/${r.rule}`
  return call(url, 'PUT', { remindHours, yellowDays: r.yellowDays, redDays: r.redDays })
}
const thresholdColumns = [
  { title: '规则', key: 'rule', width: 200 },
  { title: '提醒', key: 'remind' },
  { title: '黄', key: 'yellow' },
  { title: '红', key: 'red' },
  { title: '', key: 'save', width: 90 },
]

// ───── 停工日 ─────
const newOffDay = ref<Dayjs | undefined>()
function addOffDay() {
  if (!newOffDay.value) return message.warning('请选择日期')
  const date = newOffDay.value.format('YYYY-MM-DD')
  newOffDay.value = undefined
  return call('/api/settings/off-days', 'POST', { date }, `已添加停工日 ${date}`)
}
const removeOffDay = (date: string) => call(`/api/settings/off-days/${date}`, 'DELETE', undefined, `已删除停工日 ${date}`)
const isOffDay = (d: Dayjs) => !!data.value?.offDays.includes(d.format('YYYY-MM-DD'))

// ───── 通知对象 ─────
const ROLES = [
  { role: 'OUTSOURCE_COORDINATOR', label: '外协专员', hint: 'W1 待确认匹配的责任人' },
  { role: 'DEPT_HEAD', label: '部门负责人', hint: '黄色起：责任人所在部门的负责人（按部门名称对应）' },
  { role: 'PROJECT_DEPT_HEAD', label: '项目部负责人', hint: '红色：加上项目部负责人' },
  { role: 'LEADER', label: '分管领导', hint: '红色：加上分管领导' },
] as const
type RoleKey = (typeof ROLES)[number]['role']
const roleForm = reactive<Record<RoleKey, { userId?: string; department?: string }>>({
  OUTSOURCE_COORDINATOR: {},
  DEPT_HEAD: {},
  PROJECT_DEPT_HEAD: {},
  LEADER: {},
})
function addRole(role: RoleKey) {
  const f = roleForm[role]
  if (!f.userId) return message.warning('请选择人员')
  if (role === 'DEPT_HEAD' && !f.department) return message.warning('请选择部门')
  const body = { role, userId: f.userId, department: role === 'DEPT_HEAD' ? f.department : null }
  roleForm[role] = {}
  return call('/api/settings/roles', 'POST', body, '已添加')
}
const removeRole = (id: string) => call(`/api/settings/roles/${id}`, 'DELETE', undefined, '已移除')

// ───── 工单项目经理 ─────
const setPm = (wo: string, projectManagerId: unknown) =>
  call(`/api/settings/work-orders/${encodeURIComponent(wo)}`, 'PUT', { projectManagerId: (projectManagerId as string) || null })
const woColumns = [
  { title: '工单', dataIndex: 'workOrderNumber', width: 180 },
  { title: '项目', key: 'project' },
  { title: '项目经理', key: 'pm', width: 280 },
]
</script>

<template>
  <a-result v-if="me && !me.isAdmin" status="403" title="仅管理员可用" sub-title="管理员由环境变量 NUXT_ADMIN_USER_IDS 指定" />
  <a-result v-else-if="error" status="error" :title="apiError(error)" />
  <a-card v-else-if="data" title="设置">
    <a-tabs v-model:active-key="tab">
      <a-tab-pane key="thresholds" tab="阈值">
        <p class="muted">全公司一套。计时按自然日，停工日整天不计入。级别只升不降：调大阈值后已经升级的预警不会退回。</p>
        <a-table :columns="thresholdColumns" :data-source="rows" row-key="rule" size="small" :pagination="false">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'rule'">{{ RULE_TEXT[record.rule as Row['rule']] }}</template>
            <template v-else-if="column.key === 'remind'">
              <span v-if="record.rule === 'W2' || record.rule === 'W4'" class="muted">不提醒，直接黄</span>
              <a-space v-else>
                <a-input-number v-model:value="record.remind" :min="1" :max="record.rule === 'W3' ? 30 : 720" size="small" />
                <span>{{ REMIND_LABEL[record.rule as Row['rule']] }}</span>
              </a-space>
            </template>
            <template v-else-if="column.key === 'yellow'">
              <a-space><a-input-number v-model:value="record.yellowDays" :min="1" :max="365" size="small" /><span>{{ YELLOW_LABEL[record.rule as Row['rule']] }}</span></a-space>
            </template>
            <template v-else-if="column.key === 'red'">
              <a-space><a-input-number v-model:value="record.redDays" :min="1" :max="365" size="small" /><span>{{ RED_LABEL[record.rule as Row['rule']] }}</span></a-space>
              <div v-if="record.rule === 'W3'" class="muted">要求完成日已过也直接红</div>
              <div v-if="record.rule === 'W4'" class="muted">W4 红色不再转异常</div>
            </template>
            <template v-else-if="column.key === 'save'">
              <a-button type="primary" size="small" @click="saveThreshold(record as Row)">保存</a-button>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <a-tab-pane key="off-days" tab="停工日">
        <p class="muted">国庆、春节等停工日整天不计时（只暂停计时，不屏蔽承诺返回日到期前的提醒）。</p>
        <a-space>
          <a-date-picker v-model:value="newOffDay" :disabled-date="isOffDay" placeholder="选择停工日" />
          <a-button type="primary" @click="addOffDay">添加</a-button>
        </a-space>
        <div class="off-days">
          <a-empty v-if="!data.offDays.length" description="还没有停工日" />
          <a-tag v-for="d in data.offDays" :key="d" closable class="off-day" @close.prevent="removeOffDay(d)">
            {{ d }} {{ '周' + '日一二三四五六'[dayjs(d).day()] }}
          </a-tag>
        </div>
      </a-tab-pane>

      <a-tab-pane key="roles" tab="通知对象">
        <p class="muted">提醒 → 责任人；黄 → 加部门负责人、工单项目经理；红 → 再加项目部负责人、分管领导。没有设置的角色跳过。</p>
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item v-for="r in ROLES" :key="r.role">
            <template #label>
              <div>{{ r.label }}</div>
              <div class="muted">{{ r.hint }}</div>
            </template>
            <div class="role-users">
              <span v-if="!data.roles.some((x) => x.role === r.role)" class="muted">未设置</span>
              <a-tag v-for="x in data.roles.filter((x) => x.role === r.role)" :key="x.id" closable @close.prevent="removeRole(x.id)">
                {{ x.userName }}<template v-if="x.department">（{{ x.department }}）</template>
              </a-tag>
            </div>
            <a-space>
              <a-select
                v-if="r.role === 'DEPT_HEAD'"
                v-model:value="roleForm[r.role].department"
                placeholder="部门"
                style="width: 140px"
                size="small"
                :options="data.departments.map((d) => ({ value: d, label: d }))"
              />
              <a-select
                v-model:value="roleForm[r.role].userId"
                placeholder="选择人员"
                show-search
                option-filter-prop="label"
                style="width: 220px"
                size="small"
                :options="userOptions"
              />
              <a-button size="small" @click="addRole(r.role)">添加</a-button>
            </a-space>
          </a-descriptions-item>
        </a-descriptions>
      </a-tab-pane>

      <a-tab-pane key="sync" tab="QMS 同步状态">
        <p class="muted">
          每 5 分钟按游标增量同步一次 QMS 的工单、外协单位（含厂内班组）、工序、部门、用户、报检，同步后自动做返厂匹配和不合格转异常。
          某类资源连续失败 3 次会给管理员发一条置顶提醒（同一轮故障只发一次）。
        </p>
        <a-alert v-if="sync && !sync.configured" type="warning" show-icon message="未配置 QMS 同步（NUXT_QMS_SYNC_ENABLED=0，或 QMS 地址、客户端凭据为空），定时任务会跳过" style="margin-bottom: 12px" />
        <a-table :columns="syncColumns" :data-source="sync?.resources ?? []" :loading="syncPending" row-key="resource" size="small" :pagination="false" class="sync-table">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'label'">{{ record.label }}<div class="muted">{{ record.resource }}</div></template>
            <template v-else-if="column.key === 'lastSyncedAt'">{{ record.lastSyncedAt ? timeText(record.lastSyncedAt) : '未同步' }}</template>
            <template v-else-if="column.key === 'cursor'">
              <span v-if="record.since" class="mono">{{ record.since }} / {{ record.afterId }}</span>
              <span v-else class="muted">从头开始</span>
            </template>
            <template v-else-if="column.key === 'lastRunAt'">{{ record.lastRunAt ? timeText(record.lastRunAt) : '—' }}</template>
            <template v-else-if="column.key === 'failCount'">
              <a-tag v-if="record.failCount" color="red">{{ record.failCount }}</a-tag>
              <span v-else class="muted">0</span>
            </template>
            <template v-else-if="column.key === 'lastError'">
              <span v-if="record.lastError" class="sync-err">{{ record.lastError }}</span>
              <span v-else class="muted">—</span>
            </template>
          </template>
        </a-table>
        <a-button size="small" style="margin-top: 12px" @click="refreshSync()">刷新</a-button>
      </a-tab-pane>

      <a-tab-pane key="work-orders" tab="工单项目经理">
        <p class="muted">黄色预警起通知该工单的项目经理。</p>
        <a-table :columns="woColumns" :data-source="data.workOrders" row-key="workOrderNumber" size="small" :pagination="{ pageSize: 20, hideOnSinglePage: true }">
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'project'">{{ record.projectName ?? '' }}<span class="muted">　{{ record.customerName }}</span></template>
            <template v-else-if="column.key === 'pm'">
              <a-select
                :value="record.projectManagerId ?? undefined"
                allow-clear
                show-search
                option-filter-prop="label"
                placeholder="未设置"
                style="width: 100%"
                size="small"
                :options="userOptions"
                @change="(v: unknown) => setPm(record.workOrderNumber, v)"
              />
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </a-card>
</template>

<style scoped>
.muted { color: #999; font-size: 12px; }
.off-days { margin-top: 16px; }
.off-day { margin-bottom: 8px; font-size: 14px; padding: 2px 8px; }
.role-users { margin-bottom: 8px; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
.sync-err { color: #cf1322; }
</style>
