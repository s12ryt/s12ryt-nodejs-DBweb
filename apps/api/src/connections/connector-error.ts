export class DatabaseConnectionError extends Error {
  constructor() {
    super('DATABASE_CONNECTION_FAILED')
    this.name = 'DatabaseConnectionError'
  }
}
