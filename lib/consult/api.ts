/**
 * POST /api/consult のリクエスト処理（M6 フェーズ1 / M6-G P2）
 *
 * - Route Handler（app/api/consult/route.ts）はこの関数に処理を委ねる
 *   （テストでは resolveProvider / rateLimiter / env を注入して検証する）
 * - 入力検証（zod）→ レート制限（Live 時のみ）→ プロバイダ応答
 * - 通信障害は原則エラー表示＋再試行。モックへの自動フォールバックは
 *   CONSULT_FALLBACK_TO_MOCK=1 のときのみ（既定 0）。フォールバック時は
 *   必ず「モック応答に切り替えました」と障害原因を明示する
 * - 【M6-G P2】応答生成後、lib/consult/kbContext.ts の純関数で公式情報KB
 *   （lib/supports/kb.ts）から決定論的に出典・確認状態を付与する。
 *   KB 情報はサーバー側の既存 KB から取得し、クライアント入力や AI 生成文
 *   の URL・金額・制度名は根拠として採用しない（外部通信なし）
 */
import { z } from 'zod'
import {
  enrichReplyWithKb,
  resolveKbConsultContext,
  type KbConsultContext,
  type KbConsultContextInput,
} from './kbContext'
import {
  ConsultSendError,
  reasonLabelForKind,
  safeErrorInfo,
  statusForKind,
  userMessageForKind,
  type ConsultErrorKind,
} from './errors'
import { buildMockReply } from './mockAdvisor'
import { isLiveConsultEnabled } from './provider'
import {
  getDefaultRateLimiter,
  resolveClientKey,
  type RateLimiter,
} from './rateLimit'
import type { ConsultProvider, ConsultReply, ConsultRequest } from './types'

export type ConsultApiDeps = {
  /** プロバイダ解決（既定: getConsultProvider。テストでは偽プロバイダを注入） */
  resolveProvider: () => ConsultProvider
  env?: Record<string, string | undefined>
  /** レートリミッタ（未指定ならメモリ既定実装） */
  rateLimiter?: RateLimiter
  now?: () => number
  logger?: Pick<Console, 'warn' | 'error'> & Partial<Pick<Console, 'info'>>
  /**
   * KB 文脈の解決（M6-G）。既定: resolveKbConsultContext（既存 KB から解決）。
   * テストで KB 不能時のフォールバックを検証するために差し替え可能
   */
  resolveKbContext?: (input: KbConsultContextInput) => KbConsultContext
}

/** 質問の最大文字数（env で変更可・1〜1000 を想定） */
export function maxQuestionChars(env: Record<string, string | undefined>): number {
  const n = Number.parseInt(env.CONSULT_MAX_QUESTION_CHARS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 1000
}

const relatedProgramSchema = z.object({
  id: z.string().max(100),
  name: z.string().max(200),
  sourceType: z.enum(['mock', 'verified']),
  note: z.string().max(500),
})

const chatMessageSchema = z.object({
  id: z.string().max(100),
  role: z.enum(['user', 'assistant']),
  text: z.string().max(2000),
  isMock: z.boolean().optional(),
  hasUnverified: z.boolean().optional(),
  relatedPrograms: z.array(relatedProgramSchema).max(20).optional(),
  sourceType: z.enum(['mock', 'mock-fallback', 'ai', 'kb', 'web']).optional(),
})

const programSchema = z.object({
  id: z.string().max(100),
  name: z.string().max(200),
  summary: z.string().max(1000),
  amountDescription: z.string().max(500),
  where: z.string().max(200).nullable(),
  deadlineNote: z.string().max(200).nullable(),
  missingInformation: z.array(z.string().max(200)).max(20),
  mock: z.boolean(),
})

const userContextSchema = z.object({
  childCount: z.number().int().min(0).max(30),
  hasAnnualIncome: z.boolean(),
  usedProgramIds: z.array(z.string().max(100)).max(50),
})

function buildConsultRequestSchema(env: Record<string, string | undefined>) {
  return z.object({
    message: z.string().min(1).max(maxQuestionChars(env)),
    history: z.array(chatMessageSchema).max(20).optional(),
    program: programSchema.nullable().optional(),
    userContext: userContextSchema.nullable().optional(),
  })
}

export type ParseResult =
  | { ok: true; value: ConsultRequest }
  | { ok: false; message: string }

/** リクエストボディの検証（不正ならユーザー向けメッセージ付きで拒否） */
export function parseConsultRequest(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): ParseResult {
  const result = buildConsultRequestSchema(env).safeParse(body)
  if (result.success) {
    return {
      ok: true,
      value: {
        message: result.data.message,
        history: (result.data.history ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          isMock: m.isMock ?? false,
          hasUnverified: m.hasUnverified ?? false,
          relatedPrograms: (m.relatedPrograms ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            sourceType: p.sourceType,
            note: p.note,
          })),
          sourceType: m.sourceType,
        })),
        program: result.data.program ?? null,
        userContext: result.data.userContext ?? null,
      },
    }
  }
  const issue = result.error.issues[0]
  const path = issue?.path?.join('.') ?? ''
  const limit = maxQuestionChars(env)
  const message =
    path === 'message' && issue?.code === 'too_big'
      ? `質問が長すぎます（上限 ${limit} 文字）。`
      : '質問・会話データの形式が不正です。'
  return { ok: false, message }
}

