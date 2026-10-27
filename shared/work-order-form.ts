/**
 * 新建工单弹窗（履约新建工单 10-27）的前端规则，纯函数便于单测：
 *   项目经理默认填当前登录用户（可改、可清空）；
 *   可见范围受限的人（/api/me 的 limited = resolveScope 返回 all:false，只看自己负责的工单）把项目经理改成别人或清空时，
 *   建好后自己就看不到这张工单，提交前要确认。
 */
export interface FormViewer {
  id: string
  limited: boolean
}

/** 新建时项目经理的默认值：当前登录用户；拿不到为 undefined */
export const defaultProjectManager = (me: Pick<FormViewer, 'id'> | null | undefined): string | undefined => me?.id || undefined

/** 建好后自己是否会看不到这张工单（拿不到当前用户时不提示） */
export function losesSightAfterCreate(me: FormViewer | null | undefined, projectManagerId: string | null | undefined): boolean {
  if (!me?.limited) return false
  return projectManagerId !== me.id
}
