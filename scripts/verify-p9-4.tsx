/**
 * P9-4 検証: 相談画面の注意表示・回答モード表示・クライアントタイムアウト・ログ安全
 *
 * 実行: npx tsx scripts/verify-p9-4.tsx
 *
 * - 使用するデータはすべてダミー（実ユーザーの相談文・実個人情報・実 API キーは
 *   使わない。秘密情報らしき文字列もすべてダミー）
 * - 外部通信は一切行わない（fetch はテスト内でローカルのスタブに差し替える）
 * - 確認項目:
 *   1. モック回答の表示が引き続き正しい
 *   2. 回答モード（通常モック / ライブ AI / 障害時フォールバック）が応答
 *      フィールドのみから正しく判定・表示される（本文から推測しない）
 *   3. 注意表示に「マスクが完全」と誤解させる表現がなく、限界を明示している
 *   4. クライアントのタイムアウトが所定のエラー形式へ変換される
 *      （成功応答・通信エラー・AbortError 由来でない中断を誤ってタイムアウトにしない）
 *   5. タイムアウト時に送信中表示が解除され、再試行できる
 *   6. 通常成功・入力エラー・サーバーエラー・既存のエラー表示が変わらない
 *   7. APIキーや質問文などがログに出力されない（許可リスト方式の維持）
 *   8. クライアント待ち上限の設定根拠（サーバー最大処理時間＋余裕）を確認
 */
import * as React from 'react'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import Consult from '../components/Consult'
import {
  handleConsultRequest,
  handleConsultStatusRequest,
} from '../lib/consult/api'
import {
  CONSULT_CLIENT_TIMEOUT_MS,
  fetchConsultReply,
  normalizeReplyBody,
} from '../lib/consult/clientTransport'
import {
  ConsultSendError,
  isRetryableKind,
  kindForStatus,
  userMessageForKind,
  type ConsultErrorKind,
} from '../lib/consult/errors'
import { MemoryRateLimiter } from '../lib/consult/rateLimit'
import {
  getConsultProvider,
  isLiveConsultEnabled,
} from '../lib/consult/provider'
import { replyDisplayMode } from '../lib/consult/replyMode'
import type {
  ChatMessage,
  ConsultProvider,
  ConsultReply,
  ConsultRequest,
  ConsultUserContext,
} from '../lib/consult/types'
import { useConsultChat, type UseConsultChat } from '../lib/consult/useConsultChat'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

// ── ダミー文字列（実データ・実キーではない） ──
const FAKE_KEY = 'sk-FAKE-P94-TEST-KEY-DO-NOT-LOG'
const FAKE_QUESTION = 'ダミーの質問文（秘密情報テスト用ダミー）'

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function okReply(text = '応答本文'): ConsultReply {
  return {
    text,
    isMock: false,
    hasUnverified: true,
    relatedPrograms: [],
    unsupported: false,
    sourceType: 'ai',
  }
}

function assistantMessage(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'isMock'>,
): ChatMessage {
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    text: partial.text ?? '回答です。',
    isMock: partial.isMock,
    hasUnverified: partial.hasUnverified ?? true,
    relatedPrograms: partial.relatedPrograms ?? [],
    sourceType: partial.sourceType,
  }
}

function renderConsult(
  messages: ChatMessage[],
  userContext: ConsultUserContext | null = null,
  liveAiEnabled?: boolean | null,
): string {
  return renderToString(
    createElement(Consult, {
      program: null,
      userContext,
      messages,
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
      liveAiEnabled,
    }),
  )
}

// ── fetch スタブ（ローカル制御のみ。実通信は行わない） ──
type FetchStub = (input: unknown, init?: { signal?: AbortSignal }) => Promise<Response>
const originalFetch = globalThis.fetch

function abortError(): Error {
  const e = new Error('This operation was aborted')
  e.name = 'AbortError'
  return e
}

/** 制限時間まで応答しない（中断時に AbortError で失敗する） fetch */
const hangingFetch: FetchStub = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', () => reject(abortError()))
  })

