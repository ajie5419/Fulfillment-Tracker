import { z } from 'zod'

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export interface PageResult<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

/** 所有列表入口共用，拒绝数组、非整数和不安全的偏移。 */
const positiveInteger = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]).pipe(z.coerce.number().int().positive().safe())
export const paginationFields = {
  page: positiveInteger.default(1),
  pageSize: positiveInteger.pipe(z.number().max(MAX_PAGE_SIZE)).default(DEFAULT_PAGE_SIZE),
}

export function safePageOffset(value: { page: number; pageSize: number }, ctx: z.RefinementCtx) {
  if (!Number.isSafeInteger((value.page - 1) * value.pageSize)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['page'], message: '分页偏移量太大' })
  }
}

export const paginationSchema = z.object(paginationFields).superRefine(safePageOffset)
export type PageInput = z.input<typeof paginationSchema>
