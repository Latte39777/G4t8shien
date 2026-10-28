/**
 * 公式情報ページの限定取得エンジン（M6-F）
 *
 * 【責務】
 * - URL 台帳（lib/supports/sourceLedger.ts）に登録済みの公式ページだけを対象に、
 *   ページ本文を安全に取得する。Web 全体の自動巡回クローラーは作らない。
 * - 取得元 URL・ページタイトル・取得日時・取得結果（失敗理由付き）を記録する。
 * - HTML から制度情報の抽出に使える本文を整理する（script/style 等は除去のみで
 *   実行しない。JavaScript・埋め込みコードは一切実行しない）。
 *
 * 【安全性（SSRF・悪意ある応答対策）】
 * - HTTPS 必須（http は拒否）。URL 内のユーザー情報（user:pass@）は拒否。
 * - 登録済み公式ホスト名の許可リストに無いホストへは接続しない（サブドメインの
 *   推測許可もしない。完全一致のみ）。
 * - localhost・プライベート IP・内部ネットワーク宛（IPv4/IPv6 リテラル・
 *   .local/.internal 等）へのアクセスを禁止する。
 * - リダイレクトは手動で追い、遷移先ごとに上記の再検証を行う（最大回数あり）。
 * - 接続タイムアウト・本文サイズ上限・許可コンテンツ形式（text/html 系のみ）を適用。
 * - PDF の取得・本文抽出は未対応（抽出ライブラリが無いため。application/pdf は
 *   unsupported-content-type として失敗記録する）。
 * - robots.txt を取得し、Disallow に当たるパスは取得しない。
 *   robots.txt が取得できない場合は安全側に倒して取得を中止する。
 *
 * 【テスト可能】transport（fetch 相当）を注入する。通常テストは偽 transport を使い、
 * 外部ネットワークへ一切接続しない。本モジュール自体はグローバル fetch を呼ばない
 * （fetchTransport 経由で利用側が明示的に注入した場合のみ）。
 */
/** fetch 相当の最小インターフェース（テスト用偽 transport の注入も可能） */
export type TransportHeaders = { get(name: string): string | null }
export type TransportResponse = {
  status: number
  headers: TransportHeaders
  text(): Promise<string>
}
export type TransportInit = {
  method: 'GET'
  redirect: 'manual'
  headers: Record<string, string>
  signal?: AbortSignal
}
export type FetchTransport = (
  url: string,
  init: TransportInit,
) => Promise<TransportResponse>

/** 取得に失敗した理由の分類（未確認情報を確定扱いしないための分類） */
export const FETCH_FAILURE_CODES = [
  'invalid-url',
  'insecure-scheme',
  'credentials-in-url',
  'blocked-target',
  'not-allowlisted',
  'robots-disallowed',
  'robots-unavailable',
  'redirect-blocked',
  'too-many-redirects',
  'timeout',
  'network-error',
  'http-error',
  'too-large',
  'unsupported-content-type',
  'invalid-content',
] as const
export type FetchFailureCode = (typeof FETCH_FAILURE_CODES)[number]

/** 取得結果の記録（取得元 URL・タイトル・取得日時・取得結果・失敗理由） */
export type RetrievalRecord = {
  /** 取得対象として指定した URL */
  url: string
  /** リダイレクト後の最終 URL（取得できた場合のみ） */
  finalUrl: string | null
  /** ページタイトル（HTML から抽出できた場合のみ） */
  title: string | null
  /** 取得日時（ISO 8601。人手確認日時 review.reviewedAt とは別に保持する） */
  retrievedAt: string
  /** 取得結果。失敗は理由コード */
  result: 'ok' | FetchFailureCode
  /** 失敗理由（成功時は null） */
  failureReason: string | null
  httpStatus: number | null
  contentType: string | null
  byteSize: number | null
  /** robots.txt を確認できた日時（確認できなかった場合は null） */
  robotsCheckedAt: string | null
}

/** 整形済みページ本文（制度情報の抽出に使う。全文保存は必須としない） */
export type FetchedPage = {
  title: string | null
  /** 本文テキスト（タグ除去済み・空白正規化済み） */
  text: string
  /** 必要最小限の引用用抜粋 */
  excerpt: string
  /**
   * ページ内リンクの href 属性値（生の値。実行・解決はしない。M7-D）。
   * 相対 URL の解決と取得可否の判定は lib/discovery/linkScan.ts が行う。
   */
  hrefs: string[]
}

