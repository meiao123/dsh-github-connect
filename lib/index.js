/**
 * dsh-github-connect — host half.
 *
 * What this half owns:
 *  - GitHub OAuth device flow (start + poll) and PAT validation,
 *  - the local credential file `<plugin>/.github-auth.json`,
 *  - same-origin HTTP routes under /dsh-github/* for the browser half,
 *  - the model-facing `github_api` tool and its prompt guidance.
 *
 * The token never leaves this machine except as a Bearer header sent
 * directly to api.github.com. The credential file is gitignored.
 * Network reachability (proxy + system CA) is handled by ./net.js, which
 * works on Windows, macOS and Linux with or without a proxy.
 *
 * Expiring user tokens — the default for OAuth Apps registered today — are
 * supported: whenever GitHub hands back a `refresh_token` it is stored next to
 * the access token and used to renew it automatically before it lapses.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatcherFor } from './net.js'

export const name = 'dsh-github-connect'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const AUTH_FILE = join(PLUGIN_DIR, '.github-auth.json')
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-github-connect'
const DEFAULT_SCOPES = 'repo gist read:org workflow'
const DEFAULT_MAX_BODY_CHARS = 60000
// Client id shapes. GitHub Apps use `Iv1.` + 16 chars. OAuth Apps use
// 20 characters: legacy apps were issued 20 hex chars
// (`a1b2c3d4e5f6a7b8c9d0`), but apps registered today get a base62 id such as
// `0v23i1oAZuA2IERUSbdQ` or `Ov23liXXXXXXXXXXXXXX`. Only the shape is checked
// here — GitHub itself is the judge of whether the id exists.
const CLIENT_ID_RE = /^(?:[A-Za-z0-9]{20}|Iv1\.[A-Za-z0-9]{16})$/
// Renew an access token this long before its deadline so no request races it.
const REFRESH_SKEW_MS = 120000
const SCOPE_RE = /^[a-z0-9:,_\- ]*$/i

// Active plugin config (set by apply()); the network layer reads it for
// proxy/CA behavior. `proxy` accepts 'auto' (default), 'direct', or a URL.
let activeConfig = {}

/** Fetch with the plugin's trusted dispatcher (proxy + system CA aware). */
async function fetchGithub(url, init) {
  const dispatcher = await dispatcherFor(new URL(url).hostname, activeConfig)
  return fetch(url, { ...init, ...(dispatcher !== undefined ? { dispatcher } : {}) })
}

// ── credential store ───────────────────────────────────────────────────────

let authCache = null

function readAuth() {
  if (authCache !== null) return authCache
  try {
    if (!existsSync(AUTH_FILE)) return null
    const parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
    authCache = parsed !== null && typeof parsed === 'object' ? parsed : null
    return authCache
  } catch {
    return null
  }
}

