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
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  Table2,
  Trash2,
  Users,
  UserPlus,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'

import {
  ApiError,
  apiRequest,
  type ConnectionProfile,
  type DatabaseColumn,
  type DatabaseTable,
  type DataMutationInspection,
  type DatabaseValueType,
  type DdlCapabilities,
  type Locale,
  type NativeAccount,
  type NativeAccountResult,
  type QueryResult,
  type RowPage,
  type Session,
  type TaggedDatabaseValue,
  type User,
  type WebAccessAssignment,
  type WebCapability,
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
  if (session.user.passwordChangeRequired) {
    return <PasswordChange locale={locale} session={session} onChanged={() => setSession(null)} />
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

function PasswordChange({ locale, session, onChanged }: { locale: Locale; session: Session; onChanged: () => void }) {
  const t = translations(locale)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    try {
      await apiRequest<void>('/api/auth/change-password', {
        method: 'POST', locale, csrfToken: session.csrfToken,
        body: { currentPassword: fields.get('currentPassword'), newPassword: fields.get('newPassword') },
      })
      onChanged()
    } catch (cause) { setError(errorMessage(cause)) }
  }
  return <main className="login-layout"><section className="login-brand" aria-label="DBWeb"><div className="wordmark"><Database size={28} aria-hidden="true" /> DBWeb</div><p>SECURITY UPDATE</p></section><section className="login-panel"><form className="login-form" onSubmit={(event) => void submit(event)}><header><span className="eyebrow">PASSWORD REQUIRED</span><h1>{t('changePassword')}</h1><p>{t('changePasswordBody')}</p></header><Field label={t('currentPassword')}><input name="currentPassword" type="password" autoComplete="current-password" required autoFocus /></Field><Field label={t('newPassword')}><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></Field>{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary-button wide" type="submit">{t('changePassword')}</button></form></section></main>
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
  const [dialog, setDialog] = useState<'connection' | 'users'>()

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
          <button className="rail-command" type="button" onClick={() => setDialog('users')}><Users size={17} />{t('userAccess')}</button>
        )}
      </aside>
      <section className="workspace">
        {error && <div className="error-banner" role="alert"><AlertTriangle size={17} />{error}<button type="button" onClick={() => setError('')} aria-label="Close"><X size={16} /></button></div>}
        {!selected ? <EmptyWorkspace title={t('connectionWorkbench')} text={t('selectConnection')} /> : <ConnectionWorkspace key={selected.id} connection={selected} locale={locale} csrfToken={session.csrfToken} isAdmin={session.user.role === 'admin'} />}
      </section>
      {dialog === 'connection' && <ConnectionDialog locale={locale} csrfToken={session.csrfToken} onClose={() => setDialog(undefined)} onCreated={() => { setDialog(undefined); void loadConnections() }} />}
      {dialog === 'users' && <UserManagementDialog locale={locale} csrfToken={session.csrfToken} connections={connections} onClose={() => setDialog(undefined)} />}
    </main>
  )
}

function EmptyWorkspace({ title, text }: { title: string; text: string }) {
  return <div className="empty-workspace"><Server size={34} strokeWidth={1.4} /><h1>{title}</h1><p>{text}</p></div>
}

function ConnectionWorkspace({ connection, locale, csrfToken, isAdmin }: { connection: ConnectionProfile; locale: Locale; csrfToken: string; isAdmin: boolean }) {
  const t = translations(locale)
  const [tab, setTab] = useState<'browse' | 'query' | 'structure' | 'accounts'>('browse')
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
        {isAdmin && <button role="tab" aria-selected={tab === 'structure'} onClick={() => setTab('structure')}><Wrench size={17} />{t('structure')}</button>}
        <button role="tab" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}><ShieldCheck size={17} />{t('nativeAccounts')}</button>
      </div>
      {tab === 'browse' && <DataBrowser connectionId={connection.id} locale={locale} csrfToken={csrfToken} isAdmin={isAdmin} />}
      {tab === 'query' && <QueryEditor connectionId={connection.id} locale={locale} csrfToken={csrfToken} />}
      {tab === 'structure' && isAdmin && <DdlWorkbench connectionId={connection.id} locale={locale} csrfToken={csrfToken} />}
      {tab === 'accounts' && <NativeAccountWorkbench connection={connection} locale={locale} csrfToken={csrfToken} isAdmin={isAdmin} />}
      {confirmingReset && <ConfirmDialog title={t('sshReset')} body={t('sshResetBody')} confirm={t('sshResetConfirm')} cancel={t('cancel')} onCancel={() => setConfirmingReset(false)} onConfirm={() => void resetSshHostKey()} />}
    </div>
  )
}

type NativeConfirmation =
  | { kind: 'create'; body: Record<string, unknown> }
  | { kind: 'adopt'; account: NativeAccount }
  | { kind: 'disable' | 'delete' | 'restore'; account: NativeAccount }

