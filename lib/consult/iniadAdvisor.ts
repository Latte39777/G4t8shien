/**
 * INIAD API（大学提供 OpenAI 互換 API）によるライブ応答プロバイダ（M6 フェーズ1）
 *
 * 【確認済みの仕様のみに依存する】
 * - Base URL: https://api.openai.iniad.org/api/v1（CONSULT_API_BASE_URL で変更可）
 * - モデル: gpt-5.4（CONSULT_MODEL で変更可）
 * - 送信は chat.completions.create({ model, messages }) のみ（大学の使用例どおり）
 * - 上記以外（Responses API / web_search / structured outputs / レート上限 /
 *   価格 / データ保持）は大学側で未確認のため使用しない
 * - Web 検索・公式サイトの取得は lib/consult/officialSource.ts（M6-E・未実装）に
 *   分離済み。このモジュールは取得処理を持たない。設計は docs/consult-m6e-design.md
 *
 * 【フェーズ1（G0）の制約】
 * - このプロバイダは CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定の
 *   両方そろったときのみ provider.ts 経由で選択される（テストでは偽
 *   クライアントを注入し、実 API へは一切接続しない）
 * - 具体的な制度情報（特定プログラムの受給資格・金額・期限・窓口など）は、
 *   「公式情報 KB」ブロックの「確認済みの事実」に記載された範囲でのみ説明する。
 *   KB にない・未確認の内容は断定せず、確認質問・一般的な進め方・公式窓口の
 *   案内に限定する
 * - AI が挙げた URL を出典として表示しない
 * - 相談文・履歴の個人情報は redact.ts でマスキングしてから送る（相談者の
 *   金額は渡さない）。KB の確認済みの事実（公表値）は KB ブロックとして送る
 */
import OpenAI from 'openai'
import { ConsultSendError } from './errors'
import {
  LIMITED_FALLBACK_REPLY,
  parseAiReplyJson,
  toConsultReplyFromAi,
  toConsultReplyFromRawText,
} from './replySchema'
import { redactForApi, redactText } from './redact'
import { buildKbPromptBlock, buildProgramCandidateList } from './kbPrompt'
import {
  resolveAiProposedPrograms,
  type KbConsultContext,
} from './kbContext'
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
    'Web検索は利用できません。ご自身で検索をした・公式サイトを確認したかのような表現は一切禁止です（サーバーから渡された、公式ページで確認された情報を説明するのはこの限りでない。「今回調べた」「最新情報を確認した」など、新しい調査を行ったかのような表現は禁止）。',
    '制度の具体的な情報は、「公式情報 KB」ブロックの「確認済みの事実」に記載された内容に限り、記載の範囲・記載どおりに説明してよい。それ以外（KB にない情報・未確認の情報）は検証されていないため、次の事項を断定して答えないこと：',
    '・特定の制度の受給資格・対象条件・所得制限',
    '・金額・支給額・補助額',
    '・申請期限・申請時期・対象期間',
    '・申請先窓口・必要書類・申請手順の詳細',
    '「公式確認済み」「確定」などの表現で断定しないこと。確認状態は「確認できています」「まだ確認できていません」のように、相談者にわかる言葉で伝えること。相談者本人の受給資格・利用資格・申請可否を確定と表現しないこと。',
    'URL やリンクを回答に含めないこと（出典として扱わないため）。',
    '架空の制度名・金額・期限を作り出さないこと。',
    '内部用語の禁止：「KB」「ナレッジベース」「登録データ」「データベース」「内部資料」「記録では」「システムに登録」など、内部の仕組み・資料・データの名前を示す言葉を回答本文に書かないこと。資料の存在や内部名に触れず、質問への答えを直接説明すること。',
    '回答の構成と文体：',
    '・最初に、質問への結論・直接の回答を述べる。',
    '・重要な制度は制度名と短い説明で整理する。箇条書きは必要なときだけ使う。',
    '・金額が未確認なら金額の箇所で、対象条件が未確認なら対象条件の箇所で未確認と説明する。同じ注意書きを何度も繰り返さない。',
    '・内部の変数名・データ構造・ファイル名を回答に出さない。',
    '・「〜という記録があります」「〜とされています」といった不自然な表現を多用せず、利用者に話しかける自然な日本語で書く。',
    '・質問に関係しない制度を大量に列挙しない。根拠のない金額・条件を一般知識から補わない。',
    '・未確認の制度・項目を、人間が確認済みであるかのように説明しない。',
    '回答できること：',
    '・状況を整理するための確認質問',
    '・一般的な手続きの進め方（例：自治体の窓口に問い合わせる、公式情報を確認する）',
    '・お住まいの自治体の窓口や公式窓口への確認を促すこと',
    '未確認の内容を述べる場合は「未確認」と明示してください。ただし未確認の注意は必要な箇所で1回述べればよく、同じ注意を繰り返さないこと。',
    '確認質問は、最も役立つものを1つだけ選ぶこと（自治体独自の制度の案内が必要なら住んでいる市区町村、年齢によって制度が変わるなら子どもの年齢、世帯状況によって変わるなら世帯状況の順に検討する）。すでに入力された情報や会話履歴にあることを聞き直さない。',
    '回答は日本語で、簡潔に行ってください。',
    '相談者の収入・貯蓄の金額は渡されていません。金額を推測して尋ねたり答えたりしないでください。',
  ]
  if (flags.jsonMode === 'prompt') {
    lines.push(
      '応答は必ず次の JSON オブジェクトのみを返してください（コードフェンスや前置きの文章は禁止）：',
      '{"reply": "回答本文", "clarificationQuestions": ["確認質問1", "確認質問2"], "unsupported": false, "programIds": ["制度ID"]}',
      'reply には回答本文を入れる。制度の具体的な金額・期限・条件は、公式情報 KB の「確認済みの事実」に記載されたものに限り、その範囲・記載どおりに含めてよい。KB にない・未確認の確定情報は含めないでください。内部用語（KB・ナレッジベース・登録データなど）は使わず、自然な日本語で書いてください。',
      'clarificationQuestions は状況把握に必要な質問（最も役立つもの1つだけ。なければ空配列）。すでに聞いたこと・入力済みの情報は聞き直さない。',
      '制度と無関係な質問や、正確な制度情報が必要な質問に答えられない場合は unsupported: true とし、根拠のない制度情報を生成しないでください。',
      'programIds は、サーバーから渡される「支援制度候補リスト」にある制度 ID の中から、相談者の状況に関連する可能性があるものを最大 5 件だけ入れる（リストにない ID・架空の制度 ID は禁止。関連する制度がなければ空配列）。',
      '制度候補の提案は関連性の目安にすぎず、受給資格の判定ではない。提案した制度についても、受給資格・金額・申請期限を断定しないこと。候補が見つからない場合は無理に選ばず、本文で確認できる候補がないこと・追加の確認が必要なことを案内する。',
    )
  }
  return lines.join('\n')
}