function writeAuth(record) {
  authCache = record
  if (record === null) {
    try {
      if (existsSync(AUTH_FILE)) writeFileSync(AUTH_FILE, '')
    } catch {
      /* best effort */
    }
    return
  }
  const tmp = `${AUTH_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, AUTH_FILE)
}

/** Public status: never contains the token itself. */
function publicStatus() {
  const auth = readAuth()
  if (auth === null || typeof auth.token !== 'string' || auth.token === '') {
    return { connected: false, clientId: typeof auth?.clientId === 'string' ? auth.clientId : null }
  }
  return {
    connected: true,
    login: auth.login ?? null,
    avatarUrl: auth.avatarUrl ?? null,
    name: auth.displayName ?? null,
    kind: auth.kind ?? null,
    scopes: Array.isArray(auth.scopes) ? auth.scopes : [],
    connectedAt: auth.connectedAt ?? null,
    lastVerifiedAt: typeof auth.lastVerifiedAt === 'string' ? auth.lastVerifiedAt : null,
    clientId: typeof auth.clientId === 'string' ? auth.clientId : null,
    // Expiring-token support: only the deadlines are exposed, never a token.
    expiresAt: typeof auth.accessTokenExpiresAt === 'string' ? auth.accessTokenExpiresAt : null,
    refreshExpiresAt: typeof auth.refreshTokenExpiresAt === 'string' ? auth.refreshTokenExpiresAt : null,
    canRefresh:
      typeof auth.refreshToken === 'string' && auth.refreshToken !== '' &&
      typeof auth.clientId === 'string' && auth.clientId !== '',
    hasClientSecret: typeof auth.clientSecret === 'string' && auth.clientSecret !== '',
  }
}

/** ISO deadline `seconds` from now, or null when GitHub sent none. */
function isoIn(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null
}

/** Has an ISO deadline passed (optionally with a safety margin)? */
function isExpired(iso, skewMs = 0) {
  if (typeof iso !== 'string' || iso === '') return false
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return false
  return at - skewMs <= Date.now()
}

/**
 * Deadline fields carried by a token response. GitHub only sends them while
 * the OAuth App has "Expire user access tokens" enabled; without them the
 * token simply never expires and none of this runs.
 */
function tokenFields(data) {
  const fields = {}
  if (typeof data.refresh_token === 'string' && data.refresh_token !== '') {
    fields.refreshToken = data.refresh_token
  }
  const accessExpiresAt = isoIn(data.expires_in)
  if (accessExpiresAt !== null) fields.accessTokenExpiresAt = accessExpiresAt
  const refreshExpiresAt = isoIn(data.refresh_token_expires_in)
  if (refreshExpiresAt !== null) fields.refreshTokenExpiresAt = refreshExpiresAt
  return fields
}

/**
 * Exchange the stored refresh token for a fresh access token. GitHub rotates
 * the refresh token on every use, so its replacement is persisted at once.
 * Returns `{ auth }` on success, `{ error }` when renewal is impossible.
 */
async function refreshAccessToken(auth) {
  const refreshToken = typeof auth.refreshToken === 'string' ? auth.refreshToken : ''
  const clientId = typeof auth.clientId === 'string' ? auth.clientId : ''
  if (refreshToken === '' || clientId === '') {
    return { error: '没有可用的 refresh token，无法自动续期，请重新连接 GitHub。' }
  }
  const fields = {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }
  // GitHub asks for the client secret on the refresh grant. When the user
  // stored one we send it; without one we still try, because some app types
  // accept the public-client path — and the error below says what to do next.
  if (typeof auth.clientSecret === 'string' && auth.clientSecret !== '') {
    fields.client_secret = auth.clientSecret
  }
  let res
  try {
    res = await ghFetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: formBody(fields),
    })
  } catch (error) {
    return { error: `无法连接 github.com：${error instanceof Error ? error.message : String(error)}` }
  }
  const data = await res.json().catch(() => null)
  if (data === null || typeof data.access_token !== 'string' || data.access_token === '') {
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`
    const hint = fields.client_secret === undefined
      ? '。GitHub 的续期请求通常还需要该 OAuth App 的 Client Secret——在连接面板填上它即可自动续期，或到 App 设置里关闭「Expire user access tokens」'
      : ''
    return { error: `令牌续期失败：${detail}${hint}` }
  }
  const next = { ...auth, token: data.access_token, ...tokenFields(data) }
  writeAuth(next)
  return { auth: next }
}

/**
 * Hand back a credential that is safe to use right now: when the access token
 * is at (or past) its deadline the refresh grant runs first. `auth: null` means
 * the connection is gone; a populated `error` means the token is still stored
 * but cannot be used — the caller decides what to tell the user.
 */
async function ensureFreshToken(auth) {
  if (auth === null) return { auth: null }
  if (typeof auth.refreshToken !== 'string' || auth.refreshToken === '') return { auth }
  if (typeof auth.accessTokenExpiresAt !== 'string') return { auth }
  if (!isExpired(auth.accessTokenExpiresAt, REFRESH_SKEW_MS)) return { auth }
  if (isExpired(auth.refreshTokenExpiresAt, 0)) {
    return { auth: null, error: 'GitHub 授权已失效（refresh token 也已过期），请在连接面板重新授权。' }
  }
  const refreshed = await refreshAccessToken(auth)
  if (refreshed.auth !== undefined) return { auth: refreshed.auth }
  return { auth, error: refreshed.error }
}