/** 即座に JSON 応答を返す fetch */
function jsonFetch(status: number, body: unknown): FetchStub {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
}

/** 通信エラー（TypeError）で失敗する fetch */
const networkErrorFetch: FetchStub = () =>
  Promise.reject(new TypeError('Failed to fetch'))

/** AbortError で失敗するが、タイムアウト起因ではない fetch */
const foreignAbortFetch: FetchStub = () => Promise.reject(abortError())

async function expectErrorKind(
  name: string,
  stub: FetchStub,
  expected: ConsultErrorKind,
  timeoutMs = 500,
): Promise<void> {
  globalThis.fetch = stub as typeof fetch
  try {
    await fetchConsultReply(
      { message: '質問', history: [], program: null, userContext: null },
      { timeoutMs },
    )
    check(name, false, 'エラーにならなかった')
  } catch (e) {
    const kind = e instanceof ConsultSendError ? e.kind : 'other'
    check(name, kind === expected, `kind=${kind}`)
  }
}

// ── テスト専用ハーネス: React のフックディスパッチャを差し替え、useConsultChat
//    （実物）を単独実行して状態遷移を観測する。React 内部 API を触るのはこの
//    テストスクリプトだけ（本番コード・依存は通常の React のまま。外部依存追加なし）。 ──
type HookSlot = { value: unknown }

type HookHarness = {
  /** フック呼び出しのカーソルを先頭へ戻す（フック実行の直前に呼ぶ） */
  begin: () => void
  /** 疑似ディスパッチャを React に差し込む（フック実行中のみ） */
  install: () => void
  restore: () => void
  /** useState のスロット index の現在値（メッセージ0/送信中1/エラー2/再試行3） */
  stateAt: (index: number) => unknown
}

function installHookHarness(): HookHarness {
  const slots: HookSlot[] = []
  let cursor = 0
  const dispatcher = {
    useState(init: unknown): [unknown, (v: unknown) => void] {
      const i = (cursor += 1) - 1
      if (slots[i] === undefined) {
        slots[i] = {
          value: typeof init === 'function' ? (init as () => unknown)() : init,
        }
      }
      const slot = slots[i]
      const set = (v: unknown): void => {
        slot.value =
          typeof v === 'function' ? (v as (prev: unknown) => unknown)(slot.value) : v
      }
      return [slot.value, set]
    },
    useRef(init: unknown): { current: unknown } {
      const i = (cursor += 1) - 1
      if (slots[i] === undefined) slots[i] = { value: { current: init } }
      return slots[i].value as { current: unknown }
    },
    useCallback(fn: unknown): unknown {
      const i = (cursor += 1) - 1
      if (slots[i] === undefined) slots[i] = { value: fn }
      return slots[i].value
    },
  }
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown }
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  const original = internals.H
  return {
    begin: () => {
      cursor = 0
    },
    install: () => {
      internals.H = dispatcher
    },
    restore: () => {
      internals.H = original
    },
    stateAt: (index: number) => slots[index]?.value,
  }
}

/** useConsultChat（実物）を疑似ディスパッチャ上で起動して返す */
function startChat(respond: (req: ConsultRequest) => Promise<ConsultReply>): {
  chat: UseConsultChat
  harness: HookHarness
} {
  const harness = installHookHarness()
  harness.begin()
  harness.install()
  try {
    // テスト専用ハーネスのため意図的に React 外からフックを起動する
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return { chat: useConsultChat({ respond }), harness }
  } finally {
    harness.restore()
  }
}

