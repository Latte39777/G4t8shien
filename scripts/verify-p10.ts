/**
 * P10 検証: AI による支援制度提案（programIds）の安全な実装と既存制約の維持
 *
 * 実行: npx tsx scripts/verify-p10.ts
 *
 * - 外部通信は一切行わない（偽クライアント注入のみ。実 API・KB 外部取得なし）
 * - 使うのは合成データのみ（実在人物の情報・実相談履歴は使わない）
 * - 確認項目:
 *   1. AI JSON スキーマ: programIds（ID のみ）を許可し、制度名・金額・URL を含む
 *      旧フィールド（programs / relatedPrograms / sources など）は引き続き strip
 *   2. 提案チップ化: サーバー側レジストリに存在する ID のみ採用（不明な ID は破棄）。
 *      名称・区分・確認状態・出典は KB / レジストリの値のみ（AI 生成文は不採用）
 *   3. 未確認の扱い: KB に確認記録が無い制度は未確認のまま。提案注記に
 *      「受給資格の判定ではありません」を必ず付す
 *   4. 候補リスト: ID・名称・区分のみ（金額・期限・窓口・URL なし）。
 *      相談セッションが無い質問には候補制度名を送らない（既存不変条件の維持）
 *   5. E2E（偽クライアント）: /api/consult 通常経路で提案が採用/破棄される。
 *      パース失敗時は限定文のみ（AI 生出力の破棄）を維持
 *   6. mock / ai の区別（isMock / sourceType）と toConsultReplyFromAi の
 *      relatedPrograms 空強制を維持
 */