/**
 * Re-validate the stored token against GitHub (called when the UI shows the
 * status — after a dsh restart the "connected" state is therefore refreshed,
 * not replayed from disk). On success the `lastVerifiedAt` stamp is updated;
 * an expired access token is renewed when possible; a definitive 401 clears
 * the stale connection; transient failures keep the token and report
 * `verified: false` so an offline host never logs the user out by accident.
 */
async function verifyAuth() {
  const auth = readAuth()
  if (auth === null || typeof auth.token !== 'string' || auth.token === '') {
    return { connected: false, lastVerifiedAt: null }
  }
  const fresh = await ensureFreshToken(auth)
  if (fresh.auth === null) {
    writeAuth(null)
    return { connected: false, lastVerifiedAt: null, invalidated: true, message: fresh.error ?? null }
  }
  const result = await apiUser(fresh.auth.token)
  if (result.user !== undefined) {
    writeAuth({ ...fresh.auth, lastVerifiedAt: new Date().toISOString() })
    return { ...publicStatus(), verified: true }
  }
  if (result.status === 401) {
    // Between the deadline check and this call the token may have lapsed (or
    // GitHub revoked it early): one renewal attempt before the connection is
    // dropped, so a stale deadline never logs the user out for nothing.
    const renewable =
      fresh.error === undefined &&
      typeof fresh.auth.refreshToken === 'string' && fresh.auth.refreshToken !== ''
    if (renewable) {
      const refreshed = await refreshAccessToken(fresh.auth)
      if (refreshed.auth !== undefined) {
        const retry = await apiUser(refreshed.auth.token)
        if (retry.user !== undefined) {
          writeAuth({ ...refreshed.auth, lastVerifiedAt: new Date().toISOString() })
          return { ...publicStatus(), verified: true }
        }
      } else if (refreshed.error !== undefined) {
        writeAuth(null)
        return { connected: false, lastVerifiedAt: null, invalidated: true, message: refreshed.error }
      }
    }
    writeAuth(null)
    return { connected: false, lastVerifiedAt: null, invalidated: true, message: result.message }
  }
  return { ...publicStatus(), verified: false, message: result.message }
}

function rememberClientId(clientId, clientSecret) {
  const auth = readAuth() ?? {}
  auth.clientId = clientId
  if (typeof clientSecret === 'string' && clientSecret !== '') auth.clientSecret = clientSecret
  writeAuth(auth)
}

// ── GitHub plumbing ────────────────────────────────────────────────────────

