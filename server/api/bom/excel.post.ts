import { z } from 'zod'
import { importTechBom, previewTechBom } from '../../services/bom/excel'

/** 整个请求体上限：5MB 文件 + 表单开销。超过直接 413，不读进内存 */
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
/** .xlsx 是 zip：文件头 PK\x03\x04 */
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

const fields = z
  .object({
    workOrderNumber: z.string().min(1).max(64),
    mode: z.enum(['preview', 'import']),
    /** 导入时勾选的图号（JSON 数组）；不传 = 全部可导入的 */
    drawingNos: z
      .string()
      .max(200000)
      .optional()
      .transform((s, ctx) => {
        if (s === undefined) return null
        try {
          return z.array(z.string().min(1).max(191)).max(2000).parse(JSON.parse(s))
        } catch {
          ctx.addIssue({ code: 'custom', message: '勾选的图号格式不对' })
          return z.NEVER
        }
      }),
  })
  .strict()

/**
 * 技术部 BOM Excel（CAD 导出）导入工件（multipart/form-data：file、workOrderNumber、mode、drawingNos）。
 * mode=preview 只读文件返回归类结果；mode=import 服务端重新读文件后建工件（整批一个事务）。
 * 生产部、外协专员、该工单项目经理、管理员。
 */
export default defineFlowHandler(async (event) => {
  const raw = getRequestHeader(event, 'content-length')
  const length = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(length)) throw createError({ statusCode: 411, statusMessage: 'Length Required', message: '缺少 Content-Length' })
  if (length > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '文件太大：不能超过 5MB' })
  const parts = (await readMultipartFormData(event).catch(() => undefined)) ?? []
  const files = parts.filter((p) => p.name === 'file' && p.filename !== undefined)
  if (files.length !== 1) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '请选择一个 Excel 文件' })
  const file = files[0]!
  if (!isZip(file.data)) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '只能导入 .xlsx 文件（.xls 请先用 Excel 另存为 .xlsx）' })
  const form: Record<string, string> = {}
  for (const p of parts) if (p.name && p.name !== 'file' && p.filename === undefined) form[p.name] = p.data.toString('utf8')
  const parsed = fields.safeParse(form)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: parsed.error.issues[0]?.message ?? '参数不对' })
  const { workOrderNumber, mode, drawingNos } = parsed.data
  await assertCanSee(event, workOrderNumber)
  await assertCanOperate(event, 'route', { workOrderNumber })
  return mode === 'preview' ? previewTechBom(workOrderNumber, file.data) : importTechBom(workOrderNumber, file.data, drawingNos)
})