function NativeAccountWorkbench({ connection, locale, csrfToken, isAdmin }: { connection: ConnectionProfile; locale: Locale; csrfToken: string; isAdmin: boolean }) {
  const t = translations(locale)
  const base = `/api/connections/${encodeURIComponent(connection.id)}/accounts`
  const [accounts, setAccounts] = useState<NativeAccount[]>([])
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirming, setConfirming] = useState<NativeConfirmation>()
  const [revealing, setRevealing] = useState<NativeAccount>()
  const [shownPassword, setShownPassword] = useState('')

  const load = useCallback(async () => {
    try {
      setAccounts(await apiRequest<NativeAccount[]>(base, { locale }))
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [base, locale])

  useEffect(() => { void load() }, [load])

  async function postResult(path: string, body: Record<string, unknown>) {
    const result = await apiRequest<NativeAccountResult>(path, { method: 'POST', locale, csrfToken, body })
    setShownPassword(result.password ?? '')
    await load()
  }

  async function runConfirmation() {
    const pending = confirming
    if (!pending) return
    setConfirming(undefined); setShownPassword(''); setError('')
    try {
      if (pending.kind === 'create') {
        await postResult(base, { ...pending.body, confirmed: true }); setCreating(false); return
      }
      const identity = pending.account.identity
      if (pending.kind === 'adopt') {
        await postResult(`${base}/adopt`, { identity: identity.engine === 'mysql' ? { username: identity.username, host: identity.host } : { username: identity.username }, confirmed: true }); return
      }
      const id = encodeURIComponent(pending.account.managedAccountId ?? '')
      if (pending.kind === 'disable') {
        await apiRequest<void>(`${base}/${id}`, { method: 'PATCH', locale, csrfToken, body: { enabled: false, confirmed: true } })
      } else if (pending.kind === 'delete') {
        await apiRequest<void>(`${base}/${id}`, { method: 'DELETE', locale, csrfToken, body: { confirmed: true } })
      } else {
        await apiRequest<void>(`${base}/${id}/restore`, { method: 'POST', locale, csrfToken, body: { confirmed: true } })
      }
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function simpleAction(account: NativeAccount, action: 'verify' | 'rotate' | 'enable') {
    const id = encodeURIComponent(account.managedAccountId ?? '')
    setShownPassword(''); setError('')
    try {
      if (action === 'verify') await apiRequest<void>(`${base}/${id}/verify`, { method: 'POST', locale, csrfToken, body: {} })
      if (action === 'rotate') await postResult(`${base}/${id}/rotate-password`, {})
      if (action === 'enable') await apiRequest<void>(`${base}/${id}`, { method: 'PATCH', locale, csrfToken, body: { enabled: true, confirmed: true } })
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  async function reveal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!revealing?.managedAccountId) return
    const data = new FormData(event.currentTarget)
    try {
      const result = await apiRequest<{ password: string }>(`${base}/${encodeURIComponent(revealing.managedAccountId)}/reveal-password`, {
        method: 'POST', locale, csrfToken, body: { webPassword: String(data.get('webPassword') ?? '') },
      })
      setShownPassword(result.password); setRevealing(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const confirmCopy = confirming ? nativeConfirmationCopy(confirming.kind, t) : undefined
  return (
    <section className="native-accounts">
      <div className="native-account-toolbar">
        <div><span className="section-label">{t('nativeAccounts')}</span><strong>{accounts.length}</strong></div>
        <button className="primary-button" type="button" onClick={() => { setCreating(true); setShownPassword('') }}><Plus size={16} />{t('createNativeAccount')}</button>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {shownPassword && <div className="password-once"><span>{t('passwordShownOnce')}</span><code>{shownPassword}</code><button type="button" onClick={() => setShownPassword('')} aria-label="Close"><X size={15} /></button></div>}
      <div className="native-account-list">
        {accounts.map((account) => {
          const identity = account.identity
          const label = identity.engine === 'mysql' ? `${identity.username}@${identity.host}` : identity.username
          const deleted = account.managedStatus === 'deleted'
          return <article className="native-account-row" key={`${identity.engine}:${label}`}>
            <div className="native-account-identity"><strong>{label}</strong><small>{account.managed ? t('managed') : t('unmanaged')} · {account.canLogin ? t('enabled') : t('disabled')}</small></div>
            <div className="native-account-state">{account.protected && <span className="status warning">{t('protectedAccount')}</span>}{account.managedStatus && <span className="status">{account.managedStatus}</span>}</div>
            <div className="native-account-actions">
              {!account.protected && !account.managed && <button type="button" onClick={() => setConfirming({ kind: 'adopt', account })}>{t('adoptNativeAccount')} {label}</button>}
              {!account.protected && account.managed && !deleted && account.managedAccountId && <>
                <IconButton label={`${t('verifyNativeAccount')} ${label}`} onClick={() => void simpleAction(account, 'verify')}><RefreshCw size={15} /></IconButton>
                <button type="button" onClick={() => void simpleAction(account, 'rotate')}>{t('rotateNativePassword')} {label}</button>
                {isAdmin && <button type="button" onClick={() => setRevealing(account)}>{t('revealNativePassword')} {label}</button>}
                {account.managedStatus === 'disabled'
                  ? <button type="button" onClick={() => void simpleAction(account, 'enable')}>{t('enableNativeAccount')} {label}</button>
                  : <button type="button" onClick={() => setConfirming({ kind: 'disable', account })}>{t('disableNativeAccount')} {label}</button>}
                <button className="danger-button" type="button" onClick={() => setConfirming({ kind: 'delete', account })}>{t('deleteNativeAccount')} {label}</button>
              </>}
              {!account.protected && account.managed && deleted && <button type="button" onClick={() => setConfirming({ kind: 'restore', account })}>{t('restoreNativeAccount')} {label}</button>}
            </div>
          </article>
        })}
      </div>
      {creating && <Modal title={t('createNativeAccount')} onClose={() => setCreating(false)}><form className="form-grid" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget)
        const username = String(data.get('username') ?? '').trim(); const password = String(data.get('password') ?? '')
        const host = String(data.get('host') ?? '').trim()
        setConfirming({ kind: 'create', body: {
          identity: connection.engine === 'mysql' ? { username, host: host || '%' } : { username },
          ...(password ? { password } : {}),
        } })
      }}>
        <Field label={t('nativeAccountName')}><input name="username" required /></Field>
        {connection.engine === 'mysql' && <Field label={t('nativeHost')}><input name="host" defaultValue="%" required /></Field>}
        <Field label={t('nativeAccountPassword')}><input name="password" type="password" minLength={16} /></Field>
        <div className="dialog-actions"><button type="button" onClick={() => setCreating(false)}>{t('cancel')}</button><button className="primary-button" type="submit">{t('create')}</button></div>
      </form></Modal>}
      {revealing && <Modal title={t('reauthenticate')} onClose={() => setRevealing(undefined)}><form className="form-grid" onSubmit={(event) => void reveal(event)}><Field label={t('currentPassword')}><input name="webPassword" type="password" required /></Field><div className="dialog-actions"><button type="button" onClick={() => setRevealing(undefined)}>{t('cancel')}</button><button className="primary-button" type="submit">{t('revealNativePassword')}</button></div></form></Modal>}
      {confirmCopy && <ConfirmDialog title={confirmCopy.title} body={confirmCopy.body} confirm={confirmCopy.confirm} cancel={t('cancel')} onCancel={() => setConfirming(undefined)} onConfirm={() => void runConfirmation()} />}
    </section>
  )
}

function nativeConfirmationCopy(kind: NativeConfirmation['kind'], t: ReturnType<typeof translations>) {
  if (kind === 'create') return { title: t('confirmCreateAccount'), body: t('confirmCreateAccount'), confirm: t('create') }
  if (kind === 'adopt') return { title: t('confirmAdoptAccount'), body: t('confirmAdoptAccount'), confirm: t('adoptNativeAccount') }
  if (kind === 'disable') return { title: t('confirmDisableAccount'), body: t('confirmDisableAccount'), confirm: t('disableNativeAccount') }
  if (kind === 'delete') return { title: t('confirmDeleteNativeAccount'), body: t('confirmDeleteNativeAccount'), confirm: t('delete') }
  return { title: t('confirmRestoreAccount'), body: t('confirmRestoreAccount'), confirm: t('restoreNativeAccount') }
}

const DDL_ACTIONS = [
  'create-database', 'rename-database', 'drop-database',
  'create-schema', 'rename-schema', 'drop-schema',
  'create-table', 'rename-table', 'drop-table',
  'add-column', 'rename-column', 'drop-column',
  'create-index', 'drop-index', 'add-constraint', 'drop-constraint',
  'create-view', 'drop-view',
  'create-materialized-view', 'refresh-materialized-view', 'drop-materialized-view',
  'create-sequence', 'drop-sequence',
  'create-enum', 'create-domain', 'drop-type',
  'create-extension', 'drop-extension',
  'create-routine', 'drop-routine',
  'create-trigger', 'drop-trigger',
  'create-event', 'drop-event',
  'create-partition', 'drop-partition',
] as const
type DdlAction = (typeof DDL_ACTIONS)[number]

function DdlWorkbench({ connectionId, locale, csrfToken }: { connectionId: string; locale: Locale; csrfToken: string }) {
  const t = translations(locale)
  const [capabilities, setCapabilities] = useState<DdlCapabilities>()
  const [action, setAction] = useState<DdlAction>()
  const [pendingCommand, setPendingCommand] = useState<Record<string, unknown>>()
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ statementsExecuted: number; transactional: boolean }>()

  useEffect(() => {
    setError('')
    void apiRequest<DdlCapabilities>(`/api/connections/${encodeURIComponent(connectionId)}/ddl/capabilities`, { locale })
      .then(setCapabilities)
      .catch((cause) => setError(errorMessage(cause)))
  }, [connectionId, locale])

  async function execute(command: Record<string, unknown>) {
    setError('')
    try {
      setResult(await apiRequest(`/api/connections/${encodeURIComponent(connectionId)}/ddl/execute`, {
        method: 'POST', locale, csrfToken, body: { command },
      }))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!action) return
    const data = new FormData(event.currentTarget)
    const command = buildCoreDdlCommand(action, data, capabilities)
    if (requiresDdlConfirmation(command)) {
      setPendingCommand({ ...command, confirmed: true })
      return
    }
    void execute(command)
  }

  const versionLabel = capabilities
    ? `${capabilities.engine === 'postgres' ? 'PostgreSQL' : 'MySQL'} ${capabilities.version.major}.${capabilities.version.minor}.${capabilities.version.patch}`
    : undefined

  return (
    <section className="ddl-layout">
      <header className="ddl-toolbar">
        <div><span className="eyebrow">DDL CAPABILITIES</span>{versionLabel && <h2>{versionLabel}</h2>}</div>
        {result && <span className="status online">{result.statementsExecuted} DDL</span>}
      </header>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <form className="ddl-form" key={action ?? 'none'} onSubmit={submit}>
        <Field label={t('ddlAction')}>
            <select value={action ?? ''} onChange={(event) => setAction(event.target.value as DdlAction)}>
            <option value="" disabled>{t('ddlAction')}</option>
            {DDL_ACTIONS.map((item) => <option key={item} value={item} disabled={!ddlActionSupported(item, capabilities)}>{t(ddlActionLabel(item))}</option>)}
          </select>
        </Field>
        {action && <>
          <DdlCommandFields action={action} capabilities={capabilities} locale={locale} />
          <div className="ddl-actions"><button className={action.startsWith('drop-') ? 'danger-button' : 'primary-button'} type="submit"><Wrench size={16} />{t('ddlRun')}</button></div>
        </>}
      </form>
      {pendingCommand && <ConfirmDialog title={t('ddlConfirmTitle')} body={t('ddlConfirmBody')} confirm={t('delete')} cancel={t('cancel')} onCancel={() => setPendingCommand(undefined)} onConfirm={() => { const command = pendingCommand; setPendingCommand(undefined); void execute(command) }} />}
    </section>
  )
}

function DdlCommandFields({ action, capabilities, locale }: { action: DdlAction; capabilities: DdlCapabilities | undefined; locale: Locale }) {
  const t = translations(locale)
  const databaseAction = action.endsWith('-database')
  const schemaAction = action.endsWith('-schema')
  const tableObjectAction = action.endsWith('-table')
  const columnAction = action.endsWith('-column')
  const indexAction = action.endsWith('-index')
  const constraintAction = action.endsWith('-constraint')
  const advancedAction = DDL_ACTIONS.indexOf(action) >= 16
  const rename = action.startsWith('rename-')
  const createColumn = action === 'create-table' || action === 'add-column' || (action === 'rename-column' && capabilities?.column.renameSyntax === 'change-column')
  return <>
    {databaseAction && !rename && <Field label={t('database')}><input name="name" required autoFocus /></Field>}
    {schemaAction && !rename && <Field label={t('ddlSchemaName')}><input name="name" required autoFocus /></Field>}
    {(tableObjectAction || columnAction || indexAction || constraintAction) && <Field label={t('ddlSchemaName')}><input name="schema" required autoFocus /></Field>}
    {(columnAction || indexAction || constraintAction) && <Field label={t('ddlTableName')}><input name="table" required /></Field>}
    {tableObjectAction && !rename && <Field label={t('ddlTableName')}><input name="name" required /></Field>}
    {rename && <><Field label={t('ddlFromName')}><input name="from" required autoFocus /></Field><Field label={t('ddlToName')}><input name="to" required /></Field></>}
    {columnAction && !rename && <Field label={t('ddlColumnName')}><input name="name" required /></Field>}
    {createColumn && <>
      {action === 'create-table' && <Field label={t('ddlColumnName')}><input name="column" required /></Field>}
      <Field label={t('ddlColumnType')}><select name="columnType" required>{capabilities?.columnTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></Field>
      <label className="check-field"><input name="nullable" type="checkbox" />{t('ddlNullable')}</label>
    </>}
    {indexAction && <Field label={t('ddlIndexName')}><input name="name" required /></Field>}
    {action === 'create-index' && <>
      <Field label={t('ddlIndexMethod')}><select name="method">{capabilities?.index.methods.map((method) => <option key={method}>{method}</option>)}</select></Field>
      <Field label={t('ddlIndexColumn')}><input name="indexColumn" /></Field>
      {capabilities?.index.expression && <Field label={t('ddlIndexExpression')}><input name="expression" /></Field>}
      {capabilities?.index.partial && <Field label={t('ddlIndexPredicate')}><input name="predicate" /></Field>}
      <label className="check-field"><input name="unique" type="checkbox" />{t('ddlUnique')}</label>
    </>}
    {constraintAction && <Field label={t('ddlConstraintName')}><input name="name" required /></Field>}
    {constraintAction && <Field label={t('ddlConstraintType')}><select name="constraintKind" defaultValue="unique"><option value="unique">UNIQUE</option><option value="primary-key">PRIMARY KEY</option><option value="foreign-key">FOREIGN KEY</option>{capabilities?.constraint.check && <option value="check">CHECK</option>}</select></Field>}
    {action === 'add-constraint' && <>
      <Field label={t('ddlConstraintColumns')}><input name="constraintColumns" /></Field>
      <Field label={t('ddlReferenceSchema')}><input name="referenceSchema" /></Field>
      <Field label={t('ddlReferenceTable')}><input name="referenceTable" /></Field>
      <Field label={t('ddlReferenceColumns')}><input name="referenceColumns" /></Field>
      <Field label={t('ddlCheckExpression')}><input name="checkExpression" /></Field>
    </>}
    {advancedAction && !action.endsWith('-extension') && <Field label={t('ddlSchemaName')}><input name="advancedSchema" required autoFocus /></Field>}
    {advancedAction && <Field label={t('name')}><input name="advancedName" required /></Field>}
    {(action.endsWith('-trigger') || action.endsWith('-partition')) && <Field label={t('ddlTableName')}><input name="advancedTable" required /></Field>}
    {action === 'create-view' && <><Field label={t('ddlQuery')}><textarea name="query" required /></Field><label className="check-field"><input name="replace" type="checkbox" />{t('ddlReplace')}</label></>}
    {action === 'create-materialized-view' && <><Field label={t('ddlQuery')}><textarea name="query" required /></Field><label className="check-field"><input name="withData" type="checkbox" defaultChecked />{t('ddlWithData')}</label></>}
    {action === 'refresh-materialized-view' && <label className="check-field"><input name="concurrently" type="checkbox" />{t('ddlConcurrently')}</label>}
    {action === 'create-sequence' && <><Field label="START"><input name="start" type="number" /></Field><Field label="INCREMENT"><input name="increment" type="number" /></Field><Field label="CACHE"><input name="cache" type="number" /></Field><label className="check-field"><input name="cycle" type="checkbox" />{t('ddlCycle')}</label></>}
    {action === 'create-enum' && <Field label={t('ddlValues')}><input name="values" required /></Field>}
    {action === 'create-domain' && <><Field label={t('ddlBaseType')}><select name="baseType" required>{capabilities?.columnTypes.map((type) => <option key={type}>{type}</option>)}</select></Field><label className="check-field"><input name="nullable" type="checkbox" />{t('ddlNullable')}</label><Field label={t('ddlCheckExpression')}><input name="domainCheck" /></Field></>}
    {action === 'create-extension' && <><Field label={t('ddlSchemaName')}><input name="extensionSchema" /></Field><Field label={t('ddlVersion')}><input name="version" /></Field></>}
    {(action === 'create-routine' || action === 'drop-routine') && <><Field label={t('ddlRoutineKind')}><select name="routineKind"><option value="function" disabled={!capabilities?.advanced.function}>function</option><option value="procedure" disabled={!capabilities?.advanced.procedure}>procedure</option></select></Field><Field label={t('ddlArguments')}><input name="argumentTypes" /></Field></>}
    {action === 'create-routine' && <><Field label={t('ddlReturnType')}><input name="returnType" /></Field>{capabilities?.engine === 'postgres' && <Field label={t('ddlLanguage')}><select name="language"><option value="sql">sql</option><option value="plpgsql">plpgsql</option></select></Field>}{capabilities?.engine === 'mysql' && <><label className="check-field"><input name="deterministic" type="checkbox" />{t('ddlDeterministic')}</label><Field label={t('ddlDataAccess')}><select name="dataAccess" defaultValue=""><option value="">-</option><option value="no-sql">NO SQL</option><option value="contains-sql">CONTAINS SQL</option><option value="reads-sql-data">READS SQL DATA</option><option value="modifies-sql-data">MODIFIES SQL DATA</option></select></Field></>}<Field label={t('ddlBody')}><textarea name="body" required /></Field></>}
    {action === 'create-trigger' && <><Field label={t('ddlTriggerTiming')}><select name="timing"><option value="before">BEFORE</option><option value="after">AFTER</option><option value="instead-of">INSTEAD OF</option></select></Field><Field label={t('ddlTriggerEvents')}><input name="events" defaultValue="insert" required /></Field><Field label={t('ddlForEach')}><select name="forEach"><option value="row">ROW</option><option value="statement">STATEMENT</option></select></Field>{capabilities?.engine === 'postgres' ? <><Field label={t('ddlFunctionSchema')}><input name="functionSchema" required /></Field><Field label={t('ddlFunctionName')}><input name="functionName" required /></Field></> : <Field label={t('ddlBody')}><textarea name="body" required /></Field>}</>}
    {action === 'create-event' && <><Field label={t('ddlScheduleKind')}><select name="scheduleKind"><option value="every">EVERY</option><option value="at">AT</option></select></Field><Field label={t('ddlScheduleAmount')}><input name="scheduleAmount" type="number" defaultValue="1" /></Field><Field label={t('ddlScheduleUnit')}><select name="scheduleUnit"><option value="minute">MINUTE</option><option value="hour">HOUR</option><option value="day">DAY</option><option value="week">WEEK</option><option value="month">MONTH</option><option value="year">YEAR</option></select></Field><Field label={t('ddlScheduleAt')}><input name="scheduleAt" /></Field><label className="check-field"><input name="preserve" type="checkbox" />{t('ddlPreserve')}</label><label className="check-field"><input name="enabled" type="checkbox" defaultChecked />{t('ddlEnabled')}</label><Field label={t('ddlBody')}><textarea name="body" required /></Field></>}
    {action === 'create-partition' && <Field label={t('ddlDefinition')}><input name="definition" required /></Field>}
    {action.startsWith('drop-') && action !== 'drop-database' && <label className="check-field"><input name="cascade" type="checkbox" />{t('ddlCascade')}</label>}
  </>
}

function buildCoreDdlCommand(action: DdlAction, data: FormData, capabilities?: DdlCapabilities): Record<string, unknown> {
  const value = (name: string) => String(data.get(name) ?? '').trim()
  const list = (name: string) => value(name).split(',').map((item) => item.trim()).filter(Boolean)
  const number = (name: string) => value(name) ? Number(value(name)) : undefined
  const advancedSchema = value('advancedSchema')
  const advancedName = value('advancedName')
  const cascade = data.has('cascade') ? { cascade: true } : {}
  if (action === 'create-view') return { kind: action, schema: advancedSchema, name: advancedName, query: value('query'), ...(data.has('replace') ? { replace: true } : {}), confirmed: false }
  if (action === 'drop-view') return { kind: action, schema: advancedSchema, name: advancedName, ...cascade, confirmed: false }
  if (action === 'create-materialized-view') return { kind: action, schema: advancedSchema, name: advancedName, query: value('query'), withData: data.has('withData'), confirmed: false }
  if (action === 'refresh-materialized-view') return { kind: action, schema: advancedSchema, name: advancedName, ...(data.has('concurrently') ? { concurrently: true } : {}), confirmed: false }
  if (action === 'drop-materialized-view') return { kind: action, schema: advancedSchema, name: advancedName, ...cascade, confirmed: false }
  if (action === 'create-sequence') return { kind: action, schema: advancedSchema, name: advancedName, ...(number('start') === undefined ? {} : { start: number('start') }), ...(number('increment') === undefined ? {} : { increment: number('increment') }), ...(number('cache') === undefined ? {} : { cache: number('cache') }), ...(data.has('cycle') ? { cycle: true } : {}) }
  if (action === 'drop-sequence') return { kind: action, schema: advancedSchema, name: advancedName, ...cascade, confirmed: false }
  if (action === 'create-enum') return { kind: action, schema: advancedSchema, name: advancedName, values: list('values') }
  if (action === 'create-domain') return { kind: action, schema: advancedSchema, name: advancedName, baseType: { name: value('baseType') }, nullable: data.has('nullable'), ...(value('domainCheck') ? { check: value('domainCheck') } : {}), confirmed: false }
  if (action === 'drop-type') return { kind: action, schema: advancedSchema, name: advancedName, ...cascade, confirmed: false }
  if (action === 'create-extension') return { kind: action, name: advancedName, ...(value('extensionSchema') ? { schema: value('extensionSchema') } : {}), ...(value('version') ? { version: value('version') } : {}), ...cascade, confirmed: false }
  if (action === 'drop-extension') return { kind: action, name: advancedName, ...cascade, confirmed: false }
  if (action === 'create-routine') {
    const routineKind = value('routineKind')
    const returnType = value('returnType')
    return { kind: action, routineKind, schema: advancedSchema, name: advancedName, arguments: list('argumentTypes').map((type) => ({ type: { name: type } })), ...(returnType ? { returns: { name: returnType } } : {}), ...(capabilities?.engine === 'postgres' && value('language') ? { language: value('language') } : {}), ...(capabilities?.engine === 'mysql' && data.has('deterministic') ? { deterministic: true } : {}), ...(capabilities?.engine === 'mysql' && value('dataAccess') ? { dataAccess: value('dataAccess') } : {}), body: value('body'), confirmed: false }
  }
  if (action === 'drop-routine') return { kind: action, routineKind: value('routineKind'), schema: advancedSchema, name: advancedName, argumentTypes: list('argumentTypes').map((name) => ({ name })), ...cascade, confirmed: false }
  if (action === 'create-trigger') return { kind: action, schema: advancedSchema, table: value('advancedTable'), name: advancedName, timing: value('timing'), events: list('events'), forEach: value('forEach'), ...(capabilities?.engine === 'postgres' ? { functionSchema: value('functionSchema'), functionName: value('functionName') } : { body: value('body') }), confirmed: false }
  if (action === 'drop-trigger') return { kind: action, schema: advancedSchema, table: value('advancedTable'), name: advancedName, confirmed: false }
  if (action === 'create-event') return { kind: action, schema: advancedSchema, name: advancedName, schedule: value('scheduleKind') === 'at' ? { kind: 'at', at: value('scheduleAt') } : { kind: 'every', amount: Number(value('scheduleAmount')), unit: value('scheduleUnit') }, preserve: data.has('preserve'), enabled: data.has('enabled'), body: value('body'), confirmed: false }
  if (action === 'drop-event') return { kind: action, schema: advancedSchema, name: advancedName, confirmed: false }
  if (action === 'create-partition') return { kind: action, schema: advancedSchema, table: value('advancedTable'), name: advancedName, definition: value('definition'), confirmed: false }
  if (action === 'drop-partition') return { kind: action, schema: advancedSchema, table: value('advancedTable'), name: advancedName, confirmed: false }
  if (action.endsWith('-database')) {
    if (action === 'rename-database') return { kind: action, from: value('from'), to: value('to') }
    return { kind: action, name: value('name'), ...(action === 'drop-database' ? { confirmed: false } : {}) }
  }
  if (action.endsWith('-schema')) {
    if (action === 'rename-schema') return { kind: action, from: value('from'), to: value('to') }
    return { kind: action, name: value('name'), ...(action === 'drop-schema' ? { ...(data.has('cascade') ? { cascade: true } : {}), confirmed: false } : {}) }
  }
  const schema = value('schema')
  if (action === 'create-table') return { kind: action, schema, name: value('name'), columns: [{ name: value('column'), type: { name: value('columnType') }, nullable: data.has('nullable') }] }
  if (action === 'rename-table') return { kind: action, schema, from: value('from'), to: value('to') }
  if (action === 'drop-table') return { kind: action, schema, name: value('name'), ...(data.has('cascade') ? { cascade: true } : {}), confirmed: false }
  const table = value('table')
  if (action === 'add-column') return { kind: action, schema, table, column: { name: value('name'), type: { name: value('columnType') }, nullable: data.has('nullable') } }
  if (action === 'rename-column') return { kind: action, schema, table, from: value('from'), to: value('to'), ...(capabilities?.column.renameSyntax === 'change-column' ? { definition: { name: value('to'), type: { name: value('columnType') }, nullable: data.has('nullable') } } : {}) }
  if (action === 'drop-column') return { kind: action, schema, table, name: value('name'), ...(data.has('cascade') ? { cascade: true } : {}), confirmed: false }
  if (action === 'create-index') {
    const expression = value('expression')
    const predicate = value('predicate')
    return { kind: action, schema, table, name: value('name'), method: value('method'), unique: data.has('unique'), parts: expression ? [{ expression }] : [{ column: value('indexColumn') }], ...(predicate ? { predicate } : {}), confirmed: false }
  }
  if (action === 'drop-index') return { kind: action, schema, table, name: value('name'), confirmed: false }
  const constraintKind = value('constraintKind')
  if (action === 'drop-constraint') return { kind: action, schema, table, name: value('name'), constraintKind, ...(data.has('cascade') ? { cascade: true } : {}), confirmed: false }
  const columns = list('constraintColumns')
  const constraint = constraintKind === 'foreign-key'
    ? { kind: constraintKind, columns, referenceSchema: value('referenceSchema'), referenceTable: value('referenceTable'), referenceColumns: list('referenceColumns') }
    : constraintKind === 'check'
      ? { kind: constraintKind, expression: value('checkExpression') }
      : { kind: constraintKind, columns }
  return { kind: action, schema, table, name: value('name'), constraint, confirmed: false }
}

function requiresDdlConfirmation(command: Record<string, unknown>): boolean {
  if (String(command.kind).startsWith('drop-')) return true
  if (command.kind === 'create-index') return command.method !== 'btree' || Boolean(command.predicate) || 'expression' in ((command.parts as object[])[0] ?? {})
  if (command.kind === 'add-constraint') return (command.constraint as { kind: string }).kind !== 'unique'
  if (command.kind === 'create-domain') return Boolean(command.check)
  if (['create-view', 'create-materialized-view', 'refresh-materialized-view', 'create-extension', 'create-routine', 'create-trigger', 'create-event', 'create-partition'].includes(String(command.kind))) return true
  return false
}

function ddlActionSupported(action: DdlAction, capabilities?: DdlCapabilities): boolean {
  if (!capabilities) return false
  const operation = action.split('-')[0] as 'create' | 'rename' | 'drop' | 'add'
  const object = action.split('-')[1] as 'database' | 'schema' | 'table' | 'column' | 'index' | 'constraint'
  if (object === 'database' || object === 'schema' || object === 'table') return operation === 'add' || capabilities[object][operation]
  if (object === 'column') return operation !== 'rename' || capabilities.column.rename
  const advancedCapability = {
    'create-view': 'view', 'drop-view': 'view',
    'create-materialized-view': 'materializedView', 'refresh-materialized-view': 'materializedView', 'drop-materialized-view': 'materializedView',
    'create-sequence': 'sequence', 'drop-sequence': 'sequence',
    'create-enum': 'enum', 'create-domain': 'domain', 'drop-type': capabilities.advanced.enum ? 'enum' : 'domain',
    'create-extension': 'extension', 'drop-extension': 'extension',
    'create-routine': capabilities.advanced.function ? 'function' : 'procedure', 'drop-routine': capabilities.advanced.function ? 'function' : 'procedure',
    'create-trigger': 'trigger', 'drop-trigger': 'trigger',
    'create-event': 'event', 'drop-event': 'event',
    'create-partition': 'partition', 'drop-partition': 'partition',
  } as const
  if (action in advancedCapability) return capabilities.advanced[advancedCapability[action as keyof typeof advancedCapability]]
  return true
}

function ddlActionLabel(action: DdlAction) {
  const labels = {
    'create-database': 'ddlCreateDatabase', 'rename-database': 'ddlRenameDatabase', 'drop-database': 'ddlDropDatabase',
    'create-schema': 'ddlCreateSchema', 'rename-schema': 'ddlRenameSchema', 'drop-schema': 'ddlDropSchema',
    'create-table': 'ddlCreateTable', 'rename-table': 'ddlRenameTable', 'drop-table': 'ddlDropTable',
    'add-column': 'ddlAddColumn', 'rename-column': 'ddlRenameColumn', 'drop-column': 'ddlDropColumn',
    'create-index': 'ddlCreateIndex', 'drop-index': 'ddlDropIndex', 'add-constraint': 'ddlAddConstraint', 'drop-constraint': 'ddlDropConstraint',
    'create-view': 'ddlCreateView', 'drop-view': 'ddlDropView',
    'create-materialized-view': 'ddlCreateMaterializedView', 'refresh-materialized-view': 'ddlRefreshMaterializedView', 'drop-materialized-view': 'ddlDropMaterializedView',
    'create-sequence': 'ddlCreateSequence', 'drop-sequence': 'ddlDropSequence',
    'create-enum': 'ddlCreateEnum', 'create-domain': 'ddlCreateDomain', 'drop-type': 'ddlDropType',
    'create-extension': 'ddlCreateExtension', 'drop-extension': 'ddlDropExtension',
    'create-routine': 'ddlCreateRoutine', 'drop-routine': 'ddlDropRoutine',
    'create-trigger': 'ddlCreateTrigger', 'drop-trigger': 'ddlDropTrigger',
    'create-event': 'ddlCreateEvent', 'drop-event': 'ddlDropEvent',
    'create-partition': 'ddlCreatePartition', 'drop-partition': 'ddlDropPartition',
  } as const
  return labels[action]
}

function DataBrowser({ connectionId, locale, csrfToken, isAdmin }: { connectionId: string; locale: Locale; csrfToken: string; isAdmin: boolean }) {
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
  const [inspection, setInspection] = useState<DataMutationInspection>()
  const [refresh, setRefresh] = useState(0)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [editingRow, setEditingRow] = useState<Record<string, unknown>>()
  const [deletingRow, setDeletingRow] = useState<Record<string, unknown>>()
  const [mutationMode, setMutationMode] = useState<'insert' | 'batch'>()

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
    setOffset(0); setPage(undefined); setColumns([]); setInspection(undefined); setSelectedRows(new Set())
  }, [table])

  useEffect(() => {
    if (!schema || !table) return
    const base = `/api/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`
    void Promise.all([
      apiRequest<DatabaseColumn[]>(`${base}/columns`, { locale }),
      apiRequest<RowPage>(`${base}/rows?limit=100&offset=${offset}`, { locale }),
    ]).then(([nextColumns, nextPage]) => { setColumns(nextColumns); setPage(nextPage) })
      .catch((cause) => setError(errorMessage(cause)))
    if (isAdmin) {
      void apiRequest<DataMutationInspection>(`${base}/mutations`, { locale })
        .then(setInspection)
        .catch(() => setInspection(undefined))
    }
  }, [connectionId, isAdmin, locale, offset, refresh, schema, table])

  const mutationBase = schema && table ? `/api/connections/${encodeURIComponent(connectionId)}/schemas/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/mutations` : ''
  async function mutate(operations: unknown[]) {
    try {
      await apiRequest(mutationBase, { method: 'POST', locale, csrfToken, body: { operations } })
      setMutationMode(undefined); setEditingRow(undefined); setDeletingRow(undefined); setSelectedRows(new Set()); setRefresh((value) => value + 1)
    } catch (cause) { setError(errorMessage(cause)) }
  }
  function rowReference(row: Record<string, unknown>) {
    if (!inspection?.policy.identity) throw new Error('TABLE_WITHOUT_STABLE_KEY')
    const original = encodeRow(row, inspection)
    return { identity: Object.fromEntries(inspection.policy.identity.columns.map((name) => [name, original[name]])), original }
  }
  const selected = [...selectedRows].map((index) => page?.rows[index]).filter((row): row is Record<string, unknown> => row !== undefined)
  const rowLabel = (row: Record<string, unknown>) => inspection?.policy.identity?.columns.map((name) => formatCell(row[name])).join('/') ?? ''

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
          {view === 'rows' && <div className="row-toolbar">{inspection && <><button className="secondary-button compact-command" type="button" onClick={() => setMutationMode('insert')}><Plus size={15} />{t('createRow')}</button>{selected.length > 0 && inspection.policy.canUpdate && <button className="secondary-button compact-command" type="button" onClick={() => setMutationMode('batch')}>{t('batchEdit')} {selected.length} {t('rowUnit')}</button>}</>}<div className="pager"><IconButton label={t('previousPage')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}><ChevronLeft size={17} /></IconButton><span>{offset + 1}–{offset + (page?.rows.length ?? 0)}</span><IconButton label={t('nextPage')} disabled={page?.nextOffset === null || !page} onClick={() => setOffset(page?.nextOffset ?? offset)}><ChevronRight size={17} /></IconButton></div></div>}
        </div>
        {view === 'rows' ? <DataTable columns={page?.columns ?? []} rows={page?.rows ?? []} empty={t('noRows')} {...(inspection?.policy.identity ? { mutation: { selectedRows, setSelectedRows, canUpdate: inspection.policy.canUpdate, canDelete: inspection.policy.canDelete, rowLabel, edit: setEditingRow, remove: setDeletingRow, t } } : {})} /> : <ColumnTable columns={columns} />}
      </section>
      {inspection && mutationMode === 'insert' && <MutationDialog title={t('createRow')} inspection={inspection} mode="insert" locale={locale} onClose={() => setMutationMode(undefined)} onSubmit={(values) => void mutate([{ kind: 'insert', values }])} />}
      {inspection && editingRow && <MutationDialog title={t('editRow')} inspection={inspection} mode="patch" locale={locale} initial={editingRow} onClose={() => setEditingRow(undefined)} onSubmit={(patch) => void mutate([{ kind: 'update', ...rowReference(editingRow), patch }])} />}
      {inspection && mutationMode === 'batch' && <MutationDialog title={t('batchEdit')} inspection={inspection} mode="patch" locale={locale} onClose={() => setMutationMode(undefined)} onSubmit={(patch) => void mutate([{ kind: 'batch-update', rows: selected.map(rowReference), patch }])} />}
      {deletingRow && <ConfirmDialog title={t('deleteRow')} body={t('deleteRowBody')} confirm={t('delete')} cancel={t('cancel')} onCancel={() => setDeletingRow(undefined)} onConfirm={() => void mutate([{ kind: 'delete', ...rowReference(deletingRow), confirmed: true }])} />}
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

const WEB_CAPABILITIES: Array<{ value: WebCapability; label: 'structureRead' | 'dataRead' | 'queryRead' | 'dataWrite' | 'ddlWrite' | 'accountManage' }> = [
  { value: 'structure-read', label: 'structureRead' },
  { value: 'data-read', label: 'dataRead' },
  { value: 'query-read', label: 'queryRead' },
  { value: 'data-write', label: 'dataWrite' },
  { value: 'ddl-write', label: 'ddlWrite' },
  { value: 'account-manage', label: 'accountManage' },
]

function UserManagementDialog({ locale, csrfToken, connections, onClose }: { locale: Locale; csrfToken: string; connections: ConnectionProfile[]; onClose: () => void }) {
  const t = translations(locale)
  const [users, setUsers] = useState<User[]>([])
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<User>()
  const [assignments, setAssignments] = useState<WebAccessAssignment[]>([])
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setUsers(await apiRequest<User[]>('/api/users', { locale })) } catch (cause) { setError(errorMessage(cause)) }
  }, [locale])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!selected) { setAssignments([]); return }
    let active = true
    void apiRequest<WebAccessAssignment[]>(`/api/users/${selected.id}/access`, { locale })
      .then((value) => { if (active) setAssignments(value) })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [locale, selected?.id])

  function updateUser(next: User) {
    setSelected(next)
    setUsers((current) => current.map((user) => user.id === next.id ? next : user))
  }
  async function patchUser(body: { enabled: boolean } | { role: 'admin' | 'user' }) {
    if (!selected) return
    try {
      updateUser(await apiRequest<User>(`/api/users/${selected.id}`, { method: 'PATCH', locale, csrfToken, body }))
    } catch (cause) { setError(errorMessage(cause)) }
  }
  async function resetPassword() {
    if (!selected) return
    try {
      const result = await apiRequest<{ user: User; temporaryPassword: string }>(`/api/users/${selected.id}/reset-password`, { method: 'POST', locale, csrfToken, body: {} })
      updateUser(result.user); setTemporaryPassword(result.temporaryPassword)
    } catch (cause) { setError(errorMessage(cause)) }
  }
  async function deleteUser() {
    if (!selected) return
    try {
      await apiRequest<void>(`/api/users/${selected.id}`, { method: 'DELETE', locale, csrfToken, body: { confirmed: true } })
      setUsers((current) => current.filter((user) => user.id !== selected.id))
      setSelected(undefined); setConfirmingDelete(false); setTemporaryPassword('')
    } catch (cause) { setError(errorMessage(cause)); setConfirmingDelete(false) }
  }
  function capabilitiesFor(connectionId: string): WebCapability[] {
    return assignments.find((assignment) => assignment.connectionId === connectionId)?.capabilities ?? []
  }
  function setCapability(connectionId: string, capability: WebCapability, checked: boolean) {
    const current = capabilitiesFor(connectionId)
    const capabilities = checked ? [...current, capability] : current.filter((value) => value !== capability)
    const next = { userId: selected?.id ?? '', connectionId, capabilities }
    setAssignments((values) => [...values.filter((value) => value.connectionId !== connectionId), next])
  }
  async function saveAccess(connectionId: string) {
    if (!selected) return
    try {
      const next = await apiRequest<WebAccessAssignment>(`/api/users/${selected.id}/connections/${connectionId}/access`, { method: 'PUT', locale, csrfToken, body: { capabilities: capabilitiesFor(connectionId) } })
      setAssignments((values) => [...values.filter((value) => value.connectionId !== connectionId), next])
    } catch (cause) { setError(errorMessage(cause)) }
  }
  async function revokeAccess(connectionId: string) {
    if (!selected) return
    try {
      await apiRequest<void>(`/api/users/${selected.id}/connections/${connectionId}/access`, { method: 'DELETE', locale, csrfToken })
      setAssignments((values) => values.filter((value) => value.connectionId !== connectionId))
    } catch (cause) { setError(errorMessage(cause)) }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const result = await apiRequest<{ user: User; temporaryPassword: string }>('/api/users', {
        method: 'POST', locale, csrfToken,
        body: { username: data.get('username'), role: data.get('role'), ...(data.get('password') ? { password: data.get('password') } : {}) },
      })
      setTemporaryPassword(result.temporaryPassword)
      setCreating(false)
      await load()
    } catch (cause) { setError(errorMessage(cause)) }
  }
  return <><Modal title={t('userAccess')} onClose={onClose}><div className="user-manager"><div className="user-manager-toolbar"><span>{users.length} {t('users')}</span><button className="primary-button" type="button" onClick={() => { setCreating(true); setTemporaryPassword('') }}><UserPlus size={16} />{t('createUser')}</button></div>{temporaryPassword && <div className="temporary-secret" role="status"><span>{t('passwordShownOnce')}</span><code>{temporaryPassword}</code></div>}<div className="user-manager-grid"><div className="user-list">{users.map((user) => <button aria-label={user.username} className={selected?.id === user.id ? 'user-row active' : 'user-row'} key={user.id} type="button" onClick={() => { setSelected(user); setTemporaryPassword('') }}><strong>{user.username}</strong><span>{user.role === 'admin' ? t('adminRole') : t('userRole')}</span><span>{user.enabled ? t('enabled') : t('disabled')}</span></button>)}</div>{selected && <section className="user-detail"><div className="user-lifecycle"><label className="check-field"><input type="checkbox" aria-label={t('accountEnabled')} checked={selected.enabled} onChange={(event) => void patchUser({ enabled: event.target.checked })} />{t('accountEnabled')}</label><Field label={t('role')}><select value={selected.role} onChange={(event) => void patchUser({ role: event.target.value as 'admin' | 'user' })}><option value="user">{t('userRole')}</option><option value="admin">{t('adminRole')}</option></select></Field><button className="secondary-button" type="button" onClick={() => void resetPassword()}>{t('resetPassword')}</button><button className="danger-button" type="button" onClick={() => setConfirmingDelete(true)}>{t('deletePermanently')}</button></div><div className="access-list">{connections.map((connection) => <section className="access-row" key={connection.id}><header><strong>{connection.name}</strong><small>{connection.engine}</small></header><div className="capability-grid">{WEB_CAPABILITIES.map((capability) => <label className="check-field" key={capability.value}><input type="checkbox" checked={capabilitiesFor(connection.id).includes(capability.value)} onChange={(event) => setCapability(connection.id, capability.value, event.target.checked)} />{t(capability.label)}</label>)}</div><div className="access-actions"><button className="secondary-button" type="button" onClick={() => void saveAccess(connection.id)}>{t('saveAccess')}</button><button className="danger-button" type="button" onClick={() => void revokeAccess(connection.id)}>{t('revokeAccess')}</button></div></section>)}</div></section>}</div>{error && <div className="inline-error" role="alert">{error}</div>}</div>{creating && <Modal title={t('createUser')} onClose={() => setCreating(false)}><form className="stack-form" onSubmit={(event) => void submit(event)}><Field label={t('username')}><input name="username" required autoFocus /></Field><Field label={t('password')}><input name="password" type="password" minLength={12} placeholder={t('generatePassword')} /></Field><Field label={t('role')}><select name="role" defaultValue="user"><option value="user">{t('userRole')}</option><option value="admin">{t('adminRole')}</option></select></Field><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setCreating(false)}>{t('cancel')}</button><button className="primary-button" type="submit"><UserPlus size={16} />{t('create')}</button></div></form></Modal>}</Modal>{confirmingDelete && <ConfirmDialog title={t('deleteUserTitle')} body={t('deleteUserBody')} confirm={t('delete')} cancel={t('cancel')} onCancel={() => setConfirmingDelete(false)} onConfirm={() => void deleteUser()} />}</>
}

