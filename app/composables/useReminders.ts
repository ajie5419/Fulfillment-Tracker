export interface ReminderItem {
  id: string
  title: string
  level: 'REMIND' | 'YELLOW' | 'RED'
  readAt: string | null
  createdAt: string
}

export function useReminders() {
  return useFetch<{ items: ReminderItem[]; unread: number }>('/api/reminders', { key: 'reminders' })
}