/** モックフォールバックの有無（既定 0 = エラー表示＋再試行） */
export function isFallbackToMockEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env.CONSULT_FALLBACK_TO_MOCK === '1'
}

/** Retry-After 秒数の正規化（正の整数。判定値が無い/不正な場合は既定 30 秒） */
function normalizeRetryAfterSec(retryAfterSec: number | undefined): number {
  if (retryAfterSec === undefined || !Number.isFinite(retryAfterSec)) {
    return 30
  }
  return Math.max(1, Math.ceil(retryAfterSec))
}

function errorResponse(
  kind: ConsultErrorKind,
  message?: string,
  retryAfterSec?: number,
): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (kind === 'rate_limit') {
    // レート制限の拒否時のみ、判定結果の待機秒数を Retry-After に反映する（P9-1）
    headers['retry-after'] = String(normalizeRetryAfterSec(retryAfterSec))
  }
  return Response.json(
    { error: { kind, message: message ?? userMessageForKind(kind) } },
    { status: statusForKind(kind), headers },
  )
}

/** 障害時フォールバックのモック応答（必ず障害ラベル付き） */
export function buildMockFallbackReply(
  request: ConsultRequest,
  kind: ConsultErrorKind,
): ConsultReply {
  const mock = buildMockReply(request)
  const label = `【モック応答に切り替えました：AI 通信で障害が発生したため（原因: ${reasonLabelForKind(kind)}）】`
  return {
    ...mock,
    text: `${label}\n\n${mock.text}`,
    isMock: true,
    hasUnverified: true,
    sourceType: 'mock-fallback',
  }
}

/**
 * KB 文脈の解決と出典・確認状態の付与（M6-G P2・外部通信なし）。
 *
/**
 * サーバー側 KB 文脈の解決（1 リクエストにつき 1 回だけ呼び出す）。
 * - 解決に使う入力は request.program の ID と質問文のみ。KB の内容（事実・
 *   出典・確認状態）はサーバー側の既存 KB から取得し、クライアント入力や
 *   AI 生成文の URL・金額・制度名は根拠として採用しない
 * - 解決に失敗した場合は null を返す（応答はそのまま、出典・金額を捏造しない）。
 *   ここで得た同じ結果を AI への KB プロンプト供給と出典付与の両方に使う
 */
function resolveKbContextSafe(
  request: ConsultRequest,
  deps: ConsultApiDeps,
): KbConsultContext | null {
  const resolveKb = deps.resolveKbContext ?? resolveKbConsultContext
  try {
    return resolveKb({
      programId: request.program?.id ?? null,
      message: request.message,
    })
  } catch (error) {
    deps.logger?.warn(
      '[consult] KB 文脈の解決に失敗したため出典の付与を省略（応答はそのまま返す）',
      safeErrorInfo(error),
    )
    return null
  }
}

