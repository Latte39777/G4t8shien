/**
 * /api/consult スモークテスト（M6 フェーズ1 / G0）
 *
 * 実行: npx tsx scripts/smoke-consult-api.ts
 *
 * - 実 Route Handler を含めすべてローカルで検証する（偽クライアント/偽
 *   プロバイダを注入）。外部 API への通信は一切行わない（fetch ガードで確認）
 * - 確認項目: 既定モック配線 / リクエスト形状（金額なし）/ 障害時の
 *   エラー表示＋再試行（check-A・C）/ 明示設定時のみラベル付きモック
 *   フォールバック（check-B）/ 入力検証 / 具体的制度値フィールドの破棄 /
 *   JSON パース失敗リトライ / 429・タイムアウト・5xx / PII マスキング /
 *   レート制限と偽装ヘッダの無視
 */
import { POST } from '../app/api/consult/route'
import {
  handleConsultRequest,
  isFallbackToMockEnabled,
} from '../lib/consult/api'
import { ConsultSendError } from '../lib/consult/errors'
import {
  createIniadConsultProvider,
  type ChatCompletionParams,
  type ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import { MemoryRateLimiter } from '../lib/consult/rateLimit'
import type {
  ConsultProvider,
  ConsultRequest,
  ConsultReply,
} from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

// ── 外部通信ガード: テスト中の fetch を封じて呼び出しを記録する ──
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown) => {
  fetchCalls.push(String(input))
  return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
}) as typeof fetch

const silentLogger = { warn: () => {}, error: () => {} }

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validBody = {
  message: '申請はどこですればいい？',
  history: [],
  program: null,
  userContext: null,
}

const okReply: ConsultReply = {
  text: '応答',
  isMock: false,
  hasUnverified: true,
  relatedPrograms: [],
  unsupported: false,
  sourceType: 'ai',
}

function liveProvider(
  respond: (request: ConsultRequest) => Promise<ConsultReply>,
): ConsultProvider {
  return { id: 'iniad-live', label: 'AI回答（テスト）', isMock: false, respond }
}

