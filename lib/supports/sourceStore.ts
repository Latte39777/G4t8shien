/**
 * 公式情報の台帳・取得ログの永続化（M6-F 安定化）
 *
 * 【責務】
 * - URL 台帳（lib/supports/sourceLedger.ts）と取得ログ
 *   （lib/supports/sourceFetch.ts の RetrievalRecord）の保存・復元を、
 *   純関数として提供する。プロセス終了後も台帳・照合記録を保持し、
 *   次回起動時に復元できるようにする。
 *
 * 【復元のマージ規則（重要）】
 * - 識別情報（URL・名称・組織・対象制度・登録メモ・取得ポリシー）は
 *   コード側の最新定義（buildInitialLedger）を優先する。
 * - 状態（到達・取得・照合・provenance 等の実績）はディスク側の記録を優先する。
 * - コード側に無い URL（実行時に登録されたもの）は保存分をそのまま追加する。
 *
 * 【エラー処理】
 * - JSON 解析・スキーマ検証の失敗は例外ではなく結果（StoreResult）で返す。
 *   呼び出し側は壊れた保存物を上書きせず、内容を保全したまま中断する。
 *
 * 【外部通信なし・ファイル I/O なし】
 *   このモジュールは serialize/parse/merge の純関数のみ。
 *   ファイルの読み書きは scripts/retrieve-official-sources.ts が行う。
 */
import { z } from 'zod'
import {
  CONTENT_STATES,
  LEDGER_PROVENANCE_REGISTERED,
  LEDGER_PROVENANCE_RETRIEVAL,
  LEDGER_PROVENANCE_REVIEW,
  URL_STATES,
  buildInitialLedger,
  type LedgerEntry,
} from './sourceLedger'
import { FETCH_FAILURE_CODES, type RetrievalRecord } from './sourceFetch'

/** 保存形式のバージョン（形式変更時に上げる） */
export const LEDGER_SNAPSHOT_VERSION = 1
export const RETRIEVAL_LOG_VERSION = 1

/** 保存・読込の結果（解析失敗は例外ではなく結果で返す） */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 台帳スナップショット（data/source-ledger.json） */
export type LedgerSnapshot = {
  version: number
  savedAt: string
  entries: LedgerEntry[]
}

/** 取得ログ（data/source-retrievals.json） */
export type RetrievalLog = {
  version: number
  savedAt: string
  records: RetrievalRecord[]
}

// ── zod スキーマ（読み込んだ JSON の検証） ─────────────────────────

const provenanceSchema = z.object({
  registered: z.enum(LEDGER_PROVENANCE_REGISTERED),
  retrieval: z.enum(LEDGER_PROVENANCE_RETRIEVAL).nullable(),
  review: z.enum(LEDGER_PROVENANCE_REVIEW).nullable(),
})

const contentReviewSchema = z.object({
  reviewedAt: z.string().nullable(),
  reviewedFields: z.array(z.string()),
  note: z.string().nullable(),
  reviewer: z.enum(['manual']).nullable(),
})

const fetchResultSchema = z.union([z.literal('ok'), z.enum(FETCH_FAILURE_CODES)])

const ledgerEntrySchema: z.ZodType<LedgerEntry> = z.object({
  urlId: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  organization: z.string().min(1),
  programIds: z.array(z.string()),
  registeredAt: z.string().min(1),
  registrationNote: z.string(),
  urlState: z.enum(URL_STATES),
  reachableAt: z.string().nullable(),
  officialConfirmedAt: z.string().nullable(),
  officialConfirmNote: z.string().nullable(),
  contentRetrievedAt: z.string().nullable(),
  contentState: z.enum(CONTENT_STATES),
  review: contentReviewSchema,
  provenance: provenanceSchema,
  lastFetchResult: fetchResultSchema.nullable(),
  lastFetchFailureReason: z.string().nullable(),
  excerpt: z.string().nullable(),
  retrievalPolicy: z.object({ maxAgeDays: z.number(), note: z.string() }),
  robots: z.object({ checkedAt: z.string().nullable(), note: z.string() }),
  terms: z.object({ acknowledgedAt: z.string().nullable(), note: z.string() }),
})

