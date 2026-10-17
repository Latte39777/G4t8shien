/**
 * 子育て支援制度ナレッジベース（M6-F）— 公式情報の取得結果を利用形式に整理する
 *
 * 【責務】
 * - 公式情報の取得結果（URL 台帳 lib/supports/sourceLedger.ts）と既存の調査記録
 *   （lib/supports/officialPrograms.ts）から、制度情報をアプリと AI に提供できる
 *   構造化データとして整理する。過剰なインフラ（DB 等）は導入せず、
 *   既存レジストリ（lib/supports/registry.ts）と整合するローカルの構造化データで
 *   管理する（このファイルの zod スキーマで検証する）。
 *
 * 【扱う情報（各制度・情報源）】
 * - 制度 ID・制度名／情報源のタイトルと URL／実施主体と対象地域
 * - 取得日時（retrievedAt）と確認日時（reviewedAt・checkedAt）の分離
 * - 対象年齢・適用期間／金額・金額単位・適用年度／対象条件・所得条件
 * - 申請期限・申請先／根拠法令・条例
 * - 確認済みの項目と未確認の項目（項目ごとの確度）
 * - 出典と対応する情報の関係（field.sourceIds）
 * - 更新履歴（revisions: 登録・取得・人手照合の前後追跡）
 *
 * 【確度の原則】
 * - 確認済み（confirmed）は「公式資料と人手で照合済み」の項目のみ。
 *   URL にアクセスできた・本文を取得しただけでは confirmed にしない。
 * - 未確認の値は null とし、AI の知識で不足情報を補完しない。
 * - 金額の計算は lib/finance/supports.ts 等の既存プログラムが行い、
 *   AI に金額を自由生成させて計算結果として採用しない。
 *
 * 【こども医療費助成の区単位の扱い（重要）】
 * - 条件が区ごとに異なる制度は、対象区が確認できたデータだけをその区に紐づける。
 *   区が不明な制度を東京都全体で共通の制度として扱わない（boundWards は原則空）。
 *
 * 【外部通信なし】このモジュールは整形・判定・検証のみ。fetch は行わない。
 */
import { z } from 'zod'
import {
  type Jurisdiction,
  type SupportProgram,
  type UnconfirmedItem,
} from '../types/support'
import { MOCK_SUPPORT_PROGRAMS } from './mockPrograms'
import { buildOfficialPrograms } from './officialPrograms'
import {
  LEDGER_PROVENANCE_REGISTERED,
  LEDGER_PROVENANCE_RETRIEVAL,
  LEDGER_PROVENANCE_REVIEW,
  buildInitialLedger,
  isReviewOutdated,
  type LedgerEntry,
} from './sourceLedger'

/** 項目ごとの確度（confirmed は人手照合済みのみ。AI 自己申告では上がらない） */
export const KB_FIELD_CONFIDENCE = ['confirmed', 'estimated', 'unconfirmed'] as const
export type KbFieldConfidence = (typeof KB_FIELD_CONFIDENCE)[number]

/**
 * 項目の確度の根拠（照合）の provenance。
 * 「M6-C 調査ログからの転記」と「実運用での取得後に人手照合した実績」を
 * 混同しないための区別（根拠なしは 'none'、混在は 'mixed'）。
 */
export const KB_FIELD_PROVENANCES = [
  'research-log-transcribed',
  'manual-review',
  'mixed',
  'none',
] as const
export type KbFieldProvenance = (typeof KB_FIELD_PROVENANCES)[number]

/** 情報源の状態の provenance（URL 台帳の LedgerProvenance と対応） */
export const kbProvenanceSchema = z.object({
  registered: z.enum(LEDGER_PROVENANCE_REGISTERED),
  retrieval: z.enum(LEDGER_PROVENANCE_RETRIEVAL).nullable(),
  review: z.enum(LEDGER_PROVENANCE_REVIEW).nullable(),
})
export type KbProvenance = z.infer<typeof kbProvenanceSchema>