/**
 * 応答への KB 出典・確認状態の付与（M6-G P2。resolveKbContextSafe で解決済みの
 * 同一コンテキストを使用する）
 * - 付与は enrichReplyWithKb の決定論的な処理のみ（既存フィールドは変更しない）
 * - KB が利用できない場合（null）は応答をそのまま返し、既存の安全な応答を
 *   維持する（出典・金額を捏造しない）
 */
function attachKbContext(
  reply: ConsultReply,
  kbContext: KbConsultContext | null,
): ConsultReply {
  return kbContext === null ? reply : enrichReplyWithKb(reply, kbContext)
}

/** POST /api/consult 本体（リクエスト検証・レート制限・応答生成） */
export async function handleConsultRequest(
  request: Request,
  deps: ConsultApiDeps,
): Promise<Response> {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now

  // 1. ボディ検証
  let body: unknown
  try {
    body = JSON.parse(await request.text())
  } catch {
    return errorResponse('validation', 'リクエストの形式が不正です。')
  }
  const parsed = parseConsultRequest(body, env)
  if (!parsed.ok) {
    return errorResponse('validation', parsed.message)
  }

  // 2. プロバイダ解決とレート制限（API コストが生じる Live 時のみ）
  let provider: ConsultProvider
  try {
    provider = deps.resolveProvider()
  } catch (error) {
    deps.logger?.error('[consult] プロバイダの解決に失敗', safeErrorInfo(error))
    return errorResponse('server')
  }

  if (!provider.isMock) {
    const limiter = deps.rateLimiter ?? getDefaultRateLimiter(env)
    const clientKey = resolveClientKey(request.headers, env)
    const decision = limiter.check(clientKey.key, now())
    if (!decision.allowed) {
      return errorResponse('rate_limit', undefined, decision.retryAfterSec)
    }
  }

  // 実行モードの確認用ログ（P11-1）。非機密メタデータ（モード名と乱数の
  // リクエスト ID）のみを出す（質問文・会話履歴・回答本文・API キーは出さない）
  const requestId = Math.random().toString(36).slice(2, 10)
  deps.logger?.info?.(
    `[consult] 実行モード: ${provider.isMock ? 'mock' : 'live'}（request_id=${requestId}）`,
  )

  // 3. 応答生成（障害時は原則エラー表示＋再試行）
  //    KB 文脈はここで 1 回だけ解決し、AI へのプロンプト供給と出典付与の
  //    両方に同じ解決結果を使う（M6-G P2）。失敗時は KB なしで応答する
  const kbContext = resolveKbContextSafe(parsed.value, deps)
  try {
    const reply = await provider.respond(parsed.value, kbContext)
    return Response.json(attachKbContext(reply, kbContext), {
      status: 200,
    })
  } catch (error) {
    const kind: ConsultErrorKind =
      error instanceof ConsultSendError ? error.kind : 'server'
    deps.logger?.error(
      `[consult] AI 応答の取得に失敗（kind=${kind}）`,
      safeErrorInfo(error),
    )
    if (isFallbackToMockEnabled(env)) {
      // 明示設定時のみモックへ切り替え（必ずラベル付き）
      deps.logger?.warn(
        `[consult] CONSULT_FALLBACK_TO_MOCK=1 のためモック応答へ切り替え（kind=${kind}）`,
      )
      return Response.json(
        attachKbContext(
          buildMockFallbackReply(parsed.value, kind),
          kbContext,
        ),
        {
          status: 200,
        },
      )
    }
    return errorResponse(kind)
  }
}

/**
 * GET /api/consult のリクエスト処理（P10-1）
 *
 * - 相談画面の送信前注意表示用に「外部 AI（ライブ）が有効か」の真偽値だけを返す
 * - 判定は POST と同じ isLiveConsultEnabled（CONSULT_LIVE_AI=1 かつ
 *   INIAD_API_KEY 設定の両方が揃ったときのみ true）を使い、表示と実際の
 *   動作が必ず一致するようにする
 * - API キーなどの秘密情報・環境変数の値はレスポンスに含めない
 */
export function handleConsultStatusRequest(
  deps: { env?: Record<string, string | undefined> } = {},
): Response {
  const env = deps.env ?? process.env
  return Response.json(
    { liveAiEnabled: isLiveConsultEnabled(env) },
    { headers: { 'cache-control': 'no-store' } },
  )
}