const retrievalRecordSchema: z.ZodType<RetrievalRecord> = z.object({
  url: z.string().min(1),
  finalUrl: z.string().nullable(),
  title: z.string().nullable(),
  retrievedAt: z.string().min(1),
  result: fetchResultSchema,
  failureReason: z.string().nullable(),
  httpStatus: z.number().nullable(),
  contentType: z.string().nullable(),
  byteSize: z.number().nullable(),
  robotsCheckedAt: z.string().nullable(),
})

function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' / ')
}

// ── 台帳スナップショット ─────────────────────────────────────────

/** 台帳スナップショットを JSON 文字列にする（純関数） */
export function serializeLedgerSnapshot(
  entries: readonly LedgerEntry[],
  savedAt: string,
): string {
  const snapshot: LedgerSnapshot = {
    version: LEDGER_SNAPSHOT_VERSION,
    savedAt,
    entries: [...entries],
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

/** 台帳スナップショットの JSON を検証して読む（純関数。失敗は結果で返す） */
export function parseLedgerSnapshot(text: string): StoreResult<LedgerSnapshot> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: `台帳スナップショットの JSON を解析できませんでした: ${(err as Error).message}`,
    }
  }
  const parsed = z
    .object({
      version: z.literal(LEDGER_SNAPSHOT_VERSION),
      savedAt: z.string().min(1),
      entries: z.array(ledgerEntrySchema),
    })
    .safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: `台帳スナップショットの形式が不正です（version ${String((raw as { version?: unknown } | null)?.version ?? '不明')}）: ${formatIssues(parsed.error.issues)}`,
    }
  }
  return { ok: true, value: parsed.data }
}

/**
 * 保存済みの台帳状態を初期台帳にマージして復元する（純関数）。
 * - 識別情報はコード側（base）の最新定義を優先
 * - 状態（実績）はディスク側（persisted）の記録を優先
 * - コード側に無い URL は保存分をそのまま追加
 */
export function mergeLedgerEntries(
  base: readonly LedgerEntry[],
  persisted: readonly LedgerEntry[],
): LedgerEntry[] {
  const merged: LedgerEntry[] = base.map((b) => {
    const p = persisted.find((e) => e.url === b.url)
    if (p === undefined) return b
    return {
      ...p,
      // 識別情報はコード側の最新定義を優先（名称改称等をスナップショットに固定しない）
      urlId: b.urlId,
      url: b.url,
      title: b.title,
      organization: b.organization,
      programIds: [...b.programIds],
      registrationNote: b.registrationNote,
      retrievalPolicy: { ...b.retrievalPolicy },
      // 登録の由来もコード側に合わせる（実行時登録 URL のみ保存分を維持）
      provenance: { ...p.provenance, registered: b.provenance.registered },
    }
  })
  const baseUrls = new Set(base.map((e) => e.url))
  for (const p of persisted) {
    if (!baseUrls.has(p.url)) merged.push(p)
  }
  return merged
}

/** 台帳スナップショットから台帳を復元する（純関数） */
export function restoreLedgerEntries(snapshot: LedgerSnapshot): LedgerEntry[] {
  return mergeLedgerEntries(buildInitialLedger(), snapshot.entries)
}

// ── 取得ログ ───────────────────────────────────────────────────

/** 取得ログを JSON 文字列にする（純関数） */
export function serializeRetrievalLog(log: RetrievalLog): string {
  return `${JSON.stringify(log, null, 2)}\n`
}

/** 取得ログの JSON を検証して読む（純関数。壊れた JSON は失敗として返す） */
export function parseRetrievalLog(text: string): StoreResult<RetrievalLog> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: `取得ログの JSON を解析できませんでした: ${(err as Error).message}`,
    }
  }
  const parsed = z
    .object({
      version: z.literal(RETRIEVAL_LOG_VERSION).optional(),
      savedAt: z.string().optional(),
      records: z.array(retrievalRecordSchema),
    })
    .safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: `取得ログの形式が不正です: ${formatIssues(parsed.error.issues)}`,
    }
  }
  return {
    ok: true,
    value: {
      version: parsed.data.version ?? RETRIEVAL_LOG_VERSION,
      savedAt: parsed.data.savedAt ?? '',
      records: parsed.data.records,
    },
  }
}

/** 取得ログに 1 件追加する（純関数。既存記録は保持する） */
export function appendRetrievalRecord(
  log: RetrievalLog,
  record: RetrievalRecord,
  savedAt: string,
): RetrievalLog {
  return {
    version: RETRIEVAL_LOG_VERSION,
    savedAt,
    records: [...log.records, record],
  }
}