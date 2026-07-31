import {
  AlertTriangle,
  Braces,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Columns3,
  Database,
  KeyRound,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Server,
  Square,
  Table2,
  UserPlus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'

import {
  ApiError,
  apiRequest,
  type ConnectionProfile,
  type DatabaseColumn,
  type DatabaseTable,
  type Locale,
  type QueryResult,
  type RowPage,
  type Session,
} from './api.js'
import { translations } from './i18n.js'

export function App() {
  const [locale, setLocale] = useState<Locale>('zh-TW')
  const [session, setSession] = useState<Session | null>()

  useEffect(() => {
    let active = true
    void apiRequest<Session>('/api/auth/me', { locale })
      .then((value) => { if (active) setSession(value) })
      .catch((error: unknown) => {
        if (active && error instanceof ApiError && error.status === 401) setSession(null)
      })
    return () => { active = false }
  }, [])

  if (session === undefined) return <LoadingScreen />
  if (!session) {
    return <Login locale={locale} onLocale={setLocale} onLogin={setSession} />
  }
  return (
    <Workbench
      locale={locale}
      onLocale={setLocale}
      session={session}
      onLogout={() => setSession(null)}
    />
  )
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-label="Loading">
      <div className="brand-mark"><Database size={24} aria-hidden="true" /></div>
      <span>DBWeb</span>
    </main>
  )
}

function Login({ locale, onLocale, onLogin }: {
  locale: Locale
  onLocale: (locale: Locale) => void
  onLogin: (session: Session) => void
}) {
  const t = translations(locale)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onLogin(await apiRequest<Session>('/api/auth/login', {
        method: 'POST',
        locale,
        body: { username: fields.get('username'), password: fields.get('password') },
      }))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('loginFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-layout">
      <section className="login-brand" aria-label="DBWeb">
        <div className="wordmark"><Database size={28} aria-hidden="true" /> DBWeb</div>
        <div className="signal-grid" aria-hidden="true">
          <span /><span /><span /><span /><span /><span /><span /><span /><span />
        </div>
        <p>POSTGRESQL / MYSQL</p>
      </section>
      <section className="login-panel">
        <button className="text-button locale-button" type="button" onClick={() => onLocale(locale === 'en' ? 'zh-TW' : 'en')}>
          {t('language')}
        </button>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <header>
            <span className="eyebrow">DATABASE OPERATIONS</span>
            <h1>{t('signInTitle')}</h1>
            <p>{t('loginSubtitle')}</p>
          </header>
          <Field label={t('username')}><input name="username" autoComplete="username" required autoFocus /></Field>
          <Field label={t('password')}><input name="password" type="password" autoComplete="current-password" required /></Field>
          {error && <div className="inline-error" role="alert">{error}</div>}
          <button className="primary-button wide" type="submit" disabled={busy}>
            {busy ? <RefreshCw className="spin" size={17} aria-hidden="true" /> : null}{t('login')}
          </button>
        </form>
      </section>
    </main>
  )
}

