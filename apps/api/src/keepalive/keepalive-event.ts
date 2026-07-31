import { randomUUID } from 'node:crypto'

import type {
  KeepAliveEvent,
  KeepAliveRecorder,
  KeepAliveStatus,
} from './sql-keepalive-service.js'

export interface StoredKeepAliveEvent {
  id: string
  connectionId: string
  status: KeepAliveStatus
  durationMs: number
  createdAt: string
  expiresAt: string
}

export interface KeepAliveEventRepository {
  create(event: StoredKeepAliveEvent): Promise<void>
  deleteExpired(now: string): Promise<number>
}

export class RetainedKeepAliveRecorder implements KeepAliveRecorder {
  constructor(
    private readonly repository: KeepAliveEventRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(event: KeepAliveEvent): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + 90 * 24 * 60 * 60_000).toISOString()
    await this.repository.create({
      id: randomUUID(),
      ...event,
      expiresAt,
    })
  }

  async purgeExpired(): Promise<number> {
    return this.repository.deleteExpired(this.now().toISOString())
  }
}