async function main(): Promise<void> {
  // ── 1. モック回答の表示が引き続き正しい ──
  section('1. モック回答の表示')
  const mockHtml = renderConsult([
    assistantMessage({ id: 'm-kick', isMock: true, text: '相談を開始しました。' }),
    assistantMessage({ id: 'm-mock', isMock: true }),
  ])
  check('モック: 開発用モックサンプル表示を維持', mockHtml.includes('開発用モックサンプル'))
  check('モック: 未確認情報を含む表示を維持', mockHtml.includes('未確認情報を含む'))
  check(
    'モック: ライブ AI 表示を出さない',
    !mockHtml.includes('consult-ai-badge') && !mockHtml.includes('AI回答（Web検索なし'),
  )
  check(
    'モック: フォールバック表示を出さない',
    !mockHtml.includes('consult-fallback-badge') && !mockHtml.includes('障害時のモック回答'),
  )

  // ── 2. 回答モードが応答フィールドのみから正しく判定される ──
  section('2. 回答モード判定（isMock / sourceType のみ。本文から推測しない）')
  const modeCases: Array<[Pick<ChatMessage, 'isMock' | 'sourceType'>, string]> = [
    [{ isMock: true }, 'mock'],
    [{ isMock: true, sourceType: 'mock' }, 'mock'],
    [{ isMock: true, sourceType: 'mock-fallback' }, 'mock-fallback'],
    [{ isMock: false, sourceType: 'mock-fallback' }, 'mock-fallback'],
    [{ isMock: false, sourceType: 'ai' }, 'ai'],
    [{ isMock: false, sourceType: 'kb' }, 'ai'],
    [{ isMock: false, sourceType: 'web' }, 'ai'],
    [{ isMock: false, sourceType: 'mock' }, 'mock'],
    // フィールドが矛盾する場合は AI と表示しない（安全側）
    [{ isMock: true, sourceType: 'ai' }, 'mock'],
    // sourceType 未設定（M5 以前）は isMock だけで判定
    [{ isMock: false }, 'ai'],
    [{ isMock: true }, 'mock'],
  ]
  for (const [fields, expected] of modeCases) {
    const actual = replyDisplayMode(fields)
    check(
      `モード判定: isMock=${fields.isMock} sourceType=${fields.sourceType ?? '未設定'} -> ${expected}`,
      actual === expected,
      `actual=${actual}`,
    )
  }
  const fallbackHtml = renderConsult([
    assistantMessage({
      id: 'm-fb',
      isMock: true,
      sourceType: 'mock-fallback',
      text: '【モック応答に切り替えました：AI 通信で障害が発生したため】',
    }),
  ])
  check(
    'フォールバック: モックサンプル表示を維持',
    fallbackHtml.includes('開発用モックサンプル'),
  )
  check(
    'フォールバック: AI が回答できなかった旨を明示',
    fallbackHtml.includes('障害時のモック回答（AI は回答できませんでした）'),
  )
  check(
    'フォールバック: ライブ AI が回答したかのような表示をしない',
    !fallbackHtml.includes('consult-ai-badge') &&
      !fallbackHtml.includes('AI回答（Web検索なし'),
  )
  const aiHtml = renderConsult([assistantMessage({ id: 'm-ai', isMock: false, sourceType: 'ai' })])
  check(
    'ライブAI: AI 生成の回答であることを表示',
    aiHtml.includes('AI回答（Web検索なし・未確認の可能性があります）'),
  )
  check(
    'ライブAI: 誤り・未確認の事項があり得ることを伝える',
    aiHtml.includes('が生成した自動応答です') &&
      aiHtml.includes('誤りや未確認の事項が含まれることがあります'),
  )
  check('ライブAI: モック表示を出さない', !aiHtml.includes('開発用モックサンプル'))
  check(
    'ライブAI: 出典・資格免責の表示構造は変更しない（回答本文の URL をリンク化しない）',
    !aiHtml.includes('<a ') && !aiHtml.includes('公式確認済み'),
  )

  // ── 3. 注意表示（マスクが完全と誤解させない／金額の区別／外部送信の説明は実態と一致） ──
  section('3. 個人情報の注意表示（外部送信の説明は環境の実態と一致させる）')
  // 状態未指定（GET 未取得＝未確認）: 安全側の表示になる
  const noticeHtml = renderConsult(
    [assistantMessage({ id: 'm-n', isMock: true })],
    { childCount: 1, hasAnnualIncome: true, usedProgramIds: [] },
  )
  // モック環境（外部 AI 無効）: 外部送信していない現状を明示する
  const mockNoticeHtml = renderConsult(
    [assistantMessage({ id: 'm-n2', isMock: true })],
    { childCount: 1, hasAnnualIncome: true, usedProgramIds: [] },
    false,
  )
  // ライブ AI 有効: 送信前に外部送信される旨を案内する
  const liveNoticeHtml = renderConsult(
    [assistantMessage({ id: 'm-n3', isMock: false, sourceType: 'ai' })],
    { childCount: 1, hasAnnualIncome: true, usedProgramIds: [] },
    true,
  )
  const noticeRequired = [
    '氏名・住所・電話番号・メールアドレス',
    '個人番号（マイナンバー）',
    '口座情報',
    '完全な検出ではありません',
    '氏名・住所・表記ゆれなどは伏せ字にできないことがあります',
    '質問文に直接書いた金額や個人情報',
    '伏せ字にならないことがあります',
    '入力フォームで入力した金額（収入・貯蓄など）は相談機能に渡していません',
    '質問文に自分で書いた金額は相談の本文として扱われます',
  ]
  for (const text of noticeRequired) {
    check(`注意表示: 「${text}」を含む`, noticeHtml.includes(text))
    check(`注意表示（モック）: 「${text}」を含む`, mockNoticeHtml.includes(text))
    check(`注意表示（ライブ）: 「${text}」を含む`, liveNoticeHtml.includes(text))
  }
  check(
    '注意表示（モック）: 外部 AI へ送信していない現状を明示（有効と誤認させない）',
    mockNoticeHtml.includes('現在は外部の AI へ送信していません') &&
      mockNoticeHtml.includes('利用の前に告知します'),
  )
  check(
    '注意表示（ライブ）: 質問文・会話履歴が外部 AI サービスへ送信されることが分かる',
    liveNoticeHtml.includes('質問文・会話履歴が外部') &&
      liveNoticeHtml.includes('送信されます') &&
      liveNoticeHtml.includes('INIAD AI-MOP'),
  )
  check(
    '注意表示（ライブ）: 実態と矛盾する「送信していない」表示を出さない',
    !liveNoticeHtml.includes('送信していません'),
  )
  check(
    '注意表示（状態未確認）: 送信され得る前提の説明にし「送信していない」と断らない',
    noticeHtml.includes('質問文・会話履歴が外部') &&
      noticeHtml.includes('送信されることがあります') &&
      !noticeHtml.includes('送信していません'),
  )
  const misleading = [
    // 改正前の説明（質問文中の金額まで送信されないように読める）は使わない
    '収入・貯蓄などの金額は相談機能に渡していません',
    '完全な検出を保証',
    '漏れなく伏せ字',
    'すべての個人情報を伏せ字',
    '必ず伏せ字',
    '100% 検出',
  ]
  for (const html of [noticeHtml, mockNoticeHtml, liveNoticeHtml]) {
    for (const text of misleading) {
      check(`注意表示: 誤解を与える「${text}」を含まない`, !html.includes(text))
    }
  }

  // ── 3b. 設定状態 API（GET /api/consult）: 真偽値のみ・秘密情報なし ──
  section('3b. 設定状態 API（ライブ有効/無効の真偽値のみ）')
  const liveStatus = await handleConsultStatusRequest({
    env: { CONSULT_LIVE_AI: '1', INIAD_API_KEY: 'secret-key-for-test' },
  }).json()
  const keylessStatus = await handleConsultStatusRequest({
    env: { CONSULT_LIVE_AI: '1' },
  }).json()
  const switchOffStatus = await handleConsultStatusRequest({
    env: { INIAD_API_KEY: 'secret-key-for-test' },
  }).json()
  const statusValue = (v: unknown): unknown =>
    (v as { liveAiEnabled?: unknown }).liveAiEnabled
  check(
    '設定状態: 2 重スイッチ両方そろって liveAiEnabled=true（実態と一致）',
    statusValue(liveStatus) === true,
  )
  check(
    '設定状態: キー無しなら liveAiEnabled=false（実態と一致）',
    statusValue(keylessStatus) === false,
  )
  check(
    '設定状態: CONSULT_LIVE_AI 無しなら liveAiEnabled=false（実態と一致）',
    statusValue(switchOffStatus) === false,
  )
  const statusRaw = JSON.stringify([liveStatus, keylessStatus, switchOffStatus])
  check(
    '設定状態: API キーなどの秘密情報・環境変数の値を含まない',
    !statusRaw.includes('secret-key-for-test') &&
      !statusRaw.includes('INIAD_API_KEY'),
  )
  // GET の liveAiEnabled と POST の provider 選択が同じ条件（isLiveConsultEnabled が
  // 読む process.env）で決まることを確認する（表示と実際の実行モードがずれない保証）
  const savedLiveSwitch = process.env.CONSULT_LIVE_AI
  const savedApiKey = process.env.INIAD_API_KEY
  const providerEnvCases: Array<[string, string | undefined, string | undefined]> = [
    ['両方あり', '1', 'secret-key-for-test'],
    ['キーのみ', '1', undefined],
    ['スイッチのみ', undefined, 'secret-key-for-test'],
    ['どちらもなし', undefined, undefined],
  ]
  for (const [label, switchValue, keyValue] of providerEnvCases) {
    if (switchValue === undefined) delete process.env.CONSULT_LIVE_AI
    else process.env.CONSULT_LIVE_AI = switchValue
    if (keyValue === undefined) delete process.env.INIAD_API_KEY
    else process.env.INIAD_API_KEY = keyValue
    const status = await handleConsultStatusRequest()
    const liveFlag = (await status.json()) as { liveAiEnabled?: unknown }
    check(
      `実行条件: ${label} なら GET liveAiEnabled=${String(liveFlag.liveAiEnabled)} と POST provider.isMock=${String(getConsultProvider().isMock)} が一致`,
      liveFlag.liveAiEnabled === !getConsultProvider().isMock,
    )
    // isLiveConsultEnabled の引数差し替え（GET のテスト用注入）でも同じ結果
    check(
      `実行条件: ${label} なら isLiveConsultEnabled(注入 env) も同じ結果`,
      isLiveConsultEnabled({
        CONSULT_LIVE_AI: switchValue,
        INIAD_API_KEY: keyValue,
      }) === liveFlag.liveAiEnabled,
    )
  }
  if (savedLiveSwitch === undefined) delete process.env.CONSULT_LIVE_AI
  else process.env.CONSULT_LIVE_AI = savedLiveSwitch
  if (savedApiKey === undefined) delete process.env.INIAD_API_KEY
  else process.env.INIAD_API_KEY = savedApiKey

  // ── 3c. 上部のモード注意書きが実行モードと一致する（P11-1） ──
  section('3c. 上部の注意書きと実行モードの一致（表示と実態をずらさない）')
  const mockModeHtml = renderConsult(
    [assistantMessage({ id: 'm-mm', isMock: true })],
    null,
    false,
  )
  const liveModeHtml = renderConsult(
    [assistantMessage({ id: 'm-ml', isMock: false, sourceType: 'ai' })],
    null,
    true,
  )
  const unknownModeHtml = renderConsult(
    [assistantMessage({ id: 'm-mu', isMock: true })],
    null,
    null,
  )
  check(
    'モード注意書き（モック）: 開発用モックサンプルであることを明示',
    mockModeHtml.includes('開発用のモックサンプルです') &&
      mockModeHtml.includes('公式サイトをリアルタイム検索する機能ではありません'),
  )
  check(
    'モード注意書き（モック）: AI 利用中であるかのような表示をしない',
    !mockModeHtml.includes('生成した応答です') && !mockModeHtml.includes('質問に回答します'),
  )
  check(
    'モード注意書き（ライブ）: AI 生成応答であることを明示',
    liveModeHtml.includes('外部AI（INIAD AI-MOP API）が質問に回答します') &&
      liveModeHtml.includes('INIAD AI-MOP API'),
  )
  check(
    'モード注意書き（ライブ）: モックであるかのような表示をしない',
    !liveModeHtml.includes('開発用のモックサンプル') &&
      !liveModeHtml.includes('開発用モックサンプル') &&
      !liveModeHtml.includes('外部 AI へ送信していません'),
  )
  check(
    'モード注意書き（未確認）: モックと AI の両方があり得ると示し、AI 利用を断定しない',
    unknownModeHtml.includes('開発用のモックサンプル') &&
      unknownModeHtml.includes('生成応答の場合があります') &&
      !unknownModeHtml.includes('生成した応答です') &&
      !unknownModeHtml.includes('質問に回答します'),
  )
  check(
    'モード注意書き（モック）: 未確認の免責を維持',
    mockModeHtml.includes('制度の受給資格・金額・申請期限・必要書類などは未確認'),
  )
  check(
    'モード注意書き（ライブ）: 未確認の免責を維持',
    liveModeHtml.includes('制度の受給資格・金額・申請期限・必要書類などは未確認'),
  )
  check(
    'モード注意書き（未確認）: 未確認の免責を維持',
    unknownModeHtml.includes('制度の受給資格・金額・申請期限・必要書類などは未確認'),
  )
  // POST 応答に秘密情報・質問文が含まれないこと（フィールドは相談応答のスキーマのみ）
  const stubForSecret: ConsultProvider = {
    id: 'stub-secret',
    label: 'スタブ',
    isMock: false,
    respond: () => Promise.resolve(okReply()),
  }
  const resSecret = await handleConsultRequest(
    jsonRequest({
      message: FAKE_QUESTION,
      history: [],
      program: null,
      userContext: null,
    }),
    {
      resolveProvider: () => stubForSecret,
      env: { CONSULT_LIVE_AI: '1', INIAD_API_KEY: FAKE_KEY },
      rateLimiter: new MemoryRateLimiter({
        perMinute: 100,
        perDay: 1000,
        globalPerMinute: 1000,
      }),
    },
  )
  const secretRaw = JSON.stringify(await resSecret.json())
  check(
    'POST 応答: API キー・秘密の環境変数名を含まない',
    !secretRaw.includes(FAKE_KEY) && !secretRaw.includes('INIAD_API_KEY'),
  )
  check('POST 応答: 質問文をそのまま含まない', !secretRaw.includes(FAKE_QUESTION))

  // ── 4. クライアントのタイムアウト変換（制御されたローカルスタブのみ） ──
  section('4. クライアント側タイムアウトのエラー変換')
  try {
    await expectErrorKind(
      'タイムアウト: 待ち時間超過は ConsultSendError("timeout")',
      hangingFetch,
      'timeout',
      40,
    )
    await expectErrorKind(
      'タイムアウト起因でない AbortError は network（誤って timeout にしない）',
      foreignAbortFetch,
      'network',
      5000,
    )
    await expectErrorKind('通信エラー（TypeError）は network', networkErrorFetch, 'network')
    await expectErrorKind('サーバーエラー（500）は server（従来どおり）', jsonFetch(500, {}), 'server')
    await expectErrorKind(
      '入力エラー（400）は validation（従来どおり）',
      jsonFetch(400, { error: { kind: 'validation' } }),
      'validation',
    )
    await expectErrorKind(
      '壊れた応答（200 不正 JSON）は invalid_response（timeout にしない）',
      async () =>
        new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
      'invalid_response',
    )
    // 成功済みの応答をタイムアウトにしない
    globalThis.fetch = jsonFetch(200, okReply('成功した応答')) as typeof fetch
    const ok = await fetchConsultReply(
      { message: '質問', history: [], program: null, userContext: null },
      { timeoutMs: 5000 },
    )
    check('成功応答はそのまま返る（タイムアウト扱いにしない）', ok.text === '成功した応答')
  } finally {
    globalThis.fetch = originalFetch
  }

  // ── 5. タイムアウト時に送信中表示が解除され、再試行できる ──
  section('5. タイムアウト時の状態遷移（useConsultChat 実物）')
  try {
    let fetchCalls = 0
    const countingHangingFetch: FetchStub = (input, init) => {
      fetchCalls += 1
      return hangingFetch(input, init)
    }
    const countingOkFetch: FetchStub = (input, init) => {
      fetchCalls += 1
      return jsonFetch(200, okReply('再試行の応答'))(input, init)
    }
    globalThis.fetch = countingHangingFetch as typeof fetch
    const { chat, harness } = startChat((req) => fetchConsultReply(req, { timeoutMs: 40 }))
    const sending = chat.send('申請はどこですればいい？')
    check('タイムアウト中: 送信中表示（sending=true）', harness.stateAt(1) === true)
    await sending
    check('タイムアウト後: 送信中表示が解除される（sending=false）', harness.stateAt(1) === false)
    check(
      'タイムアウト後: 固定のタイムアウト文言',
      harness.stateAt(2) === userMessageForKind('timeout'),
      String(harness.stateAt(2)),
    )
    check('タイムアウト後: 再試行できる（retryable=true）', harness.stateAt(3) === true)

    globalThis.fetch = countingOkFetch as typeof fetch
    await chat.retry()
    check('再試行成功後: エラーが解除される', harness.stateAt(2) === null)
    check('再試行成功後: 再試行不要に戻る', harness.stateAt(3) === false)
    check(
      '再試行成功後: 応答が会話に追加される',
      (harness.stateAt(0) as ChatMessage[]).some((m) => m.text === '再試行の応答'),
    )

    // 連続操作（二重送信）で状態管理を壊さない
    globalThis.fetch = countingHangingFetch as typeof fetch
    const before = fetchCalls
    const first = chat.send('質問1です')
    const second = chat.send('質問2です')
    check(
      '連続操作: 2 件目は送信せず待機案内',
      harness.stateAt(2) === 'ただいま回答を準備しています。少しお待ちください。',
    )
    await Promise.all([first, second])
    check('連続操作: 実行したリクエストは 1 件', fetchCalls === before + 1, String(fetchCalls - before))
    check('連続操作後: 送信中表示が解除される', harness.stateAt(1) === false)
  } finally {
    globalThis.fetch = originalFetch
  }

  // ── 6. 通常成功・入力エラー・サーバーエラー・既存のエラー表示が変わらない ──
  section('6. 既存のエラー・成功表示の不変')
  const expectedMessages: Array<[ConsultErrorKind, string]> = [
    ['validation', '質問の形式に問題があります。内容を確認して再度お試しください。'],
    ['auth', 'AI 相談機能が現在ご利用いただけません（設定を確認中です）。'],
    ['rate_limit', 'アクセスが集中しています。時間をおいて再度お試しください。'],
    ['timeout', '回答の取得に時間がかかりすぎました。時間をおいて再度お試しください。'],
    ['network', '通信エラーが発生しました。時間をおいて再度お試しください。'],
    ['server', '回答の取得に失敗しました。時間をおいて再度お試しください。'],
    ['invalid_response', '回答を準備できませんでした。時間をおいて再度お試しください。'],
  ]
  for (const [kind, text] of expectedMessages) {
    check(`エラー文言: ${kind} は固定文のまま`, userMessageForKind(kind) === text)
  }
  const retryCases: Array<[ConsultErrorKind, boolean]> = [
    ['validation', false],
    ['auth', false],
    ['rate_limit', true],
    ['timeout', true],
    ['network', true],
    ['server', true],
    ['invalid_response', true],
  ]
  for (const [kind, expected] of retryCases) {
    check(`再試行可否: ${kind}`, isRetryableKind(kind) === expected)
  }
  const statusCases: Array<[number, ConsultErrorKind]> = [
    [400, 'validation'],
    [422, 'validation'],
    [401, 'auth'],
    [429, 'rate_limit'],
    [504, 'timeout'],
    [500, 'server'],
  ]
  for (const [status, kind] of statusCases) {
    check(`ステータス変換: ${status} -> ${kind}`, kindForStatus(status) === kind)
  }
  const stubLive: ConsultProvider = {
    id: 'stub-live',
    label: 'スタブ',
    isMock: false,
    respond: () => Promise.resolve(okReply()),
  }
  const resValidation = await handleConsultRequest(
    jsonRequest({ message: '', history: [], program: null, userContext: null }),
    {
      resolveProvider: () => stubLive,
      env: {},
      rateLimiter: new MemoryRateLimiter({ perMinute: 100, perDay: 1000, globalPerMinute: 1000 }),
    },
  )
  check('入力エラー: HTTP 400 のまま', resValidation.status === 400)
  const bodyValidation = (await resValidation.json()) as { error?: { message?: unknown } }
  check(
    '入力エラー: 既定の文言',
    typeof bodyValidation.error?.message === 'string' && bodyValidation.error.message.length > 0,
    String(bodyValidation.error?.message),
  )
  const normalized = normalizeReplyBody({ text: 'T', isMock: true, hasUnverified: true })
  check(
    '成功応答の正規化: 既存フィールドを維持',
    normalized.text === 'T' && normalized.isMock === true && normalized.hasUnverified === true,
  )

  // ── 7. APIキー・質問文などがログに出力されない ──
  section('7. ログの安全（許可リスト方式の維持）')
  const logEntries: string[] = []
  const capturingLogger = {
    warn: (...args: unknown[]): void => {
      logEntries.push(JSON.stringify(args))
    },
    error: (...args: unknown[]): void => {
      logEntries.push(JSON.stringify(args))
    },
  }
  const limiter = new MemoryRateLimiter({ perMinute: 100, perDay: 1000, globalPerMinute: 1000 })
  const leakProvider: ConsultProvider = {
    id: 'leak-test',
    label: 'テスト（秘密情報混入エラー）',
    isMock: false,
    respond: () =>
      Promise.reject(new ConsultSendError('timeout', `${FAKE_QUESTION} ${FAKE_KEY}`)),
  }
  const resLeak = await handleConsultRequest(
    jsonRequest({ message: FAKE_QUESTION, history: [], program: null, userContext: null }),
    { resolveProvider: () => leakProvider, env: {}, rateLimiter: limiter, logger: capturingLogger },
  )
  const logs1 = logEntries.join('\n')
  check('ログ: エラー種別（kind）は記録する', logs1.includes('timeout'))
  check(
    'ログ: 質問文・APIキー・error.message を出さない',
    !logs1.includes(FAKE_QUESTION) && !logs1.includes(FAKE_KEY) && !logs1.includes('sk-FAKE'),
  )
  const bodyLeak = (await resLeak.json()) as { error?: { message?: unknown } }
  check(
    '応答: 秘密情報を含まない固定文のみ',
    bodyLeak.error?.message === userMessageForKind('timeout'),
    String(bodyLeak.error?.message),
  )
  // 未知エラー名の error.message もログに出さない
  logEntries.length = 0
  const plainProvider: ConsultProvider = {
    id: 'leak-test-2',
    label: 'テスト（通常エラー）',
    isMock: false,
    respond: () => Promise.reject(new Error(`${FAKE_QUESTION} ${FAKE_KEY}`)),
  }
  await handleConsultRequest(
    jsonRequest({ message: FAKE_QUESTION, history: [], program: null, userContext: null }),
    { resolveProvider: () => plainProvider, env: {}, rateLimiter: limiter, logger: capturingLogger },
  )
  const logs2 = logEntries.join('\n')
  check(
    'ログ: 未知エラーの message も出さない',
    !logs2.includes(FAKE_QUESTION) && !logs2.includes(FAKE_KEY),
  )

  // ── 8. クライアント待ち上限の設定根拠 ──
  section('8. クライアント待ち上限の設定根拠')
  check(
    'サーバー最大処理時間 120.5 秒（30 秒×2 試行×2 生成＋待機）＋余裕 30 秒 = 150.5 秒',
    CONSULT_CLIENT_TIMEOUT_MS === 150_500,
    String(CONSULT_CLIENT_TIMEOUT_MS),
  )
  check('サーバー最大処理時間を下回らない', CONSULT_CLIENT_TIMEOUT_MS > 120_500)

  console.log(`\nP9-4: ${failed === 0 ? 'ALL PASSED' : `${failed} 件失敗`}`)
  if (failed > 0) process.exitCode = 1
}

void main()
