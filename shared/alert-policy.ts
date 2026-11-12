import type { AlertRuleKey } from './alert-rules'

/** Storage stays in hours; only the editing unit differs between rules. */
const REMINDER_UNIT: Record<AlertRuleKey, 'day' | 'hour' | null> = {
  W1: 'hour', W2: null, W3: 'day', W4: null, W5: 'hour', W6: 'day',
  W7: 'day', W8: null, W9: 'day', W10: 'day', W11: null,
}
const HOURS_PER_DAY = 24
export const alertReminderUnit = (rule: AlertRuleKey) => REMINDER_UNIT[rule]
export function alertReminderFromHours(rule: AlertRuleKey, hours: number | null) {
  if (hours == null || REMINDER_UNIT[rule] == null) return null
  return REMINDER_UNIT[rule] === 'day' ? hours / HOURS_PER_DAY : hours
}
export function alertReminderToHours(rule: AlertRuleKey, value: number | null) {
  if (value == null || REMINDER_UNIT[rule] == null) return null
  return REMINDER_UNIT[rule] === 'day' ? Math.round(value * HOURS_PER_DAY) : value
}
export function alertThresholdError(rule: AlertRuleKey, threshold: { remindHours: number | null; yellowDays: number; redDays: number }): string | null {
  if (rule === 'W8') {
    if (threshold.yellowDays < threshold.redDays) return 'W8 黄色的提前天数不能小于红色'
  } else if (threshold.redDays < threshold.yellowDays) return '红色阈值不能小于黄色阈值'
  if (REMINDER_UNIT[rule] != null && threshold.remindHours == null) return `${rule} 必须设置提醒阈值`
  return null
}
