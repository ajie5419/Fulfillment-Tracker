import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../shared/pagination'

/** Reject ambiguous query values instead of silently falling back to page one. */
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