/** 制度の個別項目（出典との対応・必要最小限の引用付き） */
export const kbFieldSchema = z.object({
  /** プロジェクト共通のフィールドパス（例: 'amount.value'） */
  field: z.string().min(1),
  label: z.string().min(1),
  /** 値。未確認は null（根拠のない値を補完しない） */
  value: z.union([z.string(), z.number()]).nullable(),
  /** 金額の単位（金額項目のみ） */
  unit: z.string().nullable().optional(),
  /** 適用年度（未確認は null。年度を推測しない） */
  fiscalYear: z.string().nullable().optional(),
  confidence: z.enum(KB_FIELD_CONFIDENCE),
  /** この情報を裏付ける情報源（台帳の urlId。出典と情報の対応） */
  sourceIds: z.array(z.string()),
  /**
   * この項目の確度の根拠（照合）の provenance。
   * 転記（調査ログ）と実績（実運用の取得後の手動照合）を混同しないための区別。
   */
  provenance: z.enum(KB_FIELD_PROVENANCES),
  /** 取得本文からの必要最小限の引用 */
  excerpt: z.string().nullable(),
  note: z.string().nullable(),
})
export type KbField = z.infer<typeof kbFieldSchema>

/** 情報源のビュー（URL 検証状態と内容確認状態を分離して保持） */
export const kbSourceViewSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  organization: z.string().min(1),
  /** URL 側: candidate-registered / reachable / official-confirmed */
  urlState: z.string().min(1),
  /** 内容側: no-content / needs-review / reviewed */
  contentState: z.string().min(1),
  /** 取得日時（機械的） */
  retrievedAt: z.string().nullable(),
  /** 人手で照合した日（取得日時とは別） */
  reviewedAt: z.string().nullable(),
  reviewedFields: z.array(z.string()),
  lastFetchResult: z.string().nullable(),
  /** 再取得後のため照合が古い（= 再確認が必要） */
  reviewOutdated: z.boolean(),
  /** この情報源の状態の provenance（転記・実取得・人手照合の区別） */
  provenance: kbProvenanceSchema,
  excerpt: z.string().nullable(),
})
export type KbSourceView = z.infer<typeof kbSourceViewSchema>

/** 更新履歴（変更前後を追跡するための情報） */
export const kbRevisionSchema = z.object({
  at: z.string().min(1),
  kind: z.enum(['registration', 'retrieval', 'review', 'update']),
  summary: z.string().min(1),
  before: z.string().nullable(),
  after: z.string().nullable(),
  by: z.string().min(1),
})
export type KbRevision = z.infer<typeof kbRevisionSchema>

/** 区単位の紐づけ（対象区が確認できたデータだけを当該区に紐づける） */
export const kbWardBindingSchema = z.object({
  /** 確認済みで紐づけた区コード（未確認の区は含めない） */
  boundWards: z.array(z.string()),
  note: z.string().min(1),
})
export type KbWardBinding = z.infer<typeof kbWardBindingSchema>

export const kbProgramEntrySchema = z.object({
  /** 既存レジストリ（registry.ts）の制度 ID と一致させる */
  programId: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  level: z.string().min(1),
  /** 実施主体・対象地域（不明は推測しない） */
  jurisdiction: z.object({
    coverage: z.string().min(1),
    prefecture: z.string().nullable(),
    municipality: z.string().nullable(),
    ward: z.string().nullable(),
    scopeNote: z.string().nullable(),
    confidence: z.string().nullable(),
  }),
  fields: z.array(kbFieldSchema),
  sources: z.array(kbSourceViewSchema),
  unconfirmedItems: z.array(
    z.object({ field: z.string().min(1), reason: z.string().min(1) }),
  ),
  wardBinding: kbWardBindingSchema,
  revisions: z.array(kbRevisionSchema),
})
export type KbProgramEntry = z.infer<typeof kbProgramEntrySchema>

// ── 既存データからの構造化（確定情報と未確認の分離）─────────────────

/**
 * 照合済み項目名と KB フィールドパスを同一視してよい明示的な対応表。
 * ここで挙げていない部分文字列一致は認めない（'app' 等で確認済みにしない）。
 */
const REVIEWED_FIELD_ALIASES: Record<string, readonly string[]> = {
  'application.deadline': ['application.deadlineNote', 'application.deadlineDate'],
}

/**
 * フィールドパスの対応関係（厳格。純関数）。
 * - 完全一致（'amount.value' ⇔ 'amount.value'）
 * - 祖先パス（照合済みの親項目は子項目に反映: 'amountBands' → 'amountBands.0.value'）。
 *   '.' 区切りの境界のみ認め、部分文字列（'app' → 'application.where'）は認めない
 * - 明示エイリアス（REVIEWED_FIELD_ALIASES）のみ
 * - 下位項目の照合で上位項目を確認済みにしない（'application.where.x' → 'application.where' 不可）
 */
