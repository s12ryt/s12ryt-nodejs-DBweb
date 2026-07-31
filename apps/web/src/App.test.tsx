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

  it('requires a temporary-password user to change their password before entering the workbench', async () => {
    const requests: Array<{ url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      })
      if (url === '/api/auth/me') return Response.json(passwordChangeSession)
      if (url === '/api/auth/change-password') return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    expect(await screen.findByRole('heading', { name: '變更密碼' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: '連線工作台' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('目前密碼'), 'temporary password 123')
    await user.type(screen.getByLabelText('新密碼'), 'new operator password 456')
    await user.click(screen.getByRole('button', { name: '變更密碼' }))

    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/auth/change-password',
      body: { currentPassword: 'temporary password 123', newPassword: 'new operator password 456' },
    }))
    expect(await screen.findByRole('heading', { name: '登入 DBWeb' })).toBeVisible()
  })

  it('creates a managed user and shows the generated temporary password once', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([])
      if (url === '/api/users' && (init?.method ?? 'GET') === 'GET') {
        return Response.json([authenticatedSession.user])
      }
      if (url === '/api/users') return Response.json({
        user: { id: 'user-2', username: 'reader', role: 'user', enabled: true, passwordChangeRequired: true },
        temporaryPassword: 'generated-password-1',
      }, { status: 201 })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: '使用者與權限' }))
    await user.click(screen.getByRole('button', { name: '建立使用者' }))
    await user.type(screen.getByLabelText('使用者名稱'), 'reader')
    await user.click(screen.getByRole('button', { name: '建立' }))

    expect(await screen.findByText('generated-password-1')).toBeVisible()
    expect(screen.getByText('此密碼只顯示一次')).toBeVisible()
  })

  it('manages user state, role, password reset, and confirmed deletion', async () => {
    const commands: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([])
      if (url === '/api/users' && method === 'GET') return Response.json([authenticatedSession.user, managedReader])
      if (url.endsWith('/access')) return Response.json([])
      if (method !== 'GET') commands.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) })
      if (method === 'PATCH') return Response.json({ ...managedReader, ...(init?.body ? JSON.parse(String(init.body)) as object : {}) })
      if (url.endsWith('/reset-password')) return Response.json({ user: { ...managedReader, passwordChangeRequired: true }, temporaryPassword: 'reset-password-value' })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: '使用者與權限' }))
    await user.click(await screen.findByRole('button', { name: 'reader' }))
    await user.click(screen.getByRole('checkbox', { name: '啟用帳號' }))
    await user.selectOptions(screen.getByLabelText('角色'), 'admin')
    await user.click(screen.getByRole('button', { name: '重設密碼' }))
    expect(await screen.findByText('reset-password-value')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '永久刪除' }))
    await user.click(within(screen.getByRole('dialog', { name: '確認刪除使用者' })).getByRole('button', { name: '刪除' }))

    await waitFor(() => expect(commands).toEqual(expect.arrayContaining([
      { method: 'PATCH', url: '/api/users/user-2', body: { enabled: false } },
      { method: 'PATCH', url: '/api/users/user-2', body: { role: 'admin' } },
      { method: 'POST', url: '/api/users/user-2/reset-password', body: {} },
      { method: 'DELETE', url: '/api/users/user-2', body: { confirmed: true } },
    ])))
  })

  it('reads, updates, and revokes all six per-connection capabilities', async () => {
    const commands: Array<{ method: string; url: string; body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url === '/api/users') return Response.json([authenticatedSession.user, managedReader])
      if (url === '/api/users/user-2/access') return Response.json([{ userId: 'user-2', connectionId: connection.id, capabilities: ['structure-read', 'query-read'] }])
      if (method === 'PUT' || method === 'DELETE') commands.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) })
      if (method === 'PUT') return Response.json({ userId: 'user-2', connectionId: connection.id, capabilities: ['structure-read', 'data-read', 'data-write', 'account-manage'] })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByRole('button', { name: '使用者與權限' }))
    await user.click(await screen.findByRole('button', { name: 'reader' }))
    expect(await screen.findByRole('checkbox', { name: '查詢唯讀' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: '資料寫入' }))
    await user.click(screen.getByRole('checkbox', { name: '帳號管理' }))
    await user.click(screen.getByRole('button', { name: '儲存連線權限' }))
    await user.click(screen.getByRole('button', { name: '撤銷連線權限' }))

    expect(commands).toEqual([
      {
        method: 'PUT', url: '/api/users/user-2/connections/connection-1/access',
        body: { capabilities: ['structure-read', 'query-read', 'data-write', 'account-manage'] },
      },
      { method: 'DELETE', url: '/api/users/user-2/connections/connection-1/access' },
    ])
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

  it('creates, updates, and confirms deletion of rows with tagged values', async () => {
    const mutationBodies: unknown[] = []
    let rowLoads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json(['public'])
      if (url.endsWith('/tables')) return Response.json([{ schema: 'public', name: 'products', type: 'table' }])
      if (url.endsWith('/columns')) return Response.json([{ name: 'id', dataType: 'integer', nullable: false, primaryKey: true }])
      if (url.includes('/rows?')) {
        rowLoads += 1
        return Response.json({ columns: ['id', 'name', 'price'], rows: [{ id: 7, name: 'Keyboard', price: '49.90' }], nextOffset: null })
      }
      if (url.endsWith('/mutations') && init?.method !== 'POST') return Response.json(productMutationInspection)
      if (url.endsWith('/mutations') && init?.method === 'POST') {
        mutationBodies.push(JSON.parse(String(init.body)))
        return Response.json({ affectedRows: 1, items: [{ index: 0, affectedRows: 1 }] })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    expect(await screen.findByText('Keyboard')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '新增資料列' }))
    let dialog = screen.getByRole('dialog', { name: '新增資料列' })
    await user.type(within(dialog).getByLabelText('name'), 'Mouse')
    await user.type(within(dialog).getByLabelText('price'), '19.95')
    await user.click(within(dialog).getByRole('button', { name: '儲存' }))

    await user.click(await screen.findByRole('button', { name: '編輯資料列 7' }))
    dialog = screen.getByRole('dialog', { name: '編輯資料列' })
    await user.click(within(dialog).getByLabelText('變更 name'))
    await user.clear(within(dialog).getByRole('textbox', { name: 'name' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'name' }), 'Keyboard Pro')
    await user.click(within(dialog).getByRole('button', { name: '儲存' }))

    await user.click(await screen.findByRole('button', { name: '刪除資料列 7' }))
    dialog = screen.getByRole('dialog', { name: '刪除資料列' })
    await user.click(within(dialog).getByRole('button', { name: '刪除' }))

    await waitFor(() => expect(mutationBodies).toHaveLength(3))
    expect(mutationBodies[0]).toEqual({ operations: [{ kind: 'insert', values: { name: { kind: 'value', type: 'string', value: 'Mouse' }, price: { kind: 'value', type: 'decimal', value: '19.95' } } }] })
    expect(mutationBodies[1]).toEqual({ operations: [{ kind: 'update', identity: { id: { kind: 'value', type: 'number', value: 7 } }, original: productOriginal, patch: { name: { kind: 'value', type: 'string', value: 'Keyboard Pro' } } }] })
    expect(mutationBodies[2]).toEqual({ operations: [{ kind: 'delete', identity: { id: { kind: 'value', type: 'number', value: 7 } }, original: productOriginal, confirmed: true }] })
    expect(rowLoads).toBeGreaterThanOrEqual(4)
  })

  it('applies one patch to selected rows as a single batch operation', async () => {
    let mutationBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json(['public'])
      if (url.endsWith('/tables')) return Response.json([{ schema: 'public', name: 'products', type: 'table' }])
      if (url.endsWith('/columns')) return Response.json([])
      if (url.includes('/rows?')) return Response.json({ columns: ['id', 'name', 'price'], rows: [{ id: 7, name: 'Keyboard', price: '49.90' }, { id: 8, name: 'Mouse', price: '19.95' }], nextOffset: null })
      if (url.endsWith('/mutations') && init?.method !== 'POST') return Response.json(productMutationInspection)
      if (url.endsWith('/mutations') && init?.method === 'POST') {
        mutationBody = JSON.parse(String(init.body))
        return Response.json({ affectedRows: 2, items: [{ index: 0, affectedRows: 1 }, { index: 1, affectedRows: 1 }] })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    await user.click(await screen.findByRole('checkbox', { name: '選取資料列 7' }))
    await user.click(screen.getByRole('checkbox', { name: '選取資料列 8' }))
    await user.click(screen.getByRole('button', { name: '批次編輯 2 列' }))
    const dialog = screen.getByRole('dialog', { name: '批次編輯' })
    await user.click(within(dialog).getByLabelText('變更 price'))
    await user.clear(within(dialog).getByRole('textbox', { name: 'price' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'price' }), '39.00')
    await user.click(within(dialog).getByRole('button', { name: '儲存' }))

    await waitFor(() => expect(mutationBody).toEqual({ operations: [{ kind: 'batch-update', rows: [
      { identity: { id: { kind: 'value', type: 'number', value: 7 } }, original: productOriginal },
      { identity: { id: { kind: 'value', type: 'number', value: 8 } }, original: { id: { kind: 'value', type: 'number', value: 8 }, name: { kind: 'value', type: 'string', value: 'Mouse' }, price: { kind: 'value', type: 'decimal', value: '19.95' } } },
    ], patch: { price: { kind: 'value', type: 'decimal', value: '39.00' } } }] }))
  })

  it('removes stale mutation controls immediately when switching tables', async () => {
    let resolveLogsInspection: ((response: Response) => void) | undefined
    const logsInspection = new Promise<Response>((resolve) => { resolveLogsInspection = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json(['public'])
      if (url.endsWith('/tables')) return Response.json([{ schema: 'public', name: 'products', type: 'table' }, { schema: 'public', name: 'logs', type: 'table' }])
      if (url.includes('/logs/mutations')) return logsInspection
      if (url.endsWith('/mutations')) return Response.json(productMutationInspection)
      if (url.endsWith('/columns')) return Response.json([])
      if (url.includes('/rows?')) return Response.json({ columns: [], rows: [], nextOffset: null })
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    expect(await screen.findByRole('button', { name: '新增資料列' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: /logs/ }))
    expect(screen.queryByRole('button', { name: '新增資料列' })).not.toBeInTheDocument()
    resolveLogsInspection?.(Response.json(productMutationInspection))
  })

  it('creates a table from live DDL capabilities and confirms destructive DDL', async () => {
    const ddlBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url.endsWith('/ddl/capabilities')) return Response.json(postgresDdlCapabilities)
      if (url.endsWith('/ddl/execute')) {
        ddlBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ statementsExecuted: 1, transactional: true })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    await user.click(screen.getByRole('tab', { name: '結構' }))
    expect(await screen.findByText('PostgreSQL 17.5.0')).toBeVisible()

    await user.selectOptions(screen.getByLabelText('DDL 操作'), 'create-table')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('資料表名稱'), 'orders')
    await user.type(screen.getByLabelText('欄位名稱'), 'id')
    await user.selectOptions(screen.getByLabelText('欄位型別'), 'bigint')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))

    await user.selectOptions(screen.getByLabelText('DDL 操作'), 'drop-table')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('資料表名稱'), 'orders')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))
    const dialog = screen.getByRole('dialog', { name: '確認結構變更' })
    await user.click(within(dialog).getByRole('button', { name: '刪除' }))

    await waitFor(() => expect(ddlBodies).toEqual([
      { command: {
        kind: 'create-table', schema: 'public', name: 'orders',
        columns: [{ name: 'id', type: { name: 'bigint' }, nullable: false }],
      } },
      { command: { kind: 'drop-table', schema: 'public', name: 'orders', confirmed: true } },
    ]))
  })

  it('builds column, index, and constraint commands from the complete core DDL action set', async () => {
    const ddlBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url.endsWith('/ddl/capabilities')) return Response.json(postgresDdlCapabilities)
      if (url.endsWith('/ddl/execute')) {
        ddlBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ statementsExecuted: 1, transactional: true })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    await user.click(screen.getByRole('tab', { name: '結構' }))
    await screen.findByText('PostgreSQL 17.5.0')
    const actions = screen.getByLabelText('DDL 操作')
    expect(within(actions).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(expect.arrayContaining([
      '', 'create-database', 'rename-database', 'drop-database',
      'create-schema', 'rename-schema', 'drop-schema',
      'create-table', 'rename-table', 'drop-table',
      'add-column', 'rename-column', 'drop-column',
      'create-index', 'drop-index', 'add-constraint', 'drop-constraint',
    ]))

    await user.selectOptions(actions, 'add-column')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('資料表名稱'), 'orders')
    await user.type(screen.getByLabelText('欄位名稱'), 'total')
    await user.selectOptions(screen.getByLabelText('欄位型別'), 'bigint')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))

    await user.selectOptions(screen.getByLabelText('DDL 操作'), 'create-index')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('資料表名稱'), 'orders')
    await user.type(screen.getByLabelText('索引名稱'), 'orders_total_idx')
    await user.type(screen.getByLabelText('索引欄位'), 'total')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))

    await user.selectOptions(screen.getByLabelText('DDL 操作'), 'add-constraint')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('資料表名稱'), 'orders')
    await user.type(screen.getByLabelText('約束名稱'), 'orders_number_key')
    await user.selectOptions(screen.getByLabelText('約束類型'), 'unique')
    await user.type(screen.getByLabelText('約束欄位'), 'number')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))

    await waitFor(() => expect(ddlBodies).toEqual([
      { command: { kind: 'add-column', schema: 'public', table: 'orders', column: { name: 'total', type: { name: 'bigint' }, nullable: false } } },
      { command: { kind: 'create-index', schema: 'public', table: 'orders', name: 'orders_total_idx', method: 'btree', unique: false, parts: [{ column: 'total' }], confirmed: false } },
      { command: { kind: 'add-constraint', schema: 'public', table: 'orders', name: 'orders_number_key', constraint: { kind: 'unique', columns: ['number'] }, confirmed: false } },
    ]))
  })

  it('exposes advanced DDL actions and confirms PostgreSQL function source', async () => {
    const ddlBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([connection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url.endsWith('/ddl/capabilities')) return Response.json(postgres96DdlCapabilities)
      if (url.endsWith('/ddl/execute')) {
        ddlBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ statementsExecuted: 1, transactional: true })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary PostgreSQL'))
    await user.click(screen.getByRole('tab', { name: '結構' }))
    await screen.findByText('PostgreSQL 9.6.24')
    const actions = screen.getByLabelText('DDL 操作')
    const values = within(actions).getAllByRole('option').map((option) => option.getAttribute('value'))
    expect(values).toEqual(expect.arrayContaining([
      'create-view', 'drop-view', 'create-materialized-view', 'refresh-materialized-view',
      'drop-materialized-view', 'create-sequence', 'drop-sequence', 'create-enum',
      'create-domain', 'drop-type', 'create-extension', 'drop-extension',
      'create-routine', 'drop-routine', 'create-trigger', 'drop-trigger',
      'create-event', 'drop-event', 'create-partition', 'drop-partition',
    ]))
    expect(within(actions).getByRole('option', { name: '建立事件' })).toBeDisabled()

    await user.selectOptions(actions, 'create-routine')
    expect(screen.getByRole('option', { name: 'procedure' })).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Routine 類型'), 'function')
    await user.type(screen.getByLabelText('Schema 名稱'), 'public')
    await user.type(screen.getByLabelText('名稱'), 'mask_email')
    await user.type(screen.getByLabelText('回傳型別'), 'text')
    await user.selectOptions(screen.getByLabelText('語言'), 'sql')
    await user.type(screen.getByLabelText('程式碼原文'), "SELECT 'masked'")
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))
    const dialog = screen.getByRole('dialog', { name: '確認結構變更' })
    await user.click(within(dialog).getByRole('button', { name: '刪除' }))

    await waitFor(() => expect(ddlBodies).toEqual([{ command: {
      kind: 'create-routine', routineKind: 'function', schema: 'public', name: 'mask_email',
      arguments: [], returns: { name: 'text' }, language: 'sql', body: "SELECT 'masked'",
      confirmed: true,
    } }]))
  })

  it('builds MySQL functions with replication-safe routine characteristics', async () => {
    const ddlBodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return Response.json(authenticatedSession)
      if (url === '/api/connections') return Response.json([mysqlConnection])
      if (url.endsWith('/schemas')) return Response.json([])
      if (url.endsWith('/ddl/capabilities')) return Response.json(mysql84DdlCapabilities)
      if (url.endsWith('/ddl/execute')) {
        ddlBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ statementsExecuted: 1, transactional: false })
      }
      return new Response(null, { status: 404 })
    }))
    const user = userEvent.setup()

    render(<App />)
    await user.click(await screen.findByText('Primary MySQL'))
    await user.click(screen.getByRole('tab', { name: '結構' }))
    await screen.findByText('MySQL 8.4.6')
    await user.selectOptions(screen.getByLabelText('DDL 操作'), 'create-routine')
    await user.selectOptions(screen.getByLabelText('Routine 類型'), 'function')
    await user.type(screen.getByLabelText('Schema 名稱'), 'inventory')
    await user.type(screen.getByLabelText('名稱'), 'constant_value')
    await user.type(screen.getByLabelText('回傳型別'), 'int')
    await user.click(screen.getByLabelText('確定性'))
    await user.selectOptions(screen.getByLabelText('資料存取'), 'no-sql')
    await user.type(screen.getByLabelText('程式碼原文'), 'RETURN 7')
    await user.click(screen.getByRole('button', { name: '執行 DDL' }))
    await user.click(within(screen.getByRole('dialog', { name: '確認結構變更' })).getByRole('button', { name: '刪除' }))

    await waitFor(() => expect(ddlBodies).toEqual([{ command: {
      kind: 'create-routine', routineKind: 'function', schema: 'inventory', name: 'constant_value',
      arguments: [], returns: { name: 'int' }, body: 'RETURN 7', deterministic: true,
      dataAccess: 'no-sql', confirmed: true,
    } }]))
  })
})

