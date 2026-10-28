/**
 * 制度候補の検証・承認・却下の状態管理と監査履歴（M7-E・純関数）
 *
 * 【責務】
 * - 候補の状態遷移（unverified / needs-recheck / approved / discarded）の定義と適用
 * - 項目単位の人手による根拠確認（FieldVerification）の記録と有効性判定
 * - 監査履歴（data/discovery/audit-log.json）の型・検証・追記
 * - 本文ハッシュ変更の検知（過去の確認を引き継がず要再確認へ）
 *
 * 【安全原則】
 * - AI 抽出に成功しただけ・公式 URL と確認できただけでは approved にしない。
 *   承認には重要項目ごとの人手根拠確認（根拠抜粋が本文に実在し、抽出値と
 *   一致すること）が必要。
 * - 確認記録の reviewedBy は 'manual' 固定。AI の自己申告を確認記録にしない。
 * - 本文ハッシュが確認時点と異なる記録は失効扱い（引き継がない）。
 * - 却下済み（discarded）から approved へは直行できない（restore で unverified に
 *   戻し、根拠を再確認してから承認する）。
 *
 * 【外部通信なし・ファイル I/O なし】純関数とハッシュのみ。
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  DISCOVERY_CANDIDATE_STATUSES,
  VERIFICATION_ABSENT_VALUE,
  type DiscoveryCandidate,
  type DiscoveryCandidateStatus,
  type FieldVerification,
} from './discoveryStore'
import type { StoreResult } from '../supports/sourceStore'

/** 監査履歴の保存形式バージョン */
export const REVIEW_AUDIT_FORMAT_VERSION = 1

/** 監査履歴の保存ファイル（リポジトリルートからの相対） */
export const REVIEW_AUDIT_FILE = 'data/discovery/audit-log.json'

// ── 監査履歴 ─────────────────────────────────────────────────────

/**
 * 監査の対象アクション。
 * - extracted: AI 抽出で候補として保存（発見）
 * - field-verified: 項目単位の根拠を人手で確認
 * - status-changed: 状態遷移（再確認要求・再確認完了など）
 * - approved / discarded / restored: 承認・却下・却下からの復帰
 * - published: 公開用データへ反映
 * - publish-rejected: 公開が拒否された（不足項目の記録）
 * - recheck-detected: ハッシュ変更等で要再確認を検知
 */
