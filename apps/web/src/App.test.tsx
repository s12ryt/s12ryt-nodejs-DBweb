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
    expect(within(actions).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      '', 'create-database', 'rename-database', 'drop-database',
      'create-schema', 'rename-schema', 'drop-schema',
      'create-table', 'rename-table', 'drop-table',
      'add-column', 'rename-column', 'drop-column',
      'create-index', 'drop-index', 'add-constraint', 'drop-constraint',
    ])

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
}

const productOriginal = {
  id: { kind: 'value', type: 'number', value: 7 },
  name: { kind: 'value', type: 'string', value: 'Keyboard' },
  price: { kind: 'value', type: 'decimal', value: '49.90' },
}
