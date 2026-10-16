/** 业务规则不允许的操作。接口层统一转成 400，message 直接给用户看，所以写中文。 */
export class FlowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowError'
  }
}