const authenticatedSession = {
  user: { id: 'admin-1', username: 'admin', role: 'admin' as const, enabled: true, passwordChangeRequired: false },
  csrfToken: 'csrf-token',
}

const passwordChangeSession = {
  user: { id: 'user-1', username: 'operator', role: 'user' as const, enabled: true, passwordChangeRequired: true },
  csrfToken: 'csrf-token',
}

const managedReader = {
  id: 'user-2', username: 'reader', role: 'user' as const, enabled: true,
  passwordChangeRequired: false,
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

const mysqlConnection = {
  ...connection,
  name: 'Primary MySQL',
  engine: 'mysql' as const,
  port: 3306,
}

const productMutationInspection = {
  table: {
    schema: 'public',
    name: 'products',
    columns: [
      { name: 'id', valueType: 'number', nullable: false, generated: true },
      { name: 'name', valueType: 'string', nullable: false, generated: false },
      { name: 'price', valueType: 'decimal', nullable: false, generated: false },
    ],
    uniqueKeys: [{ name: 'products_pkey', kind: 'primary', columns: ['id'] }],
  },
  policy: {
    identity: { name: 'products_pkey', kind: 'primary', columns: ['id'] },
    writableColumns: ['name', 'price'],
    readOnlyColumns: ['id'],
    canUpdate: true,
    canDelete: true,
  },
}

const postgresDdlCapabilities = {
  engine: 'postgres',
  version: { major: 17, minor: 5, patch: 0, assumedMinimum: false },
  transactionalDdl: true,
  columnTypes: ['bigint', 'text', 'varchar'],
  database: { create: true, drop: true, rename: true, owner: true },
  schema: { create: true, drop: true, rename: true, owner: true, databaseAlias: false },
  table: { create: true, drop: true, rename: true, owner: true, storageOptions: false },
  column: { generated: false, identity: true, rename: true, renameSyntax: 'rename-column' },
  constraint: { check: true, foreignKey: true, primaryKey: true, unique: true },
  index: { methods: ['btree', 'hash', 'gin', 'gist', 'brin'], expression: true, partial: true, prefixLength: false },
  advanced: {
    view: true, materializedView: true, sequence: true, enum: true, domain: true,
    function: true, procedure: true, trigger: true, partition: true, extension: true, event: false,
  },
}

const postgres96DdlCapabilities = {
  ...postgresDdlCapabilities,
  version: { major: 9, minor: 6, patch: 24, assumedMinimum: false },
  advanced: { ...postgresDdlCapabilities.advanced, procedure: false, partition: false },
}

const mysql84DdlCapabilities = {
  ...postgresDdlCapabilities,
  engine: 'mysql',
  version: { major: 8, minor: 4, patch: 6, assumedMinimum: false },
  transactionalDdl: false,
  columnTypes: ['bigint', 'int', 'varchar'],
  database: { create: true, drop: true, rename: false, owner: false },
  schema: { create: true, drop: true, rename: false, owner: false, databaseAlias: true },
  table: { create: true, drop: true, rename: true, owner: false, storageOptions: true },
  column: { generated: true, identity: true, rename: true, renameSyntax: 'rename-column' },
  index: { methods: ['btree', 'hash', 'fulltext'], expression: false, partial: false, prefixLength: true },
  advanced: {
    view: true, materializedView: false, sequence: false, enum: false, domain: false,
    function: true, procedure: true, trigger: true, partition: true, extension: false, event: true,
  },
}

const productOriginal = {
  id: { kind: 'value', type: 'number', value: 7 },
  name: { kind: 'value', type: 'string', value: 'Keyboard' },
  price: { kind: 'value', type: 'decimal', value: '49.90' },
}
