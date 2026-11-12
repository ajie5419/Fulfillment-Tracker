/** Stable role identifiers and their labels are shared by settings and release recipients. */
export const NOTIFY_ROLE_TEXT = {
  OUTSOURCE_COORDINATOR: '外协专员',
  DEPT_HEAD: '部门负责人',
  PROJECT_DEPT_HEAD: '项目部负责人',
  LEADER: '分管领导',
  FINANCE: '财务',
} as const

export type NotifyRoleCode = keyof typeof NOTIFY_ROLE_TEXT

export const NOTIFY_ROLE_OPTIONS = (Object.keys(NOTIFY_ROLE_TEXT) as NotifyRoleCode[]).map(value => ({ value, label: NOTIFY_ROLE_TEXT[value] }))
