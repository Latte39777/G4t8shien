/**
 * M6-E（INIAD API 接続準備・AI 相談の設計確認）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-m6e.tsx
 *
 * 確認項目:
 * A. 確認済み仕様のみへの依存（Responses API / web_search / structured outputs 不使用）
 * B. Web 検索（公式情報の取得）と AI 生成の分離
 * C. 公式出典の検証（URL 未検証・非公式は確認済み扱いしない）
 * D. 金額計算と AI 応答の分離・未確認表示の維持
 * E. API キーの秘匿（サーバー側 env のみ・クライアント露出なし）
 * F. 設計書（docs/consult-m6e-design.md）の整合
 * G. 外部通信ゼロの最終確認
 *
 * 外部 API への通信は一切行わない（fetch ガードで確認）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_INIAD_BASE_URL,
  DEFAULT_INIAD_MODEL,
  buildSystemPrompt,
  createIniadConsultProvider,
  resolveCapabilityFlags,
  type ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import {
  UNAVAILABLE_OFFICIAL_SOURCE_CLIENT,
  buildEvidenceContext,
  isConfirmedOfficialSource,
  toSupportSource,
  type OfficialSourceRecord,
} from '../lib/consult/officialSource'
import {
  LIMITED_FALLBACK_REPLY,
  aiReplyJsonSchema,
  parseAiReplyJson,
  toConsultReplyFromAi,
} from '../lib/consult/replySchema'
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

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

const req = (message: string): ConsultRequest => ({
  message,
  history: [],
  program: null,
  userContext: null,
})

/** 出典レコードの生成（検証パターン用） */
const record = (
  over: Partial<OfficialSourceRecord> = {},
): OfficialSourceRecord => ({
  title: '子育て支援制度',
  organization: 'example 自治体',
  url: 'https://example.go.jp/kosodate',
  urlVerified: true,
  official: true,
  checkedAt: '2026-10-15',
  excerpt: null,
  ...over,
})

