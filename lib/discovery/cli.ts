/**
 * 発見パイプライン CLI（M7-D）本体
 *
 * 【コマンド】status / scan / fetch / extract / report / validate
 * （実行エントリは scripts/discovery.ts。ここはテスト可能な実装）
 *
 * 【安全な実行モード】
 * - 通常実行はすべて dry-run（外部通信なし・保存なし）。
 *   scan / fetch / extract の外部通信は、明示的な --live と専用環境変数
 *   DISCOVERY_LIVE=1 の両方そろったときのみ（CONSULT_LIVE_AI は参照しない）。
 *   extract の AI 呼び出しには INIAD_API_KEY（サーバー側 env）がさらに必要。
 * - 外部通信経路（transport・AI クライアント）は注入式で、dry-run では
 *   生成自体が呼ばれない（検証で保証する）。
 * - ファイル I/O も注入式（scripts 側が node:fs 実装を渡す）。
 *   壊れた保存物は上書きせず中断する。
 *
 * 【既存機能の再利用】
 * - 取得: lib/supports/sourceFetch.ts（SSRF 対策・HTTPS 必須・robots.txt・
 *   サイズ/形式制限・リダイレクト検証・キャッシュ）
 * - 許可ホスト: lib/supports/sourceLedger.ts の allowedHosts（official-confirmed）
 * - 調査計画更新: lib/survey/surveyPlanStore.ts の applySurveyPlanUpdate
 *   （候補件数のみ。status を surveyed に変えることはない）
 */
import { resolve } from 'node:path'
import {
  buildInitialLedger,
  createLedgerStore,
  type LedgerStore,
} from '../supports/sourceLedger'
import {
  createSourceFetcher,
  evaluateFetchTarget,
  type FetchTransport,
} from '../supports/sourceFetch'
import {
  parseLedgerSnapshot,
  restoreLedgerEntries,
} from '../supports/sourceStore'
import {
  SURVEY_PLAN_FILE,
  SurveyPlanError,
  parseSurveyPlanJson,
  serializeSurveyPlan,
} from '../survey/surveyPlanStore'
import type { SurveyPlan } from '../types/surveyPlan'
import type { ChatCompletionsLike } from '../consult/iniadAdvisor'
import {
  extractCandidatesWithClient,
  isDiscoveryAiAvailable,
  isDiscoveryLiveEnabled,
  resolveExtractionModel,
} from './aiExtract'
import {
  CANDIDATE_STORE_FILE,
  DISCOVERY_STORE_FORMAT_VERSION,
  PAGE_STORE_FILE,
  URL_CANDIDATE_STORE_FILE,
  contentHashOf,
  makeUrlId,
  parseCandidateStore,
  parsePageStore,
  parseUrlCandidateStore,
  recordUrlFetch,
  serializeCandidateStore,
  serializePageStore,
  serializeUrlCandidateStore,
  upsertCandidates,
  upsertPageRecord,
  upsertUrlCandidate,
  type CandidateStore,
  type DiscoveryCandidate,
  type PageRecord,
  type PageStore,
  type UrlCandidateStore,
} from './discoveryStore'
import { classifyDiscoveredLinks, linksFromHrefs } from './linkScan'
import {
  appendAuditEntries,
  emptyReviewAuditStore,
  extractionAuditEntry,
  parseReviewAuditStore,
  serializeReviewAuditStore,
  REVIEW_AUDIT_FILE,
} from './reviewStore'
import { runReviewCommand } from './reviewCli'
import {
  applyCandidateCountUpdates,
  buildDiscoveryReport,
  collectSeedUrls,
  computeCandidateCountsByTask,
  planUpdatesForCandidateCounts,
} from './pipeline'

/** ファイル I/O の抽象（scripts 側が node:fs 実装を渡す） */
export type DiscoveryFileOps = {
  exists(path: string): boolean
  read(path: string): string
  /** 書き込み（実装側で一時ファイル経由のアトミック書き込みを推奨） */
  write(path: string, text: string): void
}

export type DiscoveryCliDeps = {
  env: Record<string, string | undefined>
  cwd: string
  files: DiscoveryFileOps
  /** 外部通信 transport（live 時のみ使用。dry-run では絶対に呼ばない） */
  createTransport?: () => FetchTransport
  /** AI 抽出クライアント（live 時のみ使用） */
  createAiClient?: () => ChatCompletionsLike
  now?: () => Date
  log: (line: string) => void
}

/** ページ本文の保存上限（超過分は切り詰めて textTruncated で明示） */
const PAGE_TEXT_MAX_STORED_CHARS = 200_000
/** 1 ページから登録する URL 候補の上限（暴走防止） */
const MAX_URLS_PER_PAGE = 100

const DEFAULT_SCAN_LIMIT = 10
const DEFAULT_FETCH_LIMIT = 20
const DEFAULT_EXTRACT_LIMIT = 10

export type ParsedArgs = {
  command: string
  positional: string[]
  live: boolean
  force: boolean
  retry: boolean
  task: string | null
  limit: number | null
  dataDir: string
  planFile: string
  /** 操作者（M7-E の状態変更・確認・公開で必須） */
  by: string | null
  /** 変更理由・操作理由（M7-E） */
  reason: string | null
  /** 確認対象項目（verify-field） */
  field: string | null
  /** 確認した値（verify-field） */
  value: string | null
  /** 根拠抜粋（verify-field） */
  quote: string | null
  /** 状態フィルタ（candidates --status） */
  status: string | null
  /** 更新対象の制度 ID（publish --update） */
  update: string | null
  /** 後継に切り替える旧制度 ID（publish --supersedes） */
  supersedes: string | null
  /** 公開先の制度データファイル（publish） */
  programs: string
  error: string | null
}

/**
 * コマンドライン引数の解析
 * （--live / --force / --retry / --task / --limit / --data-dir / --plan /
 *   --by / --reason / --field / --value / --quote / --status / --update /
 *   --supersedes / --programs）
 */
