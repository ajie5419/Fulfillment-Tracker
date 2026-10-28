/** 业务规则不允许的操作。接口层统一转成 400，message 直接给用户看，所以写中文。 */
export class FlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowError'
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
  ) {
    super(message)
    this.name = 'FlowHttpError'
  }
}
