/**
 * INIAD API（大学提供 OpenAI 互換 API）によるライブ応答プロバイダ（M6 フェーズ1）
 *
 * 【確認済みの仕様のみに依存する】
 * - Base URL: https://api.openai.iniad.org/api/v1（CONSULT_API_BASE_URL で変更可）
 * - モデル: gpt-5.4（CONSULT_MODEL で変更可）
 * - 送信は chat.completions.create({ model, messages }) のみ（大学の使用例どおり）
 * - 上記以外（Responses API / web_search / structured outputs / レート上限 /
 *   価格 / データ保持）は大学側で未確認のため使用しない
 *
 * 【フェーズ1（G0）の制約】
 * - このプロバイダは CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定の
 *   両方そろったときのみ provider.ts 経由で選択される（テストでは偽
 *   クライアントを注入し、実 API へは一切接続しない）
 * - 具体的な制度情報（特定プログラムの受給資格・金額・期限・窓口など）を
 *   断定しない。確認質問・一般的な進め方・公式窓口の案内に限定する
 * - AI が挙げた URL を出典として表示しない
 * - 個人情報は redact.ts でマスキングしてから送る。金額は渡さない
 */
import OpenAI from 'openai'
import { ConsultSendError } from './errors'
import {
  LIMITED_FALLBACK_REPLY,
  parseAiReplyJson,
  toConsultReplyFromAi,
  toConsultReplyFromRawText,
} from './replySchema'
import { redactForApi } from './redact'
import type {
  ConsultProvider,
  ConsultReply,
  ConsultRequest,
} from './types'

// ── chat.completions.create 相当の最小インターフェース（偽クライアント注入用） ──

export type ApiChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatCompletionParams = {
  model: string
  messages: ApiChatMessage[]
}

export type ChatCompletionResult = {
  content: string | null
}

/** OpenAI SDK の chat.completions.create の差し替え可能な形 */
export type ChatCompletionsLike = {
  create(params: ChatCompletionParams): Promise<ChatCompletionResult>
}

// ── 能力フラグ（大学側で未確認の機能は既定で無効） ──

export type ConsultCapabilityFlags = {
  /** Web検索。off 固定（CONSULT_AI_SEARCH=on は未確認機能のため拒否） */
  search: 'off'
  /** JSON 応答の取得方法。structured outputs は未確認のためプロンプト方式 */
  jsonMode: 'prompt' | 'off'
}

/**
 * 能力フラグの解決。未確認の機能が指定された場合は起動時エラーにして
 * 動作しない（「動いているが実は効いていない」状態をつくらない）。
 */
export function resolveCapabilityFlags(
  env: Record<string, string | undefined>,
): ConsultCapabilityFlags {
  const search = env.CONSULT_AI_SEARCH ?? 'off'
  if (search !== 'off') {
    throw new Error(
      `CONSULT_AI_SEARCH=${search} は大学 API の能力未確認のため利用できません（off のみ有効。能力確認・承認後に実装）`,
    )
  }
  const jsonMode = env.CONSULT_AI_JSON_MODE ?? 'prompt'
  if (jsonMode !== 'prompt' && jsonMode !== 'off') {
    throw new Error(
      `CONSULT_AI_JSON_MODE=${jsonMode} は利用できません（structured outputs は未確認のため prompt | off のみ有効）`,
    )
  }
  return { search: 'off', jsonMode }
}

// ── プロンプト ──

