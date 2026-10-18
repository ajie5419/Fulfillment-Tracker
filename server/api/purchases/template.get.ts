import { buildTemplate } from '../../services/purchases/import'

/** 下载采购行导入模板（.xlsx） */
export default defineFlowHandler(async (event) => {
  const buf = await buildTemplate()
  setResponseHeaders(event, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="purchase-template.xlsx"; filename*=UTF-8''${encodeURIComponent('关键物料导入模板.xlsx')}`,
    'cache-control': 'no-store',
  })
  return buf
})