export const AUDIT_ACTIONS = [
  'extracted',
  'field-verified',
  'status-changed',
  'approved',
  'discarded',
  'restored',
  'published',
  'publish-rejected',
  'recheck-detected',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEntry = {
  /** 監査 ID（aud-<hash>。内容から導く一意な ID） */
  auditId: string
  /** 操作日時（ISO 8601） */
  at: string
  candidateId: string
  action: AuditAction
  /** 操作者（人手操作は担当者名。自動記録は 'pipeline' / 'ai-extraction'） */
  actor: string
  /** 変更理由・操作理由 */
  reason: string
  /** 変更前の状態（初回記録は null） */
  fromStatus: DiscoveryCandidateStatus | null
  /** 変更後の状態（状態を伴わない記録は null） */
  toStatus: DiscoveryCandidateStatus | null
  /** 根拠となる取得元 URL */
  pageUrl: string | null
  /** 確認・対象とした項目名 */
  fields: string[]
  /** 公開先の制度 ID（公開時のみ） */
  programId: string | null
  /** 補足（公開拒否の不足項目・追跡情報など） */
  details: string | null
}

const auditEntrySchema: z.ZodType<AuditEntry> = z.object({
  auditId: z.string().min(1),
  at: z.string().min(1),
  candidateId: z.string().min(1),
  action: z.enum(AUDIT_ACTIONS),
  actor: z.string().min(1),
  reason: z.string().min(1),
  fromStatus: z.enum(DISCOVERY_CANDIDATE_STATUSES).nullable(),
  toStatus: z.enum(DISCOVERY_CANDIDATE_STATUSES).nullable(),
  pageUrl: z.string().nullable(),
  fields: z.array(z.string()),
  programId: z.string().nullable(),
  details: z.string().nullable(),
})

export type ReviewAuditStore = {
  formatVersion: number
  savedAt: string
  entries: AuditEntry[]
}

/** 監査 ID（同一操作の重複記録を防ぐ） */
export function makeAuditId(entry: Omit<AuditEntry, 'auditId'>): string {
  const material = [
    entry.at,
    entry.candidateId,
    entry.action,
    entry.actor,
    entry.reason,
    entry.fromStatus ?? '',
    entry.toStatus ?? '',
    entry.pageUrl ?? '',
    entry.fields.join(','),
    entry.programId ?? '',
    entry.details ?? '',
  ].join('\u0000')
  return `aud-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
}

/** 監査エントリを作る（auditId は内容から導く） */
export function makeAuditEntry(input: Omit<AuditEntry, 'auditId'>): AuditEntry {
  return { ...input, auditId: makeAuditId(input) }
}

export function parseReviewAuditStore(text: string): StoreResult<ReviewAuditStore> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `監査履歴を JSON として解析できません: ${(error as Error).message}`,
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '監査履歴のトップレベルは object である必要があります' }
  }
  const envelope = raw as { formatVersion?: unknown; savedAt?: unknown; entries?: unknown }
  if (envelope.formatVersion !== REVIEW_AUDIT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `監査履歴の formatVersion ${JSON.stringify(envelope.formatVersion)} は未対応です（対応: ${REVIEW_AUDIT_FORMAT_VERSION}）`,
    }
  }
  if (typeof envelope.savedAt !== 'string' || !Array.isArray(envelope.entries)) {
    return { ok: false, error: '監査履歴は savedAt（文字列）と entries（配列）が必要です' }
  }
  const entries: AuditEntry[] = []
  for (const [index, item] of envelope.entries.entries()) {
    const parsed = auditEntrySchema.safeParse(item)
    if (!parsed.success) {
      return {
        ok: false,
        error: `監査履歴 entries[${index}] が不正です: ${parsed.error.issues
          .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
          .join('; ')}`,
      }
    }
    entries.push(parsed.data)
  }
  return {
    ok: true,
    value: {
      formatVersion: REVIEW_AUDIT_FORMAT_VERSION,
      savedAt: envelope.savedAt,
      entries,
    },
  }
}

export function serializeReviewAuditStore(store: ReviewAuditStore): string {
  return `${JSON.stringify(
    {
      formatVersion: store.formatVersion,
      savedAt: store.savedAt,
      entries: store.entries,
    },
    null,
    2,
  )}\n`
}

export function emptyReviewAuditStore(): ReviewAuditStore {
  return {
    formatVersion: REVIEW_AUDIT_FORMAT_VERSION,
    savedAt: '',
    entries: [],
  }
}

/**
 * 監査エントリを追記する（追記型。既存エントリは変更・削除しない）。
 * 同一 auditId の重複は追加しない。
 */
export function appendAuditEntries(
  store: ReviewAuditStore,
  entries: readonly AuditEntry[],
): ReviewAuditStore {
  const seen = new Set(store.entries.map((e) => e.auditId))
  const added = entries.filter((e) => {
    if (seen.has(e.auditId)) return false
    seen.add(e.auditId)
    return true
  })
  return { ...store, entries: [...store.entries, ...added] }
}

/** AI 抽出（発見）の監査エントリ（M7-D パイプラインから記録する） */
export function extractionAuditEntry(input: {
  candidate: DiscoveryCandidate
  at: string
  extractionModel: string
}): AuditEntry {
  return makeAuditEntry({
    at: input.at,
    candidateId: input.candidate.candidateId,
    action: 'extracted',
    actor: 'ai-extraction',
    reason: `AI 抽出で候補として保存（モデル: ${input.extractionModel}）`,
    fromStatus: null,
    toStatus: 'unverified',
    pageUrl: input.candidate.sourceUrl,
    fields: input.candidate.evidenceQuotes.map((q) => q.field),
    programId: null,
    details: `発見: ${input.candidate.firstExtractedAt} / 根拠抜粋 ${input.candidate.evidenceQuotes.length} 件`,
  })
}

// ── 状態遷移 ─────────────────────────────────────────────────────

/** 状態の日本語ラベル（表示用） */
export const CANDIDATE_STATUS_LABELS: Record<DiscoveryCandidateStatus, string> = {
  'unverified': '未検証',
  'needs-recheck': '要再確認',
  'approved': '公開承認済み',
  'discarded': '却下済み',
}

/**
 * 許可される状態遷移。
 * - unverified → needs-recheck / approved / discarded
 * - needs-recheck → unverified（再確認で解消）/ approved / discarded
 * - approved → needs-recheck（検証失効）/ discarded（取消）
 * - discarded → unverified（restore のみ。直接の再承認はしない）
 * 同一状態への遷移（重複承認の防止を含む）は許可しない。
 */
export const CANDIDATE_STATUS_TRANSITIONS: Record<
  DiscoveryCandidateStatus,
  readonly DiscoveryCandidateStatus[]
> = {
  'unverified': ['needs-recheck', 'approved', 'discarded'],
  'needs-recheck': ['unverified', 'approved', 'discarded'],
  'approved': ['needs-recheck', 'discarded'],
  'discarded': ['unverified'],
}

export function canTransition(
  from: DiscoveryCandidateStatus,
  to: DiscoveryCandidateStatus,
): boolean {
  return CANDIDATE_STATUS_TRANSITIONS[from].includes(to)
}

/** CLI --status の表記ゆれ（needs_recheck 等）を正規化 */
export function normalizeStatusName(raw: string): DiscoveryCandidateStatus | null {
  const s = raw.trim().replace(/_/g, '-')
  return (DISCOVERY_CANDIDATE_STATUSES as readonly string[]).includes(s)
    ? (s as DiscoveryCandidateStatus)
    : null
}

export type StatusChangeResult =
  | { ok: true; candidate: DiscoveryCandidate; auditEntry: AuditEntry }
  | { ok: false; error: string }

/**
 * 状態遷移を適用する（純関数）。
 * - 候補ID は呼び出し側で厳密照合済みである前提（存在しない ID はここでは扱わない）
 * - 変更理由（reason）と操作者（actor）は必須。変更前後の状態・操作日時を監査に残す。
 * - 不正な遷移は受け付けない（却下済みからの直接承認・重複承認を含む）。
 */
export function applyStatusChange(
  candidate: DiscoveryCandidate,
  input: {
    to: DiscoveryCandidateStatus
    actor: string
    reason: string
    at: string
  },
): StatusChangeResult {
  const actor = input.actor.trim()
  const reason = input.reason.trim()
  if (actor === '') return { ok: false, error: '操作者（--by）を指定してください' }
  if (reason === '') return { ok: false, error: '変更理由（--reason）を指定してください' }
  const from = candidate.status
  if (from === input.to) {
    return {
      ok: false,
      error: `候補 ${candidate.candidateId} はすでに ${CANDIDATE_STATUS_LABELS[from]} です（重複した状態変更はできません）`,
    }
  }
  if (!canTransition(from, input.to)) {
    const hint =
      from === 'discarded' && input.to === 'approved'
        ? '却下済み候補の再承認はできません。まず restore で未検証に戻し、根拠を再確認してから承認してください'
        : `不正な状態遷移です: ${CANDIDATE_STATUS_LABELS[from]} → ${CANDIDATE_STATUS_LABELS[input.to]}（許可: ${CANDIDATE_STATUS_TRANSITIONS[from]
            .map((s) => CANDIDATE_STATUS_LABELS[s])
            .join(' / ')}）`
    return { ok: false, error: hint }
  }
  const next: DiscoveryCandidate = {
    ...candidate,
    status: input.to,
    recheckReason: input.to === 'needs-recheck' ? reason : null,
  }
  const action: AuditAction =
    input.to === 'approved'
      ? 'approved'
      : input.to === 'discarded'
        ? 'discarded'
        : input.to === 'unverified' && from === 'discarded'
          ? 'restored'
          : 'status-changed'
  return {
    ok: true,
    candidate: next,
    auditEntry: makeAuditEntry({
      at: input.at,
      candidateId: candidate.candidateId,
      action,
      actor,
      reason,
      fromStatus: from,
      toStatus: input.to,
      pageUrl: candidate.sourceUrl,
      fields: [],
      programId: null,
      details: null,
    }),
  }
}

// ── 項目単位の根拠確認 ─────────────────────────────────────────

/** 照合用に空白・改行を正規化する */
export function normalizeMatchText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 根拠抜粋がページ本文に実在するか（空白正規化のうえで部分一致） */
export function quoteMatchesPage(quote: string, pageText: string): boolean {
  const q = normalizeMatchText(quote)
  return q !== '' && normalizeMatchText(pageText).includes(q)
}

/**
 * 根拠確認が必要な重要項目のファミリ。
 * 金額・所得制限・対象年齢・申請期限・適用年度・対象地域など。
 */
export const CRITICAL_FIELD_FAMILIES = [
  'amount',
  'eligibility.age',
  'eligibility.household',
  'eligibility.income',
  'application.deadline',
  'regionScope',
  'fiscalYear',
  'validPeriod',
] as const
export type CriticalFieldFamily = (typeof CRITICAL_FIELD_FAMILIES)[number]

export const CRITICAL_FIELD_LABELS: Record<CriticalFieldFamily, string> = {
  amount: '金額',
  'eligibility.age': '対象年齢',
  'eligibility.household': '世帯要件',
  'eligibility.income': '所得要件',
  'application.deadline': '申請期限',
  regionScope: '対象地域',
  fiscalYear: '適用年度',
  validPeriod: '有効期間',
}

/** 確認対象フィールド名 → 重要項目ファミリ（別名も受け付ける。非重要項目は null） */
export function familyOfField(field: string): CriticalFieldFamily | null {
  const f = field.trim()
  if (/^amount(\.|$)/.test(f) || f === '金額') return 'amount'
  if (f === 'eligibility.age' || f === 'eligibility.ageNote' || f === 'age')
    return 'eligibility.age'
  if (f === 'eligibility.household' || f === 'eligibility.householdNote' || f === 'household')
    return 'eligibility.household'
  if (f === 'eligibility.income' || f === 'eligibility.incomeNote' || f === 'income')
    return 'eligibility.income'
  if (f === 'application.deadline' || f === 'application.deadlineNote' || f === 'deadline')
    return 'application.deadline'
  if (f === 'regionScope' || f === 'region') return 'regionScope'
  if (f === 'fiscalYear' || f === 'year') return 'fiscalYear'
  if (f === 'validPeriod' || f === 'period') return 'validPeriod'
  return null
}

/** 候補が持つファミリの値（文字列化。空は除外） */
export function familyValueStrings(
  candidate: DiscoveryCandidate,
  family: CriticalFieldFamily,
): string[] {
  const values: (string | number | null | undefined)[] = []
  switch (family) {
    case 'amount':
      values.push(candidate.amount.value, candidate.amount.unit, candidate.amount.description)
      break
    case 'eligibility.age':
      values.push(candidate.eligibility.ageNote)
      break
    case 'eligibility.household':
      values.push(candidate.eligibility.householdNote)
      break
    case 'eligibility.income':
      values.push(candidate.eligibility.incomeNote)
      break
    case 'application.deadline':
      values.push(candidate.application.deadlineNote)
      break
    case 'regionScope':
      values.push(candidate.regionScope)
      break
    case 'fiscalYear':
      values.push(candidate.fiscalYear)
      break
    case 'validPeriod':
      values.push(candidate.validPeriod)
      break
  }
  return values
    .filter((v): v is string | number => v !== null && v !== undefined && `${v}`.trim() !== '')
    .map((v) => `${v}`.trim())
}

/** ファミリに未確認項目として残っている情報があるか */
export function familyUnconfirmed(
  candidate: DiscoveryCandidate,
  family: CriticalFieldFamily,
): boolean {
  return (candidate.unconfirmedItems ?? []).some((i) => familyOfField(i.field) === family)
}

/** 現行のページ本文ハッシュに対して有効な確認記録（失効分は引き継がない） */
export function currentFieldVerifications(
  candidate: DiscoveryCandidate,
  currentContentHash: string,
): FieldVerification[] {
  return (candidate.fieldVerifications ?? []).filter(
    (v) => v.contentHash === currentContentHash,
  )
}

/**
 * 確認記録 1 件の妥当性を検証する（純関数）。
 * 問題がなければ null、問題があれば理由を返す。
 *
 * - 根拠抜粋が本文に実在しない場合は確認済みとして扱わない
 * - 本文と抽出値が一致しない場合は確認済みとして扱わない
 *   （確認値は抽出値と一致し、数値は根拠抜粋に現れることが必要）
 * - 「（記載なし）」で確認する場合は、候補側に値が残っていないことが条件
 */
export function fieldVerificationError(input: {
  field: string
  value: string
  evidenceQuote: string
  candidate: DiscoveryCandidate
  pageText: string
}): string | null {
  const family = familyOfField(input.field)
  const value = input.value.trim()
  if (value === '') return '確認した値（--value）を指定してください'
  const quote = input.evidenceQuote.trim()
  if (quote === '') return '根拠抜粋（--quote）を指定してください'
  if (!quoteMatchesPage(quote, input.pageText)) {
    return '根拠抜粋がページ本文に見つかりません（抜粋と本文が一致しません）'
  }
  if (family === null) {
    // 重要項目以外は抜粋の実在のみを確認する（監査記録として残す）
    return null
  }
  const values = familyValueStrings(input.candidate, family)
  const label = CRITICAL_FIELD_LABELS[family]
  if (value === VERIFICATION_ABSENT_VALUE) {
    if (values.length > 0) {
      return `${label}: 候補には値（${values.join(' / ')}）が残っています。「（記載なし）」で確認できるのは値が無い場合のみです`
    }
    return null
  }
  if (!values.includes(value)) {
    return `${label}: 確認値「${value}」が候補の抽出値（${values.length > 0 ? values.join(' / ') : 'なし'}）と一致しません（本文と抽出値が一致しているか再確認してください）`
  }
  if (/^[\d,]+$/.test(value)) {
    const compactValue = value.replace(/[,\s]/g, '')
    const compactQuote = normalizeMatchText(quote).replace(/[,\s]/g, '')
    if (!compactQuote.includes(compactValue)) {
      return `${label}: 抽出値「${value}」が根拠抜粋に現れません（本文と抽出値が一致しません）`
    }
  }
  return null
}

export type FieldVerificationResult =
  | { ok: true; candidate: DiscoveryCandidate; auditEntry: AuditEntry }
  | { ok: false; error: string }

/**
 * 項目単位の根拠確認を記録する（純関数）。
 * - reviewedBy は 'manual' 固定（AI の自己申告は受け付けない）
 * - 記録には確認者（actor）とページ本文（pageText）が必要
 * - contentHash は確認時点のページ本文ハッシュ（変更検知に使う）
 */
export function recordFieldVerification(
  candidate: DiscoveryCandidate,
  input: {
    field: string
    value: string
    evidenceQuote: string
    actor: string
    at: string
    pageText: string
    pageContentHash: string
    note?: string | null
  },
): FieldVerificationResult {
  const actor = input.actor.trim()
  if (actor === '') return { ok: false, error: '確認者（--by）を指定してください' }
  const field = input.field.trim()
  if (field === '') return { ok: false, error: '確認対象項目（--field）を指定してください' }
  if (input.pageContentHash.trim() === '') {
    return { ok: false, error: 'ページ本文ハッシュが不明です（確認を記録できません）' }
  }
  const error = fieldVerificationError({
    field,
    value: input.value,
    evidenceQuote: input.evidenceQuote,
    candidate,
    pageText: input.pageText,
  })
  if (error !== null) return { ok: false, error }
  const verification: FieldVerification = {
    field,
    value: input.value.trim(),
    evidenceQuote: input.evidenceQuote.trim(),
    reviewedBy: 'manual',
    reviewedAt: input.at,
    contentHash: input.pageContentHash,
  }
  const next: DiscoveryCandidate = {
    ...candidate,
    fieldVerifications: [...(candidate.fieldVerifications ?? []), verification],
  }
  const note = (input.note ?? '').trim()
  return {
    ok: true,
    candidate: next,
    auditEntry: makeAuditEntry({
      at: input.at,
      candidateId: candidate.candidateId,
      action: 'field-verified',
      actor,
      reason: note !== '' ? note : `${field} の根拠を本文と照合（${verification.value}）`,
      fromStatus: candidate.status,
      toStatus: null,
      pageUrl: candidate.sourceUrl,
      fields: [field],
      programId: null,
      details: `根拠抜粋: ${verification.evidenceQuote.slice(0, 120)}`,
    }),
  }
}

export type EvidenceGateResult = {
  ok: boolean
  /** 不足・不一致の内容（具体的に報告する） */
  failures: string[]
  /** 現行の本文に対して有効な確認記録のフィールド名 */
  verifiedFields: string[]
}

/**
 * 重要項目の根拠確認ゲート（承認の前提。純関数）。
 *
 * 重要項目 8 つすべてについて、現行の本文ハッシュに対する人手確認
 * （根拠抜粋が本文に実在し、抽出値と一致する。または「（記載なし）」の確認）が
 * 必須。揃わない項目は failures で具体的に返す。
 * AI 抽出に成功しただけ・公式 URL と確認できただけでは通らない。
 */
export function evaluateEvidenceGate(
  candidate: DiscoveryCandidate,
  page: { text: string; contentHash: string } | null,
): EvidenceGateResult {
  const failures: string[] = []
  const verifiedFields: string[] = []
  if (page === null) {
    return {
      ok: false,
      failures: ['取得済みページ本文が見つかりません（根拠を照合できません）'],
      verifiedFields,
    }
  }
  const valid = currentFieldVerifications(candidate, page.contentHash).filter((v) => {
    const error = fieldVerificationError({
      field: v.field,
      value: v.value,
      evidenceQuote: v.evidenceQuote,
      candidate,
      pageText: page.text,
    })
    return error === null
  })
  for (const v of valid) verifiedFields.push(v.field)

  for (const family of CRITICAL_FIELD_FAMILIES) {
    const hasValue = familyValueStrings(candidate, family).length > 0
    const unconfirmed = familyUnconfirmed(candidate, family)
    const familyOk = valid.some((v) => familyOfField(v.field) === family)
    if (!familyOk) {
      const label = CRITICAL_FIELD_LABELS[family]
      const detail = hasValue
        ? '抽出値がありますが、本文との照合記録がありません'
        : unconfirmed
          ? '未確認のままです（値を再抽出するか、「（記載なし）」で確認してください）'
          : '確認記録がありません（値または「（記載なし）」の確認が必要です）'
      failures.push(`${label}（${family}）: ${detail}`)
    }
  }
  return { ok: failures.length === 0, failures, verifiedFields }
}

// ── 要再確認の検知 ─────────────────────────────────────────────

/** 識別が必要な再確認の種別 */
export type RecheckKind = 're-verify' | 're-fetch' | 're-extract'

export type RecheckNeed = {
  candidateId: string
  need: RecheckKind
  reason: string
}

/**
 * 候補に対して「根拠の再取得・再抽出・再確認が必要か」を判定する（純関数）。
 * - ページ記録が無い → re-fetch（根拠の再取得）
 * - 抽出が失敗済み → re-extract（再抽出）
 * - 本文ハッシュが抽出時と異なる → re-verify（過去の確認は失効。根拠の再確認）
 * 不要なら null。
 */
export function detectRecheckNeeds(
  candidate: DiscoveryCandidate,
  page: { extractState: string; contentHash: string | null } | null,
): RecheckNeed | null {
  if (page === null) {
    return {
      candidateId: candidate.candidateId,
      need: 're-fetch',
      reason: '取得済みページ記録が見つかりません（根拠の再取得が必要）',
    }
  }
  if (page.extractState === 'failed') {
    return {
      candidateId: candidate.candidateId,
      need: 're-extract',
      reason: '抽出に失敗しています（根拠の再抽出が必要）',
    }
  }
  if (page.contentHash !== candidate.contentHash) {
    return {
      candidateId: candidate.candidateId,
      need: 're-verify',
      reason:
        '本文ハッシュが抽出時から変更されています（過去の確認結果は失効。根拠の再確認が必要）',
    }
  }
  return null
}