/** 支援制度相談のシステムプロンプト（フェーズ1の禁止事項を含む） */
export function buildSystemPrompt(flags: ConsultCapabilityFlags): string {
  const lines = [
    'あなたは子育て・住宅・教育・就労などの支援制度に関する相談を補助するアシスタントです。',
    'Web検索は利用できません。検索をした・公式サイトを確認したかのような表現は一切禁止です。',
    '制度の具体的な情報は検証されていないため、次の事項を断定して答えないこと：',
    '・特定の制度の受給資格・対象条件・所得制限',
    '・金額・支給額・補助額',
    '・申請期限・申請時期・対象期間',
    '・申請先窓口・必要書類・申請手順の詳細',
    '「公式確認済み」「確定」などの表現も使用禁止です。',
    'URL やリンクを回答に含めないこと（出典として扱わないため）。',
    '架空の制度名・金額・期限を作り出さないこと。',
    '回答できること：',
    '・状況を整理するための確認質問',
    '・一般的な手続きの進め方（例：自治体の窓口に問い合わせる、公式情報を確認する）',
    '・お住まいの自治体の窓口や公式窓口への確認を促すこと',
    '未確認の内容を述べる場合は「未確認」と明示してください。',
    '回答は日本語で、簡潔に行ってください。',
    '相談者の収入・貯蓄の金額は渡されていません。金額を推測して尋ねたり答えたりしないでください。',
  ]
  if (flags.jsonMode === 'prompt') {
    lines.push(
      '応答は必ず次の JSON オブジェクトのみを返してください（コードフェンスや前置きの文章は禁止）：',
      '{"reply": "回答本文", "clarificationQuestions": ["確認質問1", "確認質問2"], "unsupported": false}',
      'reply には回答本文のみを入れ、制度の具体的な金額・期限・条件の確定情報を含めないでください。',
      'clarificationQuestions は状況把握に必要な質問（最大3つ。なければ空配列）。',
      '制度と無関係な質問や、正確な制度情報が必要な質問に答えられない場合は unsupported: true とし、根拠のない制度情報を生成しないでください。',
    )
  }
  return lines.join('\n')
}

// ── API 送信メッセージの組み立て（マスキング・切り詰め込み） ──

const MAX_HISTORY_MESSAGES = 12
const MAX_MESSAGE_CHARS = 1000
const MAX_CONTEXT_CHARS = 600

/** 相談リクエスト → API 送信用メッセージ（個人情報をマスキング・最小限のみ） */
export function buildApiMessages(
  request: ConsultRequest,
  flags: ConsultCapabilityFlags,
): ApiChatMessage[] {
  const messages: ApiChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(flags) },
  ]

  // セッション文脈（最小限。金額は渡さない）
  const contextLines: string[] = []
  if (request.program) {
    contextLines.push(
      `相談のきっかけの制度（モック・未確認データ）: ${request.program.name}`,
      `概要（未確認）: ${request.program.summary}`,
      'この制度情報は検証されていないモックデータです。確定情報として回答に使用しないでください。',
    )
  }
  if (request.userContext) {
    contextLines.push(
      `相談者の状況: お子さま ${request.userContext.childCount} 人、世帯年収の入力 ${request.userContext.hasAnnualIncome ? 'あり' : 'なし'}、利用中の支援制度 ${request.userContext.usedProgramIds.length} 件`,
      '収入・貯蓄の金額は渡していません。',
    )
  }
  if (contextLines.length > 0) {
    messages.push({
      role: 'system',
      content: redactForApi(contextLines.join('\n'), MAX_CONTEXT_CHARS),
    })
  }

  // 会話履歴（直近分のみ・マスキング済み）
  const history = request.history.slice(-MAX_HISTORY_MESSAGES)
  for (const item of history) {
    messages.push({
      role: item.role === 'user' ? 'user' : 'assistant',
      content: redactForApi(item.text, MAX_MESSAGE_CHARS),
    })
  }

  // 今回の質問
  messages.push({
    role: 'user',
    content: redactForApi(request.message, MAX_MESSAGE_CHARS),
  })
  return messages
}

// ── 既定クライアント（OpenAI SDK / base_url 指定で INIAD API に接続） ──

export const DEFAULT_INIAD_BASE_URL = 'https://api.openai.iniad.org/api/v1'
export const DEFAULT_INIAD_MODEL = 'gpt-5.4'

/**
 * 大学の使用例どおり OpenAI SDK の chat.completions.create() を使う既定
 * クライアント。構築は遅延（Live 無効時に SDK を初期化しない）。
 */
export function createDefaultIniadClient(
  env: Record<string, string | undefined> = process.env,
): ChatCompletionsLike {
  const apiKey = env.INIAD_API_KEY ?? ''
  const baseURL = env.CONSULT_API_BASE_URL ?? DEFAULT_INIAD_BASE_URL
  const client = new OpenAI({ apiKey, baseURL })
  return {
    async create(params: ChatCompletionParams): Promise<ChatCompletionResult> {
      const completion = await client.chat.completions.create({
        model: params.model,
        messages: params.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      })
      return { content: completion.choices?.[0]?.message?.content ?? null }
    },
  }
}

// ── エラー変換 ──

