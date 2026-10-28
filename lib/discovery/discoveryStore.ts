/**
 * 支援制度候補の発見・構造化データ保存（M7-D）
 *
 * 【責務】
 * - 発見パイプラインの保存物 3 種の型・スキーマ・検証・保存/復元・重複排除を提供する
 *   （保存物の読み書きは scripts/discovery.ts / lib/discovery/cli.ts が行う）。
 *   1. 候補URL台帳（url-candidates.json）… 許可された公式ページのリンクから発見した
 *      追加調査候補の URL。URL 単位で重複を排除する
 *   2. ページ本文ストア（pages.json）… 取得済みページ本文とハッシュ。抽出状態も保持
 *   3. 制度候補ストア（candidates.json）… AI 抽出の未検証な制度候補
 *
 * 【未検証候補と確定制度データの分離（最重要）】
 * - ここに保存される制度候補はすべて status 'unverified' から始まり、
 *   data/programs/programs.json（確定制度データ）には一切混入させない。
 *   正式な制度データへの登録（承認フロー）は M7-E の責務。
 * - SupportProgram スキーマに無理に当てはめない（候補は候補のスキーマで保持する）。
 *
 * 【重複排除】
 * - URL 候補は URL で、制度候補は dedupeKey（地域＋実施主体＋制度名＋適用年度＋
 *   根拠URL）で一意にし、同じものを繰り返し追加しない。
 *   異なる年度・異なる制度名・異なる根拠 URL は別候補として保持し、誤って統合しない。
 *
 * 【外部通信なし・ファイル I/O なし】純関数とハッシュのみ。
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FETCH_FAILURE_CODES, type FetchFailureCode } from '../supports/sourceFetch'
import type { StoreResult } from '../supports/sourceStore'

/** 保存形式のバージョン（形式変更時に上げる） */
export const DISCOVERY_STORE_FORMAT_VERSION = 1

/** 保存ファイルの既定パス（リポジトリルートからの相対） */
export const URL_CANDIDATE_STORE_FILE = 'data/discovery/url-candidates.json'
export const PAGE_STORE_FILE = 'data/discovery/pages.json'
export const CANDIDATE_STORE_FILE = 'data/discovery/candidates.json'

/** 日時（ISO 8601。タイムゾーン付きまたは Z） */
const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const isoDateTime = z
  .string()
  .regex(isoDateTimePattern, 'ISO 8601 の日時で指定してください')

// ── 型・スキーマ: 候補URL台帳 ──────────────────────────────────────

/** URL 候補の発見方法 */
export const DISCOVERY_METHODS = ['survey-plan-portal', 'research-log', 'page-link'] as const
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number]

/** URL 候補の取得結果（未取得は lastFetch が null） */
export type UrlFetchOutcome = {
  attemptedAt: string
  /** 取得できたか。失敗時は failureCode / failureReason に理由を残す */
  state: 'ok' | 'failed'
  failureCode: FetchFailureCode | null
  failureReason: string | null
}

/** 候補URL台帳の 1 エントリ（取得対象になり得る公式ページ候補） */
export type UrlCandidate = {
  /** URL から導く一意な ID（url-<hash>） */
  urlId: string
  url: string
  /** 発見元の調査タスク（タスクに紐付かない発見は null） */
  taskId: string | null
  regionId: string | null
  fieldId: string | null
  /** この URL を発見した元ページ（自身がシードの場合は null） */
  foundFrom: string | null
  discoveryMethod: DiscoveryMethod
  firstFoundAt: string
  /** 直近の取得結果（未取得は null。失敗理由はここに残す） */
  lastFetch: UrlFetchOutcome | null
  /** 取得できた本文のハッシュ（変更検知用。未取得は null） */
  contentHash: string | null
  note: string
}

const urlFetchOutcomeSchema: z.ZodType<UrlFetchOutcome> = z.object({
  attemptedAt: isoDateTime,
  state: z.enum(['ok', 'failed']),
  failureCode: z.enum(FETCH_FAILURE_CODES).nullable(),
  failureReason: z.string().nullable(),
})