async function main(): Promise<void> {
  const iniadSrc = read('lib/consult/iniadAdvisor.ts')
  const officialSrc = read('lib/consult/officialSource.ts')
  const docSrc = read('docs/consult-m6e-design.md')
  const envSrc = read('.env.example')

  // ── A. 確認済み仕様のみへの依存 ──
  console.log('── A. 確認済み仕様のみへの依存 ──')
  check(
    'INIAD クライアントは chat.completions 形式のみ（Responses API の呼び出しなし）',
    !iniadSrc.includes('responses.create') && !iniadSrc.includes('.responses.'),
  )
  check(
    'structured outputs のパラメータを使用しない（response_format / json_schema 不使用）',
    !iniadSrc.includes('response_format') && !iniadSrc.includes('json_schema'),
  )
  check(
    '既定 Base URL / モデルは確認済み仕様の定数（env で上書き可能）',
    DEFAULT_INIAD_BASE_URL === 'https://api.openai.iniad.org/api/v1' &&
      DEFAULT_INIAD_MODEL === 'gpt-5.4' &&
      iniadSrc.includes('env.CONSULT_MODEL') &&
      iniadSrc.includes('env.CONSULT_API_BASE_URL'),
  )
  let searchRejected = false
  try {
    resolveCapabilityFlags({ CONSULT_AI_SEARCH: 'on' })
  } catch {
    searchRejected = true
  }
  check(
    '能力フラグ: Web 検索は off 固定（on 指定は起動エラー）',
    searchRejected &&
      resolveCapabilityFlags({}).search === 'off' &&
      resolveCapabilityFlags({}).jsonMode === 'prompt',
  )
  check(
    'システムプロンプトが検索したふり・制度値の断定を禁止（学習知識だけで確定しない）',
    buildSystemPrompt({ search: 'off', jsonMode: 'prompt' }).includes(
      'Web検索は利用できません',
    ),
  )
  const calls: Array<Record<string, unknown>> = []
  const fake: ChatCompletionsLike = {
    create(params) {
      calls.push(params as unknown as Record<string, unknown>)
      return Promise.resolve({
        content: '{"reply": "確認質問をさせてください。"}',
      })
    },
  }
  await createIniadConsultProvider({
    client: fake,
    env: {},
    retryDelayMs: 0,
    timeoutMs: 1000,
  }).respond(req('支援制度について教えて'))
  const sent = calls[0] ?? {}
  check(
    '送信パラメータは model / messages のみ（確認済み仕様外のパラメータを送らない）',
    calls.length === 1 && Object.keys(sent).sort().join(',') === 'messages,model',
    Object.keys(sent).sort().join(','),
  )
  // ── B. Web 検索（公式情報の取得）と AI 生成の分離 ──
  console.log('── B. Web 検索（公式情報の取得）と AI 生成の分離 ──')
  check(
    '公式情報モジュールは AI クライアントを import しない',
    !officialSrc.includes("from 'openai'") &&
      !officialSrc.includes("from './iniadAdvisor'"),
  )
  check(
    '公式情報モジュールは外部通信を実装しない（fetch 等の使用なし）',
    !officialSrc.includes('fetch(') && !officialSrc.includes('XMLHttpRequest'),
  )
  check(
    'AI モデル側は公式情報の取得を直接しない（iniadAdvisor が officialSource を import しない）',
    !iniadSrc.includes("from './officialSource'") && !iniadSrc.includes('fetch('),
  )
  check(
    '検索と取得が別機能（search と fetchSource の両方を定義）',
    typeof UNAVAILABLE_OFFICIAL_SOURCE_CLIENT.search === 'function' &&
      typeof UNAVAILABLE_OFFICIAL_SOURCE_CLIENT.fetchSource === 'function' &&
      officialSrc.includes('search(query') &&
      officialSrc.includes('fetchSource(url'),
  )
  const searchOutcome = await UNAVAILABLE_OFFICIAL_SOURCE_CLIENT.search('給付')
  const fetchOutcome = await UNAVAILABLE_OFFICIAL_SOURCE_CLIENT.fetchSource(
    'https://example.go.jp/x',
  )
  check(
    '未実装クライアントは外部通信なしで「利用不可」を返す（not-implemented）',
    searchOutcome.ok === false &&
      searchOutcome.reason === 'not-implemented' &&
      fetchOutcome.ok === false &&
      fetchOutcome.reason === 'not-implemented',
  )

  // ── C. 公式出典の検証（URL 未検証・非公式は確認済み扱いしない） ──
  console.log('── C. 公式出典の検証 ──')
  check(
    'URL 未検証の情報は確認済み扱いしない',
    isConfirmedOfficialSource(record({ urlVerified: false })) === false,
  )
  check(
    '非公式の情報は確認済み扱いしない',
    isConfirmedOfficialSource(record({ official: false })) === false,
  )
  check(
    'URL なしは確認済み扱いしない（URL を推測・補完しない）',
    isConfirmedOfficialSource(record({ url: null, urlVerified: true })) === false,
  )
  check(
    'urlVerified かつ official の情報のみ確認済み扱い',
    isConfirmedOfficialSource(record()) === true,
  )
  check(
    'evidence の URL ポリシーで正規化される（url なしなら urlVerified は false に落ちる）',
    toSupportSource(record({ url: null, urlVerified: true })).urlVerified ===
      false,
  )
  // ── D. 金額計算と AI 応答の分離・未確認表示の維持 ──
  console.log('── D. 金額計算と AI 応答の分離・未確認表示の維持 ──')
  const schemaKeys = Object.keys(aiReplyJsonSchema.shape).sort().join(',')
  check(
    'AI 応答スキーマは reply / clarificationQuestions / unsupported / programIds のみ（金額・出典フィールドなし）',
    schemaKeys === 'clarificationQuestions,programIds,reply,unsupported',
    schemaKeys,
  )
  const withExtras = parseAiReplyJson(
    JSON.stringify({
      reply: '確認質問をさせてください。',
      programs: [{ amount: 999999 }],
      sources: ['https://example.go.jp'],
      unsupported: true,
    }),
  )
  check(
    'スキーマ外フィールド（programs / sources など）は破棄される（strip）',
    withExtras !== null &&
      withExtras.reply === '確認質問をさせてください。' &&
      !JSON.stringify(withExtras).includes('programs') &&
      !JSON.stringify(withExtras).includes('sources'),
  )
  const aiReply = toConsultReplyFromAi({
    reply: '確認質問をさせてください。',
    clarificationQuestions: ['年齢は？'],
    unsupported: false,
  })
  check(
    'AI 応答は常に未確認表示を維持（hasUnverified=true・関連制度なし・検証日なし）',
    aiReply.hasUnverified === true &&
      aiReply.relatedPrograms.length === 0 &&
      aiReply.checkedAt === null,
  )
  check(
    'AI 応答の sourceType は ai（検証済み kb / web を名乗らない）',
    aiReply.sourceType === 'ai' && LIMITED_FALLBACK_REPLY.hasUnverified === true,
  )
  const emptyContext = buildEvidenceContext([])
  check(
    '公式情報を取得できない場合は確認済み材料ゼロ（未確認表示を維持する）',
    emptyContext.allUnverified === true && emptyContext.confirmedLines.length === 0,
  )
  const mixedContext = buildEvidenceContext([
    record(),
    record({ title: '未検証情報', urlVerified: false }),
  ])
  check(
    '確認済みと未確認を混ぜない（未確認は確定材料にならない）',
    mixedContext.allUnverified === false &&
      mixedContext.confirmedLines.length === 1 &&
      mixedContext.unconfirmed.length === 1,
  )
  const consultSrcs = [
    'api.ts',
    'iniadAdvisor.ts',
    'mockAdvisor.ts',
    'officialSource.ts',
    'provider.ts',
    'replySchema.ts',
  ]
    .map((f) => read('lib/consult/' + f))
    .join('')
  check(
    'AI 相談層は支援額計算を import しない（金額計算は決定論モジュール専管）',
    !consultSrcs.includes('finance/supports') &&
      !consultSrcs.includes('supports/estimate'),
  )

  // ── E. API キーの秘匿（サーバー側 env のみ） ──
  console.log('── E. API キーの秘匿 ──')
  check(
    '公式情報モジュールは API キー・env を扱わない',
    !officialSrc.includes('INIAD_API_KEY') && !officialSrc.includes('process.env'),
  )
  check(
    '新規モジュールにクライアント露出プレフィックスなし',
    !officialSrc.includes('NEXT_PUBLIC'),
  )
  check(
    'env テンプレートのキーはコメントアウトのまま（コミット・露出なし）',
    envSrc.includes('# INIAD_API_KEY=') && !/^INIAD_API_KEY=.+$/m.test(envSrc),
  )
  // ── F. 設計書の整合（docs/consult-m6e-design.md） ──
  console.log('── F. 設計書の整合 ──')
  check(
    '設計書が未確認事項を明記（Responses API / web_search / 料金 / 学外公開）',
    docSrc.includes('未確認') &&
      docSrc.includes('Responses API') &&
      docSrc.includes('web_search') &&
      docSrc.includes('料金') &&
      docSrc.includes('学外公開'),
  )
  check(
    '設計書が外部通信ゼロの調査範囲を明記',
    docSrc.includes('リクエストは一切行っていない') &&
      docSrc.includes('自動巡回'),
  )
  check(
    '設計書が責務分離（API 通信 / 公式情報の取得 / 情報整理 / スキーマ検証 / 出典検証 / 金額計算 / モック切替）を定義',
    [
      'API 通信',
      '公式情報の取得',
      '情報整理',
      'スキーマ検証',
      '出典検証',
      '金額計算',
      'モック',
    ].every((t) => docSrc.includes(t)),
  )

  // ── G. 外部通信ゼロの最終確認 ──
  console.log('── G. 外部通信ゼロの最終確認 ──')
  check('検証中の外部通信 0 回（API エンドポイントへのアクセスなし）', fetchCalls.length === 0)

  if (failed > 0) {
    console.log('M6-E verification: FAILED (' + failed + ')')
    process.exitCode = 1
    return
  }
  console.log('M6-E verification: ALL PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})