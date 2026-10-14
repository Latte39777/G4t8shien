/**
 * 相談 API のクライアント送信（M6）
 *
 * - ブラウザから POST /api/consult を呼ぶ唯一の入口
 * - キー類はサーバー側 env のみで扱う（このモジュールにキーは存在しない）
 * - サーバー専用モジュール（provider / iniadAdvisor）は import しない
 * - 失敗時は ConsultSendError（種別つき）を投げ、UI はエラー表示＋再試行
 */
import {
  ConsultSendError,
  kindForStatus,
  type ConsultErrorKind,
} from './errors'
import type { ConsultReply, ConsultReplySource, ConsultRequest } from './types'

/** 応答取得関数（useConsultChat から注入差し替え可能） */
export type ConsultResponder = (request: ConsultRequest) => Promise<ConsultReply>

export const CONSULT_API_PATH = '/api/consult'

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
  }
}

/** POST /api/consult（失敗時は ConsultSendError） */
export async function fetchConsultReply(
  request: ConsultRequest,
): Promise<ConsultReply> {
  let res: Response
  try {
    res = await fetch(CONSULT_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
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
    throw new ConsultSendError('invalid_response')
  }
}