const urlCandidateSchema: z.ZodType<UrlCandidate> = z.object({
  urlId: z.string().min(1),
  url: z.string().min(1),
  taskId: z.string().nullable(),
  regionId: z.string().nullable(),
  fieldId: z.string().nullable(),
  foundFrom: z.string().nullable(),
  discoveryMethod: z.enum(DISCOVERY_METHODS),
  firstFoundAt: isoDateTime,
  lastFetch: urlFetchOutcomeSchema.nullable(),
  contentHash: z.string().nullable(),
  note: z.string(),
})

// ── 型・スキーマ: ページ本文ストア ────────────────────────────────

/** ページごとの AI 抽出状態 */
export const PAGE_EXTRACT_STATES = ['pending', 'extracted', 'failed'] as const
export type PageExtractState = (typeof PAGE_EXTRACT_STATES)[number]

/** 取得済みページ本文（抽出段階の分離のため本文を保持する） */
export type PageRecord = {
  url: string
  finalUrl: string | null
  title: string | null
  retrievedAt: string
  /** 本文テキストの sha256（変更検知用） */
  contentHash: string
  /** 本文テキスト（上限超過分は切り詰めし textTruncated で明示） */
  text: string
  textTruncated: boolean
  extractState: PageExtractState
  extractedAt: string | null
  /** 抽出に失敗した理由（成功時は null） */
  extractionError: string | null
  /** このページから抽出できた候補数（未抽出は null。0 件も明示的に保持） */
  extractedCandidateCount: number | null
}

const pageRecordSchema: z.ZodType<PageRecord> = z.object({
  url: z.string().min(1),
  finalUrl: z.string().nullable(),
  title: z.string().nullable(),
  retrievedAt: isoDateTime,
  contentHash: z.string().min(1),
  text: z.string(),
  textTruncated: z.boolean(),
  extractState: z.enum(PAGE_EXTRACT_STATES),
  extractedAt: isoDateTime.nullable(),
  extractionError: z.string().nullable(),
  extractedCandidateCount: z.number().int().nonnegative().nullable(),
})

// ── 型・スキーマ: 制度候補（未検証） ──────────────────────────────

/** 候補の種類（給付・費用減免・貸付など。確定分類は M7-E で再判定） */
export const DISCOVERY_KINDS = [
  'cash_benefit',
  'fee_reduction',
  'loan',
  'tax',
  'other',
] as const
export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number]

export const DISCOVERY_AMOUNT_UNITS = [
  'yen_per_month',
  'yen_per_year',
  'yen_one_time',
  'other',
] as const
export type DiscoveryAmountUnit = (typeof DISCOVERY_AMOUNT_UNITS)[number]

/**
 * 抽出・検証の状態。'unverified' は未検証のまま（確定扱いにしない）。
 * （M7-E）'approved'（公開承認済み）を追加。'needs-recheck' は M7-D からの
 * 表記を継承する（要再確認 = 必要な recheck）。
 */
export const DISCOVERY_CANDIDATE_STATUSES = [
  'unverified',
  'needs-recheck',
  'approved',
  'discarded',
] as const
export type DiscoveryCandidateStatus = (typeof DISCOVERY_CANDIDATE_STATUSES)[number]

/** 根拠となる本文抜粋（field はどの項目の根拠かのラベル） */
export type EvidenceQuote = { field: string; quote: string }

/** 未確認の項目と理由 */
export type CandidateUnconfirmedItem = { field: string; reason: string }

/**
 * 項目単位の人手による根拠確認記録（M7-E）。
 * - 「どの項目を・どの根拠抜粋で・誰が・いつ確認したか」を保持する。
 * - reviewedBy は 'manual' 固定（AI の自己申告を確認記録にしない）。
 * - contentHash は確認時点のページ本文ハッシュ。ハッシュが変わった記録は
 *   失効扱いとし、引き継がない。
 */
export type FieldVerification = {
  /** 確認対象項目（例: 'amount.value' / 'application.deadline' / 'regionScope'） */
  field: string
  /** 確認した値（記載が無いことを確認した場合は ABSENT_VALUE） */
  value: string
  /** 根拠となる本文抜粋（本文に実在しない抜粋は受け付けない） */
  evidenceQuote: string
  /** 確認者区分（'manual' 固定。AI の自己申告は不可） */
  reviewedBy: 'manual'
  /** 確認日時（ISO 8601） */
  reviewedAt: string
  /** 確認時点のページ本文ハッシュ（変更検知） */
  contentHash: string
}