export type SourceFetchResult =
  | {
      ok: true
      record: RetrievalRecord
      page: FetchedPage
      /** キャッシュからの再利用（record.retrievedAt は元の取得日時のまま） */
      fromCache: boolean
    }
  | { ok: false; record: RetrievalRecord; fromCache: boolean }

/** 取得対象の判定結果 */
export type FetchPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: FetchFailureCode; reason: string }

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.home', '.lan', '.localhost']

/** ホスト名が localhost・プライベート IP・内部ネットワーク向けなら true（禁止） */
export function isBlockedNetworkTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost') return true
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return true
  }
  // IPv6 リテラル（コロンを含む）はすべて禁止（IPv4-mapped を含む）
  if (host.includes(':')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m === null) return false
  const octets = m.slice(1, 5).map((s) => Number(s))
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true
  const a = octets[0]
  const b = octets[1]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a !== undefined && a >= 224) return true
  return false
}

/**
 * 取得対象 URL の許可判定（純関数）。
 * - HTTPS 必須・URL 内ユーザー情報拒否・許可ホスト完全一致・内部ネットワーク禁止
 * - ポートは省略（443）のみ許可
 */
export function evaluateFetchTarget(
  rawUrl: string,
  allowedHosts: ReadonlySet<string>,
): FetchPolicyDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, code: 'invalid-url', reason: `URL として解釈できません: ${rawUrl}` }
  }
  if (url.protocol !== 'https:') {
    return {
      allowed: false,
      code: 'insecure-scheme',
      reason: `HTTPS 以外は取得しません（${url.protocol}）`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return {
      allowed: false,
      code: 'credentials-in-url',
      reason: 'URL にユーザー情報が含まれるため取得しません',
    }
  }
  if (url.port !== '' && url.port !== '443') {
    return {
      allowed: false,
      code: 'blocked-target',
      reason: `標準以外のポート（${url.port}）は取得しません`,
    }
  }
  const host = url.hostname.toLowerCase()
  if (isBlockedNetworkTarget(host)) {
    return {
      allowed: false,
      code: 'blocked-target',
      reason: `localhost・内部ネットワーク宛のため取得しません（${host}）`,
    }
  }
  if (!allowedHosts.has(host)) {
    return {
      allowed: false,
      code: 'not-allowlisted',
      reason: `許可リストに無いホストのため取得しません（${host}）`,
    }
  }
  return { allowed: true }
}

// ── robots.txt（取得先のアクセス制限を遵守する）────────────────────

export type RobotsRule = { allow: boolean; path: string }
export type RobotsGroup = { agents: string[]; rules: RobotsRule[] }
export type RobotsRuleset = { groups: RobotsGroup[] }

/**
 * robots.txt をパースする（純関数・User-agent グループと Allow/Disallow のみ対応）。
 * 不明なディレクティブは無視する（解釈できない行で許可扱いにしない）。
 */
export function parseRobots(text: string): RobotsRuleset {
  const groups: RobotsGroup[] = []
  let current: RobotsGroup | null = null
  let lastWasAgent = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const field = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (field === 'user-agent') {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (current === null) continue
    // Disallow: （空）は全許可を意味する（ルールとして追加しない）
    if (value === '') continue
    if (field === 'disallow') {
      current.rules.push({ allow: false, path: value })
      continue
    }
    if (field === 'allow') {
      current.rules.push({ allow: true, path: value })
      continue
    }
    // その他のフィールド（Crawl-delay 等）には対応しない
  }
  return { groups }
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  // robots のパスパターン（'*' 任意文字列、'$' 末尾）に簡易対応
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const anchoredEnd = pattern.endsWith('$')
  const source = anchoredEnd ? escaped.replace(/\\\$$/, '$') : escaped
  return new RegExp(`^${source}`).test(path)
}

/**
 * パスが robots.txt 許可か（純関数）。
 * - User-agent グループは指定 UA に最も具体的なグループを優先（'*' は汎用扱い）
 * - 同一グループ内の Allow/Disallow はパターン最長一致（同長は Allow 優先）
 * - 該当ルールが無ければ許可
 */
