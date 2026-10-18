/**
 * BOM 从哪来：演示工具开着且是 DEMO- 工单时用演示 BOM（不连 QMS 也能试导入），其余实时读 QMS。
 * QMS 读取失败转成中文业务错误，页面直接提示。
 */
import { demoBom } from '../dev/demo'
import { FlowError } from '../flow/errors'
import type { QmsSyncConfig } from '../sync/client'
import { fetchWorkOrderBom, type QmsBomItem } from './client'

export async function loadWorkOrderBom(workOrderNumber: string, opts: { config: QmsSyncConfig; devTools: boolean }): Promise<QmsBomItem[]> {
  if (opts.devTools && workOrderNumber.startsWith('DEMO-')) return demoBom(workOrderNumber)
  try {
    return await fetchWorkOrderBom(opts.config, workOrderNumber)
  } catch (err) {
    throw new FlowError(`读取 QMS BOM 失败：${(err as Error).message}`)
  }
}