/** 「記載が無いこと」を確認したことを表す FieldVerification.value の値 */
export const VERIFICATION_ABSENT_VALUE = '（記載なし）'

/** 公開（本番制度データへの反映）記録（M7-E） */
export type CandidatePublication = {
  /** 公開先の制度 ID */
  programId: string
  /** 公開日時（ISO 8601） */
  publishedAt: string
  /** 新規登録か既存制度の更新か */
  mode: 'new' | 'update'
  /** 後継制度へ切り替えた旧制度 ID（追跡用。無ければ空） */
  supersedesProgramIds: string[]
}

const fieldVerificationSchema: z.ZodType<FieldVerification> = z.object({
  field: z.string().min(1),
  value: z.string().min(1),
  evidenceQuote: z.string().min(1),
  reviewedBy: z.literal('manual'),
  reviewedAt: isoDateTime,
  contentHash: z.string().min(1),
})

const candidatePublicationSchema: z.ZodType<CandidatePublication> = z.object({
  programId: z.string().min(1),
  publishedAt: isoDateTime,
  mode: z.enum(['new', 'update']),
  supersedesProgramIds: z.array(z.string()),
})

/** AI 抽出の未検証な制度候補（SupportProgram とは別。公開はしない） */
export type DiscoveryCandidate = {
  /** dedupeKey から導く一意な ID（cand-<hash>） */
  candidateId: string
  taskId: string
  regionId: string
  fieldId: string
  name: string
  summary: string | null
  /** 実施主体（国・東京都・区など。AI 抽出。根拠なしでも保持可＝未検証） */
  implementer: string | null
  /** 対象地域（根拠抜粋がない場合は null に落とす） */
  regionScope: string | null
  kind: DiscoveryKind | null
  eligibility: {
    ageNote: string | null
    householdNote: string | null
    incomeNote: string | null
    other: string[]
  }
  amount: {
    value: number | null
    unit: DiscoveryAmountUnit | null
    description: string | null
  }
  application: {
    how: string | null
    deadlineNote: string | null
    documents: string[]
  }
  /** 適用年度（根拠抜粋がない場合は null） */
  fiscalYear: string | null
  validPeriod: string | null
  /** 根拠としたページ URL */
  sourceUrl: string
  /** 情報源台帳（sourceLedger）の ID に紐付く場合のみ */
  sourceRecordId: string | null
  /** ページ取得日時 */
  retrievedAt: string
  /** 本文ハッシュ（変更検知） */
  contentHash: string
  evidenceQuotes: EvidenceQuote[]
  /** AI が本文に記載を見つけられなかった項目 */
  unknownItems: string[]
  /** 根拠がないため確定扱いにしない項目とその理由 */
  unconfirmedItems: CandidateUnconfirmedItem[]
  discoveryMethod: 'ai-extraction'
  /** 抽出に使ったモデルまたは抽出方法（例: 'iniad:gpt-5.4' / 'mock'） */
  extractionModel: string
  /** 最初に抽出した日時 */
  firstExtractedAt: string
  /** 最終抽出日時（再抽出で更新） */
  extractedAt: string
  status: DiscoveryCandidateStatus
  /** 重複判定用のキー（地域＋実施主体＋制度名＋適用年度＋根拠URL） */
  dedupeKey: string
  /** 再調査が必要な理由（不要なら null） */
  recheckReason: string | null
  /**
   * 項目単位の人手による根拠確認記録（M7-E。無ければ省略可）。
   * contentHash が現行の本文ハッシュと一致する記録のみ有効（失効分は引き継がない）。
   */
  fieldVerifications?: FieldVerification[]
  /** 公開（本番制度データへの反映）記録（M7-E。未公開なら省略） */
  publication?: CandidatePublication
}

const evidenceQuoteSchema: z.ZodType<EvidenceQuote> = z.object({
  field: z.string().min(1),
  quote: z.string().min(1),
})

const unconfirmedItemSchema: z.ZodType<CandidateUnconfirmedItem> = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
})