interface DataTableMutation {
  selectedRows: Set<number>
  setSelectedRows(value: Set<number>): void
  canUpdate: boolean
  canDelete: boolean
  rowLabel(row: Record<string, unknown>): string
  edit(row: Record<string, unknown>): void
  remove(row: Record<string, unknown>): void
  t: ReturnType<typeof translations>
}

function DataTable({ columns, rows, empty, mutation }: { columns: string[]; rows: Array<Record<string, unknown>>; empty: string; mutation?: DataTableMutation }) {
  if (rows.length === 0) return <div className="table-empty">{empty}</div>
  return <div className="table-scroll"><table><thead><tr>{mutation && <th className="row-select" />}{columns.map((column) => <th key={column}>{column}</th>)}{mutation && <th className="row-actions" />}</tr></thead><tbody>{rows.map((row, index) => { const label = mutation?.rowLabel(row) ?? ''; return <tr key={index}>{mutation && <td className="row-select"><input type="checkbox" aria-label={`${mutation.t('selectRow')} ${label}`} checked={mutation.selectedRows.has(index)} onChange={(event) => { const next = new Set(mutation.selectedRows); if (event.target.checked && next.size < 100) next.add(index); else next.delete(index); mutation.setSelectedRows(next) }} /></td>}{columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}{mutation && <td className="row-actions">{mutation.canUpdate && <IconButton label={`${mutation.t('editRow')} ${label}`} onClick={() => mutation.edit(row)}><Pencil size={14} /></IconButton>}{mutation.canDelete && <IconButton label={`${mutation.t('deleteRow')} ${label}`} onClick={() => mutation.remove(row)}><Trash2 size={14} /></IconButton>}</td>}</tr>})}</tbody></table></div>
}

