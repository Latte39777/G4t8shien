/**
 * 公式情報の URL 台帳（M6-F）
 *
 * 【責務】
 * - 公式情報を取得する URL 候補を登録し、取得対象・実行タイミングを管理する
 *   （Web 全体の自動巡回はしない。この台帳に登録された URL だけが取得対象）。
 * - 許可ホストは「実際に公式性を確認した URL」から導出する。
 *   未確認の区公式ドメイン等を推測して登録しない。
 *
 * 【URL の確認と制度内容の確認の分離（重要）】
 * 1. URL 候補として登録済み   … registeredAt
 * 2. URL にアクセスできた     … reachableAt / urlState 'reachable'
 * 3. 公式の情報源と確認済み   … officialConfirmedAt（人手確認。urlState 'official-confirmed'）
 * 4. ページ本文を取得済み     … contentRetrievedAt（機械的な取得日時）
 * 5. 制度内容の確認が必要     … contentState 'needs-review'
 * 6. 人手で制度内容を照合済み … contentState 'reviewed' + review.reviewedAt / reviewedFields
 *
 * - URL にアクセスできただけ（2・4）で、ページ内の金額や法令名を確認済み（6）に
 *   しない。照合済みにするのは recordManualContentReview（人手の照合記録）のみで、
 *   AI の自己申告で確認済みにする経路は持たない。
 * - 取得日時（contentRetrievedAt）と人手確認日時（review.reviewedAt）は別に保持し、
 *   ページを再取得しただけでは金額・条件が再確認済みにならない
 *   （isReviewOutdated で「再確認が必要」を判定する）。
 * - 各状態には provenance（実績の由来）を保持し、「M6-C 調査ログからの転記」と
 *   「実運用での取得・人手照合の実績」を混同しない（LedgerProvenance）。
 *   保存・復元は lib/supports/sourceStore.ts（スナップショット）で行う。
 *
 * 【外部通信なし】このモジュールは状態管理と純関数のみ。fetch は行わない
 * （取得は lib/supports/sourceFetch.ts と scripts/retrieve-official-sources.ts）。
 */
import {
  OFFICIAL_RESEARCH_RECORDS,
  RESEARCH_LOG,
} from './officialPrograms'
import type { FetchFailureCode } from './sourceFetch'

/** URL 側の状態（上記 1〜3。下位から上位へのみ遷移する） */
export const URL_STATES = ['candidate-registered', 'reachable', 'official-confirmed'] as const
export type UrlState = (typeof URL_STATES)[number]

/** 内容側の状態（上記 4〜6。URL 状態とは独立に管理する） */
export const CONTENT_STATES = ['no-content', 'needs-review', 'reviewed'] as const
export type ContentState = (typeof CONTENT_STATES)[number]

/** 人手の照合記録（reviewedFields は照合できた項目のみ列挙） */
export type ContentReview = {
  /** 人手で制度内容を照合した日（YYYY-MM-DD。取得日時とは別） */
  reviewedAt: string | null
  /** 人手で照合できた項目（例: 'amount.value'）。照合できない項目は含めない */
  reviewedFields: string[]
  note: string | null
  /** 照合者区分。AI の自己申告では照合済みにできない */
  reviewer: 'manual' | null
}

/**
 * 台帳記録の provenance（実績の由来）。
 * 「M6-C 調査ログからの転記」と「実運用での取得・人手照合の実績」を
 * 混同しないために、状態を何によって記録したかを分けて保持する。
 */
export const LEDGER_PROVENANCE_REGISTERED = [
  'research-log-transcribed',
  'user-registered',
] as const
export type LedgerProvenanceRegistered = (typeof LEDGER_PROVENANCE_REGISTERED)[number]

export const LEDGER_PROVENANCE_RETRIEVAL = [
  'research-log-transcribed',
  'fetch-run',
] as const
export type LedgerProvenanceRetrieval = (typeof LEDGER_PROVENANCE_RETRIEVAL)[number]

export const LEDGER_PROVENANCE_REVIEW = [
  'research-log-transcribed',
  'manual-review',
] as const
export type LedgerProvenanceReview = (typeof LEDGER_PROVENANCE_REVIEW)[number]

