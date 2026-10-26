import { readUpload, XLSX_MIME } from '../../services/issues/uploads'

/**
 * 读取上传的照片 / 发放单附件：要求登录；已绑定异常或发放单的按所属工单 canSee 判断（发放单的接收人也能读），未绑定的只有上传人能读。
 * 无权与不存在一律 404。按库里记录的类型返回，禁止浏览器猜类型。
 */
export default defineFlowHandler(async (event, user) => {
  const scope = await getScope(event)
  const r = await readUpload(useRuntimeConfig(event).uploadDir, routeId(event), user.qmsUserId, (wo) => canSee(scope, wo))
  if (!r) throw createError({ statusCode: 404, statusMessage: 'Not Found', message: '文件不存在' })
  setResponseHeaders(event, {
    'Content-Type': r.file.mime,
    'Content-Length': String(r.data.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // 图片、PDF 在浏览器里直接看；BOM 表（Excel）下载
    'Content-Disposition': r.file.mime === XLSX_MIME ? `attachment; filename="BOM-${r.file.id.slice(0, 8)}.xlsx"` : 'inline',
  })
  return r.data
})
