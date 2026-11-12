/**
 * 7 个业务部门的编码 → 显示名：全仓唯一来源（前端 app/ 与服务端 server/ 共用，纯数据，不依赖任何运行时）。
 * 服务端从 server/services/auth/departments.ts 引用（那里另有 QMS 部门 → 业务部门的换算），前端用 #shared/business-depts。
 * 编码与 prisma schema 的 enum BusinessDept 一致（departments.ts 里有编译期校验）。
 * tests/unit/dept-names.test.ts 会扫 app/、server/，部门名称的字符串字面量只允许出现在这里（和演示数据）。
 */
export type BusinessDeptCode = 'TECH' | 'PROCESS' | 'PURCHASE' | 'PRODUCTION' | 'QUALITY' | 'FINANCE' | 'PROJECT'

/** Immutable historical aliases used only at external/legacy identity boundaries. */
const LEGACY_BUSINESS_DEPT_NAME: Readonly<Record<BusinessDeptCode, string>> = {
  TECH: '技术部',
  PROCESS: '工艺部',
  PURCHASE: '采购部',
  PRODUCTION: '生产部',
  QUALITY: '质量部',
  FINANCE: '财务部',
  PROJECT: '项目部',
}

/** Rename departments here; keep historical aliases above unchanged for existing identities. */
export const BUSINESS_DEPT_NAME: Readonly<Record<BusinessDeptCode, string>> = { ...LEGACY_BUSINESS_DEPT_NAME }

export const isBusinessDeptCode = (value: string | null | undefined): value is BusinessDeptCode =>
  !!value && Object.prototype.hasOwnProperty.call(BUSINESS_DEPT_NAME, value)

/** Unmapped QMS departments retain their historical identity until an explicit mapping exists. */
export function legacyBusinessDeptCode(name: string | null | undefined): BusinessDeptCode | null {
  return (Object.keys(LEGACY_BUSINESS_DEPT_NAME) as BusinessDeptCode[]).find(code => LEGACY_BUSINESS_DEPT_NAME[code] === name) ?? null
}

/** Persisted identities are codes; unknown legacy values remain visible for manual mapping. */
export const departmentLabel = (value: string | null | undefined): string =>
  isBusinessDeptCode(value) ? BUSINESS_DEPT_NAME[value] : value ?? ''

/** 下拉选项（项目部在前，与总计划节点的常见顺序一致） */
export const BUSINESS_DEPT_OPTIONS: { value: BusinessDeptCode; label: string }[] = (
  ['PROJECT', 'TECH', 'PROCESS', 'PURCHASE', 'PRODUCTION', 'QUALITY', 'FINANCE'] as const
).map((value) => ({ value, label: BUSINESS_DEPT_NAME[value] }))
