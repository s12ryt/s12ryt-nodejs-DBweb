export class NativeAccountGatewayError extends Error {
  constructor(readonly code: 'NATIVE_ACCOUNT_FAILED') {
    super(code)
    this.name = 'NativeAccountGatewayError'
  }
}
