import type { Duplex } from 'node:stream'

import type { SshTunnelPool } from '../ssh/ssh-tunnel-pool.js'
import type { ResolvedConnection } from './connection-types.js'

export interface DatabaseSocketProvider {
  open(connection: ResolvedConnection): Promise<Duplex | undefined>
}

export class TunnelDatabaseSocketProvider implements DatabaseSocketProvider {
  constructor(private readonly pool: Pick<SshTunnelPool, 'open'>) {}

  async open(connection: ResolvedConnection): Promise<Duplex | undefined> {
    if (!connection.ssh?.enabled) return undefined
    return this.pool.open({
      ssh: {
        host: connection.ssh.host,
        port: connection.ssh.port,
        username: connection.ssh.username,
        password: connection.ssh.password,
      },
      target: { host: connection.host, port: connection.port },
    })
  }
}