export type LedgerProvenance = {
  /** URL 登録の由来 */
  registered: LedgerProvenanceRegistered
  /** 到達・本文取得状態の由来（null = 未取得） */
  retrieval: LedgerProvenanceRetrieval | null
  /** 内容照合の由来（null = 未照合） */
  review: LedgerProvenanceReview | null
}

export type LedgerEntry = {
  /** 台帳内の ID */
  urlId: string
  url: string
  title: string
  organization: string
  /** この URL を根拠とする制度（ナレッジベースの programId との対応） */
  programIds: string[]
  /** 1. 登録日（YYYY-MM-DD） */
  registeredAt: string
  registrationNote: string
  /** URL 側の状態 */
  urlState: UrlState
  /** 2. アクセスできた日時（ISO 8601） */
  reachableAt: string | null
  /** 3. 公式情報源と人手確認した日（YYYY-MM-DD） */
  officialConfirmedAt: string | null
  officialConfirmNote: string | null
  /** 4. ページ本文を取得した日時（ISO 8601。機械的な取得） */
  contentRetrievedAt: string | null
  /** 5・6. 内容の確認状態 */
  contentState: ContentState
  review: ContentReview
  /** 状態の由来（転記・実取得・人手照合の区別。実績の混同防止） */
  provenance: LedgerProvenance
  /** 直近の取得結果（失敗理由を含む） */
  lastFetchResult: 'ok' | FetchFailureCode | null
  lastFetchFailureReason: string | null
  /** 取得本文からの必要最小限の引用 */
  excerpt: string | null
  /** 取得の実行タイミング管理（自動巡回しない） */
  retrievalPolicy: {
    /** この日数を超えていたら再取得が必要と判定 */
    maxAgeDays: number
    note: string
  }
  robots: { checkedAt: string | null; note: string }
  terms: { acknowledgedAt: string | null; note: string }
}

/**
 * URL の確認状態と制度内容の確認状態が分離されているか（混同検出用）。
 *
 * reviewedAt は日付粒度（YYYY-MM-DD）のため、照合はその日（+09:00 の一日）の
 * 終端までに実施されたものとして扱う。同日中の「取得→人手照合」を要再確認に
 * しない一方、照合日より後の日付での再取得（= 照合が古い）は要再確認にする。
 * 同日中に照合より後に再取得があった場合は日付粒度では判別できないため、
 * 運用は取得→照合の順で記録する（残余リスクは設計書 §4 に明記）。
 */
export function isReviewOutdated(entry: LedgerEntry): boolean {
  if (entry.review.reviewedAt === null || entry.contentRetrievedAt === null) return false
  const reviewed = Date.parse(`${entry.review.reviewedAt}T23:59:59+09:00`)
  const retrieved = Date.parse(entry.contentRetrievedAt)
  return retrieved > reviewed
}

/** 再確認が必要か（未取得・要確認・再取得後の照合ずれ） */
export function needsContentRecheck(entry: LedgerEntry): boolean {
  if (entry.contentRetrievedAt === null) return true
  if (entry.contentState !== 'reviewed') return true
  return isReviewOutdated(entry)
}

/** 1・2. URL 候補として登録する（公式性は未確認。取得可能ホストには含めない） */
export function registerUrlCandidate(input: {
  url: string
  title: string
  organization: string
  programIds: readonly string[]
  registeredAt: string
  note?: string
}): LedgerEntry {
  return {
    urlId: `src-${input.url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '').toLowerCase()}`,
    url: input.url,
    title: input.title,
    organization: input.organization,
    programIds: [...input.programIds],
    registeredAt: input.registeredAt,
    registrationNote: input.note ?? 'URL 候補として登録（公式性は未確認）',
    urlState: 'candidate-registered',
    reachableAt: null,
    officialConfirmedAt: null,
    officialConfirmNote: null,
    contentRetrievedAt: null,
    contentState: 'no-content',
    review: { reviewedAt: null, reviewedFields: [], note: null, reviewer: null },
    provenance: { registered: 'user-registered', retrieval: null, review: null },
    lastFetchResult: null,
    lastFetchFailureReason: null,
    excerpt: null,
    retrievalPolicy: {
      maxAgeDays: 30,
      note: '人手で実行する取得のみ。自動巡回はしない',
    },
    robots: { checkedAt: null, note: '未確認（取得時に robots.txt を確認する）' },
    terms: { acknowledgedAt: null, note: '未確認（サイトの利用条件は人手で要確認）' },
  }
}