function Workbench({ locale, onLocale, session, onLogout }: {
  locale: Locale
  onLocale: (locale: Locale) => void
  session: Session
  onLogout: () => void
}) {
  const t = translations(locale)
  const [connections, setConnections] = useState<ConnectionProfile[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'connection' | 'user'>()

  const loadConnections = useCallback(async () => {
    try {
      const next = await apiRequest<ConnectionProfile[]>('/api/connections', { locale })
      setConnections(next)
      setSelectedId((current) => current && next.some((connection) => connection.id === current) ? current : undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [locale])

  useEffect(() => { void loadConnections() }, [loadConnections])
  const selected = connections.find((connection) => connection.id === selectedId)

  async function logout() {
    try {
      await apiRequest<void>('/api/auth/logout', { method: 'POST', locale, csrfToken: session.csrfToken })
    } finally {
      onLogout()
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="wordmark compact"><Database size={20} aria-hidden="true" /> DBWeb</div>
        <div className="topbar-actions">
          <button className="text-button" type="button" onClick={() => onLocale(locale === 'en' ? 'zh-TW' : 'en')}>{t('language')}</button>
          <span className="user-chip">{session.user.username}<small>{session.user.role}</small></span>
          <IconButton label={t('logout')} onClick={() => void logout()}><LogOut size={18} /></IconButton>
        </div>
      </header>
      <aside className="connection-rail">
        <div className="rail-heading">
          <div><span className="eyebrow">DATABASES</span><h2>{t('connection')}</h2></div>
          {session.user.role === 'admin' && <IconButton label={t('addConnection')} onClick={() => setDialog('connection')}><Plus size={18} /></IconButton>}
        </div>
        <nav className="connection-list" aria-label={t('connection')}>
          {connections.map((connection) => (
            <button key={connection.id} className={connection.id === selectedId ? 'connection-item active' : 'connection-item'} type="button" onClick={() => setSelectedId(connection.id)}>
              <span className={`engine-dot ${connection.engine}`} aria-hidden="true" />
              <span><strong>{connection.name}</strong><small>{connection.host}:{connection.port}</small></span>
              <span className="engine-label">{connection.engine === 'postgres' ? 'PG' : 'MY'}{connection.ssh?.enabled ? ' / SSH' : ''}</span>
            </button>
          ))}
          {connections.length === 0 && <p className="empty-note">{t('connectionEmpty')}</p>}
        </nav>
        {session.user.role === 'admin' && (
          <button className="rail-command" type="button" onClick={() => setDialog('user')}><UserPlus size={17} />{t('createUser')}</button>
        )}
      </aside>
      <section className="workspace">
        {error && <div className="error-banner" role="alert"><AlertTriangle size={17} />{error}<button type="button" onClick={() => setError('')} aria-label="Close"><X size={16} /></button></div>}
        {!selected ? <EmptyWorkspace title={t('connectionWorkbench')} text={t('selectConnection')} /> : <ConnectionWorkspace key={selected.id} connection={selected} locale={locale} csrfToken={session.csrfToken} isAdmin={session.user.role === 'admin'} />}
      </section>
      {dialog === 'connection' && <ConnectionDialog locale={locale} csrfToken={session.csrfToken} onClose={() => setDialog(undefined)} onCreated={() => { setDialog(undefined); void loadConnections() }} />}
      {dialog === 'user' && <UserDialog locale={locale} csrfToken={session.csrfToken} onClose={() => setDialog(undefined)} />}
    </main>
  )
}

function EmptyWorkspace({ title, text }: { title: string; text: string }) {
  return <div className="empty-workspace"><Server size={34} strokeWidth={1.4} /><h1>{title}</h1><p>{text}</p></div>
}

function ConnectionWorkspace({ connection, locale, csrfToken, isAdmin }: { connection: ConnectionProfile; locale: Locale; csrfToken: string; isAdmin: boolean }) {
  const t = translations(locale)
  const [tab, setTab] = useState<'browse' | 'query'>('browse')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [error, setError] = useState('')
  const ssh = connection.ssh?.enabled ? connection.ssh : undefined

  async function resetSshHostKey() {
    if (!ssh) return
    try {
      await apiRequest<void>('/api/ssh/known-hosts/reset', { method: 'POST', locale, csrfToken, body: { host: ssh.host, port: ssh.port } })
      setConfirmingReset(false)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="connection-workspace">
      <header className="workspace-header">
        <div><span className="eyebrow">{connection.engine.toUpperCase()} / {connection.database}</span><h1>{connection.name}</h1><p><span>{connection.username}@{connection.host}:{connection.port}</span>{ssh && <span className="ssh-endpoint">{ssh.username}@{ssh.host}:{ssh.port}</span>}</p></div>
        <div className="workspace-tools"><div className="status-pair"><span className="status online">TLS {connection.tls.mode}</span>{ssh && <span className="status online">SSH</span>}<span className={connection.keepAlive.enabled ? 'status online' : 'status'}>{t('keepAlive')}</span></div>{isAdmin && ssh && <IconButton label={t('sshReset')} onClick={() => setConfirmingReset(true)}><KeyRound size={17} /></IconButton>}</div>
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'browse'} onClick={() => setTab('browse')}><Table2 size={17} />{t('rows')}</button>
        <button role="tab" aria-selected={tab === 'query'} onClick={() => setTab('query')}><Braces size={17} />{t('query')}</button>
      </div>
      {tab === 'browse' ? <DataBrowser connectionId={connection.id} locale={locale} /> : <QueryEditor connectionId={connection.id} locale={locale} csrfToken={csrfToken} />}
      {confirmingReset && <ConfirmDialog title={t('sshReset')} body={t('sshResetBody')} confirm={t('sshResetConfirm')} cancel={t('cancel')} onCancel={() => setConfirmingReset(false)} onConfirm={() => void resetSshHostKey()} />}
    </div>
  )
}

function DataBrowser({ connectionId, locale }: { connectionId: string; locale: Locale }) {
  const t = translations(locale)
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState('')
  const [tables, setTables] = useState<DatabaseTable[]>([])
  const [table, setTable] = useState('')
  const [columns, setColumns] = useState<DatabaseColumn[]>([])
  const [page, setPage] = useState<RowPage>()
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<'rows' | 'columns'>('rows')
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    void apiRequest<string[]>(`/api/connections/${encodeURIComponent(connectionId)}/schemas`, { locale })
      .then((items) => { setSchemas(items); setSchema(items[0] ?? '') })
      .catch((cause) => setError(errorMessage(cause)))
  }, [connectionId, locale])

  useEffect(() => {
    setTable(''); setTables([]); setPage(undefined); setColumns([])
    if (!schema) return
    void apiRequest<DatabaseTable[]>(`/api/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables`, { locale })
      .then((items) => { setTables(items); setTable(items[0]?.name ?? '') })
      .catch((cause) => setError(errorMessage(cause)))
  }, [connectionId, locale, schema])

  useEffect(() => {
    setOffset(0); setPage(undefined); setColumns([])
  }, [table])

  useEffect(() => {
    if (!schema || !table) return
    const base = `/api/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`
    void Promise.all([
      apiRequest<DatabaseColumn[]>(`${base}/columns`, { locale }),
      apiRequest<RowPage>(`${base}/rows?limit=100&offset=${offset}`, { locale }),
    ]).then(([nextColumns, nextPage]) => { setColumns(nextColumns); setPage(nextPage) })
      .catch((cause) => setError(errorMessage(cause)))
  }, [connectionId, locale, offset, schema, table])

  return (
    <div className="browser-layout">
      <aside className="object-picker">
        <Field label={t('schema')}><select value={schema} onChange={(event) => setSchema(event.target.value)}>{schemas.map((item) => <option key={item}>{item}</option>)}</select></Field>
        <div className="table-tree">
          <span className="section-label">{t('table')} · {tables.length}</span>
          {tables.map((item) => <button type="button" key={item.name} className={table === item.name ? 'tree-item active' : 'tree-item'} onClick={() => setTable(item.name)}><Table2 size={15} />{item.name}<small>{item.type}</small></button>)}
        </div>
      </aside>
      <section className="data-surface">
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="surface-toolbar">
          <div className="segmented"><button type="button" className={view === 'rows' ? 'active' : ''} onClick={() => setView('rows')}><Table2 size={15} />{t('rows')}</button><button type="button" className={view === 'columns' ? 'active' : ''} onClick={() => setView('columns')}><Columns3 size={15} />{t('columns')}</button></div>
          {view === 'rows' && <div className="pager"><IconButton label={t('previousPage')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}><ChevronLeft size={17} /></IconButton><span>{offset + 1}–{offset + (page?.rows.length ?? 0)}</span><IconButton label={t('nextPage')} disabled={page?.nextOffset === null || !page} onClick={() => setOffset(page?.nextOffset ?? offset)}><ChevronRight size={17} /></IconButton></div>}
        </div>
        {view === 'rows' ? <DataTable columns={page?.columns ?? []} rows={page?.rows ?? []} empty={t('noRows')} /> : <ColumnTable columns={columns} />}
      </section>
    </div>
  )
}

function QueryEditor({ connectionId, locale, csrfToken }: { connectionId: string; locale: Locale; csrfToken: string }) {
  const t = translations(locale)
  const [sql, setSql] = useState('SELECT 1;')
  const [timeout, setTimeoutValue] = useState(30)
  const [limit, setLimit] = useState(1000)
  const [queryId, setQueryId] = useState<string>()
  const [result, setResult] = useState<QueryResult>()
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  async function run(confirmedHighRisk = false) {
    const id = crypto.randomUUID()
    setQueryId(id); setError(''); setResult(undefined)
    try {
      setResult(await apiRequest<QueryResult>('/api/queries', { method: 'POST', locale, csrfToken, body: { queryId: id, connectionId, sql, timeoutMs: timeout * 1000, rowLimit: limit, confirmedHighRisk } }))
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'CONFIRMATION_REQUIRED') setConfirming(true)
      else setError(errorMessage(cause))
    } finally {
      setQueryId(undefined)
    }
  }

  async function cancel() {
    if (!queryId) return
    try { await apiRequest<void>(`/api/queries/${queryId}/cancel`, { method: 'POST', locale, csrfToken }) }
    catch (cause) { setError(errorMessage(cause)) }
  }

  return (
    <div className="query-layout">
      <div className="query-editor">
        <div className="query-toolbar"><span className="section-label">SQL</span><div className="query-settings"><Field label={t('queryTimeout')} compact><input type="number" min="1" max="300" value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} /></Field><Field label={t('queryLimit')} compact><input type="number" min="1" max="10000" value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></Field></div></div>
        <textarea aria-label={t('query')} value={sql} onChange={(event) => setSql(event.target.value)} placeholder={t('sqlPlaceholder')} spellCheck="false" />
        <div className="editor-actions">{queryId ? <button className="danger-button" type="button" onClick={() => void cancel()}><Square size={15} />{t('cancelQuery')}</button> : <button className="primary-button" type="button" onClick={() => void run()}><Play size={16} />{t('run')}</button>}</div>
      </div>
      <section className="query-result">
        {error && <div className="inline-error" role="alert">{error}</div>}
        {result && <><div className="result-meta"><span>{t('duration')} <strong>{result.durationMs} ms</strong></span><span>{t('affected')} <strong>{result.affectedRows}</strong></span>{result.truncated && <span className="warning-text">{t('truncated')}</span>}</div><DataTable columns={result.columns} rows={result.rows} empty={t('noRows')} /></>}
      </section>
      {confirming && <ConfirmDialog title={t('highRiskTitle')} body={t('highRiskBody')} confirm={t('run')} cancel={t('cancel')} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void run(true) }} />}
    </div>
  )
}