export function isPathAllowedByRobots(
  ruleset: RobotsRuleset,
  path: string,
  userAgent = '*',
): boolean {
  const ua = userAgent.toLowerCase()
  let chosen: RobotsGroup | null = null
  let chosenSpecific = false
  for (const group of ruleset.groups) {
    const specific = group.agents.some((a) => a !== '*' && ua.includes(a))
    const matches = specific || group.agents.includes('*')
    if (!matches) continue
    if (chosen === null || (specific && !chosenSpecific)) {
      chosen = group
      chosenSpecific = specific
    }
  }
  if (chosen === null) return true
  const candidates = chosen.rules.filter((r) => robotsPatternMatches(r.path, path))
  if (candidates.length === 0) return true
  // パターン最長一致を優先。同長の一致が複数ある場合は Allow を優先する（RFC 9309）
  candidates.sort((x, y) => {
    if (x.path.length !== y.path.length) return y.path.length - x.path.length
    return x.allow === y.allow ? 0 : x.allow ? -1 : 1
  })
  return candidates[0].allow
}

// ── HTML からの本文整理（script 等を実行・解釈せず除去するのみ）──────

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
}

/**
 * HTML から制度情報の抽出に使える本文を整理する（純関数）。
 * - script / style / noscript / template / iframe / svg とコメントを除去
 *   （JavaScript・埋め込みコードは一切実行しない。除去のみ）
 * - タグを除去してテキスト化し、空白を正規化する
 * - ページ内リンク（<a href>）の href 属性値を hrefs に収集する（M7-D。
 *   実行・解決はしない。解決と取得可否判定は linkScan / fetch ポリシー側）
 */
