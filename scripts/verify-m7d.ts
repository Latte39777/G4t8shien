/**
 * M7-D 支援制度候補の発見・構造化パイプラインの検証
 *
 * 実行: npx tsx scripts/verify-m7d.ts
 *
 * - HTML からのリンク抽出・相対 URL 正規化・重複排除
 * - 未許可ホスト・不正 URL の拒否（取得ポリシーの維持）
 * - ダミー本文 → AI 抽出入力の流れ（偽クライアント注入。実 API 呼び出しなし）
 * - AI 出力の検証（正常 JSON / 不正 JSON / 必須不足 / コードフェンス / 空配列）
 * - 根拠抜粋のない金額・条件・期限・対象地域を確定扱いにしない
 * - 未検証候補が本番制度データ（programs.json / getSupportPrograms）へ流入しない
 * - 調査計画の候補件数更新（status を surveyed にしない）
 * - 重複登録・取得失敗・抽出失敗からの安全な復旧
 * - dry-run では外部通信・保存が発生しない（グローバル fetch ガード＋注入経路の未使用検証）
 * - 既存制度データ・計算・UI の非破壊（ハッシュ＋スナップショット比較）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import type { FetchTransport, TransportResponse } from '../lib/supports/sourceFetch'
import {
  DISCOVERY_STORE_FORMAT_VERSION,
  candidateDedupeKey,
  contentHashOf,
  makeCandidateId,
  makeUrlId,
  parseCandidateStore,
  parsePageStore,
  parseUrlCandidateStore,
  recordUrlFetch,
  serializePageStore,
  serializeUrlCandidateStore,
  upsertCandidates,
  upsertUrlCandidate,
  type DiscoveryCandidate,
  type PageRecord,
  type UrlCandidate,
} from '../lib/discovery/discoveryStore'
import {
  classifyDiscoveredLinks,
  extractHtmlLinks,
  linksFromHrefs,
  normalizeLinkTarget,
} from '../lib/discovery/linkScan'
import {
  buildExtractionMessages,
  extractCandidatesWithClient,
  normalizeExtractedCandidate,
  parseExtractionOutput,
  type ExtractionContext,
} from '../lib/discovery/aiExtract'
import {
  applyCandidateCountUpdates,
  buildDiscoveryReport,
  collectSeedUrls,
  computeCandidateCountsByTask,
  planUpdatesForCandidateCounts,
} from '../lib/discovery/pipeline'
import {
  parseDiscoveryArgs,
  runDiscoveryCli,
  type DiscoveryCliDeps,
  type DiscoveryFileOps,
} from '../lib/discovery/cli'
import {
  parseSurveyPlanJson,
  serializeSurveyPlan,
} from '../lib/survey/surveyPlanStore'
import type { SurveyPlan, SurveyTask } from '../lib/types/surveyPlan'
import { getSupportPrograms, registryDisclaimer } from '../lib/supports/registry'

// ── 外部通信ガード（この検証では一切の外部通信を行わない）────────────
const originalFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async (...args: unknown[]) => {
  fetchCalls += 1
  throw new Error(`外部通信を検出しました: ${String(args[0])}`)
}) as typeof fetch

let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok: ${name}`)
  } else {
    failed += 1
    console.error(`NG: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** undefined とキー欠如を同一視する構造比較（順序は配列のみ厳密） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) {
    return (a ?? null) === (b ?? null)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort()
    const kb = Object.keys(b as object).sort()
    return (
      deepEqual(ka, kb) &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    )
  }
  return false
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const FIXED_TIME = '2026-10-27T10:00:00+09:00'
const fixedNow = () => new Date(FIXED_TIME)

// ── 偽 transport（ページ取得の外部通信を模擬。実通信はしない）────────

type FakePage = { status: number; body: string }

function makeFakeTransport(pages: Record<string, FakePage>): {
  transport: FetchTransport
  calls: string[]
} {
  const calls: string[] = []
  const transport: FetchTransport = async (url: string) => {
    calls.push(url)
    const entry: FakePage =
      pages[url] ??
      (url.endsWith('/robots.txt')
        ? { status: 200, body: 'User-agent: *\nAllow: /' }
        : { status: 404, body: '' })
    const response: TransportResponse = {
      status: entry.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null,
      },
      text: async () => entry.body,
    }
    return response
  }
  return { transport, calls }
}

// ── 偽 AI クライアント（固定応答。実 API を呼ばない）─────────────────

function makeFakeAiClient(responses: readonly (string | Error)[]): {
  client: ChatCompletionsLike
  calls: ChatCompletionParams[]
} {
  const calls: ChatCompletionParams[] = []
  let index = 0
  const client: ChatCompletionsLike = {
    create: async (params: ChatCompletionParams): Promise<ChatCompletionResult> => {
      calls.push(params)
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (response instanceof Error) throw response
      return { content: response }
    },
  }
  return { client, calls }
}

// ── メモリ上のファイル（保存物の読み書きを模擬）─────────────────────

function memFiles(initial: Record<string, string> = {}): {
  files: DiscoveryFileOps
  map: Map<string, string>
  written: string[]
} {
  const map = new Map(Object.entries(initial))
  const written: string[] = []
  const files: DiscoveryFileOps = {
    exists: (path) => map.has(path),
    read: (path) => map.get(path) ?? '',
    write: (path, text) => {
      map.set(path, text)
      written.push(path)
    },
  }
  return { files, map, written }
}

function collectLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = []
  return { log: (line) => void lines.push(line), lines }
}

async function main(): Promise<void> {
// ── [1] HTML からのリンク抽出・相対 URL 正規化 ─────────────────────
console.log('\n[1] HTML からのリンク抽出・相対 URL 正規化')
{
  const base = 'https://www.cfa.go.jp/policies/kokoseido/jidouteate'
  check(
    '相対 URL を基準 URL つきの絶対 URL に正規化',
    normalizeLinkTarget('/policies/kokoseido/jidouteate/annai', base) ===
      'https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai',
  )
  check(
    '相対パス（ディレクトリ基準）も解決できる',
    normalizeLinkTarget('annai', base) ===
      'https://www.cfa.go.jp/policies/kokoseido/annai',
  )
  check('フラグメントは除去する', normalizeLinkTarget('/x#sec', base) === 'https://www.cfa.go.jp/x')
  check('ページ内リンク（#のみ）は対象外', normalizeLinkTarget('#section', base) === null)
  check('mailto: は対象外', normalizeLinkTarget('mailto:x@example.com', base) === null)
  check('javascript: は対象外', normalizeLinkTarget('javascript:void(0)', base) === null)
  check('data: は対象外', normalizeLinkTarget('data:text/html,x', base) === null)
  check('空文字は対象外', normalizeLinkTarget('   ', base) === null)
  check(
    '実体参照（&amp;）を含む URL はデコードして解決',
    normalizeLinkTarget('/search?a=1&amp;b=2', base) === 'https://www.cfa.go.jp/search?a=1&b=2',
  )
  check('http の URL も解決はする（可否判定は別途で拒否する）', normalizeLinkTarget('http://www.cfa.go.jp/x', base) === 'http://www.cfa.go.jp/x')

  const html = [
    '<html><body>',
    '<a href="/policies/a">制度A</a>',
    "<a href='/policies/b'>制度B</a>",
    '<a href=/policies/c>制度C</a>',
    '<a href="/policies/a">重複リンク</a>',
    '<a href="mailto:x@example.com">メール</a>',
    '<a href="javascript:void(0)">JS</a>',
    '<a href="#top">トップ</a>',
    '<a href="https://www.cfa.go.jp/policies/a">絶対（相対と同一路線）</a>',
    '</body></html>',
  ].join('\n')
  const links = extractHtmlLinks(html, base)
  check(
    'HTML からリンクを抽出（引用符 3 形式・重複排除・非導線スキーム除去）',
    links.length === 3 &&
      links.map((l) => l.url).join(',') ===
        'https://www.cfa.go.jp/policies/a,https://www.cfa.go.jp/policies/b,https://www.cfa.go.jp/policies/c',
    links.map((l) => l.url).join(','),
  )
  check('アンカーテキストも取得できる', links[0].anchorText === '制度A')

  const fromHrefs = linksFromHrefs(
    ['/policies/a', '/policies/a', 'mailto:x@example.com', '/policies/b'],
    base,
  )
  check(
    'hrefs からの正規化も同じ基準（重複排除）',
    fromHrefs.length === 2 &&
      fromHrefs[0].url === 'https://www.cfa.go.jp/policies/a' &&
      fromHrefs[1].url === 'https://www.cfa.go.jp/policies/b',
  )
}

// ── [2] 未許可ホスト・不正 URL の拒否 ─────────────────────────────
console.log('\n[2] 未許可ホスト・不正 URL の拒否')
{
  const allowed = new Set(['www.cfa.go.jp', 'www.jasso.go.jp'])
  const links = [
    { url: 'https://www.cfa.go.jp/policies/a', anchorText: '' },
    { url: 'https://www.jasso.go.jp/shogakukin/', anchorText: '' },
    { url: 'https://www.city.example.lg.jp/kosodate', anchorText: '' },
    { url: 'http://www.cfa.go.jp/insecure', anchorText: '' },
    { url: 'https://user:pass@www.cfa.go.jp/x', anchorText: '' },
    { url: 'https://localhost/admin', anchorText: '' },
    { url: 'https://127.0.0.1/x', anchorText: '' },
    { url: 'https://169.254.169.254/latest/meta-data', anchorText: '' },
    { url: 'https://192.168.0.1/router', anchorText: '' },
    { url: 'https://www.cfa.go.jp:8443/x', anchorText: '' },
    { url: 'https://sub.www.cfa.go.jp/x', anchorText: '' },
    { url: 'not-a-url', anchorText: '' },
  ]
  const { acceptable, rejected } = classifyDiscoveredLinks(links, { allowedHosts: allowed })
  check(
    '許可ホスト（完全一致）の https リンクのみ取得対象',
    acceptable.length === 2 &&
      acceptable.map((l) => l.url).join(',') ===
        'https://www.cfa.go.jp/policies/a,https://www.jasso.go.jp/shogakukin/',
    acceptable.map((l) => l.url).join(','),
  )
  const reasons = new Map(rejected.map((r) => [r.url, r.code]))
  check('未許可ホストは not-allowlisted で拒否', reasons.get('https://www.city.example.lg.jp/kosodate') === 'not-allowlisted')
  check('http は insecure-scheme で拒否', reasons.get('http://www.cfa.go.jp/insecure') === 'insecure-scheme')
  check('URL 内ユーザー情報は credentials-in-url で拒否', reasons.get('https://user:pass@www.cfa.go.jp/x') === 'credentials-in-url')
  check('localhost は blocked-target で拒否', reasons.get('https://localhost/admin') === 'blocked-target')
  check('ループバック IP は拒否', reasons.get('https://127.0.0.1/x') === 'blocked-target')
  check('リンクローカル IP（SSRF）は拒否', reasons.get('https://169.254.169.254/latest/meta-data') === 'blocked-target')
  check('プライベート IP は拒否', reasons.get('https://192.168.0.1/router') === 'blocked-target')
  check('標準外ポートは拒否', reasons.get('https://www.cfa.go.jp:8443/x') === 'blocked-target')
  check('サブドメインの推測許可はしない（完全一致のみ）', reasons.get('https://sub.www.cfa.go.jp/x') === 'not-allowlisted')
  check('解析不能な URL は invalid-url で拒否', reasons.get('not-a-url') === 'invalid-url')
}

// ── [3] 同一 URL・同一候補の重複排除 ──────────────────────────────
console.log('\n[3] 同一 URL・同一候補の重複排除')
{
  const entry = (url: string): UrlCandidate => ({
    urlId: makeUrlId(url),
    url,
    taskId: 'nation/child-allowance-cash',
    regionId: 'nation',
    fieldId: 'child-allowance-cash',
    foundFrom: null,
    discoveryMethod: 'survey-plan-portal',
    firstFoundAt: FIXED_TIME,
    lastFetch: null,
    contentHash: null,
    note: '',
  })
  let urls: UrlCandidate[] = []
  urls = upsertUrlCandidate(urls, entry('https://www.cfa.go.jp/a'))
  urls = upsertUrlCandidate(urls, entry('https://www.cfa.go.jp/a'))
  urls = upsertUrlCandidate(urls, entry('https://www.cfa.go.jp/b'))
  check('同一 URL の候補は 1 件に重複排除', urls.length === 2)
  check(
    '同じ URL は常に同じ URL ID',
    makeUrlId('https://www.cfa.go.jp/a') === entry('https://www.cfa.go.jp/a').urlId,
  )

  // 制度候補: 年度違い・別制度は統合しない
  const keyA = candidateDedupeKey({
    regionId: 'nation',
    implementer: 'こども家庭庁',
    name: '児童手当',
    fiscalYear: '2026年度',
    sourceUrl: 'https://www.cfa.go.jp/a',
  })
  const keyB = candidateDedupeKey({
    regionId: 'nation',
    implementer: 'こども家庭庁',
    name: '児童手当',
    fiscalYear: '2025年度',
    sourceUrl: 'https://www.cfa.go.jp/a',
  })
  const keyC = candidateDedupeKey({
    regionId: 'nation',
    implementer: 'こども家庭庁',
    name: '児童手当',
    fiscalYear: '2026年度',
    sourceUrl: 'https://www.cfa.go.jp/b',
  })
  const keyA2 = candidateDedupeKey({
    regionId: 'nation',
    implementer: 'こども家庭庁',
    name: ' 児童 手当 ', // 表記ゆれ（空白）は同一視
    fiscalYear: '2026年度',
    sourceUrl: 'https://www.cfa.go.jp/a',
  })
  check('同一制度（同一年度・同一根拠URL）は同じ dedupeKey', keyA === keyA2)
  check('年度違いは別 dedupeKey（誤統合しない）', keyA !== keyB)
  check('根拠URL が違えば別 dedupeKey', keyA !== keyC)
  check('制度名が違えば別 dedupeKey', makeCandidateId(keyA) !== makeCandidateId(keyA + 'x'))

  const baseCandidate: DiscoveryCandidate = {
    candidateId: makeCandidateId(keyA),
    taskId: 'nation/child-allowance-cash',
    regionId: 'nation',
    fieldId: 'child-allowance-cash',
    name: '児童手当',
    summary: null,
    implementer: 'こども家庭庁',
    regionScope: null,
    kind: 'cash_benefit',
    eligibility: { ageNote: null, householdNote: null, incomeNote: null, other: [] },
    amount: { value: null, unit: null, description: null },
    application: { how: null, deadlineNote: null, documents: [] },
    fiscalYear: null,
    validPeriod: null,
    sourceUrl: 'https://www.cfa.go.jp/a',
    sourceRecordId: null,
    retrievedAt: FIXED_TIME,
    contentHash: 'hash',
    evidenceQuotes: [],
    unknownItems: [],
    unconfirmedItems: [],
    discoveryMethod: 'ai-extraction',
    extractionModel: 'mock',
    firstExtractedAt: FIXED_TIME,
    extractedAt: FIXED_TIME,
    status: 'unverified',
    dedupeKey: keyA,
    recheckReason: null,
  }
  let cands = upsertCandidates([], [baseCandidate])
  cands = upsertCandidates(cands, [{ ...baseCandidate, summary: '再抽出で更新' }])
  check('同一候補の再抽出は追加せず置き換え（1 件のまま）', cands.length === 1)
  check('再抽出後も firstExtractedAt は最初のまま', cands[0].firstExtractedAt === FIXED_TIME)
  const discarded = upsertCandidates(
    [{ ...baseCandidate, status: 'discarded', recheckReason: '重複のため除外' }],
    [baseCandidate],
  )
  check('除外済み（discarded）の候補は再抽出で復活しない', discarded[0].status === 'discarded')
}

// ── [4] AI 抽出: 入力の組み立てと出力検証 ─────────────────────────
console.log('\n[4] AI 抽出: 入力の組み立てと出力検証')
{
  const messages = buildExtractionMessages({
    url: 'https://www.cfa.go.jp/a',
    title: '児童手当',
    text: '本文テキスト。月15,000円。',
  })
  check(
    'AI への入力に取得済みページ本文が渡る（根拠は本文のみ）',
    messages.some((m) => m.content.includes('本文テキスト。月15,000円。')),
  )
  check(
    'AI への入力に取得元 URL が含まれる',
    messages.some((m) => m.content.includes('https://www.cfa.go.jp/a')),
  )
  check(
    'AI への指示に「推測禁止・本文のみ根拠」が含まれる',
    messages[0].content.includes('推測') && messages[0].content.includes('根拠'),
  )

  const goodJson =
    '{"candidates":[{"name":"児童手当","summary":"手当","evidenceQuotes":[],"unknownItems":[]}]}'
  const good = parseExtractionOutput(goodJson)
  check('正常な JSON 出力を検証できる', good.ok && good.value.candidates[0].name === '児童手当')
  const fenced = parseExtractionOutput('```json\n' + goodJson + '\n```')
  check('コードフェンス付き JSON も検証できる', fenced.ok && fenced.value.candidates.length === 1)
  const empty = parseExtractionOutput('{"candidates":[]}')
  check('空の候補（制度の記載なし）は 0 件として有効', empty.ok && empty.value.candidates.length === 0)
  const broken = parseExtractionOutput('{"candidates": [ {"name": "途中で壊れた"')
  check('不正な JSON 出力はエラーとして扱い保存しない', !broken.ok && broken.error.includes('JSON'))
  const missingName = parseExtractionOutput('{"candidates":[{"summary":"制度名が無い"}]}')
  check('必須情報（制度名）が不足した出力はエラー', !missingName.ok && missingName.error.includes('name'))
  const notObject = parseExtractionOutput('すみません、今日はお休みです。')
  check('JSON でない応答はエラー', !notObject.ok)

  // 抽出 → 候補化の流れ（偽クライアント。実 API 呼び出しなし）
  const ctx: ExtractionContext = {
    taskId: 'nation/child-allowance-cash',
    regionId: 'nation',
    fieldId: 'child-allowance-cash',
    sourceUrl: 'https://www.cfa.go.jp/a',
    sourceRecordId: null,
    retrievedAt: FIXED_TIME,
    contentHash: contentHashOf('本文'),
  }
  const fake = makeFakeAiClient([goodJson])
  const outcome = await extractCandidatesWithClient(
    fake.client,
    { url: ctx.sourceUrl, title: '児童手当', text: '本文' },
    ctx,
    { model: 'iniad:gpt-5.4', extractedAt: FIXED_TIME },
  )
  check('ダミー本文 → AI 抽出 → 候補化の流れが通る', outcome.ok && outcome.candidates.length === 1)
  check(
    'AI へのリクエストは chat.completions 相当（model / messages のみ）',
    fake.calls.length === 1 && Object.keys(fake.calls[0]).sort().join(',') === 'messages,model',
  )
  if (outcome.ok) {
    const c = outcome.candidates[0]
    check('候補の根拠URL は取得元ページ（AI の創作 URL を採用しない）', c.sourceUrl === ctx.sourceUrl)
    check('候補は status unverified（未検証のまま）', c.status === 'unverified')
    check(
      '取得日時・本文ハッシュが記録される',
      c.retrievedAt === FIXED_TIME && c.contentHash === ctx.contentHash,
    )
  }
  const aiError = makeFakeAiClient([new Error('upstream 500')])
  const failedOutcome = await extractCandidatesWithClient(
    aiError.client,
    { url: ctx.sourceUrl, title: null, text: '本文' },
    ctx,
    { model: 'iniad:gpt-5.4', extractedAt: FIXED_TIME },
  )
  check('AI API 障害は候補にせず失敗として返す', !failedOutcome.ok && failedOutcome.error.includes('AI API'))
}

// ── [5] 根拠のない金額・申請条件を確定扱いしない ───────────────────
console.log('\n[5] 根拠のない金額・申請条件を確定扱いしない')
{
  const ctx: ExtractionContext = {
    taskId: 'nation/child-allowance-cash',
    regionId: 'nation',
    fieldId: 'child-allowance-cash',
    sourceUrl: 'https://www.cfa.go.jp/a',
    sourceRecordId: null,
    retrievedAt: FIXED_TIME,
    contentHash: 'hash',
  }
  const withEvidence = normalizeExtractedCandidate(
    {
      name: '児童手当',
      amount: { value: 15000, unit: 'yen_per_month', description: '3歳未満' },
      eligibility: { ageNote: '0歳〜18歳', incomeNote: '所得制限あり' },
      application: { deadlineNote: '出生後15日以内' },
      regionScope: '全国',
      fiscalYear: '2026年度',
      evidenceQuotes: [
        { field: 'amount', quote: '月15,000円' },
        { field: 'age', quote: '0歳〜18歳に達する日以後' },
        { field: 'income', quote: '所得制限の記載' },
        { field: 'deadline', quote: '出生日の翌日から15日以内' },
        { field: 'region', quote: '国内に住所を有する' },
        { field: 'fiscalYear', quote: '令和8年度' },
      ],
      unknownItems: [],
    },
    ctx,
    { extractionModel: 'mock', extractedAt: FIXED_TIME },
  )
  check('根拠抜粋があれば金額を保持', withEvidence.amount.value === 15000)
  check(
    '根拠抜粋があれば条件・期限・地域・年度を保持',
    withEvidence.eligibility.ageNote === '0歳〜18歳' &&
      withEvidence.eligibility.incomeNote === '所得制限あり' &&
      withEvidence.application.deadlineNote === '出生後15日以内' &&
      withEvidence.regionScope === '全国' &&
      withEvidence.fiscalYear === '2026年度',
  )
  check('根拠がある項目は unconfirmedItems に残らない', withEvidence.unconfirmedItems.length === 0)

  const withoutEvidence = normalizeExtractedCandidate(
    {
      name: '架空の手当',
      amount: { value: 99999, unit: 'yen_per_month', description: null },
      eligibility: { ageNote: '5歳まで', incomeNote: 'なし', householdNote: '2人以上' },
      application: { deadlineNote: '3月末' },
      regionScope: '東京都',
      fiscalYear: '2025年度',
      validPeriod: '2025年4月から1年間',
      evidenceQuotes: [],
      unknownItems: ['必要書類'],
    },
    ctx,
    { extractionModel: 'mock', extractedAt: FIXED_TIME },
  )
  check('根拠抜粋のない金額は確定扱いにせず null', withoutEvidence.amount.value === null)
  check(
    '根拠抜粋のない年齢・所得・世帯条件も null',
    withoutEvidence.eligibility.ageNote === null &&
      withoutEvidence.eligibility.incomeNote === null &&
      withoutEvidence.eligibility.householdNote === null,
  )
  check(
    '根拠抜粋のない期限・対象地域・適用年度・有効期間も null',
    withoutEvidence.application.deadlineNote === null &&
      withoutEvidence.regionScope === null &&
      withoutEvidence.fiscalYear === null &&
      withoutEvidence.validPeriod === null,
  )
  check(
    '降格した項目は unconfirmedItems に理由つきで残る',
    withoutEvidence.unconfirmedItems.length >= 7 &&
      withoutEvidence.unconfirmedItems.every((u) => u.reason.length > 0),
    String(withoutEvidence.unconfirmedItems.length),
  )
  check('AI の不明項目（unknownItems）も引き継ぐ', withoutEvidence.unknownItems.includes('必要書類'))
  check('根拠なし主張でも候補自体は保持（unverified）', withoutEvidence.status === 'unverified')
  check(
    '年度の主張は降格しても重複判定キーには残す（年度違いの誤統合防止）',
    withoutEvidence.dedupeKey.includes('2025年度'),
  )
}

// ── [6] 調査計画の候補件数更新 ───────────────────────────────────
console.log('\n[6] 調査計画の候補件数更新')
{
  const makeTask = (taskId: string, regionId: string, fieldId: string): SurveyTask => ({
    taskId,
    regionId,
    fieldId,
    status: 'not_started',
    lastSurveyedAt: null,
    nextScheduledDate: null,
    portalUrls: [],
    candidateCount: 0,
    notes: '',
    openIssues: [],
  })
  const plan: SurveyPlan = {
    formatVersion: 1,
    regions: [
      { id: 'nation', name: '国', kind: 'nation' },
      { id: 'tokyo', name: '東京都', kind: 'prefecture' },
    ],
    fields: [
      { id: 'child-allowance-cash', name: '児童手当・手当' },
      { id: 'higher-education', name: '高等教育' },
    ],
    tasks: [
      makeTask('nation/child-allowance-cash', 'nation', 'child-allowance-cash'),
      makeTask('nation/higher-education', 'nation', 'higher-education'),
      makeTask('tokyo/child-allowance-cash', 'tokyo', 'child-allowance-cash'),
      makeTask('tokyo/higher-education', 'tokyo', 'higher-education'),
    ],
  }
  const cand = (
    taskId: string,
    name: string,
    status: DiscoveryCandidate['status'] = 'unverified',
  ): DiscoveryCandidate => ({
    candidateId: makeCandidateId(name),
    taskId,
    regionId: taskId.split('/')[0],
    fieldId: taskId.split('/')[1],
    name,
    summary: null,
    implementer: null,
    regionScope: null,
    kind: null,
    eligibility: { ageNote: null, householdNote: null, incomeNote: null, other: [] },
    amount: { value: null, unit: null, description: null },
    application: { how: null, deadlineNote: null, documents: [] },
    fiscalYear: null,
    validPeriod: null,
    sourceUrl: 'https://www.cfa.go.jp/a',
    sourceRecordId: null,
    retrievedAt: FIXED_TIME,
    contentHash: 'hash',
    evidenceQuotes: [],
    unknownItems: [],
    unconfirmedItems: [],
    discoveryMethod: 'ai-extraction',
    extractionModel: 'mock',
    firstExtractedAt: FIXED_TIME,
    extractedAt: FIXED_TIME,
    status,
    dedupeKey: name,
    recheckReason: null,
  })
  const candidates = [
    cand('nation/child-allowance-cash', '候補1'),
    cand('nation/child-allowance-cash', '候補2'),
    cand('nation/child-allowance-cash', '候補3', 'discarded'),
    cand('tokyo/higher-education', '候補4'),
  ]
  const counts = computeCandidateCountsByTask(candidates)
  check('discarded は候補件数に数えない', counts.get('nation/child-allowance-cash') === 2)
  check('タスクごとの候補件数を集計', counts.get('tokyo/higher-education') === 1)
  check('候補が無いタスクは 0 件（未調査の意味ではない）', !counts.has('tokyo/child-allowance-cash'))

  const { updates, unknownTaskIds } = planUpdatesForCandidateCounts(plan, counts)
  check(
    '候補件数の更新（set-candidate-count）を作成',
    updates.length === 2 && updates.every((u) => u.type === 'set-candidate-count'),
    `updates=${updates.length}`,
  )
  check('未使用の taskId は検出されない', unknownTaskIds.length === 0)
  check('未知の taskId は更新せず区別して返す', (() => {
    const r = planUpdatesForCandidateCounts(plan, new Map([['unknown/task', 1]]))
    return r.updates.length === 0 && r.unknownTaskIds.join(',') === 'unknown/task'
  })())

  const updated = applyCandidateCountUpdates(plan, updates)
  const t1 = updated.tasks.find((t) => t.taskId === 'nation/child-allowance-cash')
  const t2 = updated.tasks.find((t) => t.taskId === 'tokyo/higher-education')
  check('調査計画の candidateCount が更新される', t1?.candidateCount === 2 && t2?.candidateCount === 1)
  check(
    '候補が見つかっただけでは status を変更しない（surveyed にしない）',
    updated.tasks.every((t) => t.status === 'not_started'),
  )
  const same = planUpdatesForCandidateCounts(
    {
      ...plan,
      tasks: plan.tasks.map((t) => ({
        ...t,
        candidateCount: t.taskId === 'tokyo/higher-education' ? 1 : 2,
      })),
    },
    counts,
  )
  check('既に同じ件数なら更新を作らない', same.updates.length === 0)
}

// ── [7] パイプライン E2E（scan → extract。偽 transport / 偽 AI）────
console.log('\n[7] パイプライン E2E（scan → extract）')
const CFA_SEED = 'https://www.cfa.go.jp/policies/kokoseido/jidouteate'
const CFA_ANNAI = 'https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai'
const JASSO = 'https://www.jasso.go.jp/shogakukin/'
const miniPlan: SurveyPlan = {
  formatVersion: 1,
  regions: [
    { id: 'nation', name: '国', kind: 'nation' },
    { id: 'tokyo', name: '東京都', kind: 'prefecture' },
  ],
  fields: [
    { id: 'child-allowance-cash', name: '児童手当・手当' },
    { id: 'higher-education', name: '高等教育' },
  ],
  tasks: [
    {
      taskId: 'nation/child-allowance-cash',
      regionId: 'nation',
      fieldId: 'child-allowance-cash',
      status: 'not_started',
      lastSurveyedAt: null,
      nextScheduledDate: null,
      portalUrls: [CFA_SEED],
      candidateCount: 0,
      notes: '',
      openIssues: [],
    },
    {
      taskId: 'nation/higher-education',
      regionId: 'nation',
      fieldId: 'higher-education',
      status: 'not_started',
      lastSurveyedAt: null,
      nextScheduledDate: null,
      portalUrls: [],
      candidateCount: 0,
      notes: '',
      openIssues: [],
    },
    {
      taskId: 'tokyo/child-allowance-cash',
      regionId: 'tokyo',
      fieldId: 'child-allowance-cash',
      status: 'not_started',
      lastSurveyedAt: null,
      nextScheduledDate: null,
      portalUrls: [],
      candidateCount: 0,
      notes: '',
      openIssues: [],
    },
    {
      taskId: 'tokyo/higher-education',
      regionId: 'tokyo',
      fieldId: 'higher-education',
      status: 'not_started',
      lastSurveyedAt: null,
      nextScheduledDate: null,
      portalUrls: [],
      candidateCount: 0,
      notes: '',
      openIssues: [],
    },
  ],
}
const SEED_HTML = [
  '<html><head><title>児童手当</title></head><body>',
  '<p>児童手当のページ本文。国内に住所を有する0歳から18歳まで。月15,000円。</p>',
  '<a href="/policies/kokoseido/jidouteate/annai">手当の案内</a>',
  '<a href="https://www.jasso.go.jp/shogakukin/">日本学生支援機構</a>',
  '<a href="https://www.city.example.lg.jp/kosodate">区の子育てページ</a>',
  '<a href="http://www.cfa.go.jp/insecure">http リンク</a>',
  '<a href="mailto:x@example.com">メール</a>',
  '<a href="/policies/kokoseido/jidouteate/annai">重複リンク</a>',
  '</body></html>',
].join('\n')

const e2e = memFiles({
  '/repo/data/survey-plan.json': serializeSurveyPlan(miniPlan),
})
const transport = makeFakeTransport({ [CFA_SEED]: { status: 200, body: SEED_HTML } })
const scanLog = collectLog()
const scanCode = await runDiscoveryCli(
  ['scan', '--task', 'nation/child-allowance-cash', '--live'],
  {
    env: { DISCOVERY_LIVE: '1' },
    cwd: '/repo',
    files: e2e.files,
    createTransport: () => transport.transport,
    now: fixedNow,
    log: scanLog.log,
  },
)
check('scan --live: 成功（exit 0）', scanCode === 0, scanLog.lines.join('\n'))
const urlStoreParsed = parseUrlCandidateStore(e2e.map.get('/repo/data/discovery/url-candidates.json') ?? '')
check('scan: シードと許可ホストのリンクのみ候補URL台帳に保存', urlStoreParsed.ok && (() => {
  const urls = urlStoreParsed.value.urls.map((u) => u.url).sort()
  return urls.join(',') === [CFA_SEED, CFA_ANNAI, JASSO].sort().join(',')
})(), urlStoreParsed.ok ? urlStoreParsed.value.urls.map((u) => u.url).join(',') : urlStoreParsed.error)
check(
  'scan: 未許可ホスト・http のリンクは取得対象に追加されず取得もされない',
  !transport.calls.some((u) => u.includes('city.example.lg.jp')) &&
    !transport.calls.some((u) => u.startsWith('http://')),
  transport.calls.join(','),
)
check('scan: 未許可ホストのリンクは取得もされていない', !transport.calls.includes('https://www.city.example.lg.jp/kosodate'))
const pageStoreParsed = parsePageStore(e2e.map.get('/repo/data/discovery/pages.json') ?? '')
check(
  'scan: ページ本文とハッシュを保存し抽出待ちに',
  pageStoreParsed.ok &&
    pageStoreParsed.value.pages.length === 1 &&
    pageStoreParsed.value.pages[0].extractState === 'pending' &&
    pageStoreParsed.value.pages[0].text.includes('児童手当のページ本文'),
)

// extract --live（偽 AI。2 件抽出: 根拠あり 1 件・根拠なし 1 件）
const aiJson = JSON.stringify({
  candidates: [
    {
      name: '児童手当',
      summary: '子どもを養育する方に支給',
      implementer: 'こども家庭庁',
      regionScope: '全国',
      kind: 'cash_benefit',
      eligibility: { ageNote: '0歳〜18歳', incomeNote: '所得制限あり' },
      amount: { value: 15000, unit: 'yen_per_month', description: '3歳未満' },
      application: { how: '市区町村窓口', deadlineNote: '出生後15日以内', documents: ['認定請求書'] },
      fiscalYear: '2026年度',
      evidenceQuotes: [
        { field: 'amount', quote: '月15,000円' },
        { field: 'age', quote: '0歳から18歳まで' },
        { field: 'income', quote: '所得制限' },
        { field: 'deadline', quote: '出生後15日以内' },
        { field: 'region', quote: '国内に住所' },
        { field: 'fiscalYear', quote: '2026年度' },
      ],
      unknownItems: [],
    },
    {
      name: '第3子以降の加算',
      amount: { value: 30000, unit: 'yen_per_month', description: null },
      evidenceQuotes: [],
      unknownItems: ['対象条件'],
    },
  ],
})
const ai = makeFakeAiClient([aiJson])
const extractLog = collectLog()
const extractCode = await runDiscoveryCli(['extract', '--live'], {
  env: { DISCOVERY_LIVE: '1', INIAD_API_KEY: 'dummy-for-test' },
  cwd: '/repo',
  files: e2e.files,
  createAiClient: () => ai.client,
  now: fixedNow,
  log: extractLog.log,
})
check('extract --live: 成功（exit 0）', extractCode === 0, extractLog.lines.join('\n'))
check(
  'extract: AI には取得済みページ本文が渡る',
  ai.calls.length === 1 &&
    ai.calls[0].messages.some((m) => m.content.includes('児童手当のページ本文')),
)
const candParsed = parseCandidateStore(e2e.map.get('/repo/data/discovery/candidates.json') ?? '')
check(
  'extract: 候補を保存（2 件・すべて unverified）',
  candParsed.ok &&
    candParsed.value.candidates.length === 2 &&
    candParsed.value.candidates.every((c) => c.status === 'unverified'),
)
if (candParsed.ok) {
  const withEv = candParsed.value.candidates.find((c) => c.name === '児童手当')
  const withoutEv = candParsed.value.candidates.find((c) => c.name === '第3子以降の加算')
  check('extract: 根拠抜粋つきの金額は保持', withEv?.amount.value === 15000)
  check('extract: 根拠抜粋のない金額は未確認に降格', withoutEv?.amount.value === null)
  check(
    'extract: 候補に取得元 URL・取得日時・本文ハッシュ・根拠抜粋が記録される',
    withEv?.sourceUrl === CFA_SEED &&
      withEv?.retrievedAt === fixedNow().toISOString() &&
      typeof withEv?.contentHash === 'string' &&
      withEv?.evidenceQuotes.length === 6,
    `retrievedAt=${withEv?.retrievedAt} quotes=${withEv?.evidenceQuotes.length}`,
  )
  check(
    'extract: 候補に調査タスク・地域・分野が記録される',
    withEv?.taskId === 'nation/child-allowance-cash' &&
      withEv?.regionId === 'nation' &&
      withEv?.fieldId === 'child-allowance-cash',
  )
}
const planAfter = parseSurveyPlanJson(
  e2e.map.get('/repo/data/survey-plan.json') ?? '',
  'data/survey-plan.json',
)
const planTask = planAfter.tasks.find((t) => t.taskId === 'nation/child-allowance-cash')
check('extract: 調査計画の候補件数を更新', planTask?.candidateCount === 2)
check(
  'extract: 候補発見だけでは status を変更しない（not_started のまま）',
  planTask?.status === 'not_started',
)
const pageAfter = parsePageStore(e2e.map.get('/repo/data/discovery/pages.json') ?? '')
check(
  'extract: ページの抽出状態が extracted に',
  pageAfter.ok && pageAfter.value.pages[0].extractState === 'extracted',
)

// 再実行（重複登録されない）
const extractAgain = await runDiscoveryCli(['extract', '--live'], {
  env: { DISCOVERY_LIVE: '1', INIAD_API_KEY: 'dummy-for-test' },
  cwd: '/repo',
  files: e2e.files,
  createAiClient: () => ai.client,
  now: fixedNow,
  log: () => {},
})
const candAgain = parseCandidateStore(e2e.map.get('/repo/data/discovery/candidates.json') ?? '')
check(
  'extract 再実行: 対象ページなし・候補は重複登録されない',
  extractAgain === 0 && candAgain.ok && candAgain.value.candidates.length === 2,
)
// scan 再実行（URL 重複登録されない）
await runDiscoveryCli(['scan', '--task', 'nation/child-allowance-cash', '--live'], {
  env: { DISCOVERY_LIVE: '1' },
  cwd: '/repo',
  files: e2e.files,
  createTransport: () => transport.transport,
  now: fixedNow,
  log: () => {},
})
const urlAgain = parseUrlCandidateStore(e2e.map.get('/repo/data/discovery/url-candidates.json') ?? '')
check(
  'scan 再実行: URL 候補は重複登録されない（3 件のまま）',
  urlAgain.ok && urlAgain.value.urls.length === 3,
)

// ── [7b] 抽出失敗からの復旧（--retry）────────────────────────────
console.log('\n[7b] 取得失敗・抽出失敗からの安全な復旧')
{
  const pageRec: PageRecord = {
    url: CFA_ANNAI,
    finalUrl: null,
    title: '手当の案内',
    retrievedAt: FIXED_TIME,
    contentHash: contentHashOf('案内本文'),
    text: '案内本文',
    textTruncated: false,
    extractState: 'pending',
    extractedAt: null,
    extractionError: null,
    extractedCandidateCount: null,
  }
  const urlRec: UrlCandidate = {
    urlId: makeUrlId(CFA_ANNAI),
    url: CFA_ANNAI,
    taskId: 'nation/higher-education',
    regionId: 'nation',
    fieldId: 'higher-education',
    foundFrom: CFA_SEED,
    discoveryMethod: 'page-link',
    firstFoundAt: FIXED_TIME,
    lastFetch: {
      attemptedAt: FIXED_TIME,
      state: 'failed',
      failureCode: 'http-error',
      failureReason: '503 でした',
    },
    contentHash: null,
    note: '',
  }
  const mem = memFiles({
    '/repo/data/survey-plan.json': serializeSurveyPlan(miniPlan),
    '/repo/data/discovery/url-candidates.json': serializeUrlCandidateStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: FIXED_TIME,
      urls: [urlRec],
    }),
    '/repo/data/discovery/pages.json': serializePageStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: FIXED_TIME,
      pages: [pageRec],
    }),
  })
  // 1 回目: AI 応答が壊れている → 抽出失敗として記録
  const badAi = makeFakeAiClient(['応答が JSON ではありません'])
  await runDiscoveryCli(['extract', '--live'], {
    env: { DISCOVERY_LIVE: '1', INIAD_API_KEY: 'dummy-for-test' },
    cwd: '/repo',
    files: mem.files,
    createAiClient: () => badAi.client,
    now: fixedNow,
    log: () => {},
  })
  const pagesAfterFail = parsePageStore(mem.map.get('/repo/data/discovery/pages.json') ?? '')
  check(
    '抽出失敗は例外にせず記録する（extractState=failed + 理由）',
    pagesAfterFail.ok &&
      pagesAfterFail.value.pages[0].extractState === 'failed' &&
      (pagesAfterFail.value.pages[0].extractionError ?? '').length > 0,
    pagesAfterFail.ok ? String(pagesAfterFail.value.pages[0].extractionError) : pagesAfterFail.error,
  )
  const candsAfterFail = parseCandidateStore(mem.map.get('/repo/data/discovery/candidates.json') ?? '')
  check('抽出失敗時に不正な候補は保存しない', candsAfterFail.ok && candsAfterFail.value.candidates.length === 0)

  // 2 回目: --retry で再抽出（正常応答）→ 復旧
  const goodAi = makeFakeAiClient([
    '{"candidates":[{"name":"奨学金","evidenceQuotes":[],"unknownItems":[]}]}',
  ])
  const retryCode = await runDiscoveryCli(['extract', '--live', '--retry'], {
    env: { DISCOVERY_LIVE: '1', INIAD_API_KEY: 'dummy-for-test' },
    cwd: '/repo',
    files: mem.files,
    createAiClient: () => goodAi.client,
    now: fixedNow,
    log: () => {},
  })
  const pagesAfterRetry = parsePageStore(mem.map.get('/repo/data/discovery/pages.json') ?? '')
  const candsAfterRetry = parseCandidateStore(mem.map.get('/repo/data/discovery/candidates.json') ?? '')
  check(
    '--retry: 抽出失敗から復旧できる',
    retryCode === 0 &&
      pagesAfterRetry.ok &&
      pagesAfterRetry.value.pages[0].extractState === 'extracted' &&
      candsAfterRetry.ok &&
      candsAfterRetry.value.candidates.length === 1,
  )
  const planAfterRetry = parseSurveyPlanJson(
    mem.map.get('/repo/data/survey-plan.json') ?? '',
    'data/survey-plan.json',
  )
  check(
    '復旧後の候補件数も調査計画に反映',
    planAfterRetry.tasks.find((t) => t.taskId === 'nation/higher-education')?.candidateCount === 1,
  )
  // 取得失敗の記録（recordUrlFetch）→ 成功で上書きできること
  const recovered = recordUrlFetch(
    [urlRec],
    CFA_ANNAI,
    { attemptedAt: FIXED_TIME, state: 'ok', failureCode: null, failureReason: null },
    contentHashOf('案内本文'),
  )
  check(
    '取得失敗の記録は成功時に上書きできる（復旧可能）',
    recovered[0].lastFetch?.state === 'ok' && recovered[0].contentHash !== null,
  )
}

// ── [7c] dry-run では外部通信・保存が発生しない ────────────────────
console.log('\n[7c] dry-run の安全性')
{
  const mem = memFiles({ '/repo/data/survey-plan.json': serializeSurveyPlan(miniPlan) })
  let transportCreated = 0
  let aiCreated = 0
  const deps: DiscoveryCliDeps = {
    env: { DISCOVERY_LIVE: '1' },
    cwd: '/repo',
    files: mem.files,
    createTransport: () => {
      transportCreated += 1
      return makeFakeTransport({}).transport
    },
    createAiClient: () => {
      aiCreated += 1
      return makeFakeAiClient([]).client
    },
    now: fixedNow,
    log: () => {},
  }
  const scanCode = await runDiscoveryCli(['scan'], deps)
  const fetchCode = await runDiscoveryCli(['fetch'], deps)
  const extractCode = await runDiscoveryCli(['extract'], deps)
  check(
    'dry-run（--live なし）は成功し何も保存しない',
    scanCode === 0 && fetchCode === 0 && extractCode === 0 && mem.written.length === 0,
    `written=${mem.written.join(',')}`,
  )
  check(
    'dry-run では外部通信経路（transport / AI クライアント）を作らない',
    transportCreated === 0 && aiCreated === 0,
    `transport=${transportCreated} ai=${aiCreated}`,
  )

  // --live は専用環境変数と両方そろったときのみ
  const noEnvLog = collectLog()
  const noEnvCode = await runDiscoveryCli(['scan', '--live'], {
    ...deps,
    env: {},
    log: noEnvLog.log,
  })
  check(
    '--live のみ（DISCOVERY_LIVE 未設定）は拒否',
    noEnvCode === 1 && noEnvLog.lines.some((l) => l.includes('DISCOVERY_LIVE')),
  )
  const noKeyLog = collectLog()
  const noKeyCode = await runDiscoveryCli(['extract', '--live'], {
    ...deps,
    env: { DISCOVERY_LIVE: '1' },
    log: noKeyLog.log,
  })
  check(
    'AI 抽出は INIAD_API_KEY が無いと拒否',
    noKeyCode === 1 && noKeyLog.lines.some((l) => l.includes('INIAD_API_KEY')),
  )
  check('拒否時も保存しない', mem.written.length === 0)
  check('外部通信ガード: fetch は一度も呼ばれていない', fetchCalls === 0)

  // 不正な引数
  const badArg = parseDiscoveryArgs(['extract', '--limit', 'x'])
  check('--limit に不正な値はエラー', badArg.error !== null)
  const unknownCode = await runDiscoveryCli(['bogus'], { ...deps, log: () => {} })
  check('未対応のコマンドは exit 1', unknownCode === 1)
}

// ── [8] 壊れた保存物は上書きせず中断 ─────────────────────────────
console.log('\n[8] 壊れた保存物は上書きせず中断')
{
  const brokenJson = '{ 不正な JSON'
  const mem = memFiles({
    '/repo/data/survey-plan.json': serializeSurveyPlan(miniPlan),
    '/repo/data/discovery/url-candidates.json': brokenJson,
  })
  const validateCode = await runDiscoveryCli(['validate'], {
    env: {},
    cwd: '/repo',
    files: mem.files,
    now: fixedNow,
    log: () => {},
  })
  check('validate: 壊れた保存物を検出して exit 1', validateCode === 1)
  const scanLog = collectLog()
  const scanCode = await runDiscoveryCli(['scan', '--live'], {
    env: { DISCOVERY_LIVE: '1' },
    cwd: '/repo',
    files: mem.files,
    createTransport: () => makeFakeTransport({}).transport,
    now: fixedNow,
    log: scanLog.log,
  })
  check(
    'scan: 壊れた保存物を上書きせず中断（exit 1）',
    scanCode === 1 && scanLog.lines.some((l) => l.includes('上書きしません')),
    scanLog.lines.join('\n'),
  )
  check(
    '壊れた保存物の内容が保全される',
    mem.map.get('/repo/data/discovery/url-candidates.json') === brokenJson,
  )
}

// ── [9] 既存機能との互換性・非破壊（本番制度データ） ───────────────
console.log('\n[9] 既存機能との互換性・非破壊')
const protectedFiles = [
  'data/programs/programs.json',
  'data/survey-plan.json',
  'data/source-ledger.json',
  'data/source-retrievals.json',
  'lib/supports/programStore.ts',
  'lib/supports/registry.ts',
  'lib/finance/supports.ts',
  'lib/types/support.ts',
  'components/Form.tsx',
  'components/Result.tsx',
]
const hashesBefore = protectedFiles.map((f) => hashFile(f))

// 実スクリプトの read-only コマンド（status / report / validate）を実際に実行
function runRealCli(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', 'scripts/discovery.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
{
  const statusOut = runRealCli(['status'])
  check(
    'CLI status: 実行でき未検証候補と調査不能領域を表示',
    statusOut.status === 0 &&
      statusOut.out.includes('制度候補（未検証）') &&
      statusOut.out.includes('URL 未登録で調査不能な領域'),
    statusOut.out.slice(0, 400),
  )
  const reportOut = runRealCli(['report'])
  check(
    'CLI report: 確認の区別（調査実施/候補発見/根拠確認/公開判断）を表示',
    reportOut.status === 0 &&
      reportOut.out.includes('調査の実施') &&
      reportOut.out.includes('候補の発見') &&
      reportOut.out.includes('公式根拠の確認済み') &&
      reportOut.out.includes('公開可能と判断') &&
      reportOut.out.includes('23区の制度を網羅できたわけではありません'),
    reportOut.out.slice(0, 400),
  )
  const validateOut = runRealCli(['validate'])
  check('CLI validate: 保存済みデータの検証に成功', validateOut.status === 0 && validateOut.out.includes('問題はありません'))
  const scanDryOut = runRealCli(['scan'])
  check(
    'CLI scan（dry-run）: 外部通信なしで完結',
    scanDryOut.status === 0 && scanDryOut.out.includes('dry-run'),
    scanDryOut.out.slice(0, 400),
  )
}

{
  const report = buildDiscoveryReport({
    plan: miniPlan,
    seeds: collectSeedUrls(miniPlan),
    urls: [],
    pages: [],
    candidates: [],
  })
  check(
    'report: URL 未登録のタスクを「調査不能」として明示',
    report.unscannableTasks.length === 3 &&
      report.unscannableTasks.every((t) => t.taskId !== 'nation/child-allowance-cash'),
  )
  check(
    'report: 根拠確認済み・公開可能は M7-D では常に 0（混同しない）',
    report.distinction.evidenceVerified === 0 && report.distinction.publishable === 0,
  )
}

const hashesAfter = protectedFiles.map((f) => hashFile(f))
check(
  '既存データ・制度データ・台帳・計算モジュール・UI が無変更（ハッシュ一致）',
  deepEqual(hashesBefore, hashesAfter),
)
const snapshotPrograms = JSON.parse(
  readFileSync('scripts/fixtures/m7b-pre-migration.json', 'utf8'),
) as Array<{ id: string }>
const storePrograms = getSupportPrograms()
// M7-F: 本番データには M7-E フロー（承認→公開）を通した制度のみ追加されている。
// 既存6件が無変更で残り、追加分がすべて公開済み（出典URL確認済み）であることを
// 確認して「未検証候補の混入なし」を保証する
check(
  'getSupportPrograms() は移行前6件を無変更で含み、追加分は公開済みのみ（未検証候補の混入なし）',
  snapshotPrograms.every((s, i) => storePrograms[i]?.id === s.id) &&
    deepEqual(storePrograms.slice(0, snapshotPrograms.length), snapshotPrograms) &&
    storePrograms
      .slice(snapshotPrograms.length)
      .every((p) => p.id.startsWith('disc-') && p.verification?.status === 'partial'),
  `${storePrograms.length}件 vs ${snapshotPrograms.length}件`,
)
check(
  'registryDisclaimer() の表示契約が不変',
  typeof registryDisclaimer() === 'string' && registryDisclaimer().length > 0,
)
check('外部通信ガード: fetch は一度も呼ばれていない（最終確認）', fetchCalls === 0)

// ── 結果 ─────────────────────────────────────────────────────────
globalThis.fetch = originalFetch
console.log('')
if (failed === 0) {
  console.log('ALL CHECKS PASSED (0 network calls)')
} else {
  console.error(`${failed} 件のチェックが失敗しました`)
  process.exitCode = 1
}
}

main().catch((err: unknown) => {
  globalThis.fetch = originalFetch
  console.error('検証の実行に失敗しました:', err)
  process.exitCode = 1
})