function ConnectionDialog({ locale, csrfToken, onClose, onCreated }: { locale: Locale; csrfToken: string; onClose: () => void; onCreated: () => void }) {
  const t = translations(locale)
  const [error, setError] = useState('')
  const [sshEnabled, setSshEnabled] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    try {
      await apiRequest('/api/connections', { method: 'POST', locale, csrfToken, body: { name: data.get('name'), engine: data.get('engine'), host: data.get('host'), port: Number(data.get('port')), database: data.get('database'), username: data.get('username'), password: data.get('password'), tls: { mode: data.get('tlsMode') }, keepAlive: { enabled: data.get('keepAlive') === 'on', intervalMs: 300000 }, ssh: sshEnabled ? { enabled: true, host: data.get('sshHost'), port: Number(data.get('sshPort')), username: data.get('sshUsername'), password: data.get('sshPassword') } : { enabled: false } } })
      onCreated()
    } catch (cause) { setError(errorMessage(cause)) }
  }
  return <Modal title={t('addConnection')} onClose={onClose}><form className="form-grid" onSubmit={(event) => void submit(event)}><Field label={t('name')}><input name="name" required autoFocus /></Field><Field label={t('engine')}><select name="engine" defaultValue="postgres"><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></Field><Field label={t('host')}><input name="host" defaultValue="localhost" required /></Field><Field label={t('port')}><input name="port" type="number" min="1" max="65535" defaultValue="5432" required /></Field><Field label={t('database')}><input name="database" required /></Field><Field label={t('username')}><input name="username" required /></Field><Field label={t('password')}><input name="password" type="password" /></Field><Field label={t('tlsMode')}><select name="tlsMode" defaultValue="disable"><option value="disable">Disable</option><option value="prefer">Prefer</option><option value="require">Require</option><option value="verify-ca">Verify CA</option><option value="verify-full">Verify full</option></select></Field><label className="check-field"><input name="keepAlive" type="checkbox" />{t('keepAlive')}</label><label className="check-field"><input name="sshEnabled" type="checkbox" checked={sshEnabled} onChange={(event) => setSshEnabled(event.target.checked)} />{t('sshTunnel')}</label>{sshEnabled && <><Field label={t('sshHost')}><input name="sshHost" required /></Field><Field label={t('sshPort')}><input name="sshPort" type="number" min="1" max="65535" defaultValue="22" required /></Field><Field label={t('sshUsername')}><input name="sshUsername" required /></Field><Field label={t('sshPassword')}><input name="sshPassword" type="password" required /></Field></>}{error && <div className="inline-error full" role="alert">{error}</div>}<div className="dialog-actions full"><button className="secondary-button" type="button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit"><CirclePlus size={16} />{t('save')}</button></div></form></Modal>
}