export function extractHtmlPage(html: string): FetchedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title =
    titleMatch !== null
      ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null
      : null
  const hrefs: string[] = []
  const seenHrefs = new Set<string>()
  const anchorRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let anchorMatch: RegExpExecArray | null
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const href = (anchorMatch[1] ?? anchorMatch[2] ?? anchorMatch[3] ?? '').trim()
    if (href === '' || seenHrefs.has(href)) continue
    seenHrefs.add(href)
    if (hrefs.length >= 1000) break
    hrefs.push(href)
  }
  let body = html
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (bodyMatch !== null) body = bodyMatch[1]
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  const text = decodeHtmlEntities(body.replace(/<\/?[a-zA-Z][^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  const excerpt = text.length > 240 ? `${text.slice(0, 240)}…` : text
  return { title, text, excerpt, hrefs }
}

// ── 取得エンジン（transport 注入・キャッシュ・記録）──────────────────

export type SourceFetcherConfig = {
  /** 接続タイムアウト（ms） */
  timeoutMs: number
  /** 本文サイズ上限（bytes。デコード後の文字数でも判定） */
  maxBytes: number
  /** robots.txt の読み込みサイズ上限（bytes。RFC 9309 の 500KiB 目安。超過は安全側に中止） */
  maxRobotsBytes: number
  /** リダイレクト最大回数 */
  maxRedirects: number
  /** 取得済みキャッシュの再利用期限（ms）。超過で再取得が必要と判定 */
  cacheTtlMs: number
  /** User-Agent（robots.txt 判定にも使用） */
  userAgent: string
  /** 本文テキストの最小文字数（これ未満は invalid-content） */
  minTextLength: number
}

export const DEFAULT_SOURCE_FETCHER_CONFIG: SourceFetcherConfig = {
  timeoutMs: 10_000,
  maxBytes: 500_000,
  maxRobotsBytes: 500 * 1024,
  maxRedirects: 3,
  cacheTtlMs: 24 * 60 * 60 * 1000,
  userAgent: 'enshu-support-kb-fetcher/1.0 (manual retrieval; respects robots.txt)',
  minTextLength: 20,
}

/** 許可するコンテンツ形式（PDF は未対応。application/pdf は拒否して記録する） */
export const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'] as const

export type SourceFetcher = {
  /** 登録済み URL を取得する（キャッシュが新しければ再利用。force で再取得） */
  fetchUrl(url: string, opts?: { force?: boolean }): Promise<SourceFetchResult>
  /** 再取得が必要か（未取得・取得失敗・TTL 超過で true） */
  needsRefresh(url: string): boolean
  /** 直近の取得記録 */
  getRecord(url: string): RetrievalRecord | null
  /** 直近の「成功した」取得（失敗で上書きされない） */
  getLastSuccess(url: string): { record: RetrievalRecord; page: FetchedPage } | null
  listRecords(): RetrievalRecord[]
}

class TimeoutError extends Error {
  constructor() {
    super('取得がタイムアウトしました')
    this.name = 'TimeoutError'
  }
}

/**
 * 実 fetch を transport に変換するアダプタ。
 * リダイレクトは手動追跡のため redirect: 'manual' で呼び出す。
 */
export function fetchTransport(fetchFn: typeof fetch): FetchTransport {
  return async (url, init) => {
    const resp = await fetchFn(url, {
      method: init.method,
      redirect: init.redirect,
      headers: init.headers,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    })
    return {
      status: resp.status,
      headers: { get: (name) => resp.headers.get(name) },
      text: () => resp.text(),
    }
  }
}

type RawFetchOutcome =
  | { ok: true; response: TransportResponse; finalUrl: string }
  | {
      ok: false
      code: FetchFailureCode
      reason: string
      httpStatus: number | null
      contentType: string | null
    }

export type CreateSourceFetcherOptions = {
  transport: FetchTransport
  /** 許可された公式ホスト名（URL 台帳から導出。完全一致のみ） */
  allowedHosts: Iterable<string>
  /** 現在時刻の供給（テストで固定可能） */
  now?: () => Date
  config?: Partial<SourceFetcherConfig>
}

export function createSourceFetcher(options: CreateSourceFetcherOptions): SourceFetcher {
  const config: SourceFetcherConfig = {
    ...DEFAULT_SOURCE_FETCHER_CONFIG,
    ...options.config,
  }
  const allowedHosts = new Set(
    [...options.allowedHosts].map((h) => h.toLowerCase()),
  )
  const now = options.now ?? (() => new Date())
  const cache = new Map<string, { record: RetrievalRecord; page: FetchedPage | null; storedAtMs: number }>()
  const lastSuccess = new Map<string, { record: RetrievalRecord; page: FetchedPage }>()
  const robotsCache = new Map<
    string,
    { allowed: boolean; checkedAt: string; code?: FetchFailureCode; reason?: string }
  >()

  async function transportWithTimeout(url: string): Promise<TransportResponse> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const request = options.transport(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': config.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
        signal: controller.signal,
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new TimeoutError())
        }, config.timeoutMs)
      })
      return await Promise.race([request, timeout])
    } catch (err) {
      if (err instanceof TimeoutError) throw err
      const name = (err as { name?: string }).name
      if (name === 'AbortError' || name === 'TimeoutError') throw new TimeoutError()
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** ポリシー検証つきの素の取得（リダイレクト手動追跡。robots チェックは対象外） */
  async function rawFetch(targetUrl: string): Promise<RawFetchOutcome> {
    let current = targetUrl
    for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
      const decision = evaluateFetchTarget(current, allowedHosts)
      if (!decision.allowed) {
        return {
          ok: false,
          code: hop === 0 ? decision.code : 'redirect-blocked',
          reason:
            hop === 0
              ? decision.reason
              : `リダイレクト先が許可されていないため中止しました: ${decision.reason}`,
          httpStatus: null,
          contentType: null,
        }
      }
      let response: TransportResponse
      try {
        response = await transportWithTimeout(current)
      } catch (err) {
        if (err instanceof TimeoutError) {
          return {
            ok: false,
            code: 'timeout',
            reason: '接続タイムアウトしました',
            httpStatus: null,
            contentType: null,
          }
        }
        return {
          ok: false,
          code: 'network-error',
          reason: `通信エラーが発生しました: ${(err as Error).message}`,
          httpStatus: null,
          contentType: null,
        }
      }
      const contentType = response.headers.get('content-type')
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null || location === '') {
          return {
            ok: false,
            code: 'invalid-content',
            reason: 'リダイレクト応答に Location がありません',
            httpStatus: response.status,
            contentType,
          }
        }
        if (hop === config.maxRedirects) {
          return {
            ok: false,
            code: 'too-many-redirects',
            reason: `リダイレクトが上限（${config.maxRedirects} 回）を超えました`,
            httpStatus: response.status,
            contentType,
          }
        }
        current = new URL(location, current).toString()
        continue
      }
      return { ok: true, response, finalUrl: current }
    }
    return {
      ok: false,
      code: 'too-many-redirects',
      reason: `リダイレクトが上限（${config.maxRedirects} 回）を超えました`,
      httpStatus: null,
      contentType: null,
    }
  }

  /** robots.txt 確認（取得できない場合は安全側＝取得中止） */
  async function ensureRobotsAllowed(
    targetUrl: string,
  ): Promise<
    | { allowed: true; checkedAt: string }
    | { allowed: false; checkedAt: string | null; code: FetchFailureCode; reason: string }
  > {
    const origin = new URL(targetUrl).origin
    const cached = robotsCache.get(origin)
    if (cached !== undefined) {
      return cached.allowed
        ? { allowed: true, checkedAt: cached.checkedAt }
        : {
            allowed: false,
            checkedAt: cached.checkedAt,
            code: cached.code ?? 'robots-unavailable',
            reason: cached.reason ?? 'robots.txt により取得できません',
          }
    }
    const checkedAt = now().toISOString()
    const robotsUrl = `${origin}/robots.txt`
    const outcome = await rawFetch(robotsUrl)
    let decision: { allowed: boolean; code?: FetchFailureCode; reason?: string }
    if (!outcome.ok) {
      // robots.txt 自体が取得できない場合は安全側に倒して中止する
      decision = {
        allowed: false,
        code: 'robots-unavailable',
        reason: `robots.txt を確認できないため取得を中止しました: ${outcome.reason}`,
      }
    } else if (outcome.response.status === 404 || outcome.response.status === 410) {
      decision = { allowed: true }
    } else if (outcome.response.status >= 200 && outcome.response.status < 300) {
      // robots.txt 自体は小さくあるべき（RFC 9309）。巨大な応答は読み切らず
      // 確認できないものとして安全側に倒す
      const declaredLengthHeader = outcome.response.headers.get('content-length')
      const declaredLength =
        declaredLengthHeader !== null && /^\d+$/.test(declaredLengthHeader)
          ? Number(declaredLengthHeader)
          : null
      const robotsText =
        declaredLength !== null && declaredLength > config.maxRobotsBytes
          ? null
          : await outcome.response.text()
      if (robotsText === null || robotsText.length > config.maxRobotsBytes) {
        decision = {
          allowed: false,
          code: 'robots-unavailable',
          reason: `robots.txt がサイズ上限（${config.maxRobotsBytes} bytes）を超えるため確認できず取得を中止しました（安全側）`,
        }
      } else {
        const ruleset = parseRobots(robotsText)
        const path = new URL(targetUrl).pathname
        decision = isPathAllowedByRobots(ruleset, path, config.userAgent)
          ? { allowed: true }
          : {
              allowed: false,
              code: 'robots-disallowed',
              reason: `robots.txt の Disallow 対象のため取得しません（${path}）`,
            }
      }
    } else if (
      outcome.response.status === 401 ||
      outcome.response.status === 403 ||
      outcome.response.status === 429 ||
      outcome.response.status >= 500
    ) {
      decision = {
        allowed: false,
        code: 'robots-unavailable',
        reason: `robots.txt が取得できないため取得を中止しました（HTTP ${outcome.response.status}）`,
      }
    } else {
      // 上記以外の 4xx は robots.txt なしとみなす（標準的な扱い）
      decision = { allowed: true }
    }
    robotsCache.set(origin, {
      allowed: decision.allowed,
      checkedAt,
      ...(decision.code !== undefined ? { code: decision.code } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    })
    return decision.allowed
      ? { allowed: true, checkedAt }
      : {
          allowed: false,
          checkedAt,
          code: decision.code ?? 'robots-unavailable',
          reason: decision.reason ?? 'robots.txt により取得できません',
        }
  }

  function buildFailureRecord(
    url: string,
    code: FetchFailureCode,
    reason: string,
    extra: {
      httpStatus?: number | null
      contentType?: string | null
      byteSize?: number | null
      finalUrl?: string | null
      robotsCheckedAt?: string | null
    } = {},
  ): RetrievalRecord {
    return {
      url,
      finalUrl: extra.finalUrl ?? null,
      title: null,
      retrievedAt: now().toISOString(),
      result: code,
      failureReason: reason,
      httpStatus: extra.httpStatus ?? null,
      contentType: extra.contentType ?? null,
      byteSize: extra.byteSize ?? null,
      robotsCheckedAt: extra.robotsCheckedAt ?? null,
    }
  }

  function storeResult(record: RetrievalRecord, page: FetchedPage | null): void {
    cache.set(record.url, { record, page, storedAtMs: now().getTime() })
    // 成功記録は別途保持し、後の失敗で上書きさせない
    if (record.result === 'ok' && page !== null) {
      lastSuccess.set(record.url, { record, page })
    }
  }

  async function fetchUrl(
    url: string,
    opts?: { force?: boolean },
  ): Promise<SourceFetchResult> {
    const force = opts?.force === true
    const cached = cache.get(url)
    if (
      !force &&
      cached !== undefined &&
      cached.record.result === 'ok' &&
      cached.page !== null &&
      now().getTime() - cached.storedAtMs < config.cacheTtlMs
    ) {
      // 同一 URL を必要以上に取得しない（record.retrievedAt は元の取得日時のまま）
      return { ok: true, record: cached.record, page: cached.page, fromCache: true }
    }

    // 取得対象 URL 自体の検証（HTTPS・許可ホスト・内部ネットワーク禁止）を先に行う
    const targetDecision = evaluateFetchTarget(url, allowedHosts)
    if (!targetDecision.allowed) {
      const record = buildFailureRecord(url, targetDecision.code, targetDecision.reason)
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    const robots = await ensureRobotsAllowed(url)
    if (!robots.allowed) {
      const record = buildFailureRecord(url, robots.code, robots.reason, {
        robotsCheckedAt: robots.checkedAt,
      })
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    const raw = await rawFetch(url)
    if (!raw.ok) {
      const record = buildFailureRecord(url, raw.code, raw.reason, {
        httpStatus: raw.httpStatus,
        contentType: raw.contentType,
        robotsCheckedAt: robots.checkedAt,
      })
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }
    // HTTP エラー応答（2xx 以外）は本文として扱わず失敗記録する
    if (raw.response.status < 200 || raw.response.status >= 300) {
      const record = buildFailureRecord(
        url,
        'http-error',
        `HTTP ${raw.response.status} で取得できませんでした`,
        {
          httpStatus: raw.response.status,
          contentType: raw.response.headers.get('content-type'),
          finalUrl: raw.finalUrl,
          robotsCheckedAt: robots.checkedAt,
        },
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    const contentTypeHeader = raw.response.headers.get('content-type')
    const contentType =
      contentTypeHeader !== null ? contentTypeHeader.split(';')[0].trim().toLowerCase() : null
    const contentLengthHeader = raw.response.headers.get('content-length')
    const declaredLength =
      contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : null
    const base = {
      httpStatus: raw.response.status,
      contentType,
      finalUrl: raw.finalUrl,
      robotsCheckedAt: robots.checkedAt,
    }
    if (declaredLength !== null && declaredLength > config.maxBytes) {
      const record = buildFailureRecord(
        url,
        'too-large',
        `本文サイズが上限（${config.maxBytes} bytes）を超えています`,
        { ...base, byteSize: declaredLength },
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    let body: string
    try {
      body = await raw.response.text()
    } catch (err) {
      const record = buildFailureRecord(
        url,
        'invalid-content',
        `本文を読み取れませんでした: ${(err as Error).message}`,
        base,
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }
    const byteSize = body.length
    if (byteSize > config.maxBytes) {
      const record = buildFailureRecord(
        url,
        'too-large',
        `本文サイズが上限（${config.maxBytes} bytes）を超えています`,
        { ...base, byteSize },
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }
    // 許可したコンテンツ形式（HTML 系）のみ扱う。PDF は未対応として記録する
    if (
      contentType === null ||
      !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(contentType) ||
      body.slice(0, 5).trimStart().startsWith('%PDF')
    ) {
      const record = buildFailureRecord(
        url,
        'unsupported-content-type',
        `許可されていないコンテンツ形式です（${contentType ?? '不明'}。PDF は抽出ライブラリが無く未対応）`,
        { ...base, byteSize },
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    const page = extractHtmlPage(body)
    if (page.text.length < config.minTextLength) {
      const record = buildFailureRecord(
        url,
        'invalid-content',
        '本文テキストを抽出できませんでした（空または短すぎます）',
        { ...base, byteSize },
      )
      storeResult(record, null)
      return { ok: false, record, fromCache: false }
    }

    const record: RetrievalRecord = {
      url,
      finalUrl: raw.finalUrl,
      title: page.title,
      retrievedAt: now().toISOString(),
      result: 'ok',
      failureReason: null,
      httpStatus: raw.response.status,
      contentType,
      byteSize,
      robotsCheckedAt: robots.checkedAt,
    }
    storeResult(record, page)
    return { ok: true, record, page, fromCache: false }
  }

  return {
    fetchUrl,
    needsRefresh(targetUrl) {
      const cached = cache.get(targetUrl)
      if (cached === undefined) return true
      if (cached.record.result !== 'ok') return true
      return now().getTime() - cached.storedAtMs >= config.cacheTtlMs
    },
    getRecord(targetUrl) {
      return cache.get(targetUrl)?.record ?? null
    },
    getLastSuccess(targetUrl) {
      return lastSuccess.get(targetUrl) ?? null
    },
    listRecords() {
      return [...cache.values()].map((v) => v.record)
    },
  }
}