function MutationDialog({ title, inspection, mode, locale, initial, onClose, onSubmit }: { title: string; inspection: DataMutationInspection; mode: 'insert' | 'patch'; locale: Locale; initial?: Record<string, unknown>; onClose: () => void; onSubmit: (values: Record<string, TaggedDatabaseValue>) => void }) {
  const t = translations(locale)
  const writable = inspection.table.columns.filter((column) => inspection.policy.writableColumns.includes(column.name))
  const [included, setIncluded] = useState(() => new Set(mode === 'insert' ? writable.map((column) => column.name) : []))
  const [modes, setModes] = useState<Record<string, 'value' | 'null' | 'default'>>(() => Object.fromEntries(writable.map((column) => [column.name, 'value'])))
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const values = Object.fromEntries(writable.filter((column) => included.has(column.name)).map((column) => [column.name, taggedFormValue(column.valueType, modes[column.name] ?? 'value', data.get(column.name))]))
    onSubmit(values)
  }
  return <Modal title={title} onClose={onClose}><form className="mutation-form" onSubmit={submit}>{writable.map((column) => { const active = included.has(column.name); const valueMode = modes[column.name] ?? 'value'; return <div className="mutation-field" key={column.name}>{mode === 'patch' && <div className="check-field"><input type="checkbox" aria-label={`${t('changeColumn')} ${column.name}`} checked={active} onChange={(event) => { const next = new Set(included); if (event.target.checked) next.add(column.name); else next.delete(column.name); setIncluded(next) }} /><span aria-hidden="true">{column.name}</span></div>}<Field label={column.name}><input name={column.name} aria-label={column.name} disabled={!active || valueMode !== 'value'} defaultValue={formValue(initial?.[column.name], column.valueType)} required={active && valueMode === 'value'} /></Field><select className="value-mode" aria-label={`${column.name} mode`} disabled={!active} value={valueMode} onChange={(event) => setModes({ ...modes, [column.name]: event.target.value as 'value' | 'null' | 'default' })}><option value="value">VALUE</option>{column.nullable && <option value="null">NULL</option>}<option value="default">DEFAULT</option></select></div>})}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit" disabled={included.size === 0}>{t('save')}</button></div></form></Modal>
}