/** 2. URL にアクセスできた（URL 側のみ更新。内容の確認状態には触れない） */
export function markUrlReachable(entry: LedgerEntry, reachableAt: string): LedgerEntry {
  if (entry.urlState !== 'candidate-registered') return entry
  return {
    ...entry,
    urlState: 'reachable',
    reachableAt,
    // 到達は実際のアクセスによる実績（転記ではない）
    provenance: { ...entry.provenance, retrieval: 'fetch-run' },
  }
}

/** 3. 公式の情報源であることを人手で確認（URL 側のみ。到達記録が無いと確認できない） */
export function markOfficialConfirmed(
  entry: LedgerEntry,
  args: { confirmedAt: string; note: string },
): LedgerEntry {
  if (entry.reachableAt === null) {
    throw new Error('URL の到達記録（reachableAt）が無い URL を公式確認済みにできません')
  }
  return {
    ...entry,
    urlState: 'official-confirmed',
    officialConfirmedAt: args.confirmedAt,
    officialConfirmNote: args.note,
  }
}

/**
 * 4・5. 取得結果の記録（機械的な取得）。
 * - 成功: contentRetrievedAt を更新し、まだ人手照合していなければ 'needs-review' に
 *   する。既に 'reviewed' の場合は review（照合済み項目）を消さず、
 *   isReviewOutdated で「再取得後のため要再確認」を判定できるようにする。
 *   （ページを再取得しただけでは金額・条件が再確認済みにならない）
 * - 失敗: 取得結果・理由のみ記録し、以前の取得記録・照合済みデータは上書きしない
 *   （未確認状態の維持）。
 */
export function markContentRetrieved(
  entry: LedgerEntry,
  args: {
    retrievedAt: string
    result: 'ok' | FetchFailureCode
    failureReason?: string | null
    excerpt?: string | null
  },
): LedgerEntry {
  if (args.result !== 'ok') {
    return {
      ...entry,
      lastFetchResult: args.result,
      lastFetchFailureReason: args.failureReason ?? '取得に失敗しました',
    }
  }
  return {
    ...entry,
    contentRetrievedAt: args.retrievedAt,
    contentState: entry.contentState === 'reviewed' ? 'reviewed' : 'needs-review',
    lastFetchResult: 'ok',
    lastFetchFailureReason: null,
    ...(args.excerpt !== undefined && args.excerpt !== null ? { excerpt: args.excerpt } : {}),
    // 取得は実運用の取得による実績（転記ではない）
    provenance: { ...entry.provenance, retrieval: 'fetch-run' },
  }
}

/**
 * 6. 人手で制度内容（金額・対象条件等）を照合した記録。
 * - この関数だけが照合済み（reviewed）にできる。AI の自己申告では照合済みに
 *   できない（引数 reviewer は 'manual' 固定。'ai' 等はエラー）。
 * - 照合できた項目（reviewedFields）は実在の確認に成功した項目のみ列挙する。
 */
export function recordManualContentReview(
  entry: LedgerEntry,
  args: {
    reviewedAt: string
    fields: readonly string[]
    note: string
    reviewer: 'manual'
  },
): LedgerEntry {
  if (args.reviewer !== 'manual') {
    throw new Error('AI の自己申告で内容を照合済みにすることはできません')
  }
  if (entry.contentRetrievedAt === null) {
    throw new Error('本文取得の記録が無い内容を照合済みにできません')
  }
  if (args.fields.length === 0) {
    throw new Error('照合できた項目（fields）が空です')
  }
  return {
    ...entry,
    contentState: 'reviewed',
    review: {
      reviewedAt: args.reviewedAt,
      reviewedFields: [...args.fields],
      note: args.note,
      reviewer: 'manual',
    },
    // 照合は実運用の人手照合による実績（転記ではない）
    provenance: { ...entry.provenance, review: 'manual-review' },
  }
}

