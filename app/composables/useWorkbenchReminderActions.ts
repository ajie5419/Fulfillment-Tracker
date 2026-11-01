import { ref } from 'vue'
import type { DigestItem, PinnedItem, ReminderItem } from './useReminders'

/** 工作台提醒的打开 / 已读动作（pages/index.vue 拆分）：点开标已读并跳转、置顶故障、每日汇总展开、全部已读。 */
export function useWorkbenchReminderActions(digest: () => DigestItem | null | undefined) {
  /** 点一条：标记已读，跳到关联对象 */
  async function openReminder(item: ReminderItem) {
    await readReminder(item)
    if (item.link) await navigateTo(item.link)
  }
  /** 置顶的同步失败提醒：标为已读后去设置页看同步状态 */
  async function openPinned(p: PinnedItem) {
    await readDigest(p)
    await navigateTo(p.link)
  }
  const digestOpen = ref(false)
  async function openDigest() {
    digestOpen.value = !digestOpen.value
    const d = digest()
    if (d) await readDigest(d)
  }
  async function readAll() {
    try {
      await readAllReminders()
    } catch (e) {
      message.error(apiError(e))
    }
  }

  return { openReminder, openPinned, digestOpen, openDigest, readAll }
}
