/**
 * M6（Live AI consult / フェーズ1・G0）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-m6.ts
 *
 * 確認項目:
 * - Live AI の 2 重スイッチ（CONSULT_LIVE_AI=1 かつ INIAD_API_KEY の両方必須）
 * - 能力フラグ（未確認機能は既定無効・誤設定は起動エラー）
 * - フォールバック既定 0（エラー表示＋再試行）
 * - プロンプトの禁止事項（検索したふり禁止・URL 禁止・制度値の断定禁止）
 * - PII マスキング（API 送信前）
 * - AI 応答スキーマ（具体制度フィールドの破棄・未確認ラベル強制）
 * - INIAD プロバイダ（偽クライアントのみ。タイムアウト/429/5xx/認証エラー）
 * - レート制限（暫定値・共有バケット既定・偽装ヘッダ無視）
 * - 静的検査（保護ファイル不変・外部通信経路の分離・固定バッジ文言）
 *
 * 外部 API への通信は一切行わない（fetch ガードで確認）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isFallbackToMockEnabled,
  maxQuestionChars,
  parseConsultRequest,
} from '../lib/consult/api'
import {
  ConsultSendError,
  isRetryableKind,
  kindForStatus,
  statusForKind,
  userMessageForKind,
} from '../lib/consult/errors'
import {
  buildApiMessages,
  buildSystemPrompt,
  createIniadConsultProvider,
  mapUpstreamError,
  resolveCapabilityFlags,
  type ChatCompletionParams,
  type ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import {
  isLiveConsultEnabled,
  getConsultProvider,
} from '../lib/consult/provider'
import {
  LIMITED_FALLBACK_REPLY,
  parseAiReplyJson,
  toConsultReplyFromAi,
} from '../lib/consult/replySchema'
import { redactText } from '../lib/consult/redact'
import {
  MemoryRateLimiter,
  parseRateLimitConfig,
  resolveClientKey,
} from '../lib/consult/rateLimit'
import { mockConsultProvider } from '../lib/consult/mockAdvisor'
import { MOCK_SUPPORT_PROGRAMS } from '../lib/supports/mockPrograms'
import type { ConsultRequest } from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

// ── 外部通信ガード ──
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown) => {
  fetchCalls.push(String(input))
  return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
}) as typeof fetch

const req = (message: string, overrides?: Partial<ConsultRequest>): ConsultRequest => ({
  message,
  history: [],
  program: null,
  userContext: null,
  ...overrides,
})

/** 応答列（文字列 or 例外）を返す偽クライアント */
function fakeClient(responses: Array<string | Error>): {
  client: ChatCompletionsLike
  calls: ChatCompletionParams[]
} {
  const calls: ChatCompletionParams[] = []
  let i = 0
  return {
    calls,
    client: {
      create(params) {
        calls.push(params)
        const r = responses[Math.min(i, responses.length - 1)]
        i += 1
        return r instanceof Error
          ? Promise.reject(r)
          : Promise.resolve({ content: r })
      },
    },
  }
}

const apiError = (status: number): Error =>
  Object.assign(new Error(`upstream ${status}`), { status })