function matchesField(listField: string, fieldPath: string): boolean {
  if (listField === fieldPath) return true
  if (fieldPath.startsWith(`${listField}.`)) return true
  return (REVIEWED_FIELD_ALIASES[fieldPath] ?? []).includes(listField)
}

/**
 * 項目ごとの確度を決める（純関数）。
 * - 未確認項目（unconfirmedItems）に当たる → unconfirmed
 * - 受給資格（eligibility）は常に unconfirmed（正式な受給資格の決定ではない）
 * - 人手照合済み項目（verification.verifiedFields）かつ値あり → confirmed
 * - それ以外は値があっても estimated、値が無ければ unconfirmed
 */
export function kbConfidenceFor(
  program: SupportProgram,
  fieldPath: string,
  value: string | number | null,
): KbFieldConfidence {
  if (fieldPath === 'eligibility') return 'unconfirmed'
  const unconfirmed = (program.unconfirmedItems ?? []).some((u) =>
    matchesField(u.field, fieldPath),
  )
  if (unconfirmed) return 'unconfirmed'
  const verified = (program.verification?.verifiedFields ?? []).some((f) =>
    matchesField(f, fieldPath),
  )
  if (value === null) return 'unconfirmed'
  return verified ? 'confirmed' : 'estimated'
}

function formatPeriod(period: SupportProgram['period']): string | null {
  const parts: string[] = []
  if (period.startAgeYears !== null || period.endAgeYears !== null) {
    parts.push(
      `${period.startAgeYears ?? '?'}歳〜${period.endAgeYears ?? '?'}歳`,
    )
  }
  if (period.durationMonths !== null) parts.push(`支給期間 ${period.durationMonths}か月`)
  return parts.length > 0 ? parts.join(' / ') : null
}

/** 項目を裏付ける情報源（台帳 urlId）。ページ単位で照合済みの出典に限る */
function sourceIdsForField(
  sources: readonly LedgerEntry[],
  fieldPath: string,
): string[] {
  return sources
    .filter((s) => s.review.reviewedFields.some((f) => matchesField(f, fieldPath)))
    .map((s) => s.urlId)
}

function excerptForField(
  sources: readonly LedgerEntry[],
  fieldPath: string,
): string | null {
  const matched = sources.find((s) =>
    s.review.reviewedFields.some((f) => matchesField(f, fieldPath)),
  )
  return matched?.excerpt ?? null
}

/**
 * 項目の確度の根拠（照合）の provenance（純関数）。
 * 照合済みの出典の review provenance から導出し、転記と実績を区別する。
 */
function fieldProvenanceFor(
  sources: readonly LedgerEntry[],
  fieldPath: string,
): KbFieldProvenance {
  const kinds = new Set<string>()
  for (const s of sources) {
    if (!s.review.reviewedFields.some((f) => matchesField(f, fieldPath))) continue
    if (s.provenance.review !== null) kinds.add(s.provenance.review)
  }
  if (kinds.size === 0) return 'none'
  if (kinds.size > 1) return 'mixed'
  return kinds.has('manual-review') ? 'manual-review' : 'research-log-transcribed'
}

type FieldSpec = {
  field: string
  label: string
  value: string | number | null
  unit?: string | null
  fiscalYear?: string | null
  note?: string | null
}

