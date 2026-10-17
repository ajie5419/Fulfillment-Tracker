/** 工序路线模板的请求体（多个路由共用） */
import { z } from 'zod'

export const templateBody = z
  .object({
    name: z.string().trim().min(1, '请填写模板名称').max(191),
    description: z.string().trim().max(2000).nullish(),
    steps: z
      .array(
        z
          .object({
            processId: z.string().min(1, '请选择工序').max(64),
            mode: z.enum(['SELF', 'IN_PLANT_OUTSOURCE', 'EXTERNAL_OUTSOURCE']),
            supplierId: z.string().max(64).nullish(),
            defaultDays: z.number().int().min(0).max(365).nullish(),
          })
          .strict(),
      )
      .min(1, '模板至少要有一道工序')
      .max(50),
  })
  .strict()