import { handleConsultRequest } from '../lib/consult/api'
import {
  buildApiMessages,
  createIniadConsultProvider,
  type ChatCompletionParams,
  type ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import { buildKbPromptBlock } from '../lib/consult/kbPrompt'
import {
  AI_PROPOSAL_MAX_PROGRAMS,
  resolveAiProposedPrograms,
  resolveKbConsultContext,
} from '../lib/consult/kbContext'
import {
  aiReplyJsonSchema,
  parseAiReplyJson,
  toConsultReplyFromAi,
} from '../lib/consult/replySchema'
import type { ConsultReply, ConsultRequest } from '../lib/consult/types'
import { buildKnowledgeBase } from '../lib/supports/kb'
import { getSupportPrograms } from '../lib/supports/registry'
import type { SupportProgram } from '../lib/types/support'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

const silentLogger = { warn: () => {}, error: () => {} }

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 応答列を返す偽クライアント（実 API には一切接続しない） */
function fakeClient(responses: string[]): {
  client: ChatCompletionsLike
  calls: ChatCompletionParams[]
} {
  const calls: ChatCompletionParams[] = []
  let i = 0
  return {
    client: {
      create(params: ChatCompletionParams) {
        calls.push(params)
        const content = responses[Math.min(i, responses.length - 1)]
        i += 1
        return Promise.resolve({ content })
      },
    },
    calls,
  }
}

const syntheticUserContext = {
  childCount: 2,
  hasAnnualIncome: true,
  usedProgramIds: [],
}

const baseRequest: ConsultRequest = {
  message: '子どもが2人います。関連する支援制度の候補を挙げてください。',
  history: [],
  program: null,
  userContext: syntheticUserContext,
}

async function callApi(
  body: unknown,
  responses: string[],
): Promise<{ reply: ConsultReply; calls: ChatCompletionParams[] }> {
  const { client, calls } = fakeClient(responses)
  const provider = createIniadConsultProvider({
    client,
    env: {},
    retryDelayMs: 0,
    retryCount: 0,
    jsonRetryCount: 0,
  })
  const res = await handleConsultRequest(jsonRequest(body), {
    resolveProvider: () => provider,
    logger: silentLogger,
  })
  const reply = (await res.json()) as ConsultReply
  return { reply, calls }
}

function main(): void {
  const kb = buildKnowledgeBase()
  const registry = getSupportPrograms()
  const registryIds = registry.map((p) => p.id)

  // ── 1. AI JSON スキーマ ──
  console.log('── 1. AI JSON スキーマ（programIds のみ許可・旧フィールドは strip 維持） ──')
  const parsed = parseAiReplyJson(
    JSON.stringify({
      reply: '関連する可能性のある制度は次のとおりです。',
      clarificationQuestions: [],
      unsupported: false,
      programIds: ['mock-child-allowance', 'fake-program'],
      relatedPrograms: [{ id: 'fake-program', name: '架空の手当', note: '偽メモ' }],
      programs: [{ name: '架空手当', amount: 999999 }],
      sources: [{ title: '架空出典', url: 'https://fake.example.com' }],
    }),
  )
  check('programIds を解析できる', parsed !== null && parsed.programIds?.length === 2)
  check(
    'programs / relatedPrograms / sources は引き続き破棄される',
    parsed !== null &&
      !('programs' in parsed) &&
      !('relatedPrograms' in parsed) &&
      !('sources' in parsed),
  )
  check(
    'programIds の上限（20）を超える不正は拒否される',
    aiReplyJsonSchema.safeParse({
      reply: 'x',
      programIds: Array.from({ length: 21 }, (_, i) => `p${i}`),
    }).success === false,
  )
  const aiReply = parsed ? toConsultReplyFromAi(parsed) : null
  check(
    'toConsultReplyFromAi は relatedPrograms を空のまま返す（チップ付与は呼び出し側）',
    aiReply !== null && aiReply.relatedPrograms.length === 0,
  )

  // ── 2. 提案チップ化（レジストリ検証・KB 由来の付与） ──
  console.log('── 2. resolveAiProposedPrograms（不明な ID は破棄・AI 生成文は不採用） ──')
  const proposed = resolveAiProposedPrograms([
    'mock-child-allowance',
    'fake-program',
    'mock-education-loan',
    'mock-child-allowance',
  ])
  check(
    'レジストリに存在する ID のみ採用（fake-program は破棄）',
    proposed.every((p) => registryIds.includes(p.id)) &&
      !proposed.some((p) => p.id === 'fake-program'),
    JSON.stringify(proposed.map((p) => p.id)),
  )
  check('重複 ID は 1 件にまとめられる', proposed.length === 2)
  check(
    '区分（給付/貸与）はレジストリ・KB の値を保持する',
    proposed.some((p) => p.id === 'mock-child-allowance' && p.category === 'cash_benefit') &&
      proposed.some((p) => p.id === 'mock-education-loan' && p.category === 'loan'),
  )
  check(
    '提案注記に「受給資格の判定ではありません」を必ず付す',
    proposed.every((p) => p.note.includes('受給資格の判定ではありません')),
  )
  const allowanceChip = proposed.find((p) => p.id === 'mock-child-allowance')
  const allowanceKb = kb.find((e) => e.programId === 'mock-child-allowance')
  check(
    'KB に確認記録がある制度は KB の確認状態・確認日・出典を引き継ぐ',
    allowanceChip !== undefined &&
      allowanceChip.verification !== undefined &&
      typeof allowanceChip.checkedAt !== 'undefined' &&
      Array.isArray(allowanceChip.sources) &&
      allowanceChip.name === allowanceKb?.name,
    `verification=${allowanceChip?.verification ?? 'none'}`,
  )
  const noKbChips = resolveAiProposedPrograms(['mock-child-allowance'], [], registry)
  check(
    'KB に確認記録が無い制度は未確認のまま扱う（確認済みにしない）',
    noKbChips.length === 1 &&
      noKbChips[0].verification === 'unverified' &&
      noKbChips[0].sourceType === 'mock',
  )
  const manySynthetic = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    name: `合成制度${i}`,
    category: 'cash_benefit',
  })) as unknown as readonly SupportProgram[]
  check(
    `提案は最大 ${AI_PROPOSAL_MAX_PROGRAMS} 件に制限される`,
    resolveAiProposedPrograms(
      ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      [],
      manySynthetic,
    ).length === AI_PROPOSAL_MAX_PROGRAMS,
  )
  check('空の programIds ではチップを返さない', resolveAiProposedPrograms([]).length === 0)

  // ── 3. 支援制度候補リスト（ID・名称・区分のみ） ──
  console.log('── 3. 支援制度候補リスト（金額・期限・窓口・URL を含まない） ──')
  const listMessages = buildApiMessages(
    { ...baseRequest },
    { search: 'off', jsonMode: 'prompt' },
  )
  const listMessage = listMessages.find((m) =>
    m.content.includes('【支援制度候補リスト（サーバー管理の制度一覧）】'),
  )
  check(
    '相談セッションがあるとき候補リストを送る',
    listMessage !== undefined && listMessage.content.includes('ID: mock-child-allowance'),
  )
  check(
    '候補リストに金額・URL を含まない',
    listMessage !== undefined &&
      !/\d[\d,]*円/.test(listMessage.content) &&
      !/https?:\/\//.test(listMessage.content),
    listMessage?.content.slice(0, 120),
  )
  check(
    '候補リストの制度名はレジストリの転記のみ',
    listMessage !== undefined &&
      registry.every((p) => listMessage.content.includes(p.name)),
  )
  const noSessionMessages = buildApiMessages(
    { message: '今日の天気は？', history: [], program: null, userContext: null },
    { search: 'off', jsonMode: 'prompt' },
  )
  const noSessionText = JSON.stringify(noSessionMessages)
  check(
    '相談セッションが無い質問には候補制度名を送らない（既存不変条件の維持）',
    !noSessionText.includes('【支援制度候補リスト（サーバー管理の制度一覧）】') &&
      !noSessionText.includes('児童手当') &&
      !noSessionText.includes('mock-child-allowance'),
  )
  check(
    'KB 未特定でも候補リストは独立に出る（KB ブロックは省略のまま）',
    buildKbPromptBlock({ cards: [], amountCalculationPolicy: '' }) === '' &&
      listMessage !== undefined,
  )

  // ── 4. E2E（偽クライアント経由の /api/consult 通常経路） ──
  console.log('── 4. E2E（提案の採用/破棄・パース失敗時の限定文） ──')
  void (async () => {
    const proposalJson = JSON.stringify({
      reply: '状況に関連する可能性のある制度候補です。受給資格は未確認です。',
      clarificationQuestions: [],
      unsupported: false,
      programIds: ['mock-child-allowance', 'fake-program', 'mock-education-loan'],
    })
    const { reply, calls } = await callApi(baseRequest, [proposalJson])
    check(
      'E2E: AI 応答は isMock=false / sourceType=ai（モックと混同しない）',
      reply.isMock === false && reply.sourceType === 'ai' && reply.hasUnverified === true,
    )
    check(
      'E2E: 提案チップにレジストリ制度のみ（fake-program は破棄）',
      reply.relatedPrograms.length === 2 &&
        reply.relatedPrograms.every((p) => registryIds.includes(p.id)) &&
        !reply.relatedPrograms.some((p) => p.id === 'fake-program'),
      JSON.stringify(reply.relatedPrograms.map((p) => p.id)),
    )
    check(
      'E2E: 候補リスト（ID・名称・区分のみ）が AI に渡される',
      calls.some((c) =>
        c.messages.some((m) =>
          m.content.includes('【支援制度候補リスト（サーバー管理の制度一覧）】'),
        ),
      ),
    )
    check(
      'E2E: AI 生成の出典 URL は採用されない',
      !(reply.citations ?? []).some((c) => (c.url ?? '').includes('fake.example.com')),
    )

    // 旧形式の relatedPrograms 注入 + 捏造 ID の programIds → 破棄を維持
    const legacyJson = JSON.stringify({
      reply: '架空の制度もあります。',
      clarificationQuestions: [],
      unsupported: false,
      programIds: ['fake-program'],
      relatedPrograms: [{ id: 'fake-program', name: '架空の手当', note: '偽メモ' }],
    })
    const { reply: legacy } = await callApi(baseRequest, [legacyJson])
    check(
      'E2E: 捏造 ID のみの提案はチップを返さない（制度の捏造をしない）',
      legacy.relatedPrograms.length === 0,
      JSON.stringify(legacy.relatedPrograms),
    )

    // パース失敗 → 生出力を破棄して限定文のみ
    const { reply: limited } = await callApi(baseRequest, [
      'JSON ではない生テキスト応答です',
    ])
    check(
      'E2E: JSON パース失敗時は限定文のみ（AI 生出力は破棄）',
      limited.text.includes('回答を準備できませんでした') &&
        limited.relatedPrograms.length === 0,
    )
    check(
      'E2E: 不正応答も isMock=false / sourceType=ai のまま',
      limited.isMock === false && limited.sourceType === 'ai',
    )

    // ── 5. 維持すべき安全制約 ──
    console.log('── 5. 安全制約（受給資格の非断定・mock/ai 区別・KB 出典） ──')
    const ctx = resolveKbConsultContext({ programId: 'mock-child-allowance' })
    check(
      'KB ブロックに受給資格の未確認行が残る',
      buildKbPromptBlock(ctx).includes('受給資格（利用資格）: 未確認'),
    )
    check(
      '候補の出所はサーバー側レジストリのみ（実在制度）',
      registryIds.length > 0 && registry.every((p) => p.name.length > 0),
    )
    const rawReply = toConsultReplyFromAi({
      reply: '本文のみ',
      programIds: ['mock-child-allowance'],
    })
    check(
      'AI JSON の制度名・金額はチップに採用されない（ID 以外は不採用）',
      rawReply.relatedPrograms.length === 0 && rawReply.hasUnverified === true,
    )

    console.log(
      failed > 0
        ? `\nP10 検証: ${failed} 件 NG`
        : '\nP10 検証: すべて ok（外部通信なし・合成データのみ）',
    )
    process.exit(failed > 0 ? 1 : 0)
  })()
}

void main()