/** 上流 API のエラー → ConsultSendError（内部詳細はユーザーに見せない） */
export function mapUpstreamError(error: unknown): ConsultSendError {
  if (error instanceof ConsultSendError) return error
  const e = error as { name?: string; status?: number; message?: string }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new ConsultSendError('timeout')
  }
  if (typeof e?.status === 'number') {
    const status = e.status
    if (status === 429) return new ConsultSendError('rate_limit')
    if (status === 408 || status === 504) return new ConsultSendError('timeout')
    if (status === 401 || status === 403 || status === 404 || status === 400 || status === 422) {
      // 認証・設定エラー（再試行しても直らない）
      return new ConsultSendError('auth')
    }
    return new ConsultSendError('server')
  }
  if (
    typeof e?.message === 'string' &&
    /fetch failed|network|connection|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(e.message)
  ) {
    return new ConsultSendError('network')
  }
  return new ConsultSendError('server')
}

/** タイムアウト付きで実行（上限時間超過で timeout エラー） */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ConsultSendError('timeout'))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ── プロバイダ ──

export type IniadConsultProviderOptions = {
  /** 偽クライアント注入用（テスト）。未指定なら OpenAI SDK 既定クライアント */
  client?: ChatCompletionsLike
  env?: Record<string, string | undefined>
  /** 1 リクエストの応答待ち上限（ms） */
  timeoutMs?: number
  /** 429/5xx/通信エラー時の自動リトライ回数（既定 1） */
  retryCount?: number
  /** JSON パース失敗時の再依頼回数（既定 1） */
  jsonRetryCount?: number
  /** 自動リトライ間隔（ms）。テストでは 0 を指定 */
  retryDelayMs?: number
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms))
}

/**
 * INIAD API ライブ応答プロバイダの生成。
 * provider.ts は CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定のときのみ
 * このプロバイダを返す。
 */
export function createIniadConsultProvider(
  options: IniadConsultProviderOptions = {},
): ConsultProvider {
  const env = options.env ?? process.env
  const model = env.CONSULT_MODEL ?? DEFAULT_INIAD_MODEL
  const envTimeout = Number.parseInt(env.CONSULT_TIMEOUT_MS ?? '', 10)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000)
  const retryCount = options.retryCount ?? 1
  const jsonRetryCount = options.jsonRetryCount ?? 1
  const retryDelayMs = options.retryDelayMs ?? 250

  return {
    id: 'iniad-live',
    label: `AI回答（INIAD API ${model}・Web検索なし）`,
    isMock: false,
    async respond(request: ConsultRequest): Promise<ConsultReply> {
      const flags = resolveCapabilityFlags(env)
      const client = options.client ?? createDefaultIniadClient(env)
      const messages = buildApiMessages(request, flags)

      // 上流障害（429/5xx/通信/タイムアウト）は retryCount 回まで自動リトライ
      const createWithRetry = async (msgs: ApiChatMessage[]): Promise<string> => {
        let lastError: ConsultSendError = new ConsultSendError('server')
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
          try {
            const result = await withTimeout(
              client.create({ model, messages: msgs }),
              timeoutMs,
            )
            const content = result.content ?? ''
            if (content.trim().length === 0) {
              throw new ConsultSendError('invalid_response')
            }
            return content
          } catch (error) {
            lastError = mapUpstreamError(error)
            const retriable =
              lastError.kind === 'rate_limit' ||
              lastError.kind === 'timeout' ||
              lastError.kind === 'network' ||
              lastError.kind === 'server'
            if (!retriable || attempt === retryCount) throw lastError
            await sleep(retryDelayMs)
          }
        }
        throw lastError
      }

      const raw = await createWithRetry(messages)

      if (flags.jsonMode === 'off') {
        return toConsultReplyFromRawText(raw)
      }

      let parsed = parseAiReplyJson(raw)
      if (parsed === null && jsonRetryCount > 0) {
        // パース失敗: JSON のみで返すよう再依頼（1 回）。生出力は使わない
        const retryMessages: ApiChatMessage[] = [
          ...messages,
          { role: 'assistant', content: raw.slice(0, 500) },
          {
            role: 'user',
            content:
              'JSON オブジェクトのみを返してください。前置き・コードフェンス・説明は禁止です。',
          },
        ]
        const retried = await createWithRetry(retryMessages)
        parsed = parseAiReplyJson(retried)
      }
      // それでも駄目なら生出力を破棄して限定文のみ（残りは破棄）
      return parsed === null ? LIMITED_FALLBACK_REPLY : toConsultReplyFromAi(parsed)
    },
  }
}