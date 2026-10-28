/**
 * AI による制度候補の抽出（M7-D）
 *
 * 【責務】
 * - 取得済みの公式ページ本文だけを根拠に、支援制度候補を JSON で抽出させる。
 *   プロンプトで JSON を要求し、プログラム側で zod スキーマ検証する
 *   （structured outputs は INIAD API で能力未確認のため使用しない）。
 * - スキーマ検証に通らない出力は保存しない（抽出失敗として記録する）。
 * - 金額・所得要件・年齢条件・期限・対象地域などは、根拠となる本文抜粋
 *   （evidenceQuotes）が無い限り確定扱いにせず null に落として未確認項目に残す。
 *   AI の一般知識による補完・推測を採用しない。
 *
 * 【AI にさせること／コードが行うこと】
 * - AI: ページ本文から制度名・概要・条件・金額などの記載を読み取り、
 *   根拠抜粋とともに JSON で返すことだけ。
 * - コード: 出力のスキーマ検証、根拠のない値の降格、候補 ID・重複キーの決定、
 *   保存、調査計画の更新。AI の自己申告で「検証済み」にはしない。
 *
 * 【INIAD API（確認済みの機能のみ）】
 * - chat.completions.create({ model, messages }) のみを使う（大学の使用例どおり）。
 *   クライアントは lib/consult/iniadAdvisor.ts の createDefaultIniadClient を再利用
 *   （OpenAI SDK + Base URL 指定の確認済み接続。重複実装しない）。
 * - web_search・ツール呼び出し・structured outputs は能力未確認のため使用しない。
 *   「AI が Web 検索した」経路は存在しない（取得は sourceFetch 側の責務）。
 *
 * 【相談機能との分離】
 * - 発見パイプラインの有効化は DISCOVERY_LIVE=1 かつ --live（CLI）。既存の
 *   CONSULT_LIVE_AI（相談機能）とは独立で、CONSULT_LIVE_AI の値は参照も変更もしない。
 *   AI 呼び出しには INIAD_API_KEY（サーバー側 env のみ）が別途必要。
 */
import { z } from 'zod'
import { extractJsonObject } from '../consult/replySchema'
import {
  DEFAULT_INIAD_MODEL,
  createDefaultIniadClient,
  type ApiChatMessage,
  type ChatCompletionsLike,
} from '../consult/iniadAdvisor'
import {
  DISCOVERY_AMOUNT_UNITS,
  DISCOVERY_KINDS,
  candidateDedupeKey,
  makeCandidateId,
  type CandidateUnconfirmedItem,
  type DiscoveryCandidate,
  type DiscoveryKind,
  type DiscoveryAmountUnit,
  type EvidenceQuote,
} from './discoveryStore'

/** 発見パイプラインの外部通信を有効にする専用環境変数（CLI の --live と併用） */
export const DISCOVERY_LIVE_ENV_VAR = 'DISCOVERY_LIVE'

/** 外部通信（ページ取得・AI 呼び出し）が有効か（専用 env のみで判定。CONSULT_LIVE_AI は見ない） */
export function isDiscoveryLiveEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env[DISCOVERY_LIVE_ENV_VAR] === '1'
}

/** AI 抽出が利用可能か（専用 env ＋ API キーの両方が揃ったときのみ） */
export function isDiscoveryAiAvailable(
  env: Record<string, string | undefined>,
): boolean {
  return isDiscoveryLiveEnabled(env) && Boolean(env.INIAD_API_KEY)
}

/** 抽出モデル（既定は確認済みモデル。DISCOVERY_MODEL で変更可） */
export function resolveExtractionModel(
  env: Record<string, string | undefined>,
): string {
  return env.DISCOVERY_MODEL ?? DEFAULT_INIAD_MODEL
}

/** 既定の INIAD API クライアント（確認済み chat.completions のみ。遅延構築） */
export const createDefaultExtractClient = createDefaultIniadClient

/** プロンプトに渡す本文の最大文字数（長すぎるページは途中まで） */
export const EXTRACTION_MAX_TEXT_CHARS = 24_000

/** 1 ページから抽出する候補の上限 */
export const EXTRACTION_MAX_CANDIDATES = 20

// ── AI 出力のスキーマ（緩い入力。正規化で厳密な候補に変換する） ─────

const evidenceQuoteRawSchema = z.object({
  field: z.string().min(1),
  quote: z.string().min(1),
})