export function parseDiscoveryArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  let live = false
  let force = false
  let retry = false
  let task: string | null = null
  let limit: number | null = null
  let dataDir = 'data/discovery'
  let planFile = SURVEY_PLAN_FILE
  let by: string | null = null
  let reason: string | null = null
  let field: string | null = null
  let value: string | null = null
  let quote: string | null = null
  let status: string | null = null
  let update: string | null = null
  let supersedes: string | null = null
  let programs = 'data/programs/programs.json'
  let error: string | null = null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--live') {
      live = true
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--retry') {
      retry = true
    } else if (arg === '--task') {
      task = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--limit') {
      const raw = argv[i + 1]
      const n = raw === undefined ? NaN : Number.parseInt(raw, 10)
      if (!Number.isFinite(n) || n <= 0) {
        error = '--limit には正の整数を指定してください'
      } else {
        limit = n
      }
      i += 1
    } else if (arg === '--data-dir') {
      dataDir = argv[i + 1] ?? dataDir
      i += 1
    } else if (arg === '--plan') {
      planFile = argv[i + 1] ?? planFile
      i += 1
    } else if (arg === '--by') {
      by = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--reason') {
      reason = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--field') {
      field = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--value') {
      value = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--quote') {
      quote = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--status') {
      status = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--update') {
      update = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--supersedes') {
      supersedes = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--programs') {
      programs = argv[i + 1] ?? programs
      i += 1
    } else if (arg.startsWith('--')) {
      error = `未対応のオプションです: ${arg}`
    } else {
      positional.push(arg)
    }
  }
  return {
    command: positional[0] ?? 'status',
    positional: positional.slice(1),
    live,
    force,
    retry,
    task,
    limit,
    dataDir,
    planFile,
    by,
    reason,
    field,
    value,
    quote,
    status,
    update,
    supersedes,
    programs,
    error,
  }
}

// ── 保存物の読み込み（壊れた保存物は上書きせず中断） ────────────────

type LoadResult<T> = { ok: true; value: T } | { ok: false; error: string }

function loadStore<T>(
  files: DiscoveryFileOps,
  path: string,
  parse: (text: string) => LoadResult<T>,
  empty: () => T,
): LoadResult<T> {
  if (!files.exists(path)) return { ok: true, value: empty() }
  const parsed = parse(files.read(path))
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${path} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
    }
  }
  return parsed
}

function emptyUrlStore(): UrlCandidateStore {
  return { formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt: '', urls: [] }
}
function emptyPageStore(): PageStore {
  return { formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt: '', pages: [] }
}
function emptyCandidateStore(): CandidateStore {
  return {
    formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
    savedAt: '',
    candidates: [],
  }
}

