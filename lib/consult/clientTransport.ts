/**
 * 相談 API のクライアント送信（M6）
 *
 * - ブラウザから POST /api/consult を呼ぶ唯一の入口
 * - キー類はサーバー側 env のみで扱う（このモジュールにキーは存在しない）
 * - サーバー専用モジュール（provider / iniadAdvisor）は import しない
 * - 失敗時は ConsultSendError（種別つき）を投げ、UI はエラー表示＋再試行
 *
 * 【P9-4】クライアント側の通信タイムアウト
 * - 待ち時間の上限を AbortController（標準機能。外部依存なし）で設ける
 * - 上限値はサーバー側（lib/consult/iniadAdvisor.ts の既定値）で想定される
 *   最大処理時間から導く（根拠のない固定値にしない）:
 *   - 上流 API 1 回の応答待ち上限: 30 秒（CONSULT_TIMEOUT_MS 未設定時の既定）
 *   - 自動リトライ: 初回 + 1 回 = 2 試行、試行間の待機 250 ms
 *     → 応答生成 1 回の最大 ≈ 2 × 30 秒 + 250 ms = 60.25 秒
 *   - JSON 再依頼: 1 回（初回生成 + 再依頼 = 最大 2 生成）
 *     → サーバー側の最大処理時間 ≈ 2 × 60.25 秒 = 120.5 秒
 *   - HTTP 往復・キューイング・応答解析の余裕 30 秒を加えて 150.5 秒
 * - クライアント側タイムアウトは表示待ちの上限にすぎず、サーバー側で既に
 *   受理された処理（上流 API 呼び出しなど）をキャンセルできるとは限らない
 * - タイムアウトによる中断だけを 'timeout' に変換し、成功済みの応答や
 *   通信エラー等の別の失敗を誤ってタイムアウト扱いしない
 */
import {
  ConsultSendError,
  kindForStatus,
  type ConsultErrorKind,
} from './errors'
import type {
  ConsultCitation,
  ConsultReply,
  ConsultReplySource,
  ConsultRequest,
} from './types'
import type { KbProvenance } from '../supports/kb'
import type { ProgramVerification, SupportCategory } from '../types/support'

/** 応答取得関数（useConsultChat から注入差し替え可能） */
export type ConsultResponder = (request: ConsultRequest) => Promise<ConsultReply>

export const CONSULT_API_PATH = '/api/consult'

// ── クライアント待ち時間上限（P9-4。値の根拠はファイル冒頭の説明を参照） ──

/** サーバー側の上流 API 応答待ち上限（ms。lib/consult/iniadAdvisor.ts の既定） */
const SERVER_UPSTREAM_TIMEOUT_MS = 30_000
/** 上流 1 生成あたりの最大試行数（初回 + 自動リトライ 1 回） */
const SERVER_UPSTREAM_ATTEMPTS = 2
/** 自動リトライ間の待機（ms） */
const SERVER_RETRY_DELAY_MS = 250
/** 応答生成の最大回数（初回生成 + JSON 再依頼 1 回） */
const SERVER_GENERATE_ATTEMPTS = 2
/** サーバー側で想定される最大処理時間（ms）: 2 × (2 × 30 秒 + 250 ms) = 120,500 */
const SERVER_MAX_PROCESSING_MS =
  SERVER_GENERATE_ATTEMPTS *
  (SERVER_UPSTREAM_ATTEMPTS * SERVER_UPSTREAM_TIMEOUT_MS + SERVER_RETRY_DELAY_MS)
/** HTTP 往復・キューイング・応答解析の余裕（ms） */
const CLIENT_TRANSPORT_MARGIN_MS = 30_000

/**
 * クライアント側の通信タイムアウト（ms）。
 * サーバー最大処理時間 120.5 秒 + 余裕 30 秒 = 150.5 秒。
 * ※ CONSULT_TIMEOUT_MS 等でサーバー側の既定値を変更する運用では、
 *   この値の見直しが必要（docs/consult-operations-draft.md の確認事項を参照）。
 */
export const CONSULT_CLIENT_TIMEOUT_MS =
  SERVER_MAX_PROCESSING_MS + CLIENT_TRANSPORT_MARGIN_MS

/** fetchConsultReply の上書きオプション（主にテストでの待ち時間短縮用） */
export type ConsultFetchOptions = {
  /** 待ち時間上限（ms）。省略時は CONSULT_CLIENT_TIMEOUT_MS */
  timeoutMs?: number
}

const ERROR_KINDS: readonly ConsultErrorKind[] = [
  'validation',
  'auth',
  'rate_limit',
  'timeout',
  'network',
  'server',
  'invalid_response',
]

