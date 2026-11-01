/** 对象级权限的纯谓词：只接收普通字段，不加载角色、请求或数据库。 */
export function isProjectManagerOf(workOrders: ReadonlySet<string> | readonly string[] | undefined, workOrderNumber: string | null | undefined): boolean {
  if (!workOrderNumber || !workOrders) return false
  return 'has' in workOrders ? workOrders.has(workOrderNumber) : workOrders.includes(workOrderNumber)
}

export const isProjectManagerOperation = (op: string) => op === 'purchase' || op === 'payment' || op === 'route' || op === 'plan'

export const isObjectOwner = (userId: string, ownerId: string | null | undefined) => !!ownerId && ownerId === userId

export const leadsTeam = (teamIds: readonly string[] | undefined, teamId: string | null | undefined) => !!teamId && !!teamIds?.includes(teamId)

/** 外协的 supplierId 即使碰巧是班组也不算；仅自制工序可按班组授权。 */
export const leaderTeamOfStep = (step: { mode: string; supplierId: string | null }) => step.mode === 'SELF' ? step.supplierId : null

export interface StepActionTarget {
  workOrderNumber?: string | null
  ownerId?: string | null
  mode?: string | null
  supplierId?: string | null
  /** 只有开工、完工、报工是班组长操作，发出 / 返厂不是。 */
  leaderAction?: boolean
}

/** 前端携带原始工序字段；后端接口先用同一 leaderTeamOfStep 筛出 teamId，再用 leadsTeam。 */
export function canLeadStepAction(teamIds: readonly string[] | undefined, target: StepActionTarget): boolean {
  return !!target.leaderAction && leadsTeam(teamIds, leaderTeamOfStep({ mode: target.mode ?? '', supplierId: target.supplierId ?? null }))
}