const discoveryCandidateSchema: z.ZodType<DiscoveryCandidate> = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  regionId: z.string().min(1),
  fieldId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().nullable(),
  implementer: z.string().nullable(),
  regionScope: z.string().nullable(),
  kind: z.enum(DISCOVERY_KINDS).nullable(),
  eligibility: z.object({
    ageNote: z.string().nullable(),
    householdNote: z.string().nullable(),
    incomeNote: z.string().nullable(),
    other: z.array(z.string()),
  }),
  amount: z.object({
    value: z.number().nonnegative().nullable(),
    unit: z.enum(DISCOVERY_AMOUNT_UNITS).nullable(),
    description: z.string().nullable(),
  }),
  application: z.object({
    how: z.string().nullable(),
    deadlineNote: z.string().nullable(),
    documents: z.array(z.string()),
  }),
  fiscalYear: z.string().nullable(),
  validPeriod: z.string().nullable(),
  sourceUrl: z.string().min(1),
  sourceRecordId: z.string().nullable(),
  retrievedAt: isoDateTime,
  contentHash: z.string().min(1),
  evidenceQuotes: z.array(evidenceQuoteSchema),
  unknownItems: z.array(z.string()),
  unconfirmedItems: z.array(unconfirmedItemSchema),
  discoveryMethod: z.literal('ai-extraction'),
  extractionModel: z.string().min(1),
  firstExtractedAt: isoDateTime,
  extractedAt: isoDateTime,
  status: z.enum(DISCOVERY_CANDIDATE_STATUSES),
  dedupeKey: z.string().min(1),
  recheckReason: z.string().nullable(),
  fieldVerifications: z.array(fieldVerificationSchema).optional(),
  publication: candidatePublicationSchema.optional(),
})

// ── 保存形式（envelope） ──────────────────────────────────────────

export type UrlCandidateStore = {
  formatVersion: number
  savedAt: string
  urls: UrlCandidate[]
}
export type PageStore = {
  formatVersion: number
  savedAt: string
  pages: PageRecord[]
}
export type CandidateStore = {
  formatVersion: number
  savedAt: string
  candidates: DiscoveryCandidate[]
}

// ── ハッシュ・ID（重複排除と変更検知） ─────────────────────────────

/** 本文の sha256（変更検知用） */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}

/** URL から候補URL台帳の ID を導く（同一 URL は常に同一 ID） */
export function makeUrlId(url: string): string {
  return `url-${shortHash(url)}`
}

/** 制度候補の重複判定キー（年度・制度名・根拠URL が違えば別物として扱う） */
export function candidateDedupeKey(input: {
  regionId: string
  implementer: string | null
  name: string
  fiscalYear: string | null
  sourceUrl: string
}): string {
  const normalize = (s: string): string =>
    s.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
  return [
    input.regionId,
    normalize(input.implementer ?? 'unknown'),
    normalize(input.name),
    input.fiscalYear ?? 'unknown',
    input.sourceUrl,
  ].join('|')
}

/** 重複判定キーから候補 ID を導く */
export function makeCandidateId(dedupeKey: string): string {
  return `cand-${shortHash(dedupeKey)}`
}

// ── parse / serialize（失敗は例外ではなく StoreResult で返す） ─────

function formatIssues(prefix: string, error: z.ZodError): string {
  return error.issues
    .map(
      (i) =>
        `${prefix}${i.path.length > 0 ? `.${i.path.map(String).join('.')}` : ''}: ${i.message}`,
    )
    .join('; ')
}

function parseEnvelope<T>(
  text: string,
  label: string,
  itemsKey: string,
  itemSchema: z.ZodType<T>,
): StoreResult<{ formatVersion: number; savedAt: string; items: T[] }> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: `${label} の JSON を解析できませんでした: ${(err as Error).message}`,
    }
  }
  const envelope = z
    .object({
      formatVersion: z.literal(DISCOVERY_STORE_FORMAT_VERSION),
      savedAt: z.string(),
      [itemsKey]: z.array(itemSchema),
    })
    .safeParse(raw)
  if (!envelope.success) {
    return {
      ok: false,
      error: `${label} の形式が不正です: ${formatIssues(itemsKey, envelope.error)}`,
    }
  }
  return {
    ok: true,
    value: {
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: (envelope.data as { savedAt: string }).savedAt,
      items: (envelope.data as Record<string, T[]>)[itemsKey],
    },
  }
}

