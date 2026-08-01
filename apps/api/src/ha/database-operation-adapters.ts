import type { ResolvedConnection } from '../connections/connection-types.js'
import type { DatabaseOperationGate, DatabaseOperationPermit } from './database-operation-gate.js'

export function gateOperationGateway<T extends object>(target: T, gate: DatabaseOperationGate): T {
  return new Proxy(target, {
    get(original, property, receiver) {
      const value: unknown = Reflect.get(original, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const connection = connectionFrom(args)
        const externalSignal = findSignal(args)
        return gate.run(
          connection.id,
          async (signal) => await Reflect.apply(value, original, replaceSignals(args, signal)),
          externalSignal,
        )
      }
    },
  })
}

export function gateAsyncIterableGateway<T extends object>(target: T, gate: DatabaseOperationGate): T {
  return new Proxy(target, {
    get(original, property, receiver) {
      const value: unknown = Reflect.get(original, property, receiver)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      return (...args: unknown[]) => streamWithPermit(original, method, args, gate)
    },
  })
}

export function gateSessionFactory<T extends object>(target: T, gate: DatabaseOperationGate): T {
  return new Proxy(target, {
    get(original, property, receiver) {
      const value: unknown = Reflect.get(original, property, receiver)
      if (property !== 'open' || typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const connection = connectionFrom(args)
        const permit = await gate.enter(connection.id)
        try {
          const session: unknown = await Reflect.apply(value, original, args)
          if (!session || typeof session !== 'object') throw new TypeError('Invalid database session')
          return wrapSession(session, permit)
        } catch (error) {
          try { await permit.release() } catch { /* Preserve the open error. */ }
          throw error
        }
      }
    },
  })
}

async function* streamWithPermit(
  target: object,
  method: (...args: unknown[]) => unknown,
  args: unknown[],
  gate: DatabaseOperationGate,
): AsyncIterable<unknown> {
  const connection = connectionFrom(args)
  const permit = await gate.enter(connection.id, findSignal(args))
  let operationError: unknown
  let releaseError: unknown
  try {
    const iterable = Reflect.apply(method, target, replaceSignals(args, permit.signal))
    if (!isAsyncIterable(iterable)) throw new TypeError('Invalid database stream')
    for await (const value of iterable) {
      if (permit.signal.aborted) throw permit.signal.reason
      yield value
    }
    if (permit.signal.aborted) throw permit.signal.reason
  } catch (error) {
    operationError = error
  } finally {
    try { await permit.release() } catch (error) { releaseError = error }
  }
  if (operationError !== undefined) throw operationError
  if (releaseError !== undefined) throw releaseError
}

function wrapSession(session: object, permit: DatabaseOperationPermit): object {
  let closed = false
  return new Proxy(session, {
    get(original, property, receiver) {
      const value: unknown = Reflect.get(original, property, receiver)
      if (typeof value !== 'function') return value
      if (property === 'close') {
        return async () => {
          if (closed) return
          closed = true
          let closeError: unknown
          try { await Reflect.apply(value, original, []) } catch (error) { closeError = error }
          let releaseError: unknown
          try { await permit.release() } catch (error) { releaseError = error }
          if (closeError !== undefined) throw closeError
          if (releaseError !== undefined) throw releaseError
        }
      }
      return (...args: unknown[]) => Reflect.apply(value, original, replaceSignals(args, permit.signal))
    },
  })
}

function connectionFrom(args: unknown[]): ResolvedConnection {
  const connection = args[0]
  if (!connection || typeof connection !== 'object' || !('id' in connection)) {
    throw new TypeError('Database gateway requires a connection')
  }
  const id = Reflect.get(connection, 'id')
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Invalid database connection')
  return connection as ResolvedConnection
}

function findSignal(args: unknown[]): AbortSignal | undefined {
  for (const argument of args.slice(1)) {
    if (argument instanceof AbortSignal) return argument
    if (argument && typeof argument === 'object' && 'signal' in argument) {
      const signal = Reflect.get(argument, 'signal')
      if (signal instanceof AbortSignal) return signal
    }
  }
  return undefined
}

function replaceSignals(args: unknown[], signal: AbortSignal): unknown[] {
  return args.map((argument, index) => {
    if (index === 0) return argument
    if (argument instanceof AbortSignal) return AbortSignal.any([argument, signal])
    if (argument && typeof argument === 'object' && 'signal' in argument) {
      const existing = Reflect.get(argument, 'signal')
      if (existing instanceof AbortSignal) {
        return { ...argument, signal: AbortSignal.any([existing, signal]) }
      }
    }
    return argument
  })
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value
    && typeof value === 'object'
    && Symbol.asyncIterator in value
    && typeof Reflect.get(value, Symbol.asyncIterator) === 'function',
  )
}