export type LedgerStore = {
  list(): LedgerEntry[]
  get(urlId: string): LedgerEntry | null
  getByUrl(url: string): LedgerEntry | null
  /** 1. URL 候補の登録（公式性未確認。許可ホストには含めない） */
  registerUrlCandidate(input: {
    url: string
    title: string
    organization: string
    programIds: readonly string[]
    registeredAt: string
    note?: string
  }): LedgerEntry
  /** 状態遷移の適用（純関数の遷移関数を渡す） */
  update(urlId: string, updater: (entry: LedgerEntry) => LedgerEntry): LedgerEntry
  /** 取得を許可する公式ホスト名（公式確認済み URL のホストのみ。完全一致で使う） */
  allowedHosts(): string[]
}

export function createLedgerStore(initial: readonly LedgerEntry[]): LedgerStore {
  const entries: LedgerEntry[] = [...initial]
  return {
    list: () => [...entries],
    get: (urlId) => entries.find((e) => e.urlId === urlId) ?? null,
    getByUrl: (url) => entries.find((e) => e.url === url) ?? null,
    registerUrlCandidate(input) {
      const existing = entries.find((e) => e.url === input.url)
      if (existing !== undefined) return existing
      const entry = registerUrlCandidate(input)
      entries.push(entry)
      return entry
    },
    update(urlId, updater) {
      const idx = entries.findIndex((e) => e.urlId === urlId)
      if (idx < 0) throw new Error(`台帳に無い URL ID です: ${urlId}`)
      const next = updater(entries[idx])
      entries[idx] = next
      return next
    },
    allowedHosts() {
      const hosts = new Set<string>()
      for (const e of entries) {
        if (e.urlState === 'official-confirmed') {
          hosts.add(new URL(e.url).hostname.toLowerCase())
        }
      }
      return [...hosts]
    },
  }
}

/**
 * 初期台帳（M6-C 調査ログから構築）。
 * - RESEARCH_LOG で実際に取得・照合できた公式 URL だけを登録する
 *   （未確認の URL・推測ドメインは登録しない）。
 * - 公式確認（3）と内容の照合済み項目（6）は、調査ログ・照合記録に残っている
 *   範囲のみ転記する（ログに無い項目は照合済みにしない）。
 */
export function buildInitialLedger(): LedgerEntry[] {
  return RESEARCH_LOG.filter((log) => log.verified).map((log) => {
    const reviewedFields = new Set<string>()
    const programIds: string[] = []
    for (const record of OFFICIAL_RESEARCH_RECORDS) {
      const matched = record.candidate.sources.some((s) => s.url === log.url)
      if (!matched) continue
      programIds.push(record.programId)
      for (const field of record.verification.verifiedFields) reviewedFields.add(field)
    }
    return {
      ...registerUrlCandidate({
        url: log.url,
        title: `${log.organization}の公式ページ`,
        organization: log.organization,
        programIds,
        registeredAt: log.checkedAt,
        note: `M6-C 調査ログ（${log.checkedAt}）から転記`,
      }),
      // 2・3. 調査ログで取得・照合済みの URL（人手確認済み）
      urlState: 'official-confirmed' as const,
      reachableAt: log.retrievedAt,
      officialConfirmedAt: log.checkedAt,
      officialConfirmNote: log.note,
      // 4. 取得日時（機械的）
      contentRetrievedAt: log.retrievedAt,
      // 6. 人手で照合済み（照合できた項目のみ）
      contentState: 'reviewed' as const,
      review: {
        reviewedAt: log.checkedAt,
        reviewedFields: [...reviewedFields],
        note: log.note,
        reviewer: 'manual' as const,
      },
      lastFetchResult: 'ok' as const,
      lastFetchFailureReason: null,
      excerpt: log.matchedContent,
      // 状態はすべて調査ログからの転記（実運用の取得・照合実績ではない）
      provenance: {
        registered: 'research-log-transcribed' as const,
        retrieval: 'research-log-transcribed' as const,
        review: 'research-log-transcribed' as const,
      },
    }
  })
}
