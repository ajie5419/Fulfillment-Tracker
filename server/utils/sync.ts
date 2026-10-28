import type { H3Event } from 'h3'
import type { QmsSyncConfig } from '../services/sync/client'
import { qmsWorkOrderClient } from '../services/sync/write-client'

/**
 * QMS 同步配置：复用身份桥的 apiBase、clientId、clientSecret（同一组客户端凭据）。
 * NUXT_QMS_SYNC_ENABLED=0 时关闭；apiBase、clientId、clientSecret 任一为空也视为未配置（任务跳过、不报错）。
 */
export function qmsSyncConfig(event?: H3Event): QmsSyncConfig {
  const { qms } = useRuntimeConfig(event)
  const flag = String(qms.syncEnabled ?? '1').trim().toLowerCase()
  return {
    apiBase: qms.apiBase,
    clientId: qms.clientId,
    clientSecret: qms.clientSecret,
    enabled: !['0', 'false', 'off', 'no', ''].includes(flag),
  }
}

/** QMS 工单写接口客户端（同一组地址和凭据；不看同步开关） */
export function qmsWorkOrderApi(event?: H3Event) {
  return qmsWorkOrderClient(qmsSyncConfig(event))
}