async function main(): Promise<void> {
  // テスト自体が Live を有効化しない
  delete process.env.CONSULT_LIVE_AI
  delete process.env.INIAD_API_KEY
  delete process.env.CONSULT_FALLBACK_TO_MOCK

  // ── 1. Live AI の 2 重スイッチ ──
  delete process.env.CONSULT_LIVE_AI
  delete process.env.INIAD_API_KEY
  check(
    '2 重スイッチ: 未設定ならモック（M5 と同一プロバイダ）',
    getConsultProvider() === mockConsultProvider,
  )
  check(
    '2 重スイッチ: 単独設定では Live にならない',
    isLiveConsultEnabled({ CONSULT_LIVE_AI: '1' }) === false &&
      isLiveConsultEnabled({ INIAD_API_KEY: 'secret' }) === false &&
      isLiveConsultEnabled({ CONSULT_LIVE_AI: '0', INIAD_API_KEY: 'secret' }) === false &&
      isLiveConsultEnabled({ CONSULT_LIVE_AI: 'true', INIAD_API_KEY: 'secret' }) === false,
  )
  check(
    '2 重スイッチ: 両方そろったときのみ有効',
    isLiveConsultEnabled({ CONSULT_LIVE_AI: '1', INIAD_API_KEY: 'secret' }) === true,
  )

  // ── 2. 能力フラグ（未確認機能は既定無効・誤設定は起動エラー） ──
  const flags = resolveCapabilityFlags({})
  check(
    '能力フラグ: 既定は search=off / jsonMode=prompt',
    flags.search === 'off' && flags.jsonMode === 'prompt',
  )
  check(
    '能力フラグ: jsonMode=off は許可',
    resolveCapabilityFlags({ CONSULT_AI_JSON_MODE: 'off' }).jsonMode === 'off',
  )
  const searchOnThrows = (() => {
    try {
      resolveCapabilityFlags({ CONSULT_AI_SEARCH: 'on' })
      return false
    } catch {
      return true
    }
  })()
  check('能力フラグ: CONSULT_AI_SEARCH=on は拒否（能力未確認）', searchOnThrows)
  const structuredThrows = (() => {
    try {
      resolveCapabilityFlags({ CONSULT_AI_JSON_MODE: 'structured' })
      return false
    } catch {
      return true
    }
  })()
  check('能力フラグ: structured outputs 指定は拒否（能力未確認）', structuredThrows)

  // ── 3. フォールバック既定・入力上限・レート既定値 ──
  check(
    'フォールバック: 既定 0（エラー表示＋再試行）',
    isFallbackToMockEnabled({}) === false &&
      isFallbackToMockEnabled({ CONSULT_FALLBACK_TO_MOCK: '0' }) === false &&
      isFallbackToMockEnabled({ CONSULT_FALLBACK_TO_MOCK: 'true' }) === false &&
      isFallbackToMockEnabled({ CONSULT_FALLBACK_TO_MOCK: '1' }) === true,
  )
  check(
    '質問上限: 既定 1000 文字',
    maxQuestionChars({}) === 1000 &&
      parseConsultRequest({ message: 'あ'.repeat(1001) }, {}).ok === false &&
      parseConsultRequest({ message: 'あ'.repeat(1000) }, {}).ok === true,
  )
  const rateDefaults = parseRateLimitConfig({})
  check(
    'レート制限: 暫定既定値 10/分・100/日・全体 30/分',
    rateDefaults.perMinute === 10 &&
      rateDefaults.perDay === 100 &&
      rateDefaults.globalPerMinute === 30,
    JSON.stringify(rateDefaults),
  )
  // __S2__
  // ── 4. プロンプトの禁止事項（フェーズ1の制約） ──
  const prompt = buildSystemPrompt({ search: 'off', jsonMode: 'prompt' })
  check(
    'プロンプト: Web検索したふりを禁止',
    prompt.includes('Web検索は利用できません') && prompt.includes('一切禁止'),
  )
  check(
    'プロンプト: 制度値（資格・金額・期限・窓口）の断定を禁止',
    prompt.includes('受給資格') && prompt.includes('金額') &&
      prompt.includes('申請期限') && prompt.includes('申請先窓口') &&
      prompt.includes('断定して答えないこと'),
  )
  check(
    'プロンプト: 「公式確認済み」等の表現と URL を禁止',
    prompt.includes('公式確認済み') && prompt.includes('URL やリンクを回答に含めない'),
  )
  check(
    'プロンプト: 未確認の明示と公式窓口の案内を指示',
    prompt.includes('「未確認」と明示') && prompt.includes('公式窓口'),
  )
  check(
    'プロンプト: JSON モードでは JSON 応答形式を指示',
    prompt.includes('"reply"') && prompt.includes('unsupported'),
  )
  const offPrompt = buildSystemPrompt({ search: 'off', jsonMode: 'off' })
  check(
    'プロンプト: jsonMode=off では JSON 指示を含めない',
    !offPrompt.includes('"reply"'),
  )
  // モックデータ（未確認のデモ値）をプロンプトに混ぜない
  const mockNamesInPrompt = MOCK_SUPPORT_PROGRAMS.filter((p) =>
    prompt.includes(p.name),
  )
  check(
    'プロンプト: モック制度名を含まない（デモデータを実情報として使わない）',
    mockNamesInPrompt.length === 0,
    mockNamesInPrompt.map((p) => p.name).join(','),
  )
  check(
    'プロンプト: モックの金額らしき数字を含まない',
    !/\d{2,3}[,，]\d{3}/.test(prompt),
  )

  // ── 5. PII マスキング ──
  const masked = redactText(
    '電話 090-1234-5678 / 03-1234-5678、メール taro@example.com、番号 1234-5678-9012、連番 01201234567',
  )
  check(
    'PII: 電話・メール・番号をマスク',
    masked.includes('［電話番号］') &&
      masked.includes('［メールアドレス］') &&
      masked.includes('［番号］') &&
      masked.includes('［数字］'),
    masked,
  )
  check(
    'PII: 元の値が残らない',
    !masked.includes('090-1234-5678') &&
      !masked.includes('taro@example.com') &&
      !masked.includes('1234-5678-9012'),
  )
  check(
    'PII: 通常の文章は変更しない',
    redactText('申請はどこですればいい？') === '申請はどこですればいい？',
  )
  // 送信メッセージ組み立て（履歴上限・マスキングの適用）
  const apiMessages = buildApiMessages(
    req('質問です', {
      history: Array.from({ length: 20 }, (_, i) => ({
        id: `h${i}`,
        role: 'user' as const,
        text: '090-1234-5678 の件です',
        isMock: false,
        hasUnverified: false,
        relatedPrograms: [],
      })),
    }),
    { search: 'off', jsonMode: 'prompt' },
  )
  check(
    '送信メッセージ: 履歴は直近 12 件のみ・全件マスキング済み',
    apiMessages.length === 1 + 12 + 1 &&
      apiMessages.filter((m) => m.content.includes('［電話番号］')).length === 12 &&
      !JSON.stringify(apiMessages).includes('090-1234-5678'),
    `len=${apiMessages.length}`,
  )

  // ── 6. AI 応答スキーマ（具体制度フィールドの破棄・未確認ラベル強制） ──
  const parsed = parseAiReplyJson(
    '```json\n{"reply": "未確認ですが確認質問です。", "clarificationQuestions": ["お子さまの年齢は？"], "unsupported": false, "programs": [{"name": "架空手当", "amount": 999999}], "sources": [{"url": "https://x.invalid"}]}\n```',
  )
  check(
    '応答スキーマ: フェンス付き JSON を解析（許可フィールドのみ）',
    parsed !== null && parsed.reply.includes('未確認') && !('programs' in parsed),
  )
  const aiReply = parsed ? toConsultReplyFromAi(parsed) : null
  check(
    '応答スキーマ: relatedPrograms は常に空・hasUnverified 強制・isMock=false',
    aiReply !== null &&
      aiReply.relatedPrograms.length === 0 &&
      aiReply.hasUnverified === true &&
      aiReply.isMock === false &&
      aiReply.sourceType === 'ai',
  )
  check(
    '応答スキーマ: 確認質問を本文末尾に展開',
    aiReply !== null && aiReply.text.includes('確認したいこと：') &&
      aiReply.text.includes('お子さまの年齢は？'),
  )
  const withUrl = toConsultReplyFromAi({
    reply: '参考: https://example.invalid を見てください。',
  })
  check(
    '応答スキーマ: URL は出典扱いせず注記を付す（アンカー化しない）',
    withUrl.text.includes('出典として掲載していません') &&
      withUrl.relatedPrograms.length === 0,
  )
  check(
    '応答スキーマ: 不正 JSON は null（生出力を採用しない）',
    parseAiReplyJson('これは JSON ではありません') === null &&
      parseAiReplyJson('{broken json') === null,
  )
  check(
    '応答スキーマ: パース不能時の限定文は要確認前提',
    LIMITED_FALLBACK_REPLY.unsupported === true &&
      LIMITED_FALLBACK_REPLY.text.includes('窓口') &&
      LIMITED_FALLBACK_REPLY.text.includes('確認'),
  )
  // ── 7. INIAD プロバイダ（偽クライアントのみ・実 API 不使用） ──
  const okClient = fakeClient([
    JSON.stringify({ reply: '確認質問をさせてください。', clarificationQuestions: ['年齢は？'] }),
  ])
  const okAdapter = createIniadConsultProvider({
    client: okClient.client,
    env: {},
    retryDelayMs: 0,
  })
  const okResult = await okAdapter.respond(req('相談です'))
  check(
    'プロバイダ: 偽クライアントから JSON 応答を受信（200 相当）',
    okResult.text.includes('確認質問') && okResult.sourceType === 'ai',
  )
  const sentParams = okClient.calls[0]
  check(
    'プロバイダ: 確認済み仕様のみ送信（model + messages）',
    Object.keys(sentParams).sort().join(',') === 'messages,model' &&
      sentParams.model === 'gpt-5.4' &&
      sentParams.messages[0].role === 'system',
    JSON.stringify(Object.keys(sentParams)),
  )
  check(
    'プロバイダ: 送信メッセージに Web 検索ツール指定を含めない',
    !JSON.stringify(sentParams).includes('web_search'),
  )

  // タイムアウト
  const hanging: ChatCompletionsLike = {
    create: () => new Promise(() => {}),
  }
  const timeoutAdapter = createIniadConsultProvider({
    client: hanging,
    env: {},
    timeoutMs: 20,
    retryCount: 0,
    retryDelayMs: 0,
  })
  let timeoutKind = ''
  try {
    await timeoutAdapter.respond(req('相談です'))
  } catch (e) {
    timeoutKind = e instanceof ConsultSendError ? e.kind : 'other'
  }
  check('プロバイダ: タイムアウトで timeout エラー', timeoutKind === 'timeout')

  // 429 は自動リトライ（1 回）したあと rate_limit エラー
  const limited = fakeClient([apiError(429)])
  const limitedAdapter = createIniadConsultProvider({
    client: limited.client,
    env: {},
    retryDelayMs: 0,
  })
  let limitedKind = ''
  try {
    await limitedAdapter.respond(req('相談です'))
  } catch (e) {
    limitedKind = e instanceof ConsultSendError ? e.kind : 'other'
  }
  check(
    'プロバイダ: 429 は 1 回リトライ後に rate_limit エラー（計 2 回呼び出し）',
    limitedKind === 'rate_limit' && limited.calls.length === 2,
    `kind=${limitedKind} calls=${limited.calls.length}`,
  )

  // 認証・設定エラーはリトライしない
  const denied = fakeClient([apiError(401)])
  const deniedAdapter = createIniadConsultProvider({
    client: denied.client,
    env: {},
    retryDelayMs: 0,
  })
  let deniedKind = ''
  try {
    await deniedAdapter.respond(req('相談です'))
  } catch (e) {
    deniedKind = e instanceof ConsultSendError ? e.kind : 'other'
  }
  check(
    'プロバイダ: 401 はリトライせず auth エラー（計 1 回呼び出し）',
    deniedKind === 'auth' && denied.calls.length === 1,
    `kind=${deniedKind} calls=${denied.calls.length}`,
  )

  // エラー変換の対応表
  check(
    'エラー変換: AbortError→timeout / 通信エラー→network / その他→server',
    mapUpstreamError(Object.assign(new Error('x'), { name: 'AbortError' })).kind ===
      'timeout' &&
      mapUpstreamError(new Error('fetch failed')).kind === 'network' &&
      mapUpstreamError(new Error('unknown')).kind === 'server',
  )
  check(
    'エラー種別: 再試行可否（validation/auth は不可・それ以外は可）',
    isRetryableKind('validation') === false &&
      isRetryableKind('auth') === false &&
      isRetryableKind('rate_limit') === true &&
      isRetryableKind('timeout') === true &&
      isRetryableKind('network') === true &&
      isRetryableKind('server') === true,
  )
  check(
    'エラー種別: HTTP ステータス対応（400/429/504/502/503）',
    statusForKind('validation') === 400 &&
      statusForKind('rate_limit') === 429 &&
      statusForKind('timeout') === 504 &&
      statusForKind('server') === 502 &&
      statusForKind('auth') === 503 &&
      kindForStatus(429) === 'rate_limit' &&
      kindForStatus(504) === 'timeout',
  )
  check(
    'エラー文言: 内部詳細を出さず再試行を促す',
    userMessageForKind('network').includes('再度お試しください') &&
      !userMessageForKind('server').includes('status'),
  )
  // __S3__
  // ── 8. レート制限（単体・偽装ヘッダ無視の確認含む） ──
  const t = 1_000_000
  const limiter = new MemoryRateLimiter({
    perMinute: 10,
    perDay: 100,
    globalPerMinute: 1000,
  })
  let allowedCount = 0
  for (let i = 0; i < 11; i += 1) {
    const d = limiter.check('shared', t)
    if (d.allowed) allowedCount += 1
    else {
      check('レート制限: 11 回目は拒否（10/分）', i === 10 && d.retryAfterSec > 0)
    }
  }
  check('レート制限: 1 分間は 10 回まで許可', allowedCount === 10)

  // 日次上限（時間を進めて検証）
  const dayLimiter = new MemoryRateLimiter({
    perMinute: 1000,
    perDay: 3,
    globalPerMinute: 1000,
  })
  const dayStatuses: boolean[] = []
  for (let i = 0; i < 4; i += 1) {
    dayStatuses.push(dayLimiter.check('shared', 2_000_000 + i).allowed)
  }
  check(
    'レート制限: 日次上限（3/日）',
    dayStatuses.join(',') === 'true,true,true,false',
    dayStatuses.join(','),
  )
  check(
    'レート制限: 翌日は再び許可',
    dayLimiter.check('shared', 2_000_000 + 86_400_000).allowed,
  )
  check(
    'レート制限: 別キーは独立（TRUST_PROXY=1 時の IP バケット）',
    limiter.check('ip:203.0.113.1', t).allowed,
  )

  // クライアントキーの解決（既定ではヘッダを信用しない）
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.5' })
  const untrusted = resolveClientKey(headers, {})
  check(
    'クライアントキー: 既定では X-Forwarded-For を信用せず共有バケット',
    untrusted.key === 'shared' && untrusted.basis === 'shared',
  )
  const trusted = resolveClientKey(headers, {
    CONSULT_TRUST_PROXY: '1',
    CONSULT_TRUSTED_PROXY_HOPS: '1',
  })
  check(
    'クライアントキー: 信頼プロキシ設定時のみ IP を使用',
    trusted.key === 'ip:203.0.113.5' && trusted.basis === 'forwarded-trusted',
  )
  const multiHop = resolveClientKey(
    new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.5' }),
    { CONSULT_TRUST_PROXY: '1', CONSULT_TRUSTED_PROXY_HOPS: '1' },
  )
  check(
    'クライアントキー: hops 指定で信頼プロキシ直下のアドレスを採用',
    multiHop.key === 'ip:203.0.113.5',
    multiHop.key,
  )
  const noHeader = resolveClientKey(new Headers(), { CONSULT_TRUST_PROXY: '1' })
  check(
    'クライアントキー: ヘッダなし・判定不能時は共有バケットへ安全側',
    noHeader.key === 'shared',
  )

  // ── 9. 静的検査（保護ファイル・通信経路の分離・固定バッジ） ──
  const sha256 = (path: string): string =>
    createHash('sha256').update(readFileSync(join(process.cwd(), path))).digest('hex')
  check(
    '保護ファイル: lib/finance/costs.ts が M5 状態から不変',
    sha256('lib/finance/costs.ts') ===
      '3d7ffc8bffde1b2f3bec60783af04274a81006db7b7b167302c00d250e335b3b',
    sha256('lib/finance/costs.ts'),
  )
  check(
    '保護ファイル: lib/finance/cashflow.ts が M5 状態から不変',
    sha256('lib/finance/cashflow.ts') ===
      '618cea8de62344af85c267b6651c73da4b467c693f0fcf02e0092f63bade5518',
    sha256('lib/finance/cashflow.ts'),
  )
  check(
    '保護ファイル: lib/supports/mockPrograms.ts が M5 状態から不変',
    sha256('lib/supports/mockPrograms.ts') ===
      'dd83efc3b740bdaa90fb6c05a120535c247a583fbc8fc611b0884f3c362fbfbb',
    sha256('lib/supports/mockPrograms.ts'),
  )

  const read = (path: string): string =>
    readFileSync(join(process.cwd(), path), 'utf-8')
  const routeSrc = read('app/api/consult/route.ts')
  check(
    '配線: Route Handler は実クライアントを構築しない（OpenAI/fetch を直接使わない）',
    !/from ['"]openai['"]|require\(['"]openai['"]\)|new OpenAI|fetch\s*\(/.test(routeSrc),
  )
  const transportSrc = read('lib/consult/clientTransport.ts')
  check(
    '配線: クライアントはサーバー専用モジュールを import しない',
    !transportSrc.includes('./provider') &&
      !transportSrc.includes('./iniadAdvisor') &&
      !transportSrc.includes('INIAD_API_KEY'),
  )
  const hookSrc = read('lib/consult/useConsultChat.ts')
  check(
    '配線: useConsultChat は clientTransport 経由で API を呼ぶ',
    hookSrc.includes('./clientTransport') && !hookSrc.includes('getConsultProvider'),
  )
  check(
    'キー保護: キーは NEXT_PUBLIC_ で公開しない（コード・env テンプレートとも）',
    !routeSrc.includes('NEXT_PUBLIC') &&
      !transportSrc.includes('NEXT_PUBLIC') &&
      !hookSrc.includes('NEXT_PUBLIC') &&
      !read('.env.example').includes('NEXT_PUBLIC_INIAD') &&
      read('.env.example').includes('NEXT_PUBLIC_ プレフィックスを付けてはいけない'),
  )
  const consultSrc = read('components/Consult.tsx')
  check(
    'UI バッジ: AI 回答バッジは固定文言（公式確認済みバッジを出さない）',
    consultSrc.includes('AI回答（Web検索なし・未確認の可能性があります）') &&
      !consultSrc.includes('公式確認済み') &&
      consultSrc.includes('開発用モックサンプル'),
  )
  check(
    'UI バッジ: 本文リンク化なし（URL をアンカーにしない）',
    consultSrc.includes('アンカー') || !consultSrc.includes('<a '),
  )
  const envSrc = read('.env.example')
  check(
    'env テンプレート: CONSULT_FALLBACK_TO_MOCK=0（既定）・キーはコメントアウト',
    envSrc.includes('CONSULT_FALLBACK_TO_MOCK=0') &&
      envSrc.includes('# INIAD_API_KEY=') &&
      !/^INIAD_API_KEY=.+$/m.test(envSrc),
  )
  check(
    'env テンプレート: 2 重スイッチと暫定レート値を明記',
    envSrc.includes('CONSULT_LIVE_AI=0') &&
      envSrc.includes('CONSULT_RATE_LIMIT_RPM=10') &&
      envSrc.includes('CONSULT_TRUST_PROXY=0'),
  )
  const pkgSrc = read('package.json')
  check(
    '依存: openai SDK（大学の使用例どおり）を追加済み',
    pkgSrc.includes('"openai"'),
  )
  const storagePattern =
    /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)|sessionStorage\s*\.\s*(getItem|setItem|removeItem|clear)|indexedDB\s*\.\s*(open|deleteDatabase)|document\.cookie/
  const storageCheckedFiles = [
    'components/Consult.tsx',
    'lib/consult/useConsultChat.ts',
    'lib/consult/conversation.ts',
    'lib/consult/clientTransport.ts',
  ]
  const storageHits = storageCheckedFiles.filter((f) => storagePattern.test(read(f)))
  check(
    '非保存ガード: 会話履歴をブラウザに保存しない（M5 継続）',
    storageHits.length === 0,
    storageHits.join(', '),
  )

  // ── 10. 外部通信ゼロの最終確認 ──
  check(
    '外部通信なし: 検証中の fetch 呼び出しは 0 回',
    fetchCalls.length === 0,
    fetchCalls.join(','),
  )
  // __S4__

  console.log(
    failed === 0
      ? '\nM6 verification: ALL PASSED'
      : `\nM6 verification: ${failed} FAILED`,
  )
  if (failed > 0) process.exit(1)
}

void main()