function fieldSpecsFor(program: SupportProgram): FieldSpec[] {
  const specs: FieldSpec[] = [
    { field: 'name', label: '制度名', value: program.name },
    { field: 'summary', label: '概要', value: program.summary },
    {
      field: 'amount.value',
      label: '支給額・助成額',
      value: program.amount.value,
      unit: program.amount.unit,
      fiscalYear: program.amount.fiscalYear ?? null,
      note: program.amount.description,
    },
  ]
  for (const [i, band] of (program.amountBands ?? []).entries()) {
    specs.push({
      field: `amountBands.${i}.value`,
      label: `支給額内訳: ${band.label}`,
      value: band.value,
      unit: band.unit,
      fiscalYear: band.fiscalYear ?? null,
      note: band.note ?? null,
    })
  }
  specs.push(
    {
      field: 'period',
      label: '対象年齢・適用期間',
      value: formatPeriod(program.period),
      note:
        program.effectiveFrom != null || program.effectiveTo != null
          ? `適用期間: ${program.effectiveFrom ?? '開始未確認'}〜${program.effectiveTo ?? '終了未確認'}`
          : null,
    },
    {
      field: 'conditions.incomeLimit',
      label: '対象条件・所得条件',
      value: program.conditions.incomeLimitNote,
    },
    {
      field: 'conditions.other',
      label: 'その他の条件',
      value:
        program.conditions.other.length > 0
          ? program.conditions.other.join(' / ')
          : null,
    },
    {
      field: 'application.where',
      label: '申請先',
      value: program.application.where,
    },
    {
      field: 'application.deadline',
      label: '申請期限',
      value: program.application.deadlineDate ?? program.application.deadlineNote,
    },
    {
      field: 'application.documents',
      label: '必要書類',
      value:
        program.application.documents.length > 0
          ? program.application.documents.join(' / ')
          : null,
    },
    {
      field: 'application.steps',
      label: '申請手順',
      value:
        program.application.steps.length > 0
          ? program.application.steps.join(' → ')
          : null,
    },
    {
      field: 'legalBasis.lawName',
      label: '根拠法令',
      value: program.legalBasis.lawName,
    },
    {
      field: 'legalBasis.ordinanceName',
      label: '根拠条例',
      value: program.legalBasis.ordinanceName,
    },
    {
      field: 'category',
      label: '制度分類',
      value: program.category,
    },
    {
      field: 'jurisdiction',
      label: '実施主体・対象地域',
      value: program.jurisdiction?.scopeNote ?? null,
    },
    {
      field: 'eligibility',
      label: '受給可能性（判定は常に未確認）',
      value: program.eligibilityNote,
    },
  )
  return specs
}

// ── ナレッジベースの構築 ─────────────────────────────────────────

/** 条件が区ごとに異なる制度（区単位のデータと厳密に分離して扱う） */
const WARD_SPECIFIC_PROGRAM_IDS = new Set(['mock-child-medical-aid'])

function toSourceView(entry: LedgerEntry): KbSourceView {
  return {
    sourceId: entry.urlId,
    title: entry.title,
    url: entry.url,
    organization: entry.organization,
    urlState: entry.urlState,
    contentState: entry.contentState,
    retrievedAt: entry.contentRetrievedAt,
    reviewedAt: entry.review.reviewedAt,
    reviewedFields: [...entry.review.reviewedFields],
    lastFetchResult: entry.lastFetchResult,
    reviewOutdated: isReviewOutdated(entry),
    provenance: { ...entry.provenance },
    excerpt: entry.excerpt,
  }
}

function buildRevisions(
  program: SupportProgram,
  sources: readonly LedgerEntry[],
): KbRevision[] {
  const revisions: KbRevision[] = [
    {
      at: program.checkedAt,
      kind: 'registration',
      summary: `M6 調査記録からナレッジベースに登録（${program.name}）`,
      before: null,
      after: program.name,
      by: 'm6c-research',
    },
  ]
  for (const s of sources) {
    if (s.contentRetrievedAt !== null) {
      revisions.push({
        at: s.contentRetrievedAt,
        kind: 'retrieval',
        summary:
          s.provenance.retrieval === 'fetch-run'
            ? `公式ページ本文を取得（${s.url}）`
            : `調査ログから取得記録を転記（${s.url}）`,
        before: null,
        after: s.title,
        // 転記と実取得の実績を混同しない（provenance 由来）
        by: s.provenance.retrieval ?? 'fetch-run',
      })
    }
    if (s.review.reviewedAt !== null) {
      revisions.push({
        at: s.review.reviewedAt,
        kind: 'review',
        summary:
          s.provenance.review === 'manual-review'
            ? `人手で制度内容を照合（${s.review.reviewedFields.join(', ') || '項目なし'}）`
            : `調査ログから照合記録を転記（${s.review.reviewedFields.join(', ') || '項目なし'}）`,
        before: 'needs-review',
        after: 'reviewed',
        // 転記と人手照合の実績を混同しない（provenance 由来）
        by: s.provenance.review ?? 'manual-review',
      })
    }
  }
  return revisions
}

