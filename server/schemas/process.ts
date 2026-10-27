/** 工艺模块（料单、工艺状态）接口的 zod 片段 */
import { z } from 'zod'

export const actionBody = z
  .object({
    kind: z.enum(['MATERIAL', 'PROCESS'], { message: '请选择料单或工艺' }),
    action: z.enum(['start', 'issue', 'revise', 'reset'], { message: '操作无效' }),
    note: z.string().trim().max(500, '备注最多 500 字').nullish(),
  })
  .strict()

export const listQuery = z.object({
  workOrderNumber: z.string().max(64).optional(),
  view: z.enum(['todo', 'waiting', 'drafting', 'revising', 'issued', 'all']).default('todo'),
  q: z.string().trim().max(100).optional(),
})