const REPLY_SOURCES: readonly ConsultReplySource[] = [
  'mock',
  'mock-fallback',
  'ai',
  'kb',
  'web',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 制度区分の許容値（未知の値は採用せず既存表示に合わせる） */
const SUPPORT_CATEGORIES: readonly string[] = [
  'cash_benefit',
  'fee_reduction',
  'loan',
  'tax',
]

/** 確認状態の許容値（未知の値を確認済みと見なさない） */
const VERIFICATION_STATUSES: readonly string[] = [
  'official-verified',
  'partial',
  'unverified',
]

/**
 * 出典1件の正規化。
 * - 型が壊れた項目は欠落させる（urlVerified は true のときのみ検証済み扱い）
 * - URL を推測補完したり、本文から拾い直したりはしない
 */
function normalizeCitation(value: unknown): ConsultCitation | null {
  if (!isRecord(value)) return null
  if (typeof value.title !== 'string' || typeof value.organization !== 'string') {
    return null
  }
  return {
    title: value.title,
    organization: value.organization,
    url: typeof value.url === 'string' ? value.url : null,
    urlVerified: value.urlVerified === true,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
    reviewOutdated: value.reviewOutdated === true,
    ...(isRecord(value.provenance)
      ? { provenance: value.provenance as KbProvenance }
      : {}),
  }
}

function normalizeCitations(value: unknown): ConsultCitation[] {
  return Array.isArray(value)
    ? value
        .map(normalizeCitation)
        .filter((c): c is ConsultCitation => c !== null)
    : []
}

/** 応答ボディの正規化（壊れた応答は invalid_response として扱う） */
export function normalizeReplyBody(body: unknown): ConsultReply {
  if (!isRecord(body) || typeof body.text !== 'string') {
    throw new ConsultSendError('invalid_response')
  }
  const isMock = body.isMock === true
  const sourceType: ConsultReplySource = REPLY_SOURCES.includes(
    body.sourceType as ConsultReplySource,
  )
    ? (body.sourceType as ConsultReplySource)
    : isMock
      ? 'mock'
      : 'ai'
  const relatedPrograms = Array.isArray(body.relatedPrograms)
    ? body.relatedPrograms
        .filter(isRecord)
        .map((p) => ({
          id: typeof p.id === 'string' ? p.id : '',
          name: typeof p.name === 'string' ? p.name : '',
          sourceType: p.sourceType === 'verified' ? ('verified' as const) : ('mock' as const),
          note: typeof p.note === 'string' ? p.note : '',
          // KB 由来の確認状態・区分・確認日・出典（型が壊れている/未知の値は採用しない）
          ...(typeof p.category === 'string' &&
          SUPPORT_CATEGORIES.includes(p.category)
            ? { category: p.category as SupportCategory }
            : {}),
          ...(typeof p.verification === 'string' &&
          VERIFICATION_STATUSES.includes(p.verification)
            ? { verification: p.verification as ProgramVerification['status'] }
            : {}),
          ...(typeof p.checkedAt === 'string' || p.checkedAt === null
            ? { checkedAt: p.checkedAt }
            : {}),
          ...(Array.isArray(p.sources)
            ? { sources: normalizeCitations(p.sources) }
            : {}),
        }))
        .filter((p) => p.id.length > 0 && p.name.length > 0)
    : []
  return {
    text: body.text,
    isMock,
    hasUnverified: body.hasUnverified === true,
    relatedPrograms,
    unsupported: body.unsupported === true,
    sourceType,
    clarificationQuestions: Array.isArray(body.clarificationQuestions)
      ? body.clarificationQuestions.filter((q): q is string => typeof q === 'string')
      : [],
    checkedAt: typeof body.checkedAt === 'string' ? body.checkedAt : null,
    // 出典（KB由来）は UI 表示まで通す。壊れた要素は落とす
    citations: normalizeCitations(body.citations),
  }
}

/** Abort による中断かどうか（名前での判定。エラー本文・message は参照しない） */
function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** POST /api/consult（失敗時は ConsultSendError） */
export async function fetchConsultReply(
  request: ConsultRequest,
  options?: ConsultFetchOptions,
): Promise<ConsultReply> {
  const timeoutMs = options?.timeoutMs ?? CONSULT_CLIENT_TIMEOUT_MS
  const controller = new AbortController()
  /** タイムアウト起因の中断か（誤分類防止。中断以外の失敗には立てない） */
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let res: Response
    try {
      res = await fetch(CONSULT_API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (error) {
      // タイムアウトによる中断のみ timeout。それ以外の通信失敗は network
      if (timedOut && isAbortLike(error)) {
        throw new ConsultSendError('timeout')
      }
      throw new ConsultSendError('network')
    }

    if (!res.ok) {
      let kind: ConsultErrorKind = kindForStatus(res.status)
      let message: string | undefined
      try {
        const body = await res.json()
        if (isRecord(body) && isRecord(body.error)) {
          if (
            typeof body.error.kind === 'string' &&
            ERROR_KINDS.includes(body.error.kind as ConsultErrorKind)
          ) {
            kind = body.error.kind as ConsultErrorKind
          }
          if (typeof body.error.message === 'string') {
            message = body.error.message
          }
        }
      } catch {
        // ボディが読めない場合はステータスからの推定にフォールバック
      }
      throw new ConsultSendError(kind, message)
    }

    try {
      return normalizeReplyBody(await res.json())
    } catch (error) {
      if (error instanceof ConsultSendError) throw error
      // 解析前に待ち時間上限へ達した場合のみ timeout とし、
      // 壊れた応答などを誤ってタイムアウトにしない
      if (timedOut && isAbortLike(error)) {
        throw new ConsultSendError('timeout')
      }
      throw new ConsultSendError('invalid_response')
    }
  } finally {
    // 応答確定後は発火させない（成功後にタイムアウト扱いされるのを防ぐ）
    clearTimeout(timer)
  }
}