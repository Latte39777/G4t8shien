/**
 * P7: ライブAI接続前の最終監査とプロンプト整合性検証
 *
 * 実行: npx tsx scripts/verify-m7.tsx
 *
 * 確認項目:
 * 1. システムプロンプトと KB 用プロンプトの整合（旧「金額・期限を説明しない」
 *    指示と KB 確認済み事実の説明許可の矛盾が解消されていること・後勝ち前提の
 *    指示が残っていないこと・維持すべき制約が両方に存在すること）
 * 2. KB 事実に対するマスキングの影響（金額・年月日・制度名・法律番号・出典
 *    provenance が無変換で残ること・PII パターンの保護は維持されること）
 * 3. 実 KB データ回帰（全制度でマスキング変換ゼロ・URL 非混入）
 * 4. KB プロンプトの切り詰めと情報の完全性（上限・行単位・省略明示・
 *    未確認の誤表示なし・省略制度を収録済みとして扱わない）
 * 5. 実際に構築された messages とデータ内容の検査（P7-4 の 10 項目）
 * 6. モック応答・フォールバック・エラー処理の不変
 * 7. 外部通信ゼロ（globalThis.fetch をガードして 0 回を確認）
 *
 * 実際の外部 AI API は一切呼ばず、ライブ AI は有効化しない。
 */
import {
  KB_AMOUNT_CALCULATION_POLICY,
  buildKnowledgeBase,
} from '../lib/supports/kb'
import {
  KB_PROMPT_MAX_CHARS,
  buildKbPromptBlock,
  kbSafetyRules,
} from '../lib/consult/kbPrompt'
import {
  resolveKbConsultContext,
  type KbConsultContext,
  type KbFactCard,
} from '../lib/consult/kbContext'
import { handleConsultRequest, type ConsultApiDeps } from '../lib/consult/api'
import {
  buildSystemPrompt,
  createIniadConsultProvider,
  type ChatCompletionParams,
  type ChatCompletionsLike,
} from '../lib/consult/iniadAdvisor'
import { redactText } from '../lib/consult/redact'
import { LIMITED_FALLBACK_REPLY } from '../lib/consult/replySchema'
import { mockConsultProvider } from '../lib/consult/mockAdvisor'
import { MemoryRateLimiter } from '../lib/consult/rateLimit'
import type { ConsultReply } from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(
    `  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`,
  )
  if (!cond) failed += 1
}

// ── 外部通信ガード（検証中の外部通信が 0 回であることを最後に確認する） ──
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown) => {
  fetchCalls.push(String(input))
  return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
}) as typeof fetch

/** 応答列（文字列 or 例外）を順に返す偽クライアント（送信内容を記録する） */
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

/** 検出した KB ブロック（system メッセージ）を取り出す */
function kbBlockOf(calls: ChatCompletionParams[]): string | null {
  for (const call of calls) {
    for (const m of call.messages) {
      if (m.role === 'system' && m.content.includes('【公式情報 KB')) {
        return m.content
      }
    }
  }
  return null
}

/** 節区切りで抜き出す（確認済み節に未確認が混ざっていないかの検査用） */
function sectionBetween(block: string, from: string, to: string): string {
  const start = block.indexOf(from)
  const end = block.indexOf(to)
  return start >= 0 && end > start ? block.slice(start, end) : ''
}

/** 送信メッセージ全体（結合） */
function allMessages(calls: ChatCompletionParams[]): string {
  return calls.flatMap((c) => c.messages.map((m) => m.content)).join('\n')
}

