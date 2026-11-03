import type { BusinessErrorCode } from '../../../shared/errors'

/** 业务规则不允许的操作。可选 code 控制 HTTP 映射；无 code 时保留原来的 400。 */
export class FlowError extends Error {
  // QmsRejected 子类保留 QMS 原始 code 供服务层判断，接口边界再做业务码适配。
  readonly code: string | null | undefined
  constructor(message: string, code?: BusinessErrorCode) {
    super(message)
    this.name = 'FlowError'
    this.code = code
  }
}

/** 没有权限做这个操作（如不是责任人却要受理异常）。接口层转成 403 */
export class FlowForbidden extends FlowError {
  constructor(message: string) {
    super(message)
    this.name = 'FlowForbidden'
  }
}

/** 需要指定 HTTP 状态的业务错误（如 QMS 写接口透传的 404 / 409、连不上的 503）。接口层按 statusCode 返回，message 照样给用户看 */
export class FlowHttpError extends FlowError {
  constructor(
    message: string,
    readonly statusCode: number,
    code?: BusinessErrorCode,
    readonly data?: Record<string, unknown>,
  ) {
    super(message, code)
    this.name = 'FlowHttpError'
  }
}