function serializeEnvelope(
  savedAt: string,
  itemsKey: string,
  items: unknown[],
): string {
  return `${JSON.stringify(
    { formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt, [itemsKey]: items },
    null,
    2,
  )}\n`
}

export function parseUrlCandidateStore(text: string): StoreResult<UrlCandidateStore> {
  const parsed = parseEnvelope(text, '候補URL台帳', 'urls', urlCandidateSchema)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: {
      formatVersion: parsed.value.formatVersion,
      savedAt: parsed.value.savedAt,
      urls: parsed.value.items,
    },
  }
}

export function serializeUrlCandidateStore(store: UrlCandidateStore): string {
  return serializeEnvelope(store.savedAt, 'urls', store.urls)
}

export function parsePageStore(text: string): StoreResult<PageStore> {
  const parsed = parseEnvelope(text, 'ページ本文ストア', 'pages', pageRecordSchema)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: {
      formatVersion: parsed.value.formatVersion,
      savedAt: parsed.value.savedAt,
      pages: parsed.value.items,
    },
  }
}

export function serializePageStore(store: PageStore): string {
  return serializeEnvelope(store.savedAt, 'pages', store.pages)
}

export function parseCandidateStore(text: string): StoreResult<CandidateStore> {
  const parsed = parseEnvelope(text, '制度候補ストア', 'candidates', discoveryCandidateSchema)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: {
      formatVersion: parsed.value.formatVersion,
      savedAt: parsed.value.savedAt,
      candidates: parsed.value.items,
    },
  }
}

export function serializeCandidateStore(store: CandidateStore): string {
  return serializeEnvelope(store.savedAt, 'candidates', store.candidates)
}

// ── 重複排除つきの更新（純関数） ───────────────────────────────────

/**
 * URL 候補を登録する（URL 単位で重複排除）。
 * - 同一 URL が既にあれば追加しない（firstFoundAt は最初の発見のまま維持）。
 *   取得結果の更新は recordUrlFetch を使う。
 */
export function upsertUrlCandidate(
  urls: readonly UrlCandidate[],
  entry: UrlCandidate,
): UrlCandidate[] {
  if (urls.some((u) => u.url === entry.url)) return [...urls]
  return [...urls, entry]
}

/** URL 候補の取得結果を記録する（未登録 URL には何もしない） */
export function recordUrlFetch(
  urls: readonly UrlCandidate[],
  url: string,
  outcome: UrlFetchOutcome,
  contentHash: string | null,
): UrlCandidate[] {
  return urls.map((u) =>
    u.url === url
      ? {
          ...u,
          lastFetch: { ...outcome },
          ...(contentHash !== null ? { contentHash } : {}),
        }
      : u,
  )
}

/** ページ本文を保存する（URL 単位で置き換え。履歴は retrievedAt で追える） */
export function upsertPageRecord(
  pages: readonly PageRecord[],
  page: PageRecord,
): PageRecord[] {
  const rest = pages.filter((p) => p.url !== page.url)
  return [...rest, page]
}

/**
 * 制度候補を保存する（candidateId 単位で重複排除）。
 * - 同一候補（同一 dedupeKey）の再抽出は置き換え（firstExtractedAt は維持）。
 * - 除外済み（discarded）の候補は、再抽出で上書きせず除外のまま維持する。
 */
export function upsertCandidates(
  existing: readonly DiscoveryCandidate[],
  incoming: readonly DiscoveryCandidate[],
): DiscoveryCandidate[] {
  const byId = new Map<string, DiscoveryCandidate>()
  for (const c of existing) byId.set(c.candidateId, c)
  for (const c of incoming) {
    const prev = byId.get(c.candidateId)
    if (prev !== undefined && prev.status === 'discarded') continue
    byId.set(c.candidateId, {
      ...c,
      firstExtractedAt: prev?.firstExtractedAt ?? c.firstExtractedAt,
    })
  }
  return [...byId.values()]
}
