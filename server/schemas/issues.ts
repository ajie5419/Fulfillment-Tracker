/** 异常接口的 zod 片段 */
import { z } from 'zod'
import { day } from './flow'

export const category = z.enum(
  ['DESIGN', 'CHANGE', 'MATERIAL_PAYMENT', 'MATERIAL_MGMT', 'OUTSOURCE_SCHEDULE', 'OUTSOURCE_QUALITY', 'WORKSHOP', 'CUSTOMER', 'OTHER'],
  { message: '请选择分类' },
)

const note = z.string().trim().max(1000, '最多 1000 字')

export const assignFields = {
  responsibleDeptId: z.string().max(64).nullish(),
  responsibleUserId: z.string().max(64).nullish(),
  responsibleSupplierId: z.string().max(64).nullish(),
  dueDate: day.nullish(),
  note: note.nullish(),
}

export const noteBody = z.object({ note: note.min(1, '请填写内容') }).strict()
export const optionalNoteBody = z.object({ note: note.nullish() }).strict()

/** nullish 的字段：没传 = 不改（undefined），传 null = 清空 */
export function definedOnly<T extends Record<string, unknown>>(o: T) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}
