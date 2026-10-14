/**
 * POST /api/consult のリクエスト処理（M6 フェーズ1）
 *
 * - Route Handler（app/api/consult/route.ts）はこの関数に処理を委ねる
 *   （テストでは resolveProvider / rateLimiter / env を注入して検証する）
 * - 入力検証（zod）→ レート制限（Live 時のみ）→ プロバイダ応答
 * - 通信障害は原則エラー表示＋再試行。モックへの自動フォールバックは
 *   CONSULT_FALLBACK_TO_MOCK=1 のときのみ（既定 0）。フォールバック時は
 *   必ず「モック応答に切り替えました」と障害原因を明示する
 */
import { z } from 'zod'
import {
  ConsultSendError,
  reasonLabelForKind,
  statusForKind,
  userMessageForKind,
  type ConsultErrorKind,
} from './errors'
import { buildMockReply } from './mockAdvisor'
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
  logger?: Pick<Console, 'warn' | 'error'>
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

function errorResponse(kind: ConsultErrorKind, message?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (kind === 'rate_limit') headers['retry-after'] = '30'
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
    deps.logger?.error('[consult] プロバイダの解決に失敗', error)
    return errorResponse('server')
  }

  if (!provider.isMock) {
    const limiter = deps.rateLimiter ?? getDefaultRateLimiter(env)
    const clientKey = resolveClientKey(request.headers, env)
    const decision = limiter.check(clientKey.key, now())
    if (!decision.allowed) {
      return errorResponse('rate_limit')
    }
  }

  // 3. 応答生成（障害時は原則エラー表示＋再試行）
  try {
    const reply = await provider.respond(parsed.value)
    return Response.json(reply, { status: 200 })
  } catch (error) {
    const kind: ConsultErrorKind =
      error instanceof ConsultSendError ? error.kind : 'server'
    deps.logger?.error(
      `[consult] AI 応答の取得に失敗（kind=${kind}）`,
      error instanceof Error ? error.message : error,
    )
    if (isFallbackToMockEnabled(env)) {
      // 明示設定時のみモックへ切り替え（必ずラベル付き）
      deps.logger?.warn(
        `[consult] CONSULT_FALLBACK_TO_MOCK=1 のためモック応答へ切り替え（kind=${kind}）`,
      )
      return Response.json(buildMockFallbackReply(parsed.value, kind), {
        status: 200,
      })
    }
    return errorResponse(kind)
  }
}