function toKbEntry(
  program: SupportProgram,
  ledger: readonly LedgerEntry[],
): KbProgramEntry {
  const sources = ledger.filter((s) => s.programIds.includes(program.id))
  const fields: KbField[] = fieldSpecsFor(program).map((spec) => {
    const confidence = program.mock
      ? // モック（仮データ）は項目を問わず未確認
        'unconfirmed'
      : kbConfidenceFor(program, spec.field, spec.value)
    return {
      field: spec.field,
      label: spec.label,
      value: spec.value,
      unit: spec.unit ?? null,
      fiscalYear: spec.fiscalYear ?? null,
      confidence,
      sourceIds: sourceIdsForField(sources, spec.field),
      provenance: fieldProvenanceFor(sources, spec.field),
      excerpt: excerptForField(sources, spec.field),
      note: spec.note ?? null,
    }
  })
  const unconfirmedItems: UnconfirmedItem[] = fields
    .filter((f) => f.confidence === 'unconfirmed')
    .map((f) => {
      const existing = (program.unconfirmedItems ?? []).find((u) =>
        matchesField(u.field, f.field),
      )
      return {
        field: f.field,
        reason:
          existing?.reason ??
          (program.mock
            ? 'モック（仮データ）のため未確認。公式情報の確認が必要'
            : '公式情報で確認できていないため未確認（要確認）'),
      }
    })
  const wardSpecific = WARD_SPECIFIC_PROGRAM_IDS.has(program.id)
  const jurisdiction: Jurisdiction = program.jurisdiction ?? {
    coverage: 'unknown',
    prefecture: null,
    municipality: null,
    ward: null,
    scopeNote: '対象地域は未確認（推測で設定しない）',
    confidence: 'unconfirmed',
  }
  return {
    programId: program.id,
    name: program.name,
    category: program.category,
    level: program.level,
    jurisdiction: {
      coverage: jurisdiction.coverage,
      prefecture: jurisdiction.prefecture,
      municipality: jurisdiction.municipality,
      ward: jurisdiction.ward,
      scopeNote: jurisdiction.scopeNote,
      confidence: jurisdiction.confidence ?? null,
    },
    fields,
    sources: sources.map(toSourceView),
    unconfirmedItems,
    wardBinding: wardSpecific
      ? {
          boundWards: [],
          note: '条件が区ごとに異なる制度。対象区が確認できたデータだけをその区に紐づける（現時点で確認済みの区データは無し）。東京都全体で共通の制度として扱わない',
        }
      : {
          boundWards: [],
          note: '全国・広域の制度。区単位の独自条件は未確認のため区には紐づけない',
        },
    revisions: buildRevisions(program, sources),
  }
}

/**
 * ナレッジベースを構築する（純関数・外部通信なし）。
 * - 公式調査記録の制度（registry と同一 ID）＋ こども医療費助成（モック維持）を対象に、
 *   最初に扱う制度（児童手当・高校生等奨学給付金・教育関連の貸付/奨学金・
 *   こども医療費助成）を整理する。
 * - 全件を zod スキーマで検証してから返す。
 */
export function buildKnowledgeBase(
  ledger: readonly LedgerEntry[] = buildInitialLedger(),
): KbProgramEntry[] {
  const programs: SupportProgram[] = [...buildOfficialPrograms()]
  const medical = MOCK_SUPPORT_PROGRAMS.find((p) => p.id === 'mock-child-medical-aid')
  if (medical !== undefined) programs.push(medical)
  const entries = programs.map((p) => toKbEntry(p, ledger))
  const parsed = z.array(kbProgramEntrySchema).safeParse(entries)
  if (!parsed.success) {
    throw new Error(
      `ナレッジベースの検証に失敗しました: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(' / ')}`,
    )
  }
  return parsed.data
}

// ── AI への提供（検証済みのみ。金額計算は既存プログラム側）────────────

/** AI に供給してよい根拠（確認済みと未確認を混ぜない） */
export type KbAiContext = {
  /** 確認済み（人手照合済み）の事実のみ。出典付き */
  confirmedFacts: string[]
  /** 未確認の項目（AI は「確認できる公式情報がありません」と伝える） */
  unconfirmedNotes: string[]
  /** 根拠に使える公式出典 */
  sources: { title: string; url: string; organization: string }[]
  /** 金額計算はプログラム側で行う方針 */
  amountCalculationPolicy: string
  /** 確認済みの事実が 1 件もない */
  allUnverified: boolean
}

export const KB_AMOUNT_CALCULATION_POLICY =
  '支援額の計算はアプリの計算プログラム（lib/finance/supports.ts 等）で行う。AI は金額を自由に生成せず、生成した値を計算結果として採用しない。最新の支給額・法令・申請期限は AI の学習知識で確定せず、確認済みの公式情報（出典付き）がない場合は「確認できる公式情報がありません」「条件の確認が必要です」と答える。'

