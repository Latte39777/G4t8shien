/**
 * M6-F（公式情報の取得・検証とナレッジベース構築）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-m6f.tsx
 *
 * 確認項目:
 * A. 許可された URL を正しく取得できる（偽 transport 注入）
 * B. 許可されていないホスト・内部ネットワーク・非 HTTPS への接続を拒否する
 * C. リダイレクト先を再検証する
 * D. タイムアウト・サイズ超過・不正な本文・PDF を安全に処理する
 * E. robots.txt を確認して従う（確認できない場合は安全側）
 * F. 同一 URL の再取得を抑え、再取得要否を判別できる
 * G. URL の確認と制度内容の確認が別状態になる（AI 自己申告で確認済みにできない）
 * H. 未確認の金額・法令名が確認済み扱いにならない／更新失敗時に確認済みデータを
 *    上書きしない
 * I. ナレッジベースがレジストリと整合し、区し、区単位の扱いが分離されている
 * J. AI 接続点（検証済みのみ提供・金額計算はプログラム側）
 * K. 外部通信ゼロ・既存機能（レジストリ/公式情報クライアント）の回帰
 * L. 台帳・取得ログの永続化と復元（プロセス終了後も保持）
 * M. provenance（転記・実取得・人手照合の区別。実績の混同防止）
 * N. urlVerified と照合の鮮度（reviewOutdated では urlVerified にしない）
 * O. 項目対応の厳格化（部分文字列で確認済みにしない）と項目の網羅
 * P. robots.txt のサイズ制限と同長ルールの Allow 優先
 *
 * 通常テストは偽 transport を使い、外部ネットワークへ一切接続しない
 * （globalThis.fetch をガードして0 回であることを確認する）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOWED_CONTENT_TYPES,
  createSourceFetcher,
  evaluateFetchTarget,
  extractHtmlPage,
  isBlockedNetworkTarget,
  isPathAllowedByRobots,
  parseRobots,
  type FetchTransport,
  type TransportResponse,
} from '../lib/supports/sourceFetch'
import {
  buildInitialLedger,
  createLedgerStore,
  isReviewOutdated,
  markContentRetrieved,
  markOfficialConfirmed,
  markUrlReachable,
  needsContentRecheck,
  recordManualContentReview,
  registerUrlCandidate,
} from '../lib/supports/sourceLedger'
import {
  appendRetrievalRecord,
  parseLedgerSnapshot,
  parseRetrievalLog,
  restoreLedgerEntries,
  serializeLedgerSnapshot,
  serializeRetrievalLog,
  type RetrievalLog,
} from '../lib/supports/sourceStore'
import {
  buildKbAiContext,
  buildKnowledgeBase,
  checkKbRegistryConsistency,
  kbConfidenceFor,
  type KbProgramEntry,
} from '../lib/supports/kb'
import { getSupportPrograms } from '../lib/supports/registry'
import { MOCK_SUPPORT_PROGRAMS } from '../lib/supports/mockPrograms'
import { buildOfficialPrograms } from '../lib/supports/officialPrograms'
import { createKbOfficialSourceClient } from '../lib/consult/officialSource'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

// ── 外部通信ガード（検証中の外部通信が 0 回であることを最後に確認する） ──
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown) => {
  fetchCalls.push(String(input))
  return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
}) as typeof fetch

// ── 偽 transport（固定レスポンスの注入。外部通信は行わない） ──
type FakeRoute =
  | { status?: number; headers?: Record<string, string>; body?: string }
  | 'hang'
function createFakeTransport(routes: Record<string, FakeRoute>) {
  const calls: string[] = []
  const transport: FetchTransport = async (url) => {
    calls.push(url)
    const route = routes[url]
    if (route === undefined) {
      throw new Error(`想定外のリクエスト（テスト外へのアクセス）: ${url}`)
    }
    if (route === 'hang') {
      // タイムアウト検証用（応答しない）
      return new Promise<TransportResponse>(() => {})
    }
    return {
      status: route.status ?? 200,
      headers: { get: (name) => route.headers?.[name.toLowerCase()] ?? null },
      text: async () => route.body ?? '',
    }
  }
  return { transport, calls }
}

const PAGE_URL = 'https://www.cfa.go.jp/policies/kokoseido/jidouteate'
const ROBOTS_URL = 'https://www.cfa.go.jp/robots.txt'
const HTML_PAGE =
  '<!DOCTYPE html><html><head><title>児童手当制度のご案内</title>' +
  '<script>window.__evil = 1</script><style>body { color: red }</style></head>' +
  '<body><main><h1>児童手当</h1><p>0歳から18歳に達する日以後の最初の3月31日までの児童を養育している方に支給されます。</p></main></body></html>'

function makeFetcher(
  routes: Record<string, FakeRoute>,
  opts: {
    timeoutMs?: number
    maxBytes?: number
    maxRobotsBytes?: number
    now?: () => Date
    allowedHosts?: string[]
  } = {},
) {
  const { transport, calls } = createFakeTransport(routes)
  const fetcher = createSourceFetcher({
    transport,
    allowedHosts: opts.allowedHosts ?? ['www.cfa.go.jp'],
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    config: {
      timeoutMs: opts.timeoutMs ?? 50,
      maxBytes: opts.maxBytes ?? 4_000,
      maxRobotsBytes: opts.maxRobotsBytes ?? 100_000,
      maxRedirects: 2,
      cacheTtlMs: 60_000,
    },
  })
  return { fetcher, calls }
}

async function main(): Promise<void> {
  // ── A. 許可された URL を正しく取得できる ──
  console.log('── A. 許可 URL の取得 ──')
  {
    const { fetcher, calls } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: HTML_PAGE,
      },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('取得に成功する', result.ok, result.ok ? '' : result.record.failureReason ?? '')
    if (result.ok) {
      check('ページタイトルを記録する', result.record.title === '児童手当制度のご案内')
      check('取得元 URL を記録する', result.record.url === PAGE_URL && result.record.finalUrl === PAGE_URL)
      check('取得日時を記録する', /^\d{4}-\d{2}-\d{2}T/.test(result.record.retrievedAt))
      check('取得結果を記録する', result.record.result === 'ok')
      check('robots.txt 確認日時を記録する', result.record.robotsCheckedAt !== null)
      check('本文を整理する（script/style を実行・残存させない）', result.page.text.includes('0歳から18歳') && !result.page.text.includes('__evil'))
      check('必要最小限の引用を用意する', result.page.excerpt.length > 0 && result.page.excerpt.length <= 241)
      check('再取得はキャッシュ再利用', (await fetcher.fetchUrl(PAGE_URL)).fromCache)
      check('キャッシュ再利用時は transport を呼ばない', calls.filter((u) => u === PAGE_URL).length === 1)
      check('needsRefresh は TTL 内は false', !fetcher.needsRefresh(PAGE_URL))
    }
  }
  {
    // TTL 超過で再取得が必要と判別できる
    let nowMs = Date.parse('2025-12-01T10:00:00+09:00')
    const { fetcher, calls } = makeFetcher(
      {
        [ROBOTS_URL]: { status: 404, body: '' },
        [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
      },
      { now: () => new Date(nowMs) },
    )
    await fetcher.fetchUrl(PAGE_URL)
    nowMs += 61 * 60 * 1000
    check('TTL 超過で needsRefresh が true', fetcher.needsRefresh(PAGE_URL))
    const again = await fetcher.fetchUrl(PAGE_URL)
    check('TTL 超過後は再取得する', !again.fromCache && calls.filter((u) => u === PAGE_URL).length === 2)
  }

  // ── B. 許可されていないホスト・内部ネットワーク・非 HTTPS の拒否 ──
  console.log('── B. 取得先の安全性 ──')
  {
    const { fetcher, calls } = makeFetcher({})
    const result = await fetcher.fetchUrl('https://evil.example.com/steal')
    check('許可リスト外のホストは拒否する', !result.ok && result.record.result === 'not-allowlisted')
    check('拒否時は transport を呼ばない（接続しない）', calls.length === 0)
  }
  {
    const allow = new Set(['www.cfa.go.jp'])
    const cases: [string, string][] = [
      ['http://www.cfa.go.jp/x', 'insecure-scheme'],
      ['https://localhost/admin', 'blocked-target'],
      ['https://127.0.0.1/x', 'blocked-target'],
      ['https://10.0.0.5/x', 'blocked-target'],
      ['https://172.16.0.1/x', 'blocked-target'],
      ['https://192.168.1.10/x', 'blocked-target'],
      ['https://[::1]/x', 'blocked-target'],
      ['https://169.254.169.254/latest/meta-data', 'blocked-target'],
      ['https://intranet.local/x', 'blocked-target'],
      ['https://user:pass@www.cfa.go.jp/x', 'credentials-in-url'],
      ['https://www.cfa.go.jp:8443/x', 'blocked-target'],
      ['https://www.cfa.go.jp.evil.example.com/x', 'not-allowlisted'],
    ]
    for (const [url, code] of cases) {
      const d = evaluateFetchTarget(url, allow)
      check(`${url} は ${code} で拒否`, !d.allowed && d.code === code, d.allowed ? '許可された' : d.reason)
    }
    check(
      '許可済み URL は判定を通過する',
      evaluateFetchTarget(PAGE_URL, allow).allowed,
    )
    check('内部ネットワーク判定', isBlockedNetworkTarget('192.168.0.1') && !isBlockedNetworkTarget('www.cfa.go.jp'))
  }

  // ── C. リダイレクト先の再検証 ──
  console.log('── C. リダイレクト先の再検証 ──')
  {
    const { fetcher, calls } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 302, headers: { location: 'https://evil.example.com/next' } },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check(
      'リダイレクト先が許可外なら redirect-blocked で中止',
      !result.ok && result.record.result === 'redirect-blocked',
      result.ok ? '' : result.record.failureReason ?? '',
    )
    check('リダイレクト先へは接続しない', !calls.some((u) => u.includes('evil.example.com')))
  }
  {
    const dest = 'https://www.cfa.go.jp/new-page'
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 301, headers: { location: dest } },
      [dest]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('リダイレクト先も許可リスト内なら再検証の上で取得できる', result.ok && result.record.finalUrl === dest)
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 302, headers: { location: PAGE_URL } },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('リダイレクトのループは上限で打ち切る', !result.ok && result.record.result === 'too-many-redirects')
  }

  // ── D. タイムアウト・サイズ超過・不正な本文・PDF の安全な処理 ──
  console.log('── D. 不正な応答の処理 ──')
  {
    const { fetcher } = makeFetcher(
      { [ROBOTS_URL]: { status: 404, body: '' }, [PAGE_URL]: 'hang' },
      { timeoutMs: 5 },
    )
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('タイムアウトは timeout で失敗記録する', !result.ok && result.record.result === 'timeout')
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html', 'content-length': '9999999' }, body: HTML_PAGE },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('Content-Length 超過は too-large で拒否', !result.ok && result.record.result === 'too-large')
  }
  {
    const { fetcher } = makeFetcher(
      {
        [ROBOTS_URL]: { status: 404, body: '' },
        [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE + 'x'.repeat(5000) },
      },
      { maxBytes: 1_000 },
    )
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('本文サイズ上限超過は too-large で拒否', !result.ok && result.record.result === 'too-large')
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: '' },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('空の本文は invalid-content で失敗記録する', !result.ok && result.record.result === 'invalid-content')
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: '%PDF-1.7 ...',
      },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check(
      'PDF は未対応として unsupported-content-type で失敗記録する（無理に対応したことにしない）',
      !result.ok && result.record.result === 'unsupported-content-type',
    )
    check('許可形式は HTML 系のみ', ALLOWED_CONTENT_TYPES.includes('text/html'))
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '%PDF-1.4 伪装',
      },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('形式偽装（PDF マジックバイト）も拒否', !result.ok && result.record.result === 'unsupported-content-type')
  }
  {
    // 同一インスタンスで失敗させても以前の成功記録は保持する（getLastSuccess）
    const routes: Record<string, FakeRoute> = {
      [ROBOTS_URL]: { status: 404, body: '' },
      [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
    }
    const { fetcher } = makeFetcher(routes)
    await fetcher.fetchUrl(PAGE_URL)
    routes[PAGE_URL] = { status: 500, headers: { 'content-type': 'text/html' }, body: 'error' }
    const failedResult = await fetcher.fetchUrl(PAGE_URL, { force: true })
    check('再取得失敗は失敗として記録する', !failedResult.ok && failedResult.record.result === 'http-error')
    const last = fetcher.getLastSuccess(PAGE_URL)
    check('更新失敗時に以前の成功取得を上書きしない', last !== null && last.record.result === 'ok')
  }

  // ── E. robots.txt を確認して従う ──
  console.log('── E. robots.txt ──')
  {
    const { fetcher, calls } = makeFetcher({
      [ROBOTS_URL]: {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /policies/\n',
      },
      [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('Disallow 対象パスは取得しない', !result.ok && result.record.result === 'robots-disallowed')
    check('対象ページには接続しない', !calls.includes(PAGE_URL))
  }
  {
    const { fetcher } = makeFetcher({
      [ROBOTS_URL]: { status: 500, body: '' },
      [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
    })
    const result = await fetcher.fetchUrl(PAGE_URL)
    check('robots.txt が確認できない場合は安全側（取得中止）', !result.ok && result.record.result === 'robots-unavailable')
  }
  {
    const rules = parseRobots('User-agent: *\nAllow: /policies/kokoseido\nDisallow: /policies/\n\nUser-agent: EvilBot\nDisallow: /\n')
    check('最長マッチで Allow を優先する', isPathAllowedByRobots(rules, '/policies/kokoseido/jidouteate'))
    check('Disallow に当たるパスは不可', !isPathAllowedByRobots(rules, '/policies/other'))
    check('該当ルールなしは許可', isPathAllowedByRobots(rules, '/about'))
  }

  // ── G. URL の確認と制度内容の確認が別状態になる ──
  console.log('── G. URL 検証と内容検証の分離 ──')
  {
    let entry = registerUrlCandidate({
      url: 'https://www.city.example.lg.jp/kosodate/iryou',
      title: 'こども医療費助成（仮）',
      organization: '仮の自治体',
      programIds: ['mock-child-medical-aid'],
      registeredAt: '2026-01-10',
    })
    check('1. 登録済み状態', entry.urlState === 'candidate-registered' && entry.contentState === 'no-content')
    entry = markUrlReachable(entry, '2026-01-11T09:00:00+09:00')
    check('2. アクセス可能だけでは内容は未確認のまま', entry.urlState === 'reachable' && entry.contentState === 'no-content')
    check('到達だけでは公式確認済みにしない', entry.officialConfirmedAt === null)
    let threw = false
    try {
      markOfficialConfirmed(registerUrlCandidate({
        url: 'https://www.city.example.lg.jp/never-fetched',
        title: '未到達ページ',
        organization: '仮の自治体',
        programIds: [],
        registeredAt: '2026-01-10',
      }), { confirmedAt: '2026-01-12', note: 'x' })
    } catch {
      threw = true
    }
    check('到達記録が無い URL を公式確認済みにできない', threw)
    entry = markOfficialConfirmed(entry, { confirmedAt: '2026-01-12', note: '公式自治体ドメインと確認' })
    check('3. 公式確認は URL 側のみ更新', entry.urlState === 'official-confirmed' && entry.contentState === 'no-content')
    entry = markContentRetrieved(entry, {
      retrievedAt: '2026-01-13T10:00:00+09:00',
      result: 'ok',
      excerpt: '高校生年代まで助成（抜粋）',
    })
    check('4・5. 取得済み＝内容は要確認（照合済み項目は空）', entry.contentState === 'needs-review' && entry.review.reviewedFields.length === 0)
    entry = recordManualContentReview(entry, {
      reviewedAt: '2026-01-14',
      fields: ['period'],
      note: '対象年齢のみ照合',
      reviewer: 'manual',
    })
    check('6. 人手照合で照合済み項目が記録される', entry.contentState === 'reviewed' && entry.review.reviewedFields.join(',') === 'period')
    check('照合していない金額・法令は照合済みに含まれない', !entry.review.reviewedFields.includes('amount.value') && !entry.review.reviewedFields.includes('legalBasis.lawName'))
    threw = false
    try {
      recordManualContentReview(entry, {
        reviewedAt: '2026-01-15',
        fields: ['amount.value'],
        note: 'AI が確認した',
        reviewer: 'ai' as unknown as 'manual',
      })
    } catch {
      threw = true
    }
    check('AI の自己申告では照合済みにできない', threw)
    // 再取得後は照合済み項目を残しつつ再確認が必要になる
    entry = markContentRetrieved(entry, {
      retrievedAt: '2026-01-20T10:00:00+09:00',
      result: 'ok',
    })
    check('再取得しても照合済み項目は消えない', entry.review.reviewedFields.join(',') === 'period')
    check('再取得しただけで再確認済みにならない（照合が古い）', isReviewOutdated(entry) && needsContentRecheck(entry))
    // 日付粒度の境界（reviewedAt は YYYY-MM-DD）: 同日取得→同日照合は要再確認に
    // ならない。照合日より後の日付の再取得で要再確認になる。
    const sameDay = recordManualContentReview(
      markContentRetrieved(
        registerUrlCandidate({
          url: 'https://www.city.example.lg.jp/same-day',
          title: '同日検証用（仮）',
          organization: '仮の自治体',
          programIds: [],
          registeredAt: '2026-03-01',
        }),
        { retrievedAt: '2026-03-02T15:00:00+09:00', result: 'ok' },
      ),
      { reviewedAt: '2026-03-02', fields: ['name'], note: '同日の人手照合', reviewer: 'manual' },
    )
    check(
      '同日取得後の同日照合は要再確認にならない（日付粒度の境界）',
      !isReviewOutdated(sameDay) && !needsContentRecheck(sameDay),
    )
    const laterFetch = markContentRetrieved(sameDay, {
      retrievedAt: '2026-03-03T09:00:00+09:00',
      result: 'ok',
    })
    check(
      '照合日より後の日付の再取得は要再確認（同日境界の拡張）',
      isReviewOutdated(laterFetch) && needsContentRecheck(laterFetch),
    )
    // 失敗時は未確認状態・確認済みデータを上書きしない
    const before = entry
    entry = markContentRetrieved(entry, {
      retrievedAt: '2026-01-25T10:00:00+09:00',
      result: 'timeout',
      failureReason: 'タイムアウトしました',
    })
    check('更新失敗時に照合済みデータを上書きしない', entry.review.reviewedAt === before.review.reviewedAt && entry.contentRetrievedAt === before.contentRetrievedAt)
    check('失敗理由を記録する', entry.lastFetchResult === 'timeout' && entry.lastFetchFailureReason !== null)
  }
  {
    const ledger = createLedgerStore(buildInitialLedger())
    check('初期台帳は調査ログで公式確認済みの URL のみ', ledger.list().every((e) => e.urlState === 'official-confirmed'))
    check('許可ホストは公式確認済み URL から導出', ledger.allowedHosts().includes('www.cfa.go.jp'))
    check('台帳の取得日時と人手照合日時が分離', ledger.list().every((e) => e.contentRetrievedAt !== null && e.review.reviewedAt !== null && e.contentRetrievedAt !== e.review.reviewedAt))
  }

  // ── H・I. ナレッジベース（未確認の分離・レジストリ整合・区単位の扱い） ──
  console.log('── H・I. ナレッジベース ──')
  const kb = buildKnowledgeBase()
  check('最初に扱う制度 4 種＋JASSO を収録（6 エントリ）', kb.length === 6, `actual: ${kb.length}`)
  const registry = getSupportPrograms()
  check('KB とレジストリの整合（ID・名称）', checkKbRegistryConsistency(registry, kb).length === 0, checkKbRegistryConsistency(registry, kb).join(' / '))
  {
    const allowance = kb.find((e) => e.programId === 'mock-child-allowance')
    check('児童手当を収録', allowance !== undefined)
    if (allowance !== undefined) {
      const amount = allowance.fields.find((f) => f.field === 'amount.value')
      check('計算用の単一金額は未確認のまま（confirmed 扱いにしない）', amount !== undefined && amount.confidence === 'unconfirmed')
      const band = allowance.fields.find((f) => f.field === 'amountBands.0.value')
      check('公式照合済みの金額内訳は confirmed かつ出典付き', band !== undefined && band.confidence === 'confirmed' && band.sourceIds.length > 0)
      // 仕様変更（2026-10-17）: こども家庭庁「法令」ページ（e-Gov）で法令名「児童手当法」を照合済みのため、
      // lawName は confirmed として出典付きで出力する（法令番号・施行令/規則は未確認のまま混入させない）
      const law = allowance.fields.find((f) => f.field === 'legalBasis.lawName')
      check('確認済みの法令名は confirmed として出典付きで出る（未確認の法令情報は混入させない）', law !== undefined && law.confidence === 'confirmed' && law.value === '児童手当法' && law.sourceIds.length > 0)
      check('申請先など照合済み項目は出典と対応する', (allowance.fields.find((f) => f.field === 'application.where')?.sourceIds.length ?? 0) > 0)
      check('取得日時と確認日時を出典側で保持', allowance.sources.every((s) => s.retrievedAt !== null && s.reviewedAt !== null))
    }
    const medical = kb.find((e) => e.programId === 'mock-child-medical-aid')
    check('こども医療費助成を収録', medical !== undefined)
    if (medical !== undefined) {
      check('モック維持の制度は全項目が未確認', medical.fields.every((f) => f.confidence === 'unconfirmed'))
      check('こども医療費助成はどの区にも紐づけない（区が確認できるまで）', medical.wardBinding.boundWards.length === 0 && medical.wardBinding.note.includes('東京都全体で共通の制度として扱わない'))
      check('対象地域は未確認（推測しない）', medical.jurisdiction.coverage === 'unknown')
    }
    for (const entry of kb) {
      check(`${entry.programId}: 値が無い項目を confirmed にしない`, entry.fields.every((f) => f.confidence !== 'confirmed' || f.value !== null))
      check(`${entry.programId}: 更新履歴を持つ`, entry.revisions.length > 0)
    }
  }

  // ── J. AI との接続点（検証済みのみ提供・金額計算はプログラム側） ──
  console.log('── J. AI 接続点 ──')
  {
    const ctx = buildKbAiContext(kb)
    check('確認済みの事実には出典が付く', ctx.confirmedFacts.length > 0 && ctx.confirmedFacts.every((f) => f.includes('出典')))
    check('未確認は「確認できる公式情報がありません」として分離', ctx.unconfirmedNotes.some((n) => n.includes('確認できる公式情報がありません')))
    check('金額計算はプログラム側の方針を明記', ctx.amountCalculationPolicy.includes('lib/finance/supports.ts') && ctx.amountCalculationPolicy.includes('AI は金額を自由に生成せず'))
    // 未確認項目が confirmedFacts に混入しない
    let leaked = false
    for (const entry of kb) {
      for (const f of entry.fields) {
        if (f.confidence === 'confirmed' && f.value !== null) continue
        if (ctx.confirmedFacts.some((line) => line.startsWith(`・${entry.name}｜${f.label}:`))) leaked = true
      }
    }
    check('未確認の項目が確認済み事実に混入しない', !leaked)
  }
  {
    // 検索と取得の分離・未登録 URL は公式出典にしない
    const client = createKbOfficialSourceClient()
    const searchOutcome = await client.search('児童手当')
    check('検索は台帳由来の候補を返す（取得とは別機能）', searchOutcome.ok && searchOutcome.candidates.length > 0)
    const unregistered = await client.fetchSource('https://unregistered.example.com/x')
    check('台帳に無い URL は unverified-url で拒否', !unregistered.ok && unregistered.reason === 'unverified-url')
    const reviewed = await client.fetchSource(PAGE_URL)
    check('人手照合済み URL は公式出典として取得できる', reviewed.ok)
    if (reviewed.ok) {
      check('urlVerified は人手照合済み URL のみ true', reviewed.record.urlVerified === true && /^\d{4}-\d{2}-\d{2}$/.test(reviewed.record.checkedAt))
    }
  }
  {
    // URL アクセス可能・内容未照合では urlVerified にならない（状態の分離）
    const base = kb.find((e) => e.programId === 'mock-child-medical-aid')
    if (base !== undefined) {
      const synthetic: KbProgramEntry = {
        ...base,
        sources: [
          {
            sourceId: 'src-synth-reachable',
            title: '仮の区ページ',
            url: 'https://www.city.example.lg.jp/kosodate/iryou',
            organization: '仮の自治体',
            urlState: 'reachable',
            contentState: 'needs-review',
            retrievedAt: '2026-01-13T10:00:00+09:00',
            reviewedAt: null,
            reviewedFields: [],
            lastFetchResult: 'ok',
            reviewOutdated: false,
            provenance: { registered: 'user-registered', retrieval: 'fetch-run', review: null },
            excerpt: '抜粋',
          },
          {
            sourceId: 'src-synth-no-content',
            title: '未取得の区ページ',
            url: 'https://www.city.example.lg.jp/kosodate/other',
            organization: '仮の自治体',
            urlState: 'candidate-registered',
            contentState: 'no-content',
            retrievedAt: null,
            reviewedAt: null,
            reviewedFields: [],
            lastFetchResult: 'timeout',
            reviewOutdated: false,
            provenance: { registered: 'user-registered', retrieval: null, review: null },
            excerpt: null,
          },
        ],
      }
      const client = createKbOfficialSourceClient([synthetic])
      const reachable = await client.fetchSource('https://www.city.example.lg.jp/kosodate/iryou')
      check('取得済み・要確認の URL は取得できるが urlVerified は false', reachable.ok && reachable.record.urlVerified === false)
      const noContent = await client.fetchSource('https://www.city.example.lg.jp/kosodate/other')
      check('未取得の URL は未確認のまま失敗を返す', !noContent.ok && noContent.reason === 'network-error')
    }
  }

  // ── K. 外部通信ゼロ・既存機能の回帰 ──
  console.log('── K. 回帰と外部通信ゼロ ──')
  {
    const allowanceProgram = registry.find((p) => p.id === 'mock-child-allowance')
    check('児童手当は公式確認済みデータでレジストリ提供', allowanceProgram !== undefined && allowanceProgram.mock === false && (allowanceProgram.verification?.verifiedFields.length ?? 0) > 0)
    const medicalProgram = registry.find((p) => p.id === 'mock-child-medical-aid')
    check('こども医療費助成は安全なモック表示を維持', medicalProgram !== undefined && medicalProgram.mock === true)
    const officialIds = buildOfficialPrograms().map((p) => p.id)
    check('公式調査データの全 ID がレジストリに存在', officialIds.every((id) => registry.some((p) => p.id === id)))
    check('支援制度一覧はモック＋公式新規の全制度を返す（M1 からの既存機能）', registry.length >= MOCK_SUPPORT_PROGRAMS.length)
  }
  {
    const page = extractHtmlPage('<html><head><title>テスト</title><script>alert(1)</script></head><body><p>本文テキスト</p></body></html>')
    check('HTML 整理（タイトル抽出・script 除去）', page.title === 'テスト' && page.text === '本文テキスト')
  }
  // ── L. 台帳・取得ログの永続化と復元（プロセス終了後も保持） ──
  console.log('── L. 永続化と復元 ──')
  {
    const base = buildInitialLedger()
    const savedAt = '2026-02-01T00:00:00+09:00'
    const parsed = parseLedgerSnapshot(serializeLedgerSnapshot(base, savedAt))
    check(
      '台帳スナップショットの往復で復元できる',
      parsed.ok &&
        parsed.value.entries.length === base.length &&
        parsed.value.entries[0].urlId === base[0].urlId &&
        parsed.value.entries[0].review.reviewedFields.join(',') ===
          base[0].review.reviewedFields.join(','),
      parsed.ok ? '' : parsed.error,
    )
    const broken = parseLedgerSnapshot('{ 不正な JSON')
    check('壊れた台帳 JSON は例外ではなく失敗として返す', !broken.ok && broken.error.length > 0)
    const wrongVersion = parseLedgerSnapshot('{"version":2,"savedAt":"x","entries":[]}')
    check('未対応バージョンの台帳 JSON は拒否する', !wrongVersion.ok)
    const logBroken = parseRetrievalLog('{"records": [')
    check('取得ログの壊れた JSON も失敗として返す（保存物を壊さない）', !logBroken.ok && logBroken.error.length > 0)
    const record = {
      url: 'https://www.cfa.go.jp/x',
      finalUrl: null,
      title: null,
      retrievedAt: '2026-02-01T10:00:00+09:00',
      result: 'timeout' as const,
      failureReason: 'タイムアウトしました',
      httpStatus: null,
      contentType: null,
      byteSize: null,
      robotsCheckedAt: null,
    }
    const emptyLog: RetrievalLog = { version: 1, savedAt, records: [] }
    const logParsed = parseRetrievalLog(
      serializeRetrievalLog(appendRetrievalRecord(emptyLog, record, savedAt)),
    )
    check(
      '取得ログの往復（追記を含む）',
      logParsed.ok &&
        logParsed.value.records.length === 1 &&
        logParsed.value.records[0].result === 'timeout',
      logParsed.ok ? '' : logParsed.error,
    )
    // 復元マージ: 状態（実績）はディスク側、識別情報はコード側
    const first = base[0]
    const fetched = recordManualContentReview(
      markContentRetrieved(first, {
        retrievedAt: '2026-02-05T10:00:00+09:00',
        result: 'ok',
        excerpt: '再取得（抜粋）',
      }),
      { reviewedAt: '2026-02-06', fields: ['name'], note: '実運用での再照合', reviewer: 'manual' },
    )
    const renamed = { ...fetched, title: '書き換えられたタイトル' }
    const runtime = recordManualContentReview(
      markContentRetrieved(
        markUrlReachable(
          registerUrlCandidate({
            url: 'https://www.city.example.lg.jp/kosodate/iryou',
            title: '実行時に登録した区ページ',
            organization: '仮の自治体',
            programIds: ['mock-child-medical-aid'],
            registeredAt: '2026-02-01',
          }),
          '2026-02-02T09:00:00+09:00',
        ),
        { retrievedAt: '2026-02-02T10:00:00+09:00', result: 'ok', excerpt: '区ごとの助成（抜粋）' },
      ),
      { reviewedAt: '2026-02-03', fields: ['period'], note: '人手照合', reviewer: 'manual' },
    )
    const restored = restoreLedgerEntries({ version: 1, savedAt, entries: [renamed, runtime] })
    const restoredFirst = restored.find((e) => e.url === first.url)
    check(
      '識別情報（タイトル等）はコード側の定義で復元する',
      restoredFirst?.title === first.title,
      restoredFirst?.title ?? '',
    )
    check(
      '状態（照合記録）はディスク側の記録で復元する',
      restoredFirst?.review.reviewedFields.join(',') === 'name',
    )
    check('復元後も provenance（実績）が保たれる', restoredFirst?.provenance.review === 'manual-review')
    const restoredRuntime = restored.find((e) => e.url === runtime.url)
    check(
      '実行時に登録した URL も失われず復元する',
      restoredRuntime !== undefined &&
        restoredRuntime.contentState === 'reviewed' &&
        restoredRuntime.provenance.review === 'manual-review',
    )
    // ファイル保存→読込→復元（プロセス終了後も保持される）
    const dir = mkdtempSync(join(tmpdir(), 'enshu-m6f-'))
    try {
      const file = join(dir, 'source-ledger.json')
      writeFileSync(file, serializeLedgerSnapshot(restored, savedAt), 'utf8')
      const reread = parseLedgerSnapshot(readFileSync(file, 'utf8'))
      check(
        'ファイル保存→読込→復元できる（プロセス終了後も保持）',
        reread.ok && restoreLedgerEntries(reread.value).length === restored.length,
        reread.ok ? '' : reread.error,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── M. provenance（転記・実取得・人手照合の区別。実績の混同防止） ──
  console.log('── M. provenance ──')
  {
    const initial = buildInitialLedger()
    check(
      '初期台帳の状態は調査ログ転記の provenance',
      initial.every(
        (e) =>
          e.provenance.registered === 'research-log-transcribed' &&
          e.provenance.retrieval === 'research-log-transcribed' &&
          e.provenance.review === 'research-log-transcribed',
      ),
    )
    let prov = registerUrlCandidate({
      url: 'https://www.city.example.lg.jp/prov',
      title: 'provenance 確認用',
      organization: '仮の自治体',
      programIds: [],
      registeredAt: '2026-02-01',
    })
    check(
      'URL 登録の provenance は user-registered',
      prov.provenance.registered === 'user-registered' &&
        prov.provenance.retrieval === null &&
        prov.provenance.review === null,
    )
    prov = markUrlReachable(prov, '2026-02-02T09:00:00+09:00')
    check('到達の provenance は fetch-run（実績）', prov.provenance.retrieval === 'fetch-run')
    prov = markContentRetrieved(prov, {
      retrievedAt: '2026-02-02T10:00:00+09:00',
      result: 'ok',
    })
    check(
      '取得の provenance は fetch-run・照合は未記録',
      prov.provenance.retrieval === 'fetch-run' && prov.provenance.review === null,
    )
    prov = recordManualContentReview(prov, {
      reviewedAt: '2026-02-03',
      fields: ['amount.value'],
      note: '人手照合',
      reviewer: 'manual',
    })
    check('照合の provenance は manual-review（実績）', prov.provenance.review === 'manual-review')
    const failedEntry = markContentRetrieved(prov, {
      retrievedAt: '2026-02-04T10:00:00+09:00',
      result: 'timeout',
      failureReason: 'タイムアウト',
    })
    check(
      '取得失敗では取得 provenance を更新しない',
      failedEntry.provenance.retrieval === 'fetch-run' &&
        failedEntry.contentRetrievedAt === prov.contentRetrievedAt,
    )
    // KB 側でも転記と実績を区別する
    const kbInitial = buildKnowledgeBase()
    const allowance0 = kbInitial.find((x) => x.programId === 'mock-child-allowance')
    check(
      'KB の出典は調査ログ転記と区別される',
      allowance0?.sources.every(
        (s) =>
          s.provenance.retrieval === 'research-log-transcribed' &&
          s.provenance.review === 'research-log-transcribed',
      ) ?? false,
    )
    check(
      'KB フィールドの provenance が転記である',
      (allowance0?.fields.find((f) => f.field === 'application.where')?.provenance ?? 'none') ===
        'research-log-transcribed',
    )
    const ctx0 = buildKbAiContext(kbInitial)
    check('AI 供給文言に転記由来であることが出る', ctx0.confirmedFacts.some((f) => f.includes('調査ログ転記')))
  }

  // ── M（続）. 実取得・人手照合後の KB は実績として区別される ──
  {
    const ledger2 = buildInitialLedger().map((x) =>
      recordManualContentReview(
        markContentRetrieved(x, { retrievedAt: '2026-02-10T10:00:00+09:00', result: 'ok' }),
        {
          reviewedAt: '2026-02-11',
          fields: [...x.review.reviewedFields],
          note: '実取得後の再照合',
          reviewer: 'manual',
        },
      ),
    )
    const kb2 = buildKnowledgeBase(ledger2)
    const allowance2 = kb2.find((x) => x.programId === 'mock-child-allowance')
    check(
      '実取得後の出典は fetch-run として区別される',
      allowance2?.sources.every((s) => s.provenance.retrieval === 'fetch-run') ?? false,
    )
    check(
      '実取得後の照合は manual-review として区別される',
      (allowance2?.fields.find((f) => f.field === 'application.where')?.provenance ?? 'none') ===
        'manual-review',
    )
    const ctx2 = buildKbAiContext(kb2)
    check(
      'AI 供給文言で実取得・人手照合を区別できる',
      ctx2.confirmedFacts.some((f) => f.includes('実取得') && f.includes('人手照合')),
    )
  }

  // ── N. urlVerified と照合の鮮度（reviewOutdated では urlVerified にしない） ──
  console.log('── N. urlVerified と照合の鮮度 ──')
  {
    const baseEntry = kb.find((x) => x.programId === 'mock-child-medical-aid')
    if (baseEntry !== undefined) {
      const outdated: KbProgramEntry = {
        ...baseEntry,
        sources: [
          {
            sourceId: 'src-synth-outdated',
            title: '再取得された区ページ',
            url: 'https://www.city.example.lg.jp/kosodate/iryou',
            organization: '仮の自治体',
            urlState: 'official-confirmed',
            contentState: 'reviewed',
            retrievedAt: '2026-01-20T10:00:00+09:00',
            reviewedAt: '2026-01-14',
            reviewedFields: ['period'],
            lastFetchResult: 'ok',
            reviewOutdated: true,
            provenance: {
              registered: 'user-registered',
              retrieval: 'fetch-run',
              review: 'manual-review',
            },
            excerpt: '抜粋',
          },
        ],
      }
      const client = createKbOfficialSourceClient([outdated])
      const r = await client.fetchSource('https://www.city.example.lg.jp/kosodate/iryou')
      check(
        '照合済みでも再取得後（reviewOutdated）は urlVerified にしない',
        r.ok && r.record.urlVerified === false,
        r.ok ? '' : r.reason,
      )
    }
  }

  // ── O. 項目対応の厳格化と項目の網羅 ──
  console.log('── O. 項目対応の厳格化・項目の網羅 ──')
  {
    const p = buildOfficialPrograms().find((x) => x.id === 'mock-child-allowance')
    check('児童手当の公式データを取得', p !== undefined)
    if (p !== undefined) {
      check(
        '申請期限は deadlineNote の照合を deadline に反映する（明示エイリアス）',
        kbConfidenceFor(p, 'application.deadline', '出生日の翌日から15日以内') === 'confirmed',
      )
      check(
        '金額内訳は親パスの照合を子項目に反映する（祖先パス）',
        kbConfidenceFor(p, 'amountBands.0.value', 15000) === 'confirmed',
      )
      const v = p.verification ?? {
        status: 'unverified' as const,
        verifiedAt: null,
        verifiedFields: [] as string[],
        note: null,
      }
      const loose = { ...p, verification: { ...v, verifiedFields: ['app'] } }
      check(
        '部分文字列（app）だけで application.where を確認済みにしない',
        kbConfidenceFor(loose, 'application.where', '窓口') !== 'confirmed',
      )
      const descendant = { ...p, verification: { ...v, verifiedFields: ['application.where.x'] } }
      check(
        '下位項目の照合で上位項目を確認済みにしない',
        kbConfidenceFor(descendant, 'application.where', '窓口') !== 'confirmed',
      )
    }
    const allowance = kb.find((x) => x.programId === 'mock-child-allowance')
    if (allowance !== undefined) {
      const docs = allowance.fields.find((f) => f.field === 'application.documents')
      check(
        '照合済みの必要書類が KB フィールドとして出る（出典付き）',
        docs !== undefined && docs.confidence === 'confirmed' && docs.sourceIds.length > 0,
      )
      const steps = allowance.fields.find((f) => f.field === 'application.steps')
      check('照合済みの申請手順が KB フィールドとして出る', steps !== undefined && steps.confidence === 'confirmed')
      const jur = allowance.fields.find((f) => f.field === 'jurisdiction')
      check('実施主体・対象地域フィールドを持つ', jur !== undefined)
    }
  }

  // ── P. robots.txt のサイズ制限と同長ルールの Allow 優先 ──
  console.log('── P. robots.txt のサイズ制限と同長ルール ──')
  {
    const rules = parseRobots('User-agent: *\nDisallow: /policies/\nAllow: /policies/\n')
    check(
      'Allow/Disallow 同長のときは Allow を優先する（RFC 9309）',
      isPathAllowedByRobots(rules, '/policies/kokoseido'),
    )
    const { fetcher, calls } = makeFetcher(
      {
        [ROBOTS_URL]: {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: `User-agent: *\nDisallow: /\n${'x'.repeat(3000)}`,
        },
        [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
      },
      { maxRobotsBytes: 1000 },
    )
    const result = await fetcher.fetchUrl(PAGE_URL)
    check(
      '巨大な robots.txt は確認できないとして安全側に中止',
      !result.ok && result.record.result === 'robots-unavailable',
      result.ok ? '' : result.record.failureReason ?? '',
    )
    check('中止時は対象ページに接続しない', !calls.includes(PAGE_URL))
    const { fetcher: f2 } = makeFetcher(
      {
        [ROBOTS_URL]: {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '999999' },
          body: '',
        },
        [PAGE_URL]: { status: 200, headers: { 'content-type': 'text/html' }, body: HTML_PAGE },
      },
      { maxRobotsBytes: 1000 },
    )
    const r2 = await f2.fetchUrl(PAGE_URL)
    check('robots.txt の Content-Length 超過も安全側に中止', !r2.ok && r2.record.result === 'robots-unavailable')
  }

  check('検証中の外部通信 0 回（ライブ AI・INIAD API へのリクエストなし）', fetchCalls.length === 0, fetchCalls.join(', '))

  if (failed > 0) {
    console.log('M6-F verification: FAILED (' + failed + ')')
    process.exitCode = 1
    return
  }
  console.log('M6-F verification: ALL PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