// ── API 送信メッセージの組み立て（マスキング・切り詰め込み） ──

const MAX_HISTORY_MESSAGES = 12
const MAX_MESSAGE_CHARS = 1000
const MAX_CONTEXT_CHARS = 600

/**
 * 相談リクエスト → API 送信用メッセージ（個人情報をマスキング・最小限のみ）。
 * kbContext（サーバー側で解決済みの KB 文脈）が与えられた場合のみ、KB ブロックを
 * system メッセージとして追加する（クライアント入力の URL・金額・確認状態は使わない）。
 * モック経路ではこの関数自体を呼ばない。
 */
export function buildApiMessages(
  request: ConsultRequest,
  flags: ConsultCapabilityFlags,
  kbContext?: KbConsultContext | null,
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

  // 支援制度候補リスト（AI 提案用。P10）。ID・名称・区分のみ
  // （金額・期限・窓口・URL・受給資格は含めない）。相談セッションがあるときだけ
  // 渡し、制度と無関係な質問には候補制度名を送らない（送信する項目はサーバー側で制御）
  if (request.program !== null || request.userContext !== null) {
    const candidateList = buildProgramCandidateList()
    if (candidateList.length > 0) {
      messages.push({ role: 'system', content: redactText(candidateList) })
    }
  }

  // KB ブロック（サーバー側 KB の確認済み事実のみ。URL なし・kbPrompt が長さ制限済み）。
  // KB 未特定（cards 空）なら空文字が返り、この行自体が入らない
  const kbBlock = buildKbPromptBlock(kbContext ?? { cards: [], amountCalculationPolicy: '' })
  if (kbBlock.length > 0) {
    messages.push({
      role: 'system',
      // redactText でマスキングのみ（途中切り詰めしない。長さは kbPrompt 側で制限済み）
      content: redactText(kbBlock),
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
    async respond(
      request: ConsultRequest,
      kbContext?: KbConsultContext | null,
    ): Promise<ConsultReply> {
      const flags = resolveCapabilityFlags(env)
      const client = options.client ?? createDefaultIniadClient(env)
      const messages = buildApiMessages(request, flags, kbContext)

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
      if (parsed === null) return LIMITED_FALLBACK_REPLY
      const reply = toConsultReplyFromAi(parsed)
      // AI 提案（programIds）はサーバー側レジストリで ID を検証してのみ
      // チップ化する（不明な ID は破棄。名称・出典・金額は AI 生成文から採用しない）
      const proposed = resolveAiProposedPrograms(parsed.programIds ?? [])
      return proposed.length === 0 ? reply : { ...reply, relatedPrograms: proposed }
    },
  }
}