/** 許可ホストの解決（情報源台帳の official-confirmed なホストのみ） */
function loadAllowedHosts(files: DiscoveryFileOps, cwd: string): LoadResult<Set<string>> {
  const ledgerPath = resolve(cwd, 'data/source-ledger.json')
  try {
    let entries = buildInitialLedger()
    if (files.exists(ledgerPath)) {
      const parsed = parseLedgerSnapshot(files.read(ledgerPath))
      if (!parsed.ok) {
        return {
          ok: false,
          error: `${ledgerPath} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
        }
      }
      entries = restoreLedgerEntries(parsed.value)
    }
    const store: LedgerStore = createLedgerStore(entries)
    return { ok: true, value: new Set(store.allowedHosts()) }
  } catch (err) {
    return { ok: false, error: `許可ホストの解決に失敗しました: ${(err as Error).message}` }
  }
}

/** 台帳（情報源台帳）の検索用（sourceRecordId の紐付けに使う） */
function loadLedgerStore(files: DiscoveryFileOps, cwd: string): LedgerStore {
  const ledgerPath = resolve(cwd, 'data/source-ledger.json')
  let entries = buildInitialLedger()
  if (files.exists(ledgerPath)) {
    const parsed = parseLedgerSnapshot(files.read(ledgerPath))
    if (parsed.ok) entries = restoreLedgerEntries(parsed.value)
  }
  return createLedgerStore(entries)
}

// ── 表示ヘルパ（全角を 2 として数える簡易版） ──────────────────────

function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function padEndW(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

function printTable(log: (line: string) => void, rows: string[][]): void {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell))
    })
  }
  for (const row of rows) {
    log('  ' + row.map((cell, i) => padEndW(cell, widths[i] ?? 0)).join('  '))
  }
}

/** live 実行の可否（--live と DISCOVERY_LIVE=1 の両方が必要） */
function resolveLiveMode(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): { live: boolean; error: string | null } {
  if (!args.live) return { live: false, error: null }
  if (!isDiscoveryLiveEnabled(env)) {
    return {
      live: false,
      error:
        '--live には専用環境変数 DISCOVERY_LIVE=1 が必要です（外部通信は --live と DISCOVERY_LIVE=1 の両方がそろったときのみ）。',
    }
  }
  return { live: true, error: null }
}

// ── 取得結果の保存（抽出状態は本文ハッシュで管理） ──────────────────

/**
 * 取得できたページを保存用レコードに変換する。
 * - 本文が前回と同じ（ハッシュ一致）で抽出済みなら抽出済みのまま維持
 *   （変更があった場合のみ再抽出対象 = pending に戻す）
 */
function buildPageRecord(input: {
  url: string
  finalUrl: string | null
  title: string | null
  retrievedAt: string
  text: string
  previous: PageRecord | undefined
}): PageRecord {
  const truncated = input.text.length > PAGE_TEXT_MAX_STORED_CHARS
  const text = truncated ? input.text.slice(0, PAGE_TEXT_MAX_STORED_CHARS) : input.text
  const contentHash = contentHashOf(text)
  const previous = input.previous
  const unchanged =
    previous !== undefined &&
    previous.contentHash === contentHash &&
    previous.extractState === 'extracted'
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    title: input.title,
    retrievedAt: input.retrievedAt,
    contentHash,
    text,
    textTruncated: truncated,
    extractState: unchanged ? 'extracted' : 'pending',
    extractedAt: unchanged && previous !== undefined ? previous.extractedAt : null,
    extractionError: null,
    extractedCandidateCount:
      unchanged && previous !== undefined ? previous.extractedCandidateCount : null,
  }
}

// ── scan: 公式ページのリンクから追加 URL 候補を発見 ────────────────

async function runScan(
  args: ParsedArgs,
  deps: DiscoveryCliDeps,
  live: boolean,
): Promise<number> {
  const log = deps.log
  const planPath = resolve(deps.cwd, args.planFile)
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))

  if (!deps.files.exists(planPath)) {
    log(`調査計画が見つかりません: ${planPath}`)
    return 1
  }
  let plan: SurveyPlan
  try {
    plan = parseSurveyPlanJson(deps.files.read(planPath), args.planFile)
  } catch (err) {
    if (err instanceof SurveyPlanError) {
      log(err.message)
      return 1
    }
    throw err
  }
  const urlStore = loadStore(deps.files, urlPath, parseUrlCandidateStore, emptyUrlStore)
  if (!urlStore.ok) {
    log(urlStore.error)
    return 1
  }
  const pageStore = loadStore(deps.files, pagePath, parsePageStore, emptyPageStore)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }

  let seeds = collectSeedUrls(plan)
  if (args.task !== null) {
    seeds = seeds.filter((s) => s.taskId === args.task)
    if (seeds.length === 0) {
      log(`調査タスク ${args.task} のシード URL（公式ポータルURL）が未登録です。`)
      log('URL が未登録の地域・分野は調査不能です。推測 URL は作成しません。')
      return 1
    }
  }
  const limit = args.limit ?? DEFAULT_SCAN_LIMIT
  const targets = seeds.slice(0, limit)

  log('=== scan: 公式ページのリンク探索 ===')
  log(`シード URL: ${seeds.length} 件（今回の対象: ${targets.length} 件 / 上限 ${limit}）`)
  for (const seed of targets) {
    log(`  - ${seed.url} [${seed.taskId ?? 'タスク未紐付け'}] (${seed.method})`)
  }
  if (seeds.length > targets.length) {
    log(`  （残り ${seeds.length - targets.length} 件は --limit で増やせます）`)
  }

  const hostsResult = loadAllowedHosts(deps.files, deps.cwd)
  if (!hostsResult.ok) {
    log(hostsResult.error)
    return 1
  }
  log(`許可ホスト（公式確認済みのみ）: ${[...hostsResult.value].join(', ') || '（なし）'}`)

  if (!live) {
    log('')
    log('dry-run のため外部通信・保存は行いません。')
    log('実際の取得とリンク発見には --live と DISCOVERY_LIVE=1 が必要です。')
    return 0
  }

  const transportFactory = deps.createTransport
  if (transportFactory === undefined) {
    log('transport が注入されていないため取得できません')
    return 1
  }
  const fetcher = createSourceFetcher({
    transport: transportFactory(),
    allowedHosts: hostsResult.value,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  const nowIso = () => (deps.now !== undefined ? deps.now() : new Date()).toISOString()
  const ledger = loadLedgerStore(deps.files, deps.cwd)

  let urls = urlStore.value.urls
  let pages = pageStore.value.pages
  let discovered = 0
  let rejectedCount = 0
  let fetchedOk = 0
  let fetchedNg = 0

  for (const seed of targets) {
    // シード自身も候補URL台帳に登録（URL 単位で重複排除）
    urls = upsertUrlCandidate(urls, {
      urlId: makeUrlId(seed.url),
      url: seed.url,
      taskId: seed.taskId,
      regionId: seed.regionId,
      fieldId: seed.fieldId,
      foundFrom: null,
      discoveryMethod: seed.method,
      firstFoundAt: nowIso(),
      lastFetch: null,
      contentHash: null,
      note: 'シード URL（調査計画のポータルURL / 研究記録の確認済みURL）',
    })
    const ledgerEntry = ledger.getByUrl(seed.url)

    const decision = evaluateFetchTarget(seed.url, hostsResult.value)
    if (!decision.allowed) {
      urls = recordUrlFetch(
        urls,
        seed.url,
        {
          attemptedAt: nowIso(),
          state: 'failed',
          failureCode: decision.code,
          failureReason: decision.reason,
        },
        null,
      )
      fetchedNg += 1
      log(`  取得対象外: ${seed.url}（${decision.reason}）`)
      continue
    }

    const result = await fetcher.fetchUrl(seed.url, { force: args.force })
    if (!result.ok) {
      urls = recordUrlFetch(
        urls,
        seed.url,
        {
          attemptedAt: result.record.retrievedAt,
          state: 'failed',
          failureCode: result.record.result === 'ok' ? null : result.record.result,
          failureReason: result.record.failureReason,
        },
        null,
      )
      fetchedNg += 1
      log(
        `  取得失敗: ${seed.url}（${result.record.result}: ${result.record.failureReason ?? ''}）`,
      )
      continue
    }

    fetchedOk += 1
    const previous = pages.find((p) => p.url === seed.url)
    const pageRecord = buildPageRecord({
      url: seed.url,
      finalUrl: result.record.finalUrl,
      title: result.page.title,
      retrievedAt: result.record.retrievedAt,
      text: result.page.text,
      previous,
    })
    pages = upsertPageRecord(pages, pageRecord)
    urls = recordUrlFetch(
      urls,
      seed.url,
      {
        attemptedAt: result.record.retrievedAt,
        state: 'ok',
        failureCode: null,
        failureReason: null,
      },
      pageRecord.contentHash,
    )

    const links = linksFromHrefs(result.page.hrefs, result.record.finalUrl ?? seed.url)
    const classified = classifyDiscoveredLinks(links, { allowedHosts: hostsResult.value })
    rejectedCount += classified.rejected.length
    let added = 0
    for (const link of classified.acceptable) {
      if (added >= MAX_URLS_PER_PAGE) break
      urls = upsertUrlCandidate(urls, {
        urlId: makeUrlId(link.url),
        url: link.url,
        taskId: seed.taskId,
        regionId: seed.regionId,
        fieldId: seed.fieldId,
        foundFrom: seed.url,
        discoveryMethod: 'page-link',
        firstFoundAt: nowIso(),
        lastFetch: null,
        contentHash: null,
        note: link.anchorText !== '' ? `リンクテキスト: ${link.anchorText}` : '',
      })
      added += 1
      discovered += 1
    }
    log(
      `  取得成功: ${seed.url}（本文 ${result.page.text.length} 文字 / リンク ${links.length} 件中 ${added} 件を登録・${classified.rejected.length} 件は未許可ホスト等のため対象外${ledgerEntry !== null ? ` / 台帳 ${ledgerEntry.urlId}` : ''}）`,
    )
  }

  const savedAt = nowIso()
  deps.files.write(
    urlPath,
    serializeUrlCandidateStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt,
      urls,
    }),
  )
  deps.files.write(
    pagePath,
    serializePageStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt,
      pages,
    }),
  )
  log('')
  log(
    `保存しました: 取得成功 ${fetchedOk} / 失敗 ${fetchedNg} / 新規 URL 候補 ${discovered}（重複排除済み）/ 対象外リンク ${rejectedCount}`,
  )
  log(`候補URL台帳: ${urlPath}`)
  log(`ページ本文: ${pagePath}`)
  return 0
}

// ── fetch: 候補URL台帳のページ本文を取得 ──────────────────────────

async function runFetch(
  args: ParsedArgs,
  deps: DiscoveryCliDeps,
  live: boolean,
): Promise<number> {
  const log = deps.log
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))

  const urlStore = loadStore(deps.files, urlPath, parseUrlCandidateStore, emptyUrlStore)
  if (!urlStore.ok) {
    log(urlStore.error)
    return 1
  }
  const pageStore = loadStore(deps.files, pagePath, parsePageStore, emptyPageStore)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }

  // 未取得・取得失敗分を対象にする（--force で全件再取得）
  const candidates = args.force
    ? urlStore.value.urls
    : urlStore.value.urls.filter(
        (u) => u.lastFetch === null || u.lastFetch.state === 'failed',
      )
  const limit = args.limit ?? DEFAULT_FETCH_LIMIT
  const targets = candidates.slice(0, limit)

  log('=== fetch: 候補URLの本文取得 ===')
  log(`対象 URL: ${candidates.length} 件（今回の取得: ${targets.length} 件 / 上限 ${limit}）`)
  for (const u of targets) {
    const state = u.lastFetch === null ? '未取得' : `前回: ${u.lastFetch.state}`
    log(`  - ${u.url} [${u.taskId ?? 'タスク未紐付け'}] ${state}`)
  }

  const hostsResult = loadAllowedHosts(deps.files, deps.cwd)
  if (!hostsResult.ok) {
    log(hostsResult.error)
    return 1
  }

  if (!live) {
    log('')
    log('dry-run のため外部通信・保存は行いません。')
    log('実際の取得には --live と DISCOVERY_LIVE=1 が必要です。')
    return 0
  }

  const transportFactory = deps.createTransport
  if (transportFactory === undefined) {
    log('transport が注入されていないため取得できません')
    return 1
  }
  const fetcher = createSourceFetcher({
    transport: transportFactory(),
    allowedHosts: hostsResult.value,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  const nowIso = () => (deps.now !== undefined ? deps.now() : new Date()).toISOString()

  let urls = urlStore.value.urls
  let pages = pageStore.value.pages
  let fetchedOk = 0
  let fetchedNg = 0

  for (const target of targets) {
    const decision = evaluateFetchTarget(target.url, hostsResult.value)
    if (!decision.allowed) {
      urls = recordUrlFetch(
        urls,
        target.url,
        {
          attemptedAt: nowIso(),
          state: 'failed',
          failureCode: decision.code,
          failureReason: decision.reason,
        },
        null,
      )
      fetchedNg += 1
      log(`  取得対象外: ${target.url}（${decision.reason}）`)
      continue
    }
    const result = await fetcher.fetchUrl(target.url, { force: args.force })
    if (!result.ok) {
      urls = recordUrlFetch(
        urls,
        target.url,
        {
          attemptedAt: result.record.retrievedAt,
          state: 'failed',
          failureCode: result.record.result === 'ok' ? null : result.record.result,
          failureReason: result.record.failureReason,
        },
        null,
      )
      fetchedNg += 1
      log(
        `  取得失敗: ${target.url}（${result.record.result}: ${result.record.failureReason ?? ''}）`,
      )
      continue
    }
    fetchedOk += 1
    const previous = pages.find((p) => p.url === target.url)
    const pageRecord = buildPageRecord({
      url: target.url,
      finalUrl: result.record.finalUrl,
      title: result.page.title,
      retrievedAt: result.record.retrievedAt,
      text: result.page.text,
      previous,
    })
    pages = upsertPageRecord(pages, pageRecord)
    urls = recordUrlFetch(
      urls,
      target.url,
      {
        attemptedAt: result.record.retrievedAt,
        state: 'ok',
        failureCode: null,
        failureReason: null,
      },
      pageRecord.contentHash,
    )
    log(
      `  取得成功: ${target.url}（本文 ${result.page.text.length} 文字 / 抽出状態 ${pageRecord.extractState}）`,
    )
  }

  const savedAt = nowIso()
  deps.files.write(
    urlPath,
    serializeUrlCandidateStore({ formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt, urls }),
  )
  deps.files.write(
    pagePath,
    serializePageStore({ formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt, pages }),
  )
  log('')
  log(`保存しました: 取得成功 ${fetchedOk} / 失敗 ${fetchedNg}`)
  return 0
}

// ── extract: 取得済み本文から AI で制度候補を抽出 ──────────────────

async function runExtract(
  args: ParsedArgs,
  deps: DiscoveryCliDeps,
  live: boolean,
): Promise<number> {
  const log = deps.log
  const planPath = resolve(deps.cwd, args.planFile)
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))
  const candPath = resolve(deps.cwd, args.dataDir, CANDIDATE_STORE_FILE.replace('data/discovery/', ''))

  const urlStore = loadStore(deps.files, urlPath, parseUrlCandidateStore, emptyUrlStore)
  if (!urlStore.ok) {
    log(urlStore.error)
    return 1
  }
  const pageStore = loadStore(deps.files, pagePath, parsePageStore, emptyPageStore)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }
  const candStore = loadStore(deps.files, candPath, parseCandidateStore, emptyCandidateStore)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }

  const taskIdOfUrl = new Map<string, string | null>()
  for (const u of urlStore.value.urls) taskIdOfUrl.set(u.url, u.taskId)

  // 抽出対象: 抽出待ち（pending）＋（--retry 時）抽出失敗
  const isTargetState = (p: PageRecord): boolean =>
    p.extractState === 'pending' || (args.retry && p.extractState === 'failed')
  const allTargets = pageStore.value.pages.filter(isTargetState)
  const taskScoped = allTargets.filter(
    (p) => (taskIdOfUrl.get(p.url) ?? null) !== null || args.task !== null,
  )
  const unassignedPages = allTargets.filter(
    (p) => (taskIdOfUrl.get(p.url) ?? null) === null && args.task === null,
  )
  const scoped =
    args.task !== null
      ? taskScoped.filter((p) => {
          const tid = taskIdOfUrl.get(p.url) ?? null
          return tid === args.task || tid === null
        })
      : taskScoped
  const limit = args.limit ?? DEFAULT_EXTRACT_LIMIT
  const targets = scoped.slice(0, limit)

  log('=== extract: AI による制度候補の抽出 ===')
  log(`抽出対象ページ: ${scoped.length} 件（今回の抽出: ${targets.length} 件 / 上限 ${limit}）`)
  for (const p of targets) {
    log(`  - ${p.url} [${taskIdOfUrl.get(p.url) ?? args.task ?? 'タスク未紐付け'}] ${p.extractState}`)
  }
  if (unassignedPages.length > 0) {
    log(
      `  タスク未紐付けのため対象外: ${unassignedPages.length} 件（--task <taskId> を指定するとそのタスクに紐付けて抽出できます）`,
    )
  }

  if (!live) {
    log('')
    log('dry-run のため AI 呼び出し・保存は行いません。')
    log('実際の抽出には --live と DISCOVERY_LIVE=1（に加えて INIAD_API_KEY）が必要です。')
    return 0
  }

  if (!isDiscoveryAiAvailable(deps.env)) {
    log('AI 抽出には DISCOVERY_LIVE=1 と INIAD_API_KEY（サーバー側 env）が必要です。')
    return 1
  }
  const aiFactory = deps.createAiClient
  if (aiFactory === undefined) {
    log('AI クライアントが注入されていないため抽出できません')
    return 1
  }
  const client = aiFactory()
  const model = resolveExtractionModel(deps.env)
  const ledger = loadLedgerStore(deps.files, deps.cwd)
  const nowIso = () => (deps.now !== undefined ? deps.now() : new Date()).toISOString()

  let plan: SurveyPlan | null = null
  if (deps.files.exists(planPath)) {
    try {
      plan = parseSurveyPlanJson(deps.files.read(planPath), args.planFile)
    } catch (err) {
      if (err instanceof SurveyPlanError) {
        log(err.message)
        return 1
      }
      throw err
    }
  }

  let pages = pageStore.value.pages
  let candidates = candStore.value.candidates
  const touchedTaskIds = new Set<string>()
  let extractedPages = 0
  let failedPages = 0
  let newCandidates = 0
  /** 監査履歴へ記録する抽出結果（M7-E。候補の発見を追跡可能にする） */
  const extractedForAudit: DiscoveryCandidate[] = []

  for (const page of targets) {
    const assignedTaskId = taskIdOfUrl.get(page.url) ?? args.task
    if (assignedTaskId === null || assignedTaskId === undefined) continue
    const planTask = plan?.tasks.find((t) => t.taskId === assignedTaskId) ?? null
    const regionId = planTask?.regionId ?? 'nation'
    const fieldId = planTask?.fieldId ?? 'other'
    const ctx = {
      taskId: assignedTaskId,
      regionId,
      fieldId,
      sourceUrl: page.url,
      sourceRecordId: ledger.getByUrl(page.url)?.urlId ?? null,
      retrievedAt: page.retrievedAt,
      contentHash: page.contentHash,
    }
    const outcome = await extractCandidatesWithClient(
      client,
      { url: page.url, title: page.title, text: page.text },
      ctx,
      { model, extractionModelLabel: `iniad:${model}`, extractedAt: nowIso() },
    )
    if (!outcome.ok) {
      failedPages += 1
      pages = upsertPageRecord(pages, {
        ...page,
        extractState: 'failed',
        extractedAt: nowIso(),
        extractionError: outcome.error,
      })
      log(`  抽出失敗: ${page.url}（${outcome.error}）`)
      continue
    }
    extractedPages += 1
    const before = candidates.length
    candidates = upsertCandidates(candidates, outcome.candidates)
    newCandidates += candidates.length - before
    extractedForAudit.push(...outcome.candidates)
    pages = upsertPageRecord(pages, {
      ...page,
      extractState: 'extracted',
      extractedAt: nowIso(),
      extractionError: null,
      extractedCandidateCount: outcome.candidates.length,
    })
    touchedTaskIds.add(assignedTaskId)
    log(
      `  抽出成功: ${page.url}（候補 ${outcome.candidates.length} 件。すべて未検証（unverified））`,
    )
  }

  const savedAt = nowIso()
  deps.files.write(
    pagePath,
    serializePageStore({ formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt, pages }),
  )
  deps.files.write(
    candPath,
    serializeCandidateStore({ formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt, candidates }),
  )
  // 監査履歴へ発見（AI 抽出）を記録（M7-E。いつ・どの URL から・何を抽出したか）
  if (extractedForAudit.length > 0) {
    const auditPath = resolve(deps.cwd, args.dataDir, REVIEW_AUDIT_FILE.replace('data/discovery/', ''))
    const existing = deps.files.exists(auditPath)
      ? parseReviewAuditStore(deps.files.read(auditPath))
      : { ok: true as const, value: emptyReviewAuditStore() }
    if (existing.ok) {
      const entries = extractedForAudit.map((c) =>
        extractionAuditEntry({ candidate: c, at: savedAt, extractionModel: c.extractionModel }),
      )
      deps.files.write(
        auditPath,
        serializeReviewAuditStore({ ...appendAuditEntries(existing.value, entries), savedAt }),
      )
    } else {
      log(`監査履歴を復元できないため抽出の記録をスキップします（保存物は上書きしません）: ${existing.error}`)
    }
  }
  log('')
  log(
    `保存しました: 抽出成功 ${extractedPages} ページ / 失敗 ${failedPages} ページ / 候補 ${newCandidates} 件`,
  )
  log(`制度候補（未検証）: ${candPath}`)
  log('※ 候補はすべて未検証です。制度一覧・計算・相談AI には反映されません（確認・公開は M7-E）。')

  // 調査計画の候補件数を更新（status は変更しない。surveyed にはしない）
  if (plan !== null && touchedTaskIds.size > 0) {
    const counts = computeCandidateCountsByTask(candidates)
    const scopedCounts = new Map<string, number>()
    for (const taskId of touchedTaskIds) {
      scopedCounts.set(taskId, counts.get(taskId) ?? 0)
    }
    const { updates, unknownTaskIds } = planUpdatesForCandidateCounts(plan, scopedCounts)
    if (unknownTaskIds.length > 0) {
      log(`調査計画に無い taskId のため件数更新をスキップ: ${unknownTaskIds.join(', ')}`)
    }
    if (updates.length > 0) {
      const nextPlan = applyCandidateCountUpdates(plan, updates)
      deps.files.write(planPath, serializeSurveyPlan(nextPlan))
      for (const u of updates) {
        if (u.type === 'set-candidate-count') {
          log(`  調査計画を更新: ${u.taskId} の候補件数 → ${u.candidateCount}`)
        }
      }
      log(`調査計画: ${planPath}（status は変更していません）`)
    } else {
      log('調査計画の候補件数に変更はありません。')
    }
  }
  return 0
}

// ── status: 設定・件数・未解決事項の確認 ──────────────────────────

function runStatus(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const planPath = resolve(deps.cwd, args.planFile)
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))
  const candPath = resolve(deps.cwd, args.dataDir, CANDIDATE_STORE_FILE.replace('data/discovery/', ''))

  log('=== 発見パイプライン status（外部通信なし） ===')
  log('実行モード: 既定 dry-run（外部通信は --live と DISCOVERY_LIVE=1 の両方が必要）')
  log(`  DISCOVERY_LIVE=1: ${isDiscoveryLiveEnabled(deps.env) ? '設定済み' : '未設定'}`)
  log(
    `  AI 抽出利用可否: ${isDiscoveryAiAvailable(deps.env) ? '利用可能（INIAD_API_KEY 設定済み）' : '不可（INIAD_API_KEY 未設定または live 未設定）'}`,
  )
  log('  ※ 相談機能の CONSULT_LIVE_AI とは独立しています（相互には連動しません）')

  const urlStore = loadStore(deps.files, urlPath, parseUrlCandidateStore, emptyUrlStore)
  const pageStore = loadStore(deps.files, pagePath, parsePageStore, emptyPageStore)
  const candStore = loadStore(deps.files, candPath, parseCandidateStore, emptyCandidateStore)
  if (!urlStore.ok || !pageStore.ok || !candStore.ok) {
    for (const r of [urlStore, pageStore, candStore]) {
      if (!r.ok) log(r.error)
    }
    return 1
  }

  const urls = urlStore.value.urls
  const pages = pageStore.value.pages
  const candidates = candStore.value.candidates
  const unfetched = urls.filter((u) => u.lastFetch === null).length
  const fetchFailed = urls.filter((u) => u.lastFetch?.state === 'failed').length
  const fetchOk = urls.filter((u) => u.lastFetch?.state === 'ok').length
  const pending = pages.filter((p) => p.extractState === 'pending').length
  const extracted = pages.filter((p) => p.extractState === 'extracted').length
  const extractFailed = pages.filter((p) => p.extractState === 'failed').length
  const byStatus = {
    unverified: candidates.filter((c) => c.status === 'unverified').length,
    needsRecheck: candidates.filter((c) => c.status === 'needs-recheck').length,
    discarded: candidates.filter((c) => c.status === 'discarded').length,
  }

  log('')
  log('保存物:')
  log(
    `  候補URL台帳: ${urls.length} 件（未取得 ${unfetched} / 取得済 ${fetchOk} / 失敗 ${fetchFailed}） [${urlPath}]`,
  )
  log(
    `  ページ本文: ${pages.length} 件（抽出待ち ${pending} / 抽出済 ${extracted} / 抽出失敗 ${extractFailed}） [${pagePath}]`,
  )
  log(
    `  制度候補（未検証）: ${candidates.length} 件（unverified ${byStatus.unverified} / needs-recheck ${byStatus.needsRecheck} / discarded ${byStatus.discarded}） [${candPath}]`,
  )

  if (deps.files.exists(planPath)) {
    try {
      const plan = parseSurveyPlanJson(deps.files.read(planPath), args.planFile)
      const seeds = collectSeedUrls(plan)
      const unscannable = plan.tasks.filter((t) => t.portalUrls.length === 0)
      log('')
      log('調査計画:')
      log(`  シード URL（出発点）: ${seeds.length} 件`)
      log(
        `  URL 未登録で調査不能な領域: ${unscannable.length} / ${plan.tasks.length} タスク（東京都・23区の大半を含む。URL の根拠確認後に追加できます）`,
      )
    } catch (err) {
      if (err instanceof SurveyPlanError) {
        log(err.message)
        return 1
      }
      throw err
    }
  } else {
    log('')
    log(`調査計画が見つかりません: ${planPath}`)
  }

  const unresolved: string[] = []
  for (const u of urls) {
    if (u.lastFetch?.state === 'failed') {
      unresolved.push(
        `取得失敗: ${u.url}（${u.lastFetch.failureCode ?? ''}: ${u.lastFetch.failureReason ?? ''}）`,
      )
    }
  }
  for (const p of pages) {
    if (p.extractState === 'failed') {
      unresolved.push(`抽出失敗: ${p.url}（${p.extractionError ?? ''}）`)
    }
  }
  log('')
  if (unresolved.length === 0) {
    log('未解決事項: なし')
  } else {
    log(`未解決事項: ${unresolved.length} 件`)
    for (const line of unresolved.slice(0, 20)) log(`  - ${line}`)
    if (unresolved.length > 20) log(`  （他 ${unresolved.length - 20} 件）`)
  }
  log('')
  log('次のコマンド: scan（URL発見）→ fetch（本文取得）→ extract（AI抽出）→ report / validate')
  return 0
}

// ── report: 地域・分野ごとの取得件数・候補件数・失敗件数 ────────────

function runReport(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const planPath = resolve(deps.cwd, args.planFile)
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))
  const candPath = resolve(deps.cwd, args.dataDir, CANDIDATE_STORE_FILE.replace('data/discovery/', ''))

  if (!deps.files.exists(planPath)) {
    log(`調査計画が見つかりません: ${planPath}`)
    return 1
  }
  let plan: SurveyPlan
  try {
    plan = parseSurveyPlanJson(deps.files.read(planPath), args.planFile)
  } catch (err) {
    if (err instanceof SurveyPlanError) {
      log(err.message)
      return 1
    }
    throw err
  }
  const urlStore = loadStore(deps.files, urlPath, parseUrlCandidateStore, emptyUrlStore)
  const pageStore = loadStore(deps.files, pagePath, parsePageStore, emptyPageStore)
  const candStore = loadStore(deps.files, candPath, parseCandidateStore, emptyCandidateStore)
  if (!urlStore.ok || !pageStore.ok || !candStore.ok) {
    for (const r of [urlStore, pageStore, candStore]) {
      if (!r.ok) log(r.error)
    }
    return 1
  }

  const report = buildDiscoveryReport({
    plan,
    seeds: collectSeedUrls(plan),
    urls: urlStore.value.urls,
    pages: pageStore.value.pages,
    candidates: candStore.value.candidates,
  })

  log('=== 発見パイプライン report（外部通信なし） ===')
  log('')
  log('合計:')
  log(`  シード URL: ${report.totals.seedCount} 件`)
  log(
    `  発見 URL: ${report.totals.discoveredUrlCount} 件（タスク未紐付け ${report.totals.unassignedUrlCount} 件）`,
  )
  log(`  取得: 成功 ${report.totals.fetchedOkCount} / 失敗 ${report.totals.fetchFailedCount}`)
  log(
    `  AI 抽出: 成功 ${report.totals.pageExtractedCount} ページ / 失敗 ${report.totals.extractionFailedCount} ページ`,
  )
  log(
    `  制度候補（未検証）: ${report.totals.candidateCount} 件（タスク未紐付け ${report.totals.unassignedCandidateCount} 件）`,
  )

  log('')
  log('確認の区別（混同しないこと）:')
  log(`  調査の実施（取得できたページ）: ${report.distinction.pagesRetrieved} 件`)
  log(`  候補の発見（未検証の制度候補）: ${report.distinction.candidatesFound} 件`)
  log(`  公式根拠の確認済み（人手確認）: ${report.distinction.evidenceVerified} 件（M7-E の確認フローで記録）`)
  log(`  公開可能と判断（承認済み）: ${report.distinction.publishable} 件（M7-E の承認フローで記録）`)

  // 地域別ロールアップ
  const regionRows: string[][] = [
    ['地域', 'シード', '発見URL', '取得済', '取得失敗', '抽出済', '抽出失敗', '候補'],
  ]
  for (const region of plan.regions) {
    const rows = report.tasks.filter((t) => t.regionId === region.id)
    const sum = (f: (r: (typeof rows)[number]) => number): number =>
      rows.reduce((acc, r) => acc + f(r), 0)
    regionRows.push([
      region.name,
      String(sum((r) => r.seedCount)),
      String(sum((r) => r.discoveredUrlCount)),
      String(sum((r) => r.fetchedOkCount)),
      String(sum((r) => r.fetchFailedCount)),
      String(sum((r) => r.pageExtractedCount)),
      String(sum((r) => r.extractionFailedCount)),
      String(sum((r) => r.candidateCount)),
    ])
  }
  log('')
  log('地域別:')
  printTable(log, regionRows)

  // 活動のあるタスクの明細
  const active = report.tasks.filter(
    (t) => t.seedCount > 0 || t.discoveredUrlCount > 0 || t.candidateCount > 0,
  )
  if (active.length > 0) {
    log('')
    log('活動のある調査タスク:')
    const rows: string[][] = [
      ['タスク', 'シード', '発見URL', '取得済', '失敗', '抽出済', '候補', '計画の候補数'],
    ]
    for (const t of active) {
      rows.push([
        t.taskId,
        String(t.seedCount),
        String(t.discoveredUrlCount),
        String(t.fetchedOkCount),
        String(t.fetchFailedCount + t.extractionFailedCount),
        String(t.pageExtractedCount),
        String(t.candidateCount),
        String(t.planCandidateCount),
      ])
    }
    printTable(log, rows)
  }

  log('')
  log(
    `調査不能（公式URL未登録）の領域: ${report.unscannableTasks.length} タスク — 推測 URL では調査しません。`,
  )
  for (const t of report.unscannableTasks.slice(0, 10)) {
    log(`  - ${t.regionName} × ${t.fieldName} [${t.taskId}]`)
  }
  if (report.unscannableTasks.length > 10) {
    log(
      `  （他 ${report.unscannableTasks.length - 10} タスク。詳細は scripts/survey-plan.ts missing-urls）`,
    )
  }
  log('')
  log('※ 23区の制度を網羅できたわけではありません。URL 未登録の地域・分野は未調査のままです。')
  return 0
}

// ── validate: 保存済みデータの検証 ────────────────────────────────

function runValidate(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const planPath = resolve(deps.cwd, args.planFile)
  const urlPath = resolve(deps.cwd, args.dataDir, URL_CANDIDATE_STORE_FILE.replace('data/discovery/', ''))
  const pagePath = resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', ''))
  const candPath = resolve(deps.cwd, args.dataDir, CANDIDATE_STORE_FILE.replace('data/discovery/', ''))

  let failed = false
  log('=== 発見パイプライン validate（外部通信なし） ===')
  if (deps.files.exists(planPath)) {
    try {
      parseSurveyPlanJson(deps.files.read(planPath), args.planFile)
      log(`  ok: 調査計画 ${planPath}`)
    } catch (err) {
      failed = true
      log(`  NG: 調査計画 — ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    log(`  （調査計画が未作成: ${planPath}）`)
  }
  const checks: [string, string, (text: string) => LoadResult<unknown>][] = [
    ['候補URL台帳', urlPath, (t) => parseUrlCandidateStore(t)],
    ['ページ本文', pagePath, (t) => parsePageStore(t)],
    ['制度候補', candPath, (t) => parseCandidateStore(t)],
  ]
  for (const [label, path, parse] of checks) {
    if (!deps.files.exists(path)) {
      log(`  （${label}は未作成: ${path}）`)
      continue
    }
    const parsed = parse(deps.files.read(path))
    if (parsed.ok) {
      log(`  ok: ${label} ${path}`)
    } else {
      failed = true
      log(`  NG: ${label} — ${parsed.error}`)
    }
  }
  log(failed ? '検証に失敗しました。' : '検証に問題はありません。')
  return failed ? 1 : 0
}

// ── コマンドの振り分け ────────────────────────────────────────────

const USAGE = [
  '使い方: npx tsx scripts/discovery.ts <command> [options]',
  '',
  '  status                 発見パイプラインの設定・候補数・未解決事項',
  '  scan [--task <id>]     公式URLから追加URL候補を発見（既定 dry-run）',
  '  fetch                  候補URLの本文を取得（既定 dry-run）',
  '  extract [--task <id>]  取得済み本文から AI で制度候補を抽出（既定 dry-run）',
  '  report                 地域・分野ごとの取得件数・候補件数・失敗件数',
  '  validate               保存済みデータの検証',
  '',
  '  候補の検証・承認・公開（M7-E。外部通信なし）:',
  '  candidates [--status <s>] [candidateId]',
  '                         候補一覧 / 候補の詳細表示',
  '  recheck                再取得・再抽出・再確認が必要な候補の識別',
  '  verify                 状態・出典・根拠の検証（ハッシュ変更を要再確認へ反映）',
  '  verify-field <id> --field <項目> --value <値> --quote <本文抜粋> --by <確認者>',
  '                         項目単位の根拠確認を記録（根拠抜粋と本文の照合が必要）',
  '  request-recheck <id>   候補の再確認要求（--by --reason 必須）',
  '  discard <id>           候補の却下（--by --reason 必須）',
  '  restore <id>           却下済み候補の復帰（再承認の条件。--by --reason 必須）',
  '  approve <id>           公開承認（根拠確認が揃った候補のみ。--by --reason 必須）',
  '  publish <id>           承認済み候補の公開用データへの変換と反映',
  '                         （--by --reason 必須 / --update <制度ID> / --supersedes <制度ID>）',
  '  audit [candidateId]    監査履歴の表示',
  '',
  '共通オプション:',
  '  --live                 外部通信の実行（DISCOVERY_LIVE=1 がさらに必要）',
  '  --task <taskId>        対象の調査タスクを絞る',
  '  --limit <n>            処理する URL / ページ数の上限',
  '  --force                全件を再取得する（fetch / scan）',
  '  --retry                抽出失敗のページを再抽出の対象にする（extract）',
  '  --data-dir <path>      保存先ディレクトリ（既定: data/discovery）',
  '  --plan <path>          調査計画ファイル（既定: data/survey-plan.json）',
  '  --status <status>      状態で絞り込む（candidates。needs_recheck 表記も可）',
  '  --by <name>            操作者（確認・状態変更・公開）',
  '  --reason <text>        操作理由（状態変更・公開）',
  '  --programs <path>      公開先の制度データ（既定: data/programs/programs.json）',
].join('\n')

/** CLI の実行本体（scripts/discovery.ts と検証から呼ばれる。戻り値は終了コード） */
export async function runDiscoveryCli(
  argv: readonly string[],
  deps: DiscoveryCliDeps,
): Promise<number> {
  const args = parseDiscoveryArgs(argv)
  if (args.error !== null) {
    deps.log(args.error)
    deps.log(USAGE)
    return 1
  }
  switch (args.command) {
    case 'status':
      return runStatus(args, deps)
    case 'report':
      return runReport(args, deps)
    case 'validate':
      return runValidate(args, deps)
    case 'candidates':
    case 'recheck':
    case 'verify':
    case 'verify-field':
    case 'request-recheck':
    case 'discard':
    case 'restore':
    case 'approve':
    case 'publish':
    case 'audit':
      // 検証・承認・公開（M7-E。外部通信を一切行わない）
      return runReviewCommand(args.command, args, deps)
    case 'scan':
    case 'fetch':
    case 'extract': {
      const mode = resolveLiveMode(args, deps.env)
      if (mode.error !== null) {
        deps.log(mode.error)
        return 1
      }
      if (args.command === 'scan') return runScan(args, deps, mode.live)
      if (args.command === 'fetch') return runFetch(args, deps, mode.live)
      return runExtract(args, deps, mode.live)
    }
    default:
      deps.log(`未対応のコマンドです: ${args.command}`)
      deps.log(USAGE)
      return 1
  }
}