/** 情報源の provenance を説明文にする（転記と実績を混同しないための表記） */
function describeSourceProvenance(s: KbSourceView): string {
  let retrieval: string
  if (s.provenance.retrieval === 'fetch-run') {
    retrieval = `実取得${s.retrievedAt === null ? '' : ` ${s.retrievedAt}`}`
  } else {
    retrieval = `調査ログ転記の取得${s.retrievedAt === null ? '' : ` ${s.retrievedAt}`}`
  }
  let review: string
  if (s.provenance.review === 'manual-review') {
    review = `人手照合${s.reviewedAt === null ? '' : ` ${s.reviewedAt}`}`
  } else if (s.provenance.review === 'research-log-transcribed') {
    review = `調査ログ転記の照合${s.reviewedAt === null ? '' : ` ${s.reviewedAt}`}`
  } else {
    review = '照合なし'
  }
  return `${retrieval}・${review}`
}

/**
 * ナレッジベースから AI 供給用の根拠を整形する（純関数・外部通信なし）。
 * - confidence 'confirmed' の項目だけを confirmedFacts に入れる
 * - それ以外（estimated / unconfirmed）は未確認として分離する
 * - 出典には provenance（転記・実取得・人手照合）を明示し、実績を混同しない
 */
export function buildKbAiContext(entries: readonly KbProgramEntry[]): KbAiContext {
  const confirmedFacts: string[] = []
  const unconfirmedNotes: string[] = []
  const sourceMap = new Map<string, { title: string; url: string; organization: string }>()
  for (const entry of entries) {
    for (const s of entry.sources) {
      if (s.urlState === 'official-confirmed') {
        sourceMap.set(s.sourceId, {
          title: s.title,
          url: s.url,
          organization: s.organization,
        })
      }
    }
    const sourceById = new Map(entry.sources.map((s) => [s.sourceId, s]))
    for (const f of entry.fields) {
      const sourceNote =
        f.sourceIds.length > 0
          ? `出典: ${f.sourceIds
              .map((id) => {
                const s = sourceById.get(id)
                return s === undefined ? id : `${s.title}（${describeSourceProvenance(s)}）`
              })
              .join(' / ')}`
          : '出典: ページ単位の対応が未確認（制度単位の照合記録のみ）'
      if (f.confidence === 'confirmed' && f.value !== null) {
        const unitNote = f.unit != null ? `（単位: ${f.unit}）` : ''
        const yearNote = f.fiscalYear != null ? `（適用年度: ${f.fiscalYear}）` : ''
        confirmedFacts.push(
          `・${entry.name}｜${f.label}: ${f.value}${unitNote}${yearNote}［${sourceNote}］`,
        )
      } else {
        unconfirmedNotes.push(
          `・${entry.name}｜${f.label}: 確認できる公式情報がありません（条件の確認が必要です）`,
        )
      }
    }
  }
  return {
    confirmedFacts,
    unconfirmedNotes,
    sources: [...sourceMap.values()],
    amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
    allUnverified: confirmedFacts.length === 0,
  }
}

/**
 * ナレッジベースと既存レジストリの整合チェック（純関数）。
 * - KB の programId はすべてレジストリに存在し、名称も一致すること
 * - 未確認の金額（confidence が confirmed 以外）は confirmed 扱いにならないこと
 */
export function checkKbRegistryConsistency(
  registryPrograms: readonly SupportProgram[],
  entries: readonly KbProgramEntry[],
): string[] {
  const problems: string[] = []
  const byId = new Map(registryPrograms.map((p) => [p.id, p]))
  for (const entry of entries) {
    const program = byId.get(entry.programId)
    if (program === undefined) {
      problems.push(`KB の programId ${entry.programId} がレジストリに存在しません`)
      continue
    }
    if (program.name !== entry.name) {
      problems.push(
        `KB とレジストリの制度名が不一致: ${entry.programId} (${entry.name} / ${program.name})`,
      )
    }
    for (const f of entry.fields) {
      if (f.confidence !== 'confirmed') continue
      if (f.value === null) {
        problems.push(
          `未確認の値が confirmed 扱いになっています: ${entry.programId}.${f.field}`,
        )
      }
    }
  }
  return problems
}
