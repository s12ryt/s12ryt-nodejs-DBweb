import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('HA deployment configuration', () => {
  it('defines three API instances with shared dependencies and distinct PostgreSQL-backed roles', async () => {
    const compose = await readFile('compose.ha.yaml', 'utf8')

    expect(compose).toContain('api-1:')
    expect(compose).toContain('api-2:')
    expect(compose).toContain('api-3:')
    expect(compose).toContain('DBWEB_HA_INSTANCE_ID: api-1')
    expect(compose).toContain('DBWEB_HA_INSTANCE_ID: api-2')
    expect(compose).toContain('DBWEB_HA_INSTANCE_ID: api-3')
    expect(compose).toContain('DBWEB_METADATA_URL: postgres://')
    expect(compose).toContain('DBWEB_REDIS_URL: redis://')
    expect(compose).toContain('DBWEB_S3_ENDPOINT: http://minio:9000')
    expect(compose).toContain('haproxy:')
  })

  it('routes only ready active instances so standby promotion enters traffic automatically', async () => {
    const proxy = await readFile('deploy/haproxy.cfg', 'utf8')

    expect(proxy).toContain('option httpchk GET /api/health/ready')
    expect(proxy).toContain('server api-1 api-1:3000 check')
    expect(proxy).toContain('server api-2 api-2:3000 check')
    expect(proxy).toContain('server api-3 api-3:3000 check')
  })

  it('validates the HA compose topology in CI', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8')

    expect(workflow).toContain('docker compose --file compose.ha.yaml config')
  })
})