function UserDialog({ locale, csrfToken, onClose }: { locale: Locale; csrfToken: string; onClose: () => void }) {
  const t = translations(locale); const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); try { await apiRequest('/api/users', { method: 'POST', locale, csrfToken, body: { username: data.get('username'), password: data.get('password'), role: data.get('role') } }); onClose() } catch (cause) { setError(errorMessage(cause)) } }
  return <Modal title={t('createUser')} onClose={onClose}><form className="stack-form" onSubmit={(event) => void submit(event)}><Field label={t('username')}><input name="username" required autoFocus /></Field><Field label={t('password')}><input name="password" type="password" minLength={12} required /></Field><Field label={t('role')}><select name="role" defaultValue="user"><option value="user">{t('userRole')}</option><option value="admin">{t('adminRole')}</option></select></Field>{error && <div className="inline-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit"><UserPlus size={16} />{t('create')}</button></div></form></Modal>
}

function DataTable({ columns, rows, empty }: { columns: string[]; rows: Array<Record<string, unknown>>; empty: string }) {
  if (rows.length === 0) return <div className="table-empty">{empty}</div>
  return <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}</tr>)}</tbody></table></div>
}

function ColumnTable({ columns }: { columns: DatabaseColumn[] }) {
  return <div className="table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead><tbody>{columns.map((column) => <tr key={column.name}><td>{column.primaryKey && <span className="key-tag">PK</span>}{column.name}</td><td>{column.dataType}</td><td>{column.nullable ? 'YES' : 'NO'}</td><td>{column.defaultValue ?? 'NULL'}</td></tr>)}</tbody></table></div>
}

function Field({ label, compact = false, children }: { label: string; compact?: boolean; children: ReactNode }) { return <label className={compact ? 'field compact-field' : 'field'}><span>{label}</span>{children}</label> }
function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) { return <button className="icon-button" type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button> }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><h2 id="modal-title">{title}</h2><IconButton label="Close" onClick={onClose}><X size={18} /></IconButton></header>{children}</section></div> }
function ConfirmDialog({ title, body, confirm, cancel, onConfirm, onCancel }: { title: string; body: string; confirm: string; cancel: string; onConfirm: () => void; onCancel: () => void }) { return <Modal title={title} onClose={onCancel}><div className="confirm-body"><AlertTriangle size={30} /><p>{body}</p></div><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onCancel}>{cancel}</button><button className="danger-button" type="button" onClick={onConfirm}>{confirm}</button></div></Modal> }
function formatCell(value: unknown): string { if (value === null || value === undefined) return 'NULL'; if (typeof value === 'object') return JSON.stringify(value); return String(value) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Request failed' }