async function ghFetch(url, options, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchGithub(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Validate a token and read the account. Never throws for HTTP errors:
 * returns { status, message?, user? } with GitHub's own detail attached.
 * status: 0 = network failure, 200 = success, otherwise HTTP status.
 */
async function apiUser(token) {
  let res
  try {
    res = await ghFetch(`${API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
      },
    })
  } catch (error) {
    // undici reports network/TLS failures as "fetch failed" with the real
    // reason on `cause` — surface both so the model or user can act on it.
    let reason = error instanceof Error ? error.message : String(error)
    const cause = error?.cause
    if (cause instanceof Error && cause.message !== reason) reason = `${reason}：${cause.message}`
    return {
      status: 0,
      message: `无法连接 GitHub API：${reason}。请检查网络代理设置后重试。`,
    }
  }
  const text = await res.text().catch(() => '')
  if (res.ok) {
    try {
      return { status: res.status, user: JSON.parse(text) }
    } catch {
      return { status: res.status, message: 'GitHub 响应异常，请稍后重试' }
    }
  }
  let detail = ''
  try {
    detail = JSON.parse(text)?.message ?? ''
  } catch {
    detail = text.slice(0, 200)
  }
  if (res.status === 401) {
    return { status: 401, message: `Token 无效（Bad credentials）：令牌可能已过期、被撤销，或复制时带了多余字符。GitHub：${detail || 'Bad credentials'}` }
  }
  if (res.status === 403) {
    return { status: 403, message: `GitHub 拒绝了请求（限流或权限不足）：${detail || 'API rate limit exceeded'}。稍等一分钟再试。` }
  }
  if (res.status === 404) {
    return { status: 404, message: `令牌有效，但无法访问该账号（fine-grained token 需要 Account → Metadata 读权限）：${detail || 'Not Found'}` }
  }
  return { status: res.status, message: `GitHub API 返回 HTTP ${res.status}：${detail || '(无详情)'}` }
}

function formBody(fields) {
  return new URLSearchParams(fields).toString()
}

async function deviceStart(clientId, scopes) {
  let res
  try {
    res = await ghFetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: formBody({ client_id: clientId, scope: scopes }),
    })
  } catch (error) {
    return { error: `无法连接 github.com：${error instanceof Error ? error.message : String(error)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data === null || typeof data.device_code !== 'string') {
    return { error: data?.error_description || data?.message || `GitHub 拒绝了该 Client ID（HTTP ${res.status}）` }
  }
  rememberClientId(clientId)
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: Math.max(1, typeof data.interval === 'number' ? data.interval : 5),
  }
}

async function devicePoll(clientId, deviceCode) {
  let res
  try {
    res = await ghFetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: formBody({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
  } catch (error) {
    return { status: 'error', message: `无法连接 github.com：${error instanceof Error ? error.message : String(error)}` }
  }
  const data = await res.json().catch(() => null)
  if (data !== null && typeof data.access_token === 'string' && data.access_token.length > 0) {
    const userResult = await apiUser(data.access_token)
    if (userResult.user === undefined) {
      return { status: 'error', message: userResult.message ?? '授权成功，但读取账号信息失败，请重试' }
    }
    const user = userResult.user
    const scopes = typeof data.scope === 'string'
      ? data.scope.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    const remembered = readAuth() ?? {}
    writeAuth({
      kind: 'oauth',
      token: data.access_token,
      login: user.login,
      avatarUrl: user.avatar_url ?? null,
      displayName: user.name ?? null,
      scopes,
      connectedAt: new Date().toISOString(),
      clientId,
      // Carried across re-authorizations so automatic renewal keeps working.
      ...(typeof remembered.clientSecret === 'string' && remembered.clientSecret !== ''
        ? { clientSecret: remembered.clientSecret }
        : {}),
      // Present only while the App has "Expire user access tokens" enabled.
      ...tokenFields(data),
    })
    return {
      status: 'authorized',
      user: { login: user.login, avatarUrl: user.avatar_url ?? null, name: user.name ?? null, scopes },
    }
  }
  const code = data?.error ?? null
  if (code === 'authorization_pending') return { status: 'pending' }
  if (code === 'slow_down') return { status: 'pending', slowDown: true }
  if (code === 'expired_token') return { status: 'expired', message: '验证码已过期，请重新开始连接' }
  if (code === 'access_denied') return { status: 'denied', message: '授权被拒绝' }
  return { status: 'error', message: data?.error_description || data?.error || `GitHub 返回 HTTP ${res.status}` }
}

async function savePat(token) {
  let last = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await apiUser(token)
    if (result.user !== undefined) {
      const user = result.user
      writeAuth({
        kind: 'pat',
        token,
        login: user.login,
        avatarUrl: user.avatar_url ?? null,
        displayName: user.name ?? null,
        scopes: [],
        connectedAt: new Date().toISOString(),
      })
      return { user: { login: user.login, avatarUrl: user.avatar_url ?? null, name: user.name ?? null } }
    }
    last = result
    // Transient conditions deserve one retry: network blips, 5xx, rate limit.
    if (attempt === 1 && (result.status === 0 || result.status >= 500 || result.status === 403)) {
      await sleep(800)
      continue
    }
    break
  }
  return { error: last?.message ?? 'Token 无效，请检查后重试' }
}

// ── HTTP routes ────────────────────────────────────────────────────────────

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendText(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(text)
}

async function readJson(request, limitBytes = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === 'null') return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const ROUTES = [
  {
    method: 'GET',
    path: '/dsh-github/status',
    mutation: false,
    handle: async () => publicStatus(),
  },
  {
    method: 'POST',
    path: '/dsh-github/verify',
    mutation: true,
    handle: async () => verifyAuth(),
  },
  {
    method: 'POST',
    path: '/dsh-github/device/start',
    mutation: true,
    handle: async (input) => {
      const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
      if (!CLIENT_ID_RE.test(clientId)) {
        return { error: 'Client ID 格式不正确。请填写 GitHub OAuth App 的 20 位 Client ID（在 App 设置页可复制：老应用形如 a1b2c3d4e5f6a7b8c9d0，新应用形如 0v23i1oAZuA2IERUSbdQ / Ov23liXXXXXXXXXXXXXX）。' }
      }
      const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : ''
      const scopes = typeof input.scopes === 'string' && input.scopes.trim() !== ''
        ? input.scopes.trim()
        : DEFAULT_SCOPES
      if (scopes.length > 200 || !SCOPE_RE.test(scopes)) return { error: 'scopes 格式不正确' }
      const result = await deviceStart(clientId, scopes)
      // Remembered only once GitHub accepted the id, so a typo can never
      // overwrite a working credential.
      if (result.error === undefined) rememberClientId(clientId, clientSecret)
      return result
    },
  },
  {
    method: 'POST',
    path: '/dsh-github/device/poll',
    mutation: true,
    handle: async (input) => {
      const clientId = typeof input.clientId === 'string' ? input.clientId : ''
      const deviceCode = typeof input.deviceCode === 'string' ? input.deviceCode : ''
      if (clientId === '' || deviceCode === '') return { error: '缺少连接参数，请重新开始' }
      return devicePoll(clientId, deviceCode)
    },
  },
  {
    method: 'POST',
    path: '/dsh-github/pat',
    mutation: true,
    handle: async (input) => {
      let token = typeof input.token === 'string' ? input.token.trim() : ''
      // Strip accidental wrapping quotes picked up during copy-paste.
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1)
      }
      if (token.length < 10 || token.length > 400) return { error: '请填写有效的 Personal Access Token' }
      return savePat(token)
    },
  },
  {
    method: 'POST',
    path: '/dsh-github/disconnect',
    mutation: true,
    handle: async () => {
      writeAuth(null)
      return { connected: false }
    },
  },
]

async function handleRoute(request, response) {
  let url
  try {
    url = new URL(request.url ?? '/', 'http://127.0.0.1')
  } catch {
    sendText(response, 400, 'bad request')
    return
  }
  const method = request.method ?? 'GET'
  const route = ROUTES.find((candidate) => candidate.method === method && candidate.path === url.pathname)
  if (route === undefined) {
    sendJson(response, 404, { error: 'not found' })
    return
  }
  if (route.mutation && !sameOrigin(request)) {
    sendJson(response, 403, { error: '跨域请求被拒绝' })
    return
  }
  try {
    const input = route.mutation ? await readJson(request) : {}
    const result = await route.handle(input)
    sendJson(response, 200, result)
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

// ── model tool ─────────────────────────────────────────────────────────────

function registerGithubTool(ctx, maxBodyChars) {
  ctx.tools.register(defineTool({
    name: 'github_api',
    description:
      'Call the GitHub REST API with the GitHub account the user connected through the composer button. ' +
      'Use it for issues, pull requests, repositories, gists, workflow runs, contents, and any other ' +
      'api.github.com endpoint. Read operations first; be careful with destructive writes.',
    parameters: {
      method: {
        type: 'string',
        required: true,
        description: 'HTTP method: GET, POST, PATCH, PUT or DELETE.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'API path relative to https://api.github.com, starting with /, e.g. /repos/{owner}/{repo}/issues.',
      },
      body: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional JSON request body for write methods.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'integer' },
          error: { type: 'string' },
          body: { type: 'string' },
          rateLimit: { type: 'string' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `github_api ${args.method.toUpperCase()} ${args.path} -> HTTP ${value.status ?? 0}\n${value.error ?? value.body ?? ''}`.slice(0, 4000),
      }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const auth = readAuth()
      if (auth === null || typeof auth.token !== 'string' || auth.token === '') {
        return {
          ok: false,
          status: 401,
          error: 'GitHub 未连接。请在对话框左下角点击 GitHub 按钮完成授权（OAuth 设备流或粘贴 Token），再让我继续。',
        }
      }
      const method = String(args.method).toUpperCase()
      const path = String(args.path)
      if (!/^\/[A-Za-z0-9\-._~/%]*$/.test(path)) {
        return { ok: false, status: 400, error: `非法 API 路径：${path}` }
      }
      // A lapsed access token is renewed here, before anything is sent.
      const fresh = await ensureFreshToken(auth)
      if (fresh.auth === null || fresh.error !== undefined) {
        return { ok: false, status: 401, error: fresh.error ?? 'GitHub 授权已失效，请在左下角重新连接。' }
      }
      let credential = fresh.auth
      const init = { method, signal: exec?.signal ?? undefined }
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(args.body ?? {})
      }
      let res
      for (let attempt = 1; attempt <= 2; attempt++) {
        const headers = {
          Authorization: `Bearer ${credential.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
        }
        if (init.body !== undefined) headers['Content-Type'] = 'application/json'
        try {
          res = await fetchGithub(`${API_BASE}${path}`, { ...init, headers })
        } catch (error) {
          return { ok: false, status: 0, error: `GitHub 请求失败：${error instanceof Error ? error.message : String(error)}` }
        }
        // A 401 that survived the deadline check means GitHub aged out or
        // revoked the token early: renew once, then report honestly.
        if (res.status !== 401 || attempt === 2) break
        if (typeof credential.refreshToken !== 'string' || credential.refreshToken === '') break
        await res.text().catch(() => '')
        const refreshed = await refreshAccessToken(credential)
        if (refreshed.auth === undefined) break
        credential = refreshed.auth
      }
      const text = await res.text()
      const body = text.length > maxBodyChars ? `${text.slice(0, maxBodyChars)}\n…（已截断）` : text
      const rateLimit = `limit=${res.headers.get('x-ratelimit-limit') ?? '?'} remaining=${res.headers.get('x-ratelimit-remaining') ?? '?'}`
      return { ok: res.ok, status: res.status, body, rateLimit }
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool:github_api',
    order: 112,
    text:
      'The user may connect a GitHub account through the GitHub button at the bottom-left of the chat composer (OAuth device flow or a personal access token). When connected, use the github_api tool to act on that account: issues, pull requests, repositories, gists, workflow runs, contents, etc. Prefer read-only calls first and explain what will change before destructive writes. If github_api reports that GitHub is not connected or returns status 401, do not retry — ask the user to click the GitHub button in the composer and authorize.',
  })
}

// ── plugin entry ───────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const maxBodyChars = typeof config?.maxBodyChars === 'number' && config.maxBodyChars > 0
    ? config.maxBodyChars
    : DEFAULT_MAX_BODY_CHARS
  // The network layer reads proxy/noProxy/CA behavior from the row config.
  activeConfig = {
    ...(typeof config?.proxy === 'string' ? { proxy: config.proxy } : {}),
    ...(Array.isArray(config?.noProxy) ? { noProxy: config.noProxy } : {}),
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-github',
      handler: handleRoute,
    })
    hostCtx.effect(() => dispose, 'dsh-github-connect: http routes')
  })

  ctx.inject(['tools', 'systemPrompt'], (agentCtx) => {
    registerGithubTool(agentCtx, maxBodyChars)
  })
}
