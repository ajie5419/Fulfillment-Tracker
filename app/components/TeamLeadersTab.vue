<script setup lang="ts">
/**
 * 设置 →"班组长"（生产管理重设计第二批）：给每个厂内班组（QMS 同步来的，kind = TEAM）指定一个班组长，一个人可以带多个班组。
 * 自制工序派到班组、没指定负责人时，"安排开工""可以开工"待办和 W10 预警发给班组长；班组长可以登记本班组自制工序的开工、完工、报工。
 * 生产部、管理员可以改（接口也校验）；QMS 同步不会覆盖或清掉这里的设置。
 */
const { data: me } = await useMe()
const { data: master } = await useMaster()
interface Row { teamId: string; teamName: string; active: boolean; leaderId: string | null; leaderName: string | null; updatedAt: string | null; updatedByName: string | null }
const { data, pending, error, refresh } = await useFetch<Row[]>('/api/team-leaders', { default: () => [] })
const canEdit = computed(() => !!me.value && (me.value.isAdmin || !!me.value.can?.teamLeader))
const userOptions = computed(() => master.value.users.map((u) => ({ value: u.id, label: `${u.name}（${u.department}）` })))
const saving = ref<string | null>(null)
const send = $fetch as unknown as (url: string, opts: { method: 'PUT'; body: object }) => Promise<unknown>

async function save(r: Row, userId: string | null) {
  saving.value = r.teamId
  try {
    await send(`/api/team-leaders/${encodeURIComponent(r.teamId)}`, { method: 'PUT', body: { userId } })
    message.success(userId ? '已设置班组长' : '已清除班组长')
  } catch (e) {
    message.error(apiError(e))
  } finally {
    saving.value = null
    await refresh()
  }
}
const columns = [
  { title: '班组', key: 'team' },
  { title: '班组长', key: 'leader', width: 280 },
  { title: '最近修改', key: 'updated', width: 220 },
]
</script>

<template>
  <div>
    <p class="muted">自制工序派到班组、没有指定负责人时，待办和超期提醒发给班组长；班组长可以登记本班组自制工序的开工、完工、报工。班组从 QMS 同步，同步不会改这里的设置。</p>
    <a-result v-if="error && !pending" status="error" title="班组加载失败" :sub-title="apiError(error)">
      <template #extra><a-button type="primary" @click="refresh()">重试</a-button></template>
    </a-result>
    <a-spin v-else :spinning="pending">
      <a-empty v-if="!data.length" description="还没有从 QMS 同步到班组" />
      <a-table v-else class="ft-table" :columns="columns" :data-source="data" row-key="teamId" size="small" :pagination="false">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'team'">{{ record.teamName }} <UiStatusTag v-if="!record.active" tone="none">QMS 已停用</UiStatusTag></template>
          <template v-else-if="column.key === 'leader'">
            <a-select
              v-if="canEdit"
              :value="record.leaderId ?? undefined"
              allow-clear
              show-search
              option-filter-prop="label"
              placeholder="未设置"
              style="width: 100%"
              :options="userOptions"
              :loading="saving === record.teamId"
              :disabled="saving === record.teamId"
              @change="(v: unknown) => save(record as Row, (v as string | undefined) ?? null)"
            />
            <span v-else>{{ record.leaderName ?? '未设置' }}</span>
          </template>
          <template v-else-if="column.key === 'updated'"><span class="muted">{{ record.updatedAt ? `${timeText(record.updatedAt)} · ${record.updatedByName}` : '—' }}</span></template>
        </template>
      </a-table>
    </a-spin>
  </div>
</template>

<style scoped>
.muted { color: var(--ft-text-2); font-size: 12px; }
p.muted { margin-bottom: 12px; }
</style>