function taggedFormValue(type: DatabaseValueType | 'unsupported', mode: 'value' | 'null' | 'default', raw: FormDataEntryValue | null): TaggedDatabaseValue {
  if (mode === 'null') return { kind: 'null' }
  if (mode === 'default') return { kind: 'default' }
  const text = String(raw ?? '')
  if (type === 'number') return { kind: 'value', type, value: Number(text) }
  if (type === 'boolean') return { kind: 'value', type, value: text === 'true' }
  if (type === 'json' || type === 'array') return { kind: 'value', type, value: JSON.parse(text) as unknown }
  if (type === 'unsupported') throw new Error('UNSUPPORTED_VALUE_TYPE')
  return { kind: 'value', type, value: text }
}

function encodeRow(row: Record<string, unknown>, inspection: DataMutationInspection): Record<string, TaggedDatabaseValue> {
  return Object.fromEntries(inspection.table.columns.filter((column) => column.valueType !== 'unsupported').map((column) => [column.name, taggedRawValue(row[column.name], column.valueType)]))
}

function taggedRawValue(value: unknown, type: DatabaseValueType | 'unsupported'): TaggedDatabaseValue {
  if (value === null) return { kind: 'null' }
  if (type === 'unsupported') throw new Error('UNSUPPORTED_VALUE_TYPE')
  if (type === 'number') return { kind: 'value', type, value: Number(value) }
  if (type === 'boolean') return { kind: 'value', type, value: Boolean(value) }
  if (type === 'json' || type === 'array') return { kind: 'value', type, value }
  if (type === 'binary' && typeof value === 'object' && value !== null && 'data' in value && Array.isArray((value as { data: unknown }).data)) return { kind: 'value', type, value: bytesToBase64((value as { data: number[] }).data) }
  return { kind: 'value', type, value: String(value) }
}

