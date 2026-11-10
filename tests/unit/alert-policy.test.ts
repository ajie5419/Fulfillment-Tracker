import { describe, expect, it } from 'vitest'
import { ALERT_RULES } from '../../shared/alert-rules'
import { alertReminderFromHours, alertReminderToHours, alertReminderUnit, alertThresholdError } from '../../shared/alert-policy'

describe('shared alert editing policy', () => {
  it.each(['W3', 'W6', 'W7', 'W9', 'W10'] as const)('%s keeps fractional-day edits in stored hours', (rule) => {
    expect(alertReminderFromHours(rule, 36)).toBe(1.5)
    expect(alertReminderToHours(rule, 1.5)).toBe(36)
  })
  it.each(['W2', 'W4', 'W8', 'W11'] as const)('%s cannot retain a stale reminder value', (rule) => {
    expect(alertReminderUnit(rule)).toBeNull()
    expect(alertReminderFromHours(rule, 48)).toBeNull()
    expect(alertReminderToHours(rule, 2)).toBeNull()
    expect(alertThresholdError(rule, { remindHours: null, yellowDays: 2, redDays: 2 })).toBeNull()
  })
  it('uses reversed thresholds only for an advance warning before the demand date', () => {
    expect(alertThresholdError('W8', { remindHours: null, yellowDays: 7, redDays: 3 })).toBeNull()
    expect(alertThresholdError('W8', { remindHours: null, yellowDays: 3, redDays: 7 })).toContain('提前天数')
    expect(alertThresholdError('W7', { remindHours: 48, yellowDays: 7, redDays: 3 })).toContain('红色阈值')
  })
  it('requires reminders for every rule whose editor exposes a reminder field', () => {
    for (const rule of ALERT_RULES.filter(rule => alertReminderUnit(rule) !== null)) {
      expect(alertThresholdError(rule, { remindHours: null, yellowDays: 1, redDays: 2 })).toContain('必须设置提醒')
    }
    expect(alertReminderToHours('W1', 6)).toBe(6)
    expect(alertReminderFromHours('W5', 12)).toBe(12)
  })
})