async function main(): Promise<void> {
  const kb = buildKnowledgeBase()
  const allowanceEntry = kb.find((e) => e.programId === 'mock-child-allowance')
  if (allowanceEntry === undefined) throw new Error('児童手当が KB にありません')
  const coreAllowance = allowanceEntry.name.replace(/（[^）]*）/g, '')

  // ── 1. システムプロンプトと KB 用プロンプトの整合性 ──
  console.log('── 1. システムプロンプトと KB 用プロンプトの整合性 ──')
  const sysPrompt = buildSystemPrompt({ search: 'off', jsonMode: 'prompt' })
  const rules = kbSafetyRules(KB_AMOUNT_CALCULATION_POLICY)
  check(
    '旧の無条件禁止（制度の具体的な情報を一切断定しない）が整理され、KB 確認済みの範囲で説明を許可する',
    !sysPrompt.includes('制度の具体的な情報は検証されていないため') &&
      sysPrompt.includes('「確認済みの事実」に記載された内容に限り') &&
      sysPrompt.indexOf('「確認済みの事実」に記載された内容に限り') <
        sysPrompt.indexOf('・申請先窓口'),
  )
  check(
    'JSON 指示の旧「確定情報を含めない」が整理され、確認済みの範囲のみ許可する',
    sysPrompt.includes('「確認済みの事実」に記載されたものに限り') &&
      !sysPrompt.includes('確定情報を含めないでください'),
  )
  check(
    '内部用語（KB の記録では等）の使用禁止と確認状態の自然な表現が指示されている',
    !sysPrompt.includes('「KB の記録では確認済み」') &&
      sysPrompt.includes('内部用語の禁止') &&
      sysPrompt.includes('受給資格・利用資格・申請可否を確定と表現しない') &&
      !sysPrompt.includes('表現も使用禁止'),
  )
  check(
    'KB ルール9 は後勝ちを前提にせず、矛盾しない形に整理されている',
    rules.includes('既存の安全指示と矛盾しない') &&
      !rules.includes('このルールに従う') &&
      rules.includes('制約を緩めず'),
  )
  check(
    '維持制約（資格非確定）が両指示に存在する',
    sysPrompt.includes('受給資格・利用資格・申請可否を確定と表現しない') &&
      rules.includes('相談者本人の受給資格・利用資格・申請可否は確定しない'),
  )
  check(
    '維持制約（金額計算の禁止）が両指示に存在する',
    sysPrompt.includes('金額を推測して') &&
      rules.includes('金額の合算・換算・資格判定を行わない') &&
      rules.includes(KB_AMOUNT_CALCULATION_POLICY),
  )
  check(
    '維持制約（未確認の明示・URL 禁止）が両指示に存在する',
    sysPrompt.includes('「未確認」と明示') &&
      rules.includes('「確認できる公式情報がありません」と伝え') &&
      sysPrompt.includes('URL やリンクを回答に含めない') &&
      rules.includes('URL やリンクを回答本文に書かない'),
  )
  check(
    '禁止リスト（資格・金額・期限・窓口の断定禁止）は維持される',
    ['受給資格', '金額', '申請期限', '申請先窓口', '断定して答えないこと'].every(
      (s) => sysPrompt.includes(s),
    ),
  )

  // ── 2. KB 事実に対するマスキングの影響（前後比較） ──
  console.log('── 2. KB 事実に対するマスキングの影響 ──')
  const maskMatrix: Array<[string, string, boolean]> = [
    ['給付額（カンマ付き）', '月額10,000 円（適用年度: 2025）', true],
    ['給付額（5 桁・実データ形式）', '15000（単位: yen_per_month）', true],
    ['年月日（確認日）', '確認日: 2026-10-15', true],
    [
      'ISO 日時（取得日時・provenance）',
      '2026-10-15T00:00:00+09:00 / 2026-10-16T15:24:50.131Z',
      true,
    ],
    ['制度名・法律番号', '児童手当（じどうてあて）・平成24年法律第89号', true],
    [
      '出典タイトル・provenance',
      'こども家庭庁の公式ページ（調査ログ転記の取得 2026-10-15・人手照合 2026-10-16）',
      true,
    ],
    ['メールアドレス', 'taro@example.com', false],
    ['電話番号', '03-1234-5678', false],
    ['マイナンバー様 12 桁', '1234-5678-9012', false],
    ['連続数字 11 桁', '09012345678', false],
  ]
  for (const [label, text, keep] of maskMatrix) {
    const after = redactText(text)
    check(
      `マスキング前後: ${label} は${keep ? '無変換で' : 'マスク（保護）'}残る`,
      keep ? after === text : after !== text,
      keep ? after : `${text} -> ${after}`,
    )
  }
  // KB ブロック全体への適用（正当な数値は無変換・PII は保護される）
  const maskCard: KbFactCard = {
    programId: 'mask-test',
    name: 'マスク確認制度',
    category: 'cash_benefit',
    verification: 'partial',
    checkedAt: '2026-10-15',
    reviewOutdated: false,
    confirmedFacts: [
      '・マスク確認制度｜支給額: 月額10,000 円（適用年度: 2025）［出典: 公式資料（実取得 2026-10-15・人手照合 2026-10-16）］',
      '・マスク確認制度｜適用日: 2026-10-15（確認日: 2026-01-15）［出典: 公式資料（調査ログ転記の取得 2026-10-15T00:00:00+09:00）］',
      '・マスク確認制度｜根拠: 平成24年法律第89号・15000（単位: yen_per_month）［出典: 公式資料（人手照合 2026-10-17）］',
    ],
    unconfirmedNotes: [
      '・マスク確認制度｜備考: 確認できる公式情報がありません（条件の確認が必要です）',
      '・マスク確認制度｜連絡先例: taro@example.com / 03-1234-5678',
    ],
    unconfirmedItems: [],
    citations: [],
  }
  const maskBlock = buildKbPromptBlock({
    cards: [maskCard],
    amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
  })
  const maskedBlock = redactText(maskBlock)
  check(
    'KB ブロック内の確認済み事実（金額・日付・法律番号・provenance）は無変換で送られる',
    maskCard.confirmedFacts.every((f) => maskedBlock.includes(f)),
  )
  check(
    'KB ブロック内でも PII らしき文字列はマスクされる（保護は無効化しない）',
    maskedBlock.includes('［メールアドレス］') &&
      maskedBlock.includes('［電話番号］') &&
      !maskedBlock.includes('taro@example.com') &&
      !maskedBlock.includes('03-1234-5678'),
  )
  check(
    '既知の制約: 8 桁以上の連続数字は金額でも［数字］にマスクされる（過剰マスク・安全側。実データには該当なし）',
    redactText('12345678円') === '［数字］円',
    redactText('12345678円'),
  )

  // ── 3. 実 KB データ回帰（マスキング変換ゼロ・URL 非混入） ──
  console.log('── 3. 実 KB データ回帰 ──')
  const maskChanged: string[] = []
  const urlBlocks: string[] = []
  const urlLines: string[] = []
  for (const e of kb) {
    const ctx = resolveKbConsultContext({ programId: e.programId, message: null })
    for (const card of ctx.cards) {
      const block = buildKbPromptBlock({
        cards: [card],
        amountCalculationPolicy: ctx.amountCalculationPolicy,
      })
      if (redactText(block) !== block) maskChanged.push(card.programId)
      if (/https?:\/\/|www\./i.test(block)) urlBlocks.push(card.programId)
      for (const line of [...card.confirmedFacts, ...card.unconfirmedNotes]) {
        if (/https?:\/\/|www\./i.test(line)) urlLines.push(card.programId)
      }
    }
  }
  check(
    '実 KB データ: 全制度でマスキング変換が発生しない（正当な数値・日付・出典が無変換）',
    maskChanged.length === 0,
    maskChanged.join(','),
  )
  check(
    '実 KB データ: 事実・未確認行・ブロックに URL が混入しない',
    urlBlocks.length === 0 && urlLines.length === 0,
    `${urlBlocks.join(',')}/${urlLines.join(',')}`,
  )

  // ── 4. KB プロンプトの切り詰めと情報の完全性 ──
  console.log('── 4. KB プロンプトの切り詰めと情報の完全性 ──')
  const syntheticCards: KbFactCard[] = Array.from({ length: 6 }, (_, i) => ({
    programId: `p${i}`,
    name: `合成制度${i}`,
    category: 'cash_benefit' as const,
    verification: 'partial' as const,
    checkedAt: '2026-01-01',
    reviewOutdated: false,
    confirmedFacts: Array.from(
      { length: 30 },
      (_, j) => `・synthetic-${i}-${j}-fact${'あ'.repeat(30)}`,
    ),
    unconfirmedNotes: [`・synthetic-${i}-unconfirmed`],
    unconfirmedItems: [],
    citations: [],
  }))
  const synCtx: KbConsultContext = {
    cards: syntheticCards,
    amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
  }
  const synBlock = buildKbPromptBlock(synCtx)
  check(
    '上限（文字数）が適用される',
    synBlock.length <= KB_PROMPT_MAX_CHARS,
    `${synBlock.length} > ${KB_PROMPT_MAX_CHARS}`,
  )
  const factLines = new Set(syntheticCards.flatMap((c) => c.confirmedFacts))
  check(
    '行の途中で切らない（事実行は完全な行のまま）',
    synBlock
      .split('\n')
      .filter((l) => l.includes('-fact'))
      .every((l) => factLines.has(l)),
  )
  check(
    '切り詰め・省略は AI が認識できるよう明示される',
    synBlock.includes('行のみ表示（長さ制限）') ||
      synBlock.includes('省略しました'),
  )
  check(
    '未確認の事項が確認済みの事実として表示されない（eligibility も未確認）',
    !sectionBetween(synBlock, '【確認済みの事実】', '【未確認の事項】').includes(
      '-unconfirmed',
    ) && synBlock.includes('受給資格（利用資格）: 未確認'),
  )
  check(
    '後続制度の省略は件数を明示する（または全制度が収録される）',
    /制度 \d+ 件は長さ制限/.test(synBlock) ||
      synBlock.split('制度: ').length - 1 === syntheticCards.length,
  )
  const hugeCard: KbFactCard = {
    ...syntheticCards[0],
    programId: 'huge',
    name: '巨大制度',
    confirmedFacts: Array.from(
      { length: 300 },
      (_, j) => `・synthetic-huge-${j}-fact${'う'.repeat(50)}`,
    ),
    unconfirmedNotes: ['・synthetic-huge-unconfirmed'],
  }
  const hugeBlock = buildKbPromptBlock({
    cards: [hugeCard],
    amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
  })
  check(
    '巨大制度も上限内で固定部分（基本情報・未確認・出典）を丸ごと表示する',
    hugeBlock.length <= KB_PROMPT_MAX_CHARS &&
      hugeBlock.includes('制度: 巨大制度') &&
      hugeBlock.includes('・synthetic-huge-unconfirmed') &&
      hugeBlock.includes('受給資格（利用資格）: 未確認'),
  )
  check(
    'URL を AI 用コンテキストに混入させない',
    !/https?:\/\/|www\./i.test(hugeBlock) && !/https?:\/\/|www\./i.test(synBlock),
  )

  // ── 5. 実際に構築された messages とデータ内容の検査（10 項目） ──
  console.log('── 5. 実際に構築された messages の検査 ──')
  const silentLogger: Pick<Console, 'warn' | 'error'> = {
    warn: () => undefined,
    error: () => undefined,
  }
  const apiRateLimiter = new MemoryRateLimiter({
    perMinute: 100,
    perDay: 1000,
    globalPerMinute: 1000,
  })
  const jsonRequest = (body: unknown): Request =>
    new Request('http://localhost/api/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const callApi = (
    request: Request,
    extra: Partial<ConsultApiDeps> = {},
  ): Promise<Response> =>
    handleConsultRequest(request, {
      resolveProvider: () => mockConsultProvider,
      rateLimiter: apiRateLimiter,
      logger: silentLogger,
      ...extra,
    })
  const aiReplyJson = JSON.stringify({
    reply: '確認済みの事実の範囲で案内します。',
    clarificationQuestions: [],
    unsupported: false,
  })
  const allowanceMessage = `${coreAllowance}の金額はいくら？`
  const allowanceCtx = resolveKbConsultContext({
    programId: null,
    message: allowanceMessage,
  })
  const allowanceBlock = buildKbPromptBlock(allowanceCtx)
  const expectedCitations = allowanceCtx.cards.flatMap((c) => c.citations)

  const okClient = fakeClient([aiReplyJson])
  const okProvider = createIniadConsultProvider({
    client: okClient.client,
    env: {},
    retryDelayMs: 0,
  })
  const res1 = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    { resolveProvider: () => okProvider },
  )
  const body1 = (await res1.json()) as ConsultReply
  const sentBlock = kbBlockOf(okClient.calls)
  check(
    '1. 確認済みの金額・年月日・事実が意図しない書き換えなく messages に残る',
    res1.status === 200 &&
      sentBlock === redactText(allowanceBlock) &&
      allowanceCtx.cards.some((c) =>
        c.confirmedFacts.some((f) => (sentBlock ?? '').includes(f)),
      ),
  )
  check(
    '2. 未確認情報と eligibility が明確に区別される',
    sentBlock !== null &&
      sentBlock.includes('【未確認の事項】') &&
      sentBlock.includes('受給資格（利用資格）: 未確認') &&
      !sectionBetween(sentBlock, '【確認済みの事実】', '【未確認の事項】').includes(
        '確認できる公式情報がありません',
      ),
  )
  const sentAll = allMessages(okClient.calls)
  check(
    '3. 既存の system 指示と KB 用指示に矛盾がない（整理済みの文言が送信される）',
    sentAll.includes('「確認済みの事実」に記載された内容に限り') &&
      sentAll.includes('既存の安全指示と矛盾しない') &&
      !sentAll.includes('制度の具体的な情報は検証されていないため') &&
      !sentAll.includes('確定情報を含めないでください') &&
      !sentAll.includes('このルールに従う'),
  )
  check(
    '4. 個人の受給資格を確定しない・金額計算を禁止する指示が維持される',
    sentAll.includes('相談者本人の受給資格・利用資格・申請可否は確定しない') &&
      sentAll.includes('金額の合算・換算・資格判定を行わない') &&
      sentAll.includes('申請可否を確定と表現しない'),
  )
  check(
    '5. URL が AI 用コンテキストに含まれない',
    okClient.calls.every((c) =>
      !/https?:\/\//.test(c.messages.map((m) => m.content).join('\n')),
    ),
  )
  check(
    '5b. 応答の出典は KB の内容と一致（AI 送信と同一の解決結果）',
    JSON.stringify(body1.citations ?? []) === JSON.stringify(expectedCitations),
  )
  // 6. KB 未解決・無関係な質問では無関係な制度情報を送信しない
  const unrelatedClient = fakeClient([aiReplyJson])
  const unrelatedProvider = createIniadConsultProvider({
    client: unrelatedClient.client,
    env: {},
    retryDelayMs: 0,
  })
  await callApi(
    jsonRequest({ message: '今日の天気は？', history: [], program: null }),
    { resolveProvider: () => unrelatedProvider },
  )
  const unrelatedText = allMessages(unrelatedClient.calls)
  check(
    '6. KB 未特定・無関係な質問では無関係な制度情報を送信しない',
    kbBlockOf(unrelatedClient.calls) === null &&
      !unrelatedText.includes(coreAllowance) &&
      !unrelatedText.includes('【公式情報 KB'),
  )
  const kbFailClient = fakeClient([aiReplyJson])
  const kbFailProvider = createIniadConsultProvider({
    client: kbFailClient.client,
    env: {},
    retryDelayMs: 0,
  })
  const resFail = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    {
      resolveProvider: () => kbFailProvider,
      resolveKbContext: () => {
        throw new Error('KB down')
      },
    },
  )
  const bodyFail = (await resFail.json()) as ConsultReply
  check(
    '6b. KB 解決失敗時も無関係な制度情報・出典を送信／付与しない',
    kbBlockOf(kbFailClient.calls) === null &&
      (bodyFail.citations ?? []).length === 0,
  )
  // 7. AI 生成の出典・URL・関連制度が正式な根拠として採用されない
  const fakeAiJson = JSON.stringify({
    reply: '架空の制度もあります。',
    clarificationQuestions: [],
    unsupported: false,
    relatedPrograms: [{ id: 'fake-program', name: '架空の手当', note: '偽メモ' }],
    sources: [{ title: '架空出典', url: 'https://fake.example.com' }],
    citations: [{ title: '架空出典', url: 'https://fake.example.com' }],
  })
  const fakeAiClient = fakeClient([fakeAiJson])
  const fakeAiProvider = createIniadConsultProvider({
    client: fakeAiClient.client,
    env: {},
    retryDelayMs: 0,
  })
  const resFakeAi = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    { resolveProvider: () => fakeAiProvider },
  )
  const bodyFakeAi = (await resFakeAi.json()) as ConsultReply
  check(
    '7. AI 生成の出典・URL・関連制度は正式な根拠として採用されない',
    JSON.stringify(bodyFakeAi.citations ?? []) ===
      JSON.stringify(expectedCitations) &&
      !(bodyFakeAi.citations ?? []).some((c) =>
        (c.url ?? '').includes('fake.example.com'),
      ) &&
      !(bodyFakeAi.relatedPrograms ?? []).some((p) => p.id === 'fake-program') &&
      (bodyFakeAi.relatedPrograms ?? []).every((p) =>
        kb.some((e) => e.programId === p.id),
      ),
  )
  // 8. マスキングの既存保護機能が維持される（ユーザー入力・履歴）
  const piiClient = fakeClient([aiReplyJson])
  const piiProvider = createIniadConsultProvider({
    client: piiClient.client,
    env: {},
    retryDelayMs: 0,
  })
  await callApi(
    jsonRequest({
      message: '電話は090-1234-5678、メールはtaro@example.comです',
      history: [{ id: 'h1', role: 'user', text: '前回の連絡先 03-1234-5678' }],
      program: null,
    }),
    { resolveProvider: () => piiProvider },
  )
  const piiMessages = piiClient.calls.flatMap((c) =>
    c.messages.map((m) => m.content),
  )
  const piiUser = piiMessages[piiMessages.length - 1] ?? ''
  check(
    '8. マスキングの既存保護機能が維持される（相談文・履歴の PII をマスクして送る）',
    piiUser.includes('［電話番号］') &&
      piiUser.includes('［メールアドレス］') &&
      !piiUser.includes('090-1234-5678') &&
      !piiUser.includes('taro@example.com') &&
      piiMessages.some((t) => t.includes('前回の連絡先 ［電話番号］')),
  )
  // 9. KB コンテキストの上限・切り詰めが messages 上でも安全に機能する
  const bigClient = fakeClient([aiReplyJson])
  const bigProvider = createIniadConsultProvider({
    client: bigClient.client,
    env: {},
    retryDelayMs: 0,
  })
  await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    {
      resolveProvider: () => bigProvider,
      resolveKbContext: () => ({
        cards: [hugeCard],
        amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
      }),
    },
  )
  const bigBlock = kbBlockOf(bigClient.calls) ?? ''
  check(
    '9. KB の上限・切り詰めが messages 上でも安全に機能する（行単位・省略明示）',
    bigBlock.length <= KB_PROMPT_MAX_CHARS &&
      bigBlock.includes('行のみ表示（長さ制限）') &&
      bigBlock.includes('受給資格（利用資格）: 未確認') &&
      bigBlock
        .split('\n')
        .filter((l) => l.includes('synthetic-huge-'))
        .every((l) => l.startsWith('・synthetic-huge-')),
  )

  // ── 6. モック応答・フォールバック・エラー処理の不変 ──
  console.log('── 6. モック応答・フォールバック・エラー処理 ──')
  const resMock = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
  )
  const bodyMock = (await resMock.json()) as ConsultReply
  check(
    '10. モック応答は従来どおり（isMock・KB 出典の決定論的付与）',
    resMock.status === 200 &&
      bodyMock.isMock === true &&
      (bodyMock.citations ?? []).length > 0,
  )
  const badClient = fakeClient(['{ not json'])
  const badProvider = createIniadConsultProvider({
    client: badClient.client,
    env: {},
    retryDelayMs: 0,
  })
  const resBad = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    { resolveProvider: () => badProvider },
  )
  const bodyBad = (await resBad.json()) as ConsultReply
  check(
    '10b. 不正 JSON は固定安全文にフォールバック（生出力を出さない）',
    bodyBad.text === LIMITED_FALLBACK_REPLY.text,
  )
  const hanging: ChatCompletionsLike = { create: () => new Promise(() => {}) }
  const timeoutProvider = createIniadConsultProvider({
    client: hanging,
    env: {},
    timeoutMs: 20,
    retryCount: 0,
    retryDelayMs: 0,
  })
  const resTimeout = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    { resolveProvider: () => timeoutProvider },
  )
  check(
    '10c. タイムアウト時は既存どおりエラー表示（504）',
    resTimeout.status === 504,
    String(resTimeout.status),
  )
  const boomProvider = createIniadConsultProvider({
    client: fakeClient([new Error('network down')]).client,
    env: {},
    retryCount: 0,
    retryDelayMs: 0,
  })
  const resBoom = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    { resolveProvider: () => boomProvider },
  )
  check(
    '10d. 上流例外時は既存どおりエラー表示（5xx）',
    resBoom.status >= 500,
    String(resBoom.status),
  )
  const fbProvider = createIniadConsultProvider({
    client: fakeClient([new Error('network down')]).client,
    env: {},
    retryCount: 0,
    retryDelayMs: 0,
  })
  const resFb = await callApi(
    jsonRequest({ message: allowanceMessage, history: [], program: null }),
    {
      resolveProvider: () => fbProvider,
      env: { CONSULT_FALLBACK_TO_MOCK: '1' },
    },
  )
  const bodyFb = (await resFb.json()) as ConsultReply
  check(
    '10e. CONSULT_FALLBACK_TO_MOCK=1 のモックフォールバックも従来どおり（ラベル付き）',
    resFb.status === 200 && bodyFb.sourceType === 'mock-fallback',
    bodyFb.sourceType,
  )

  // ── 7. 外部通信ゼロ ──
  console.log('── 7. 外部通信ゼロ ──')
  check(
    '検証中の外部通信は 0 回（実際の外部 AI API は呼ばない）',
    fetchCalls.length === 0,
    fetchCalls.join(','),
  )

  console.log(
    failed === 0
      ? '\nP7 監査: すべての検証に合格しました'
      : `\nError: P7 監査: ${failed} 件の検証が失敗しました`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
