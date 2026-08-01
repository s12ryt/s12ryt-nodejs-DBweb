import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('security pipeline', () => {
  it('blocks vulnerable dependencies and produces a CycloneDX SBOM', async () => {
    const workflow = await readFile('.github/workflows/security.yml', 'utf8')

    expect(workflow).toContain('pnpm audit --audit-level high')
    expect(workflow).toContain('@cyclonedx/cdxgen@12.8.2')
    expect(workflow).toContain('-t pnpm -o sbom.cdx.json')
    expect(workflow).toContain('sbom.cdx.json')
  })

  it('scans tracked history for secrets with a fixed scanner release', async () => {
    const workflow = await readFile('.github/workflows/security.yml', 'utf8')

    expect(workflow).toContain('ghcr.io/gitleaks/gitleaks:v8.30.1')
    expect(workflow).toContain('gitleaks:v8.30.1 git --redact')
    expect(workflow).toContain('fetch-depth: 0')
  })

  it('verifies the production container identity and read-only filesystem', async () => {
    const workflow = await readFile('.github/workflows/security.yml', 'utf8')

    expect(workflow).toContain('test "$(docker inspect')
    expect(workflow).toContain('--read-only')
    expect(workflow).toContain('--cap-drop ALL')
  })
})