/** 応答列（文字列 or 例外）を順に返す偽クライアント */
function fakeClient(responses: Array<string | Error>): {
  client: ChatCompletionsLike
  calls: ChatCompletionParams[]
} {
  const calls: ChatCompletionParams[] = []
  let i = 0
  return {
    calls,
    client: {
      create(params: ChatCompletionParams): Promise<{ content: string | null }> {
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

async function main(): Promise<void> {
  // テスト自体が Live を有効化しない（2 重スイッチ未設定の確認）
  delete process.env.CONSULT_LIVE_AI
  delete process.env.INIAD_API_KEY
  delete process.env.CONSULT_FALLBACK_TO_MOCK

  // ── 1. 実 Route ワイヤリング（既定 = モック・外部通信なし） ──
  const mockRes = await POST(jsonRequest(validBody))
  const mockBody = (await mockRes.json()) as ConsultReply
  check('実 Route: 既定で 200（モック応答）', mockRes.status === 200)
  check(
    '実 Route: Live 未設定時はモック（isMock=true・AI 出所ではない）',
    mockBody.isMock === true && mockBody.sourceType !== 'ai',
  )
  check('実 Route: この時点でも外部通信ゼロ', fetchCalls.length === 0)

  // ── 2. プロバイダへ渡すリクエスト形状（最小限・金額なし） ──
  const capturedBox: { request: ConsultRequest | null } = { request: null }
  const capturing = liveProvider((request) => {
    capturedBox.request = request
    return Promise.resolve(okReply)
  })
  await handleConsultRequest(
    jsonRequest({
      message: '自分の状況で対象になりそうな支援は？',
      history: [],
      program: {
        id: 'p1',
        name: 'テスト制度',
        summary: '概要',
        amountDescription: '金額の説明',
        where: '窓口',
        deadlineNote: '期限',
        missingInformation: [],
        mock: true,
      },
      userContext: {
        childCount: 2,
        hasAnnualIncome: true,
        usedProgramIds: ['x'],
      },
    }),
    { resolveProvider: () => capturing, env: {}, logger: silentLogger },
  )
  const captured = capturedBox.request
  const keys = captured ? Object.keys(captured).sort() : []
  check(
    'リクエスト形状: message/history/program/userContext のみ',
    JSON.stringify(keys) ===
      JSON.stringify(['history', 'message', 'program', 'userContext']),
    keys.join(','),
  )
  const userContextKeys = captured?.userContext
    ? Object.keys(captured.userContext).sort()
    : []
  check(
    'リクエスト形状: userContext に金額フィールドがない',
    JSON.stringify(userContextKeys) ===
      JSON.stringify(['childCount', 'hasAnnualIncome', 'usedProgramIds']),
    userContextKeys.join(','),
  )
  check(
    'リクエスト形状: 送信データに年収・貯蓄の金額が含まれない',
    !JSON.stringify(captured).includes('4000000') &&
      !JSON.stringify(captured).includes('Yen'),
  )
  // ── 3. check-A: 既定（CONSULT_FALLBACK_TO_MOCK 未設定）はエラー表示＋再試行 ──
  const failing = liveProvider(() =>
    Promise.reject(new ConsultSendError('network')),
  )
  const resA = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => failing,
    env: {},
    logger: silentLogger,
  })
  const bodyA = (await resA.json()) as {
    error?: { kind?: string; message?: string }
  }
  check('check-A: 既定ではエラー応答（502）', resA.status === 502, String(resA.status))
  check(
    'check-A: モック応答へ切り替えない（ラベルも本文も出さない）',
    bodyA.error !== undefined &&
      !JSON.stringify(bodyA).includes('モック応答に切り替えました'),
  )
  check(
    'check-A: 再試行を促す文言',
    (bodyA.error?.message ?? '').includes('再度お試しください'),
  )
  check(
    'check-C: 既定フラグは 0（フォールバック無効）',
    isFallbackToMockEnabled({}) === false &&
      isFallbackToMockEnabled({ CONSULT_FALLBACK_TO_MOCK: '0' }) === false &&
      isFallbackToMockEnabled({ CONSULT_FALLBACK_TO_MOCK: '1' }) === true,
  )

  // ── 4. check-B: 明示設定時のみラベル付きモックフォールバック ──
  const resB = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => failing,
    env: { CONSULT_FALLBACK_TO_MOCK: '1' },
    logger: silentLogger,
  })
  const bodyB = (await resB.json()) as ConsultReply
  check('check-B: 明示設定時は 200 で応答', resB.status === 200)
  check(
    'check-B: 必ず「モック応答に切り替えました」と障害原因を明示',
    bodyB.text.includes('モック応答に切り替えました') &&
      bodyB.text.includes('通信エラー'),
  )
  check(
    'check-B: モック出所・未確認として扱う',
    bodyB.isMock === true && bodyB.sourceType === 'mock-fallback',
  )

  // ── 5. 入力検証（400） ──
  const resBadJson = await handleConsultRequest(jsonRequest('不正なJSON{'), {
    resolveProvider: () => capturing,
    env: {},
    logger: silentLogger,
  })
  check('入力検証: 不正な JSON は 400', resBadJson.status === 400)
  const resLong = await handleConsultRequest(
    jsonRequest({ ...validBody, message: 'あ'.repeat(1001) }),
    { resolveProvider: () => capturing, env: {}, logger: silentLogger },
  )
  const bodyLong = (await resLong.json()) as { error?: { message?: string } }
  check(
    '入力検証: 質問が長すぎる場合は 400 で上限を通知',
    resLong.status === 400 && (bodyLong.error?.message ?? '').includes('長すぎ'),
  )
  const resEmpty = await handleConsultRequest(
    jsonRequest({ ...validBody, message: '' }),
    { resolveProvider: () => capturing, env: {}, logger: silentLogger },
  )
  check('入力検証: 空の質問は 400', resEmpty.status === 400)
  // ── 6. 具体的制度値フィールドの破棄（API 経由で adapter を検証） ──
  const withPrograms = fakeClient([
    JSON.stringify({
      reply: '制度の詳細は公式窓口でご確認ください（未確認）。',
      clarificationQuestions: [],
      unsupported: false,
      programs: [{ name: '架空の給付金', amount: 999999, deadline: '3月31日' }],
      sources: [{ url: 'https://example.invalid' }],
    }),
  ])
  const adapter = createIniadConsultProvider({
    client: withPrograms.client,
    env: {},
    retryDelayMs: 0,
  })
  const resDrop = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => adapter,
    env: {},
    logger: silentLogger,
  })
  const bodyDrop = (await resDrop.json()) as ConsultReply
  check('フィールド破棄: 200 で応答', resDrop.status === 200)
  check(
    'フィールド破棄: programs/sources フィールドは破棄される',
    bodyDrop.relatedPrograms.length === 0 &&
      !bodyDrop.text.includes('架空の給付金') &&
      !bodyDrop.text.includes('999999') &&
      !bodyDrop.text.includes('example.invalid'),
  )
  check(
    'フィールド破棄: 未確認ラベル前提の固定値（isMock=false・hasUnverified=true）',
    bodyDrop.isMock === false &&
      bodyDrop.hasUnverified === true &&
      bodyDrop.sourceType === 'ai',
  )

  // ── 7. JSON パース失敗リトライ（1 回再依頼→失敗なら生出力を破棄） ──
  const flaky = fakeClient([
    'すみません、JSON ではなく散文で答えます。',
    JSON.stringify({ reply: '再依頼で JSON を返しました。', unsupported: false }),
  ])
  const flakyAdapter = createIniadConsultProvider({
    client: flaky.client,
    env: {},
    retryDelayMs: 0,
  })
  const resRetry = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => flakyAdapter,
    env: {},
    logger: silentLogger,
  })
  const bodyRetry = (await resRetry.json()) as ConsultReply
  check(
    'パース失敗リトライ: 1 回再依頼して JSON 応答を採用（2 回呼び出し）',
    flaky.calls.length === 2 && bodyRetry.text.includes('再依頼で JSON'),
  )
  const hopeless = fakeClient(['JSON ではない応答その1', 'JSON ではない応答その2'])
  const hopelessAdapter = createIniadConsultProvider({
    client: hopeless.client,
    env: {},
    retryDelayMs: 0,
  })
  const resHopeless = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => hopelessAdapter,
    env: {},
    logger: silentLogger,
  })
  const bodyHopeless = (await resHopeless.json()) as ConsultReply
  check(
    'パース失敗リトライ: 再依頼しても駄目なら生出力を破棄して限定文のみ',
    bodyHopeless.text.includes('回答を準備できませんでした') &&
      !bodyHopeless.text.includes('JSON ではない応答') &&
      bodyHopeless.unsupported === true,
  )

  // ── 8. PII マスキング（API 送信前の個人情報を伏せる） ──
  const pii = fakeClient([JSON.stringify({ reply: '確認してご連絡ください。' })])
  const piiAdapter = createIniadConsultProvider({
    client: pii.client,
    env: {},
    retryDelayMs: 0,
  })
  await handleConsultRequest(
    jsonRequest({
      ...validBody,
      message: '私の電話は090-1234-5678、メールは taro@example.com です',
    }),
    { resolveProvider: () => piiAdapter, env: {}, logger: silentLogger },
  )
  const sentPayload = JSON.stringify(pii.calls)
  check(
    'PII マスキング: 電話番号・メールをマスクして API へ送る',
    sentPayload.includes('［電話番号］') &&
      sentPayload.includes('［メールアドレス］'),
  )
  check(
    'PII マスキング: 元の個人情報が送信ペイロードに残らない',
    !sentPayload.includes('090-1234-5678') &&
      !sentPayload.includes('taro@example.com'),
  )
  // ── 9. レート制限と偽装ヘッダの無視 ──
  let liveCalls = 0
  const cheapLive = liveProvider(() => {
    liveCalls += 1
    return Promise.resolve(okReply)
  })
  const strictLimiter = new MemoryRateLimiter({
    perMinute: 3,
    perDay: 100,
    globalPerMinute: 100,
  })
  const statuses: number[] = []
  for (let i = 0; i < 5; i += 1) {
    const res = await handleConsultRequest(
      jsonRequest(validBody, { 'x-forwarded-for': `203.0.113.${i}` }),
      {
        resolveProvider: () => cheapLive,
        env: {},
        rateLimiter: strictLimiter,
        logger: silentLogger,
      },
    )
    statuses.push(res.status)
  }
  check(
    'レート制限: 4 回目以降は 429（偽装 X-Forwarded-For は無視して共有バケット）',
    statuses.slice(0, 3).every((s) => s === 200) &&
      statuses.slice(3).every((s) => s === 429),
    statuses.join(','),
  )
  const res429 = await handleConsultRequest(
    jsonRequest(validBody, { 'x-forwarded-for': '198.51.100.9' }),
    {
      resolveProvider: () => cheapLive,
      env: {},
      rateLimiter: strictLimiter,
      logger: silentLogger,
    },
  )
  check(
    'レート制限: 429 に Retry-After ヘッダ付き',
    res429.status === 429 && res429.headers.get('retry-after') !== null,
  )

  // 信頼プロキシ明示設定時のみ IP 単位バケットへ分離
  const trustedLimiter = new MemoryRateLimiter({
    perMinute: 2,
    perDay: 100,
    globalPerMinute: 100,
  })
  const trustedEnv = { CONSULT_TRUST_PROXY: '1', CONSULT_TRUSTED_PROXY_HOPS: '1' }
  const trustedStatuses: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const res = await handleConsultRequest(
      jsonRequest(validBody, { 'x-forwarded-for': i < 2 ? '203.0.113.7' : '203.0.113.8' }),
      {
        resolveProvider: () => cheapLive,
        env: trustedEnv,
        rateLimiter: trustedLimiter,
        logger: silentLogger,
      },
    )
    trustedStatuses.push(res.status)
  }
  check(
    'レート制限: TRUST_PROXY=1 では IP 単位バケット（別 IP は影響を受けない）',
    trustedStatuses.join(',') === '200,200,200,200' && liveCalls === 3 + 4,
    trustedStatuses.join(','),
  )
  // __RATE_LIMIT_SECTION__
  // ── 10. エラー種別 → HTTP ステータス（エラー表示＋再試行） ──
  const kindCases: Array<[ConsultSendError, number]> = [
    [new ConsultSendError('rate_limit'), 429],
    [new ConsultSendError('timeout'), 504],
    [new ConsultSendError('server'), 502],
    [new ConsultSendError('auth'), 503],
    [new ConsultSendError('invalid_response'), 502],
  ]
  for (const [error, expected] of kindCases) {
    const res = await handleConsultRequest(jsonRequest(validBody), {
      resolveProvider: () =>
        liveProvider(() => Promise.reject(error)),
      env: {},
      rateLimiter: new MemoryRateLimiter({
        perMinute: 100,
        perDay: 1000,
        globalPerMinute: 1000,
      }),
      logger: silentLogger,
    })
    const body = (await res.json()) as { error?: { kind?: string } }
    check(
      `エラー表示: ${error.kind} → ${expected}`,
      res.status === expected && body.error?.kind === error.kind,
      `${res.status}/${body.error?.kind}`,
    )
  }
  // __ERROR_MAPPING_SECTION__
  // ── 11. 外部通信ゼロの最終確認 ──
  check(
    '外部通信なし: テスト中の fetch 呼び出しは 0 回',
    fetchCalls.length === 0,
    fetchCalls.join(','),
  )
  // __PART4__

  console.log(
    `\nsmoke-consult-api: ${failed === 0 ? 'ALL PASSED' : `${failed} 件失敗`}`,
  )
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`)
    process.exitCode = 1
  }
}

void main()