function formValue(value: unknown, type: DatabaseValueType | 'unsupported'): string {
  if (value === null || value === undefined) return ''
  if (type === 'json' || type === 'array') return JSON.stringify(value)
  return String(value)
}

function bytesToBase64(bytes: number[]): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function ColumnTable({ columns }: { columns: DatabaseColumn[] }) {
  return <div className="table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead><tbody>{columns.map((column) => <tr key={column.name}><td>{column.primaryKey && <span className="key-tag">PK</span>}{column.name}</td><td>{column.dataType}</td><td>{column.nullable ? 'YES' : 'NO'}</td><td>{column.defaultValue ?? 'NULL'}</td></tr>)}</tbody></table></div>
}

function Field({ label, compact = false, children }: { label: string; compact?: boolean; children: ReactNode }) { return <label className={compact ? 'field compact-field' : 'field'}><span>{label}</span>{children}</label> }
function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) { return <button className="icon-button" type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button> }
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) { const titleId = useId(); return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><IconButton label="Close" onClick={onClose}><X size={18} /></IconButton></header>{children}</section></div> }
function ConfirmDialog({ title, body, confirm, cancel, onConfirm, onCancel }: { title: string; body: string; confirm: string; cancel: string; onConfirm: () => void; onCancel: () => void }) { return <Modal title={title} onClose={onCancel}><div className="confirm-body"><AlertTriangle size={30} /><p>{body}</p></div><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onCancel}>{cancel}</button><button className="danger-button" type="button" onClick={onConfirm}>{confirm}</button></div></Modal> }
function formatCell(value: unknown): string { if (value === null || value === undefined) return 'NULL'; if (typeof value === 'object') return JSON.stringify(value); return String(value) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Request failed' }