const extractedCandidateSchema = z.object({
  /** 制度名（必須。無い出力は検証エラー） */
  name: z.string().min(1),
  summary: z.string().nullable().optional(),
  implementer: z.string().nullable().optional(),
  regionScope: z.string().nullable().optional(),
  kind: z.enum(DISCOVERY_KINDS).nullable().optional(),
  eligibility: z
    .object({
      ageNote: z.string().nullable().optional(),
      householdNote: z.string().nullable().optional(),
      incomeNote: z.string().nullable().optional(),
      other: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  amount: z
    .object({
      value: z.number().nonnegative().nullable().optional(),
      unit: z.enum(DISCOVERY_AMOUNT_UNITS).nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  application: z
    .object({
      how: z.string().nullable().optional(),
      deadlineNote: z.string().nullable().optional(),
      documents: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  fiscalYear: z.string().nullable().optional(),
  validPeriod: z.string().nullable().optional(),
  evidenceQuotes: z.array(evidenceQuoteRawSchema).optional(),
  unknownItems: z.array(z.string()).optional(),
})

export type ExtractedCandidate = z.infer<typeof extractedCandidateSchema>

const extractionOutputSchema = z.object({
  candidates: z.array(extractedCandidateSchema).max(EXTRACTION_MAX_CANDIDATES),
})

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>

// ── プロンプト（JSON 出力の要求。取得本文以外を根拠にさせない） ─────

/** 抽出対象のページ（取得済み本文のみ。AI はこれを唯一の根拠にする） */
export type ExtractionPageInput = {
  url: string
  title: string | null
  /** 取得済みページ本文テキスト */
  text: string
}

/**
 * 抽出の文脈（候補に記録する取得元情報。AI ではなくコード側が確定する値）。
 */
export type ExtractionContext = {
  taskId: string
  regionId: string
  fieldId: string
  /** 根拠としたページ URL（候補の sourceUrl として記録する） */
  sourceUrl: string
  /** 情報源台帳の ID（紐付く場合のみ） */
  sourceRecordId: string | null
  /** ページ取得日時 */
  retrievedAt: string
  /** 本文ハッシュ */
  contentHash: string
}

/** AI に要求する JSON の形（プロンプトで指示する） */
const OUTPUT_FORMAT_EXAMPLE = `{"candidates":[{"name":"制度名","summary":"概要またはnull","implementer":"実施主体またはnull","regionScope":"対象地域またはnull","kind":"cash_benefit|fee_reduction|loan|tax|other または null","eligibility":{"ageNote":"対象年齢またはnull","householdNote":"世帯要件またはnull","incomeNote":"所得要件またはnull","other":["その他の条件"]},"amount":{"value":数値またはnull,"unit":"yen_per_month|yen_per_year|yen_one_time|other または null","description":"金額の前提またはnull"},"application":{"how":"申請方法またはnull","deadlineNote":"申請期限またはnull","documents":["必要書類"]},"fiscalYear":"適用年度またはnull","validPeriod":"有効期間またはnull","evidenceQuotes":[{"field":"amount（該当項目名）","quote":"本文からの抜粋"}],"unknownItems":["本文に記載が見つからなかった項目"]}]}`

/**
 * AI 抽出のメッセージを組み立てる（純関数）。
 * - system: 抽出のルール（本文のみを根拠にする・推測禁止・JSON のみで返す）
 * - user: 取得元 URL・タイトル・本文と出力形式
 */
export function buildExtractionMessages(page: ExtractionPageInput): ApiChatMessage[] {
  const system = [
    'あなたは、国・自治体の公式ページの本文から支援制度（給付金・手当・費用減免・利用料補助・貸付など）の候補を抽出するアシスタントです。',
    '与えられたページ本文だけを根拠にし、一般知識・記憶による補完や推測を一切しないでください。',
    '金額・所得要件・対象年齢・申請期限・対象地域・適用年度は、本文に明記がある場合のみ記載し、必ず対応する evidenceQuotes（本文からの抜粋）を添えてください。',
    '本文に記載が無い項目は null とし、見つからなかった項目名を unknownItems に入れてください。',
    'URL・制度名・金額を創作しないでください。本文に制度の記載が無ければ {"candidates": []} を返してください。',
    '本文に制度名の一覧しかない場合は、詳細が確認できないため candidates に含めないでください。',
    '1 ページに複数の制度が記載されている場合は、それぞれを別の候補として抽出してください。',
    '出力は JSON オブジェクトのみ。前置き・説明・コードフェンスは禁止です。',
  ].join('\n')

  const text =
    page.text.length > EXTRACTION_MAX_TEXT_CHARS
      ? `${page.text.slice(0, EXTRACTION_MAX_TEXT_CHARS)}\n…（本文が長いためここまで）`
      : page.text

  const user = [
    `取得元URL: ${page.url}`,
    `タイトル: ${page.title ?? '（不明）'}`,
    '',
    'ページ本文:',
    text,
    '',
    '出力形式（この JSON オブジェクトのみを返すこと）:',
    OUTPUT_FORMAT_EXAMPLE,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// ── 出力の検証（プログラム側で必ず検証する） ──────────────────────

export type ParseExtractionResult =
  | { ok: true; value: ExtractionOutput }
  | { ok: false; error: string }

/**
 * AI の生出力を検証して候補リストに変換する（純関数）。
 * - JSON として壊れている・必須項目（name）が無い・形式が不正な場合は
 *   { ok: false, error } を返し、候補として保存しない。
 * - スキーマ外のフィールドは破棄する（strip）。
 */
export function parseExtractionOutput(raw: string): ParseExtractionResult {
  const jsonText = extractJsonObject(raw)
  if (jsonText === null) {
    return { ok: false, error: 'AI 出力から JSON オブジェクトを取り出せませんでした' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    return {
      ok: false,
      error: `AI 出力の JSON を解析できませんでした: ${(err as Error).message}`,
    }
  }
  const result = extractionOutputSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      error: `AI 出力がスキーマ検証に通りません: ${result.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(top)'}: ${i.message}`)
        .join('; ')}`,
    }
  }
  return { ok: true, value: result.data }
}

// ── 正規化（根拠のない値を確定扱いにしない） ──────────────────────

/** 根拠抜粋の項目ラベルと該当判定 */
function hasEvidence(evidenceQuotes: readonly EvidenceQuote[], pattern: RegExp): boolean {
  return evidenceQuotes.some((q) => pattern.test(q.field) && q.quote.trim() !== '')
}

const EVIDENCE_PATTERNS = {
  amount: /amount|金額|支給|助成|補助額/i,
  age: /age|年齢/i,
  household: /household|世帯|家族/i,
  income: /income|所得/i,
  deadline: /deadline|期限/i,
  region: /region|地域|範囲/i,
  fiscalYear: /year|年度/i,
  validPeriod: /period|期間|有効/i,
} as const

/**
 * AI 抽出の緩い候補を、未検証の制度候補として正規化する（純関数）。
 *
 * 【根拠なしの値は確定扱いにしない】
 * - 金額・対象年齢・世帯要件・所得要件・申請期限・対象地域・適用年度・有効期間は、
 *   対応する根拠抜粋（evidenceQuotes）が無い場合、値を null に落とし、
 *   unconfirmedItems に理由を残す（推測値を保持しない）。
 * - 実施主体・概要・種類・申請方法・必要書類は記述として保持するが、
 *   候補全体は status 'unverified'（未検証）のまま。確定制度データには登録しない。
 * - 候補 ID は dedupeKey（地域＋実施主体＋制度名＋適用年度の主張＋根拠URL）から導く。
 *   年度違い・別制度は別候補として保持する。
 */
export function normalizeExtractedCandidate(
  raw: ExtractedCandidate,
  ctx: ExtractionContext,
  meta: { extractionModel: string; extractedAt: string },
): DiscoveryCandidate {
  const evidenceQuotes: EvidenceQuote[] = (raw.evidenceQuotes ?? []).map((q) => ({
    field: q.field,
    quote: q.quote,
  }))
  const unconfirmedItems: CandidateUnconfirmedItem[] = []
  const demoted: string[] = []

  /** 根拠があれば値を採用し、無ければ null（理由を記録） */
  function keepIfEvidenced<T>(value: T | null | undefined, field: string, pattern: RegExp): T | null {
    const v = value ?? null
    if (v === null) return null
    if (hasEvidence(evidenceQuotes, pattern)) return v
    demoted.push(field)
    unconfirmedItems.push({
      field,
      reason: '本文の根拠抜粋がないため確定扱いにしません（要検証）',
    })
    return null
  }

  const amountValue = keepIfEvidenced(raw.amount?.value ?? null, 'amount.value', EVIDENCE_PATTERNS.amount)
  const amountUnit = keepIfEvidenced(raw.amount?.unit ?? null, 'amount.unit', EVIDENCE_PATTERNS.amount)
  const ageNote = keepIfEvidenced(raw.eligibility?.ageNote ?? null, 'eligibility.age', EVIDENCE_PATTERNS.age)
  const householdNote = keepIfEvidenced(
    raw.eligibility?.householdNote ?? null,
    'eligibility.household',
    EVIDENCE_PATTERNS.household,
  )
  const incomeNote = keepIfEvidenced(
    raw.eligibility?.incomeNote ?? null,
    'eligibility.income',
    EVIDENCE_PATTERNS.income,
  )
  const deadlineNote = keepIfEvidenced(
    raw.application?.deadlineNote ?? null,
    'application.deadline',
    EVIDENCE_PATTERNS.deadline,
  )
  const regionScope = keepIfEvidenced(raw.regionScope ?? null, 'regionScope', EVIDENCE_PATTERNS.region)
  const fiscalYear = keepIfEvidenced(raw.fiscalYear ?? null, 'fiscalYear', EVIDENCE_PATTERNS.fiscalYear)
  const validPeriod = keepIfEvidenced(raw.validPeriod ?? null, 'validPeriod', EVIDENCE_PATTERNS.validPeriod)

  // 重複判定キーは「年度の主張」を使う（根拠なしで年度を落としても別年度を統合しない）
  const dedupeKey = candidateDedupeKey({
    regionId: ctx.regionId,
    implementer: raw.implementer ?? null,
    name: raw.name,
    fiscalYear: raw.fiscalYear ?? null,
    sourceUrl: ctx.sourceUrl,
  })

  return {
    candidateId: makeCandidateId(dedupeKey),
    taskId: ctx.taskId,
    regionId: ctx.regionId,
    fieldId: ctx.fieldId,
    name: raw.name,
    summary: raw.summary ?? null,
    implementer: raw.implementer ?? null,
    regionScope,
    kind: (raw.kind ?? null) as DiscoveryKind | null,
    eligibility: {
      ageNote,
      householdNote,
      incomeNote,
      other: raw.eligibility?.other ?? [],
    },
    amount: {
      value: amountValue,
      unit: (amountUnit ?? null) as DiscoveryAmountUnit | null,
      description: raw.amount?.description ?? null,
    },
    application: {
      how: raw.application?.how ?? null,
      deadlineNote,
      documents: raw.application?.documents ?? [],
    },
    fiscalYear,
    validPeriod,
    sourceUrl: ctx.sourceUrl,
    sourceRecordId: ctx.sourceRecordId,
    retrievedAt: ctx.retrievedAt,
    contentHash: ctx.contentHash,
    evidenceQuotes,
    unknownItems: raw.unknownItems ?? [],
    unconfirmedItems,
    discoveryMethod: 'ai-extraction',
    extractionModel: meta.extractionModel,
    firstExtractedAt: meta.extractedAt,
    extractedAt: meta.extractedAt,
    status: 'unverified',
    dedupeKey,
    recheckReason: null,
  }
}

// ── AI 呼び出し（確認済み chat.completions のみ） ──────────────────

export type ExtractionOutcome =
  | { ok: true; candidates: DiscoveryCandidate[] }
  | { ok: false; error: string }

/**
 * ページ本文から制度候補を抽出する（AI 呼び出しを伴う唯一の関数）。
 *
 * - client は注入する（テストは固定応答の偽クライアント。実 API を呼ばない）。
 * - AI 出力は必ず parseExtractionOutput で検証し、通らない場合は候補を
 *   1 件も保存せず { ok: false, error } を返す（呼び出し側は失敗を記録する）。
 * - 抽出できた候補はすべて status 'unverified'。検証済み・確定にはしない。
 * - options.model は AI API に送信するモデル名（例: 'gpt-5.4'）。
 *   保存する抽出方法ラベル（extractionModel）は extractionModelLabel で
 *   別に指定でき、未指定なら model をそのまま記録する
 *   （ラベルの 'iniad:' 接頭辞を API のモデル名として送信しない）。
 */
export async function extractCandidatesWithClient(
  client: ChatCompletionsLike,
  page: ExtractionPageInput,
  ctx: ExtractionContext,
  options: { model: string; extractedAt: string; extractionModelLabel?: string },
): Promise<ExtractionOutcome> {
  let content: string
  try {
    const result = await client.create({
      model: options.model,
      messages: buildExtractionMessages(page),
    })
    content = result.content ?? ''
  } catch (err) {
    return {
      ok: false,
      error: `AI API 呼び出しに失敗しました: ${(err as Error).message}`,
    }
  }
  if (content.trim() === '') {
    return { ok: false, error: 'AI 応答が空でした' }
  }
  const parsed = parseExtractionOutput(content)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    candidates: parsed.value.candidates.map((raw) =>
      normalizeExtractedCandidate(raw, ctx, {
        extractionModel: options.extractionModelLabel ?? options.model,
        extractedAt: options.extractedAt,
      }),
    ),
  }
}
