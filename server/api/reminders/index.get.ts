import { listReminders } from '../../services/alerts/reminders'

/** 我的提醒：未读在前，附跳转地址（电脑端 link、手机端 mobileLink） */
export default defineEventHandler(async (event) => listReminders(requireUser(event).qmsUserId))
