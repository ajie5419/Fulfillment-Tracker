import { z } from 'zod'
import { MAX_BYTES, MAX_FILES_PER_REQUEST, saveUpload } from '../services/issues/uploads'

/** 整个请求体上限：3 个 × 单个上限 + 表单开销。超过直接 413，不读进内存 */
const maxRequestBytes = (kind: keyof typeof MAX_BYTES) => MAX_FILES_PER_REQUEST * MAX_BYTES[kind] + 64 * 1024

const query = z.object({ kind: z.enum(['photo', 'attachment']).default('photo') })

/**
 * 上传异常照片或发放单附件（multipart/form-data，字段名 file，可多个，一次最多 3 个）。
 * ?kind=photo（默认）：按文件头魔数只收 JPG/PNG/WebP，每张 ≤ 8MB；?kind=attachment：另收 PDF，每个 ≤ 20MB。
 * 返回 upload_file 的 id，上报异常 / 建发放单时带上。
 */
export default defineFlowHandler(async (event, user) => {
  const { kind } = parseQuery(event, query)
  // readMultipartFormData 会把整个请求体读进内存且不限大小：没有 Content-Length（分块传输）的一律拒绝
  const raw = getRequestHeader(event, 'content-length')
  const length = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(length)) throw createError({ statusCode: 411, statusMessage: 'Length Required', message: '缺少 Content-Length' })
  if (length > maxRequestBytes(kind)) {
    const message = kind === 'photo' ? '照片太大：每张不能超过 8MB，一次最多 3 张' : '附件太大：每个不能超过 20MB，一次最多 3 个'
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message })
  }
  const parts = (await readMultipartFormData(event).catch(() => undefined)) ?? []
  const files = parts.filter((p) => p.name === 'file' && p.filename !== undefined)
  if (!files.length) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: kind === 'photo' ? '请选择照片' : '请选择附件' })
  if (files.length > MAX_FILES_PER_REQUEST) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: `一次最多上传 ${MAX_FILES_PER_REQUEST} 张` })
  const dir = useRuntimeConfig(event).uploadDir
  const saved = []
  for (const f of files) {
    const row = await saveUpload(dir, f.data, user.qmsUserId, kind)
    saved.push({ id: row.id, mime: row.mime, size: row.size, url: `/api/files/${row.id}` })
  }
  return saved
})
