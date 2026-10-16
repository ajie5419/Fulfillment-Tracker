import { MAX_FILES_PER_REQUEST, MAX_UPLOAD_BYTES, saveUpload } from '../services/issues/uploads'

/** 整个请求体上限：3 张 × 8MB + 表单开销。超过直接 413，不读进内存 */
const MAX_REQUEST_BYTES = MAX_FILES_PER_REQUEST * MAX_UPLOAD_BYTES + 64 * 1024

/**
 * 上传异常照片（multipart/form-data，字段名 file，可多个，最多 3 张）。
 * 按文件头魔数只收 JPG/PNG/WebP，每张 ≤ 8MB；返回 upload_file 的 id，上报异常时带上。
 */
export default defineFlowHandler(async (event, user) => {
  // readMultipartFormData 会把整个请求体读进内存且不限大小：没有 Content-Length（分块传输）的一律拒绝
  const raw = getRequestHeader(event, 'content-length')
  const length = raw === undefined ? Number.NaN : Number(raw)
  if (!Number.isFinite(length)) throw createError({ statusCode: 411, statusMessage: 'Length Required', message: '缺少 Content-Length' })
  if (length > MAX_REQUEST_BYTES) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', message: '照片太大：每张不能超过 8MB，一次最多 3 张' })
  const parts = (await readMultipartFormData(event).catch(() => undefined)) ?? []
  const files = parts.filter((p) => p.name === 'file' && p.filename !== undefined)
  if (!files.length) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: '请选择照片' })
  if (files.length > MAX_FILES_PER_REQUEST) throw createError({ statusCode: 400, statusMessage: 'Bad Request', message: `一次最多上传 ${MAX_FILES_PER_REQUEST} 张` })
  const dir = useRuntimeConfig(event).uploadDir
  const saved = []
  for (const f of files) {
    const row = await saveUpload(dir, f.data, user.qmsUserId)
    saved.push({ id: row.id, mime: row.mime, size: row.size, url: `/api/files/${row.id}` })
  }
  return saved
})
