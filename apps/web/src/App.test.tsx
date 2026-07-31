// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App } from './App.js'

describe('DBWeb application shell', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('offers a Traditional Chinese login and switches to English', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const user = userEvent.setup()

    render(<App />)

    expect(await screen.findByRole('heading', { name: '登入 DBWeb' })).toBeVisible()
    expect(screen.getByLabelText('使用者名稱')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByRole('heading', { name: 'Sign in to DBWeb' })).toBeVisible()
    expect(screen.getByLabelText('Username')).toBeVisible()
  })

  it('uses the selected language in the authenticated empty workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/api/auth/me') return Response.json(authenticatedSession)
      return Response.json([])
    }))
    const user = userEvent.setup()

    render(<App />)
    expect(await screen.findByRole('heading', { name: '連線工作台' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'English' }))

    expect(screen.getByRole('heading', { name: 'Connection workbench' })).toBeVisible()
  })

  it('logs in and loads the connection workbench', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
          csrfToken: 'csrf-token',
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            id: 'connection-1',
            name: 'Primary PostgreSQL',
            engine: 'postgres',
            host: 'db.internal',
            port: 5432,
            database: 'inventory',
            username: 'dbweb',
            tls: { mode: 'verify-full', hasCa: true, hasClientCertificate: false },
            keepAlive: { enabled: true, intervalMs: 300000 },
            createdBy: 'admin-1',
            createdAt: new Date().toISOString(),
          },
        ]),
      )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<App />)
    await screen.findByRole('heading', { name: '登入 DBWeb' })
    await user.type(screen.getByLabelText('使用者名稱'), 'admin')
    await user.type(screen.getByLabelText('密碼'), 'a-secure-password')
    await user.click(screen.getByRole('button', { name: '登入' }))

    expect(await screen.findByText('Primary PostgreSQL')).toBeVisible()
    expect(screen.getByRole('heading', { name: '連線工作台' })).toBeVisible()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/connections', expect.objectContaining({ credentials: 'include' }))
    })
  })

  it('selects a connection and browses table rows without reloading the connection list', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json(['public'])
      if (url.endsWith('/tables')) return Response.json([{ schema: 'public', name: 'products', type: 'table' }])
      if (url.endsWith('/columns')) return Response.json([{ name: 'id', dataType: 'integer', nullable: false, primaryKey: true }])
      if (url.includes('/rows?')) return Response.json({ columns: ['id', 'name'], rows: [{ id: 7, name: 'Keyboard' }], nextOffset: null })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))

    expect(await screen.findByText('Keyboard')).toBeVisible()
    expect(screen.getByRole('button', { name: /products/ })).toBeVisible()
    expect(calls.filter((url) => url === '/api/connections')).toHaveLength(1)
  })

  it('requires confirmation before submitting high-risk SQL', async () => {
    let queryAttempts = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url === '/api/queries') {
        queryAttempts += 1
        const body = JSON.parse(String(init?.body)) as { confirmedHighRisk?: boolean }
        if (!body.confirmedHighRisk) {
          return Response.json({ error: { code: 'CONFIRMATION_REQUIRED', message: '高風險 SQL 需要二次確認' } }, { status: 409 })
        }
        return Response.json({ columns: [], rows: [], affectedRows: 1, truncated: false, durationMs: 12 })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    await user.click(screen.getByRole('tab', { name: 'SQL 查詢' }))
    const editor = screen.getByLabelText('SQL 查詢')
    await user.clear(editor)
    await user.type(editor, 'DROP TABLE products;')
    await user.click(screen.getByRole('button', { name: '執行' }))

    const dialog = await screen.findByRole('dialog', { name: '確認高風險 SQL' })
    expect(dialog).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: '執行' }))
    expect(await screen.findByText('影響列數')).toBeVisible()
    expect(queryAttempts).toBe(2)
  })

  it('creates an SSH tunnel connection without exposing its password afterward', async () => {
    let createdBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections' && init?.method === 'POST') {
        createdBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return Response.json({ ...connection, ssh: { enabled: true, host: 'ssh.example.test', port: 2222, username: 'operator' } }, { status: 201 })
      }
      if (url === '/api/connections') return Response.json([])
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: '新增連線' }))
    const dialog = screen.getByRole('dialog', { name: '新增連線' })
    await user.type(within(dialog).getByLabelText('名稱'), 'Remote')
    await user.type(within(dialog).getByLabelText('資料庫'), 'inventory')
    await user.type(within(dialog).getByLabelText('使用者名稱'), 'reader')
    await user.click(within(dialog).getByLabelText('SSH Tunnel'))
    await user.clear(within(dialog).getByLabelText('SSH 主機'))
    await user.type(within(dialog).getByLabelText('SSH 主機'), 'ssh.example.test')
    await user.clear(within(dialog).getByLabelText('SSH 連接埠'))
    await user.type(within(dialog).getByLabelText('SSH 連接埠'), '2222')
    await user.type(within(dialog).getByLabelText('SSH 使用者名稱'), 'operator')
    await user.type(within(dialog).getByLabelText('SSH 密碼'), 'ssh-secret')
    await user.click(within(dialog).getByRole('button', { name: '儲存' }))

    await waitFor(() => expect(createdBody).toMatchObject({
      ssh: { enabled: true, host: 'ssh.example.test', port: 2222, username: 'operator', password: 'ssh-secret' },
    }))
    expect(document.body.textContent).not.toContain('ssh-secret')
  })

  it('shows SSH state and requires confirmation before resetting the shared TOFU pin', async () => {
    let resetBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([sshConnection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url === '/api/ssh/known-hosts/reset') {
        resetBody = JSON.parse(String(init?.body))
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Remote PostgreSQL'))
    expect(screen.getByText('PG / SSH')).toBeVisible()
    expect(screen.getByText('operator@ssh.example.test:2222')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重設 SSH 主機金鑰' }))
    const dialog = screen.getByRole('dialog', { name: '重設 SSH 主機金鑰' })
    await user.click(within(dialog).getByRole('button', { name: '重設' }))

    await waitFor(() => expect(resetBody).toEqual({ host: 'ssh.example.test', port: 2222 }))
  })
})

const authenticatedSession = {
  user: { id: 'admin-1', username: 'admin', role: 'admin' as const },
  csrfToken: 'csrf-token',
}

const connection = {
  id: 'connection-1',
  name: 'Primary PostgreSQL',
  engine: 'postgres' as const,
  host: 'db.internal',
  port: 5432,
  database: 'inventory',
  username: 'dbweb',
  tls: { mode: 'verify-full', hasCa: true, hasClientCertificate: false },
  keepAlive: { enabled: true, intervalMs: 300000 },
  createdBy: 'admin-1',
  createdAt: new Date().toISOString(),
}

const sshConnection = {
  ...connection,
  name: 'Remote PostgreSQL',
  ssh: { enabled: true as const, host: 'ssh.example.test', port: 2222, username: 'operator' },
}
