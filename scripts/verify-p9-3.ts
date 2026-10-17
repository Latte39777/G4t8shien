/**
 * P9-3 検証: 個人情報マスクの対応範囲とログ出力の安全化
 *
 * 実行: npx tsx scripts/verify-p9-3.ts
 *
 * - 使用するのは合成文字列のみ（実ユーザーの相談文・実個人情報・実 API キーは
 *   使わない。秘密情報らしき文字列もすべてダミー）
 * - 外部通信は一切行わない（このスクリプトはネットワーク API を呼ばない）
 * - 確認項目:
 *   1. 既存マスク（半角ハイフン電話・メール・12 桁 4-4-4・8 桁以上連続数字）の維持
 *   2. 追加マスク（空白区切り電話・全角数字・全角/異体字区切り・郵便番号形式）
 *   3. 金額など一般的な数字を一律マスクしない
 *   4. 検出できない対象（氏名・住所など）と過剰マスク例の明示
 *   5. 置換が周辺の文章を壊さない（元文字列の無関係な範囲を消さない）
 *   6. ログに秘密情報・error.message・スタックを出さない（許可リスト方式）
 */
import { handleConsultRequest } from '../lib/consult/api'
import {
  ConsultSendError,
  safeErrorInfo,
  userMessageForKind,
} from '../lib/consult/errors'
import { mapUpstreamError } from '../lib/consult/iniadAdvisor'
import { MemoryRateLimiter } from '../lib/consult/rateLimit'
import { redactForApi, redactText } from '../lib/consult/redact'
import type { ConsultProvider, ConsultReply } from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

// ── 合成文字列（すべてダミー。実データではない） ──
const FAKE_KEY = 'sk-FAKE-TEST-KEY-0000DEADBEEF'
const FAKE_TOKEN = 'Bearer FAKE-TOKEN-DO-NOT-LOG'
const FAKE_NAME = 'ダミー太郎'
const SECRET_MARKERS = [FAKE_KEY, FAKE_TOKEN, 'DEADBEEF', 'FAKE-TOKEN', FAKE_NAME]

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const validBody = {
  message: '申請はどこですればいい？',
  history: [],
  program: null,
  userContext: null,
}

function okReply(): ConsultReply {
  return {
    text: '応答',
    isMock: false,
    hasUnverified: true,
    relatedPrograms: [],
    unsupported: false,
    sourceType: 'ai',
  }
}

function liveStub(respond: () => Promise<ConsultReply>): ConsultProvider {
  return { id: 'stub-live', label: 'ライブスタブ（テスト）', isMock: false, respond }
}

function freshLimiter(): MemoryRateLimiter {
  return new MemoryRateLimiter({
    perMinute: 100,
    perDay: 1000,
    globalPerMinute: 1000,
  })
}

// ── ログ収集（許可リスト検証用） ──
const logEntries: string[] = []
const capturingLogger = {
  warn: (...args: unknown[]): void => {
    logEntries.push(JSON.stringify(args))
  },
  error: (...args: unknown[]): void => {
    logEntries.push(JSON.stringify(args))
  },
}

function logsText(): string {
  return logEntries.join('\n')
}

async function main(): Promise<void> {
  // ── 1. 既存マスクの維持 ──
  console.log('── 1. 既存マスクの維持 ──')
  const existingCases: Array<[string, string, string]> = [
    ['半角ハイフン電話', '090-1234-5678', '［電話番号］'],
    ['市外局番電話', '03-1234-5678', '［電話番号］'],
    ['3-3-4 電話', '090-123-456', '［電話番号］'],
    ['12 桁 4-4-4', '1234-5678-9012', '［番号］'],
    ['連続数字 11 桁', '09012345678', '［数字］'],
    ['メールアドレス', 'taro@example.com', '［メールアドレス］'],
    ['複合文の既存マスク', '電話 090-1234-5678 / メール taro@example.com', '電話 ［電話番号］ / メール ［メールアドレス］'],
  ]
  for (const [label, input, expected] of existingCases) {
    const out = redactText(input)
    check(`既存: ${label}`, out === expected, `${input} -> ${out}`)
  }

  // ── 2. 追加マスク（空白・全角・異体字・郵便番号形式） ──
  console.log('── 2. 追加マスク（空白・全角・異体字・郵便番号形式） ──')
  const addedCases: Array<[string, string, string]> = [
    ['空白区切り電話', '090 1234 5678', '［電話番号］'],
    ['全角数字＋半角スペース電話', '０９０ １２３４ ５６７８', '［電話番号］'],
    ['全角数字＋全角スペース電話', '０９０　１２３４　５６７８', '［電話番号］'],
    ['異体字ダッシュ電話(U+2010)', '090‐1234‐5678', '［電話番号］'],
    ['全角ダッシュ電話(U+FF0D)', '090－1234－5678', '［電話番号］'],
    ['長音区切り電話(U+30FC)', '090ー1234ー5678', '［電話番号］'],
    ['マイナス記号区切り電話(U+2212)', '090−1234−5678', '［電話番号］'],
    ['全角数字 4-4-4', '１２３４－５６７８－９０１２', '［番号］'],
    ['全角数字の連続 11 桁', '０９０１２３４５６７８', '［数字］'],
    ['郵便番号（〒付き）', '〒123-4567', '［郵便番号］'],
    ['郵便番号（3-4 形式）', '123-4567', '［郵便番号］'],
    ['郵便番号（〒付き・区切りなし）', '〒1234567', '［郵便番号］'],
    ['郵便番号（全角）', '〒１２３－４５６７', '［郵便番号］'],
  ]
  for (const [label, input, expected] of addedCases) {
    const out = redactText(input)
    check(`追加: ${label}`, out === expected, `${input} -> ${out}`)
  }
  // ── 3. 一般的な数字は一律マスクしない ──
  console.log('── 3. 一般的な数字は一律マスクしない ──')
  const keepCases: Array<[string, string]> = [
    ['金額（カンマ付き）', '月額10,000 円（適用年度: 2025）'],
    ['金額（万円）', '年収300万円で子ども2人です'],
    ['短い数字列（年齢など）', '12歳の子どもがいます'],
    ['7 桁の連続数字（口座番号等・一律マスクしない）', '口座番号は1234567です'],
    ['年月日', '2026-10-15に申請しました'],
  ]
  for (const [label, input] of keepCases) {
    const out = redactText(input)
    check(`維持: ${label}`, out === input, `${input} -> ${out}`)
  }

  // ── 4. 検出できない対象と過剰マスクの既知例 ──
  console.log('── 4. 検出できない対象と過剰マスクの既知例 ──')
  const unknownCases: Array<[string, string]> = [
    ['氏名（検出対象外の限界）', '申請者の田中太郎に確認します'],
    ['住所（検出対象外の限界）', '東京都千代田区霞が関1丁目2番地'],
  ]
  for (const [label, input] of unknownCases) {
    const out = redactText(input)
    check(`限界: ${label} は検出されない`, out === input, `${input} -> ${out}`)
  }
  const overMask = redactText('補助金100-2000円の範囲')
  check(
    '限界: 数字範囲 100-2000 は郵便番号形式と区別できず過剰マスクされる（既知）',
    overMask === '補助金［郵便番号］円の範囲',
    overMask,
  )

  // ── 5. 置換が周辺の文章を壊さない ──
  console.log('── 5. 置換が周辺の文章を壊さない ──')
  const contextCases: Array<[string, string, string]> = [
    ['文末の句読点を残す', '連絡先は090-1234-5678です。', '連絡先は［電話番号］です。'],
    [
      '複数 PII と前後文が残る',
      '前：x 連絡先 090 1234 5678 メール taro@example.com 後：y',
      '前：x 連絡先 ［電話番号］ メール ［メールアドレス］ 後：y',
    ],
    [
      '元文字列の全角文字は正規化されない',
      '郵便は東京都１丁目へ。電話090－1234－5678。',
      '郵便は東京都１丁目へ。電話［電話番号］。',
    ],
    [
      '日付と電話番号が併記された文',
      '2026-10-15 に03-1234-5678 へ確認',
      '2026-10-15 に［電話番号］ へ確認',
    ],
  ]
  for (const [label, input, expected] of contextCases) {
    const out = redactText(input)
    check(`周辺保持: ${label}`, out === expected, `${input} -> ${out}`)
  }
  const truncated = redactForApi('090-1234-5678abcdef', 8)
  check(
    'redactForApi: マスク後の文字列を指定長で切り詰める（既存仕様）',
    truncated === '［電話番号］ab',
    truncated,
  )
  // ── 6. ログ出力の安全化（許可リスト方式） ──
  console.log('── 6. ログ出力の安全化（許可リスト方式） ──')
  // 6-1. AI 応答失敗（error.message に秘密情報らしき文字列を含むダミー）
  logEntries.length = 0
  const res1 = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () =>
      liveStub(() =>
        Promise.reject(
          new Error(`upstream body: ${FAKE_KEY} ${FAKE_TOKEN} name=${FAKE_NAME}`),
        ),
      ),
    env: {},
    rateLimiter: freshLimiter(),
    logger: capturingLogger,
  })
  const body1 = await res1.text()
  check(
    'ログ: AI 応答失敗時に error.message をログへ書かない',
    res1.status === 502 &&
      logEntries.length > 0 &&
      SECRET_MARKERS.every((m) => !logsText().includes(m)),
  )
  check(
    'ログ: 許可リスト情報（kind=server・name）だけを記録する',
    logsText().includes('kind=server') &&
      logsText().includes('"name":"Error"') &&
      !logsText().includes('"message"'),
  )
  check(
    '応答: クライアント向けも固定文言のみ（秘密情報・スタックなし）',
    body1.includes(userMessageForKind('server')) &&
      SECRET_MARKERS.every((m) => !body1.includes(m)) &&
      !body1.includes('node:') &&
      !body1.includes('.ts:'),
    body1,
  )

  // 6-2. ConsultSendError（メッセージに秘密情報らしき文字列を含めるダミー）
  logEntries.length = 0
  const res2 = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () =>
      liveStub(() => Promise.reject(new ConsultSendError('rate_limit', FAKE_KEY))),
    env: {},
    rateLimiter: freshLimiter(),
    logger: capturingLogger,
  })
  const body2 = await res2.text()
  check(
    'ログ: ConsultSendError の独自メッセージもログに出さない',
    res2.status === 429 &&
      logsText().includes('kind=rate_limit') &&
      SECRET_MARKERS.every((m) => !logsText().includes(m)),
  )
  check(
    '応答: 429 の文言は固定（原因ラベルや秘密情報を含まない）',
    body2.includes(userMessageForKind('rate_limit')) &&
      SECRET_MARKERS.every((m) => !body2.includes(m)),
    body2,
  )

  // 6-3. 上流風の非 Error オブジェクト（status 付き）
  logEntries.length = 0
  const res3 = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () =>
      liveStub(() =>
        Promise.reject({ name: 'Error', status: 502, message: FAKE_TOKEN }),
      ),
    env: {},
    rateLimiter: freshLimiter(),
    logger: capturingLogger,
  })
  await res3.text()
  check(
    'ログ: 非 Error オブジェクトも status のみ記録（本文なし）',
    res3.status === 502 &&
      logsText().includes('"status":502') &&
      SECRET_MARKERS.every((m) => !logsText().includes(m)),
    logsText(),
  )
  // 6-4. KB 文脈解決の失敗（warn）
  logEntries.length = 0
  const res4 = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => liveStub(() => Promise.resolve(okReply())),
    env: {},
    rateLimiter: freshLimiter(),
    logger: capturingLogger,
    resolveKbContext: () => {
      throw new Error(FAKE_KEY)
    },
  })
  const body4 = await res4.text()
  check(
    'ログ: KB 解決失敗の warn も error.message を書かない',
    res4.status === 200 &&
      logEntries.length > 0 &&
      SECRET_MARKERS.every((m) => !logsText().includes(m)) &&
      SECRET_MARKERS.every((m) => !body4.includes(m)),
  )

  // 6-5. プロバイダ解決の失敗
  logEntries.length = 0
  const res5 = await handleConsultRequest(jsonRequest(validBody), {
    resolveProvider: () => {
      throw new Error(FAKE_TOKEN)
    },
    env: {},
    rateLimiter: freshLimiter(),
    logger: capturingLogger,
  })
  const body5 = await res5.text()
  check(
    'ログ: プロバイダ解決失敗も生エラーを渡さない',
    res5.status === 502 &&
      SECRET_MARKERS.every((m) => !logsText().includes(m)) &&
      SECRET_MARKERS.every((m) => !body5.includes(m)),
    logsText(),
  )

  // 6-6. safeErrorInfo / mapUpstreamError の単体確認
  const info1 = safeErrorInfo(new Error(FAKE_KEY))
  check(
    'safeErrorInfo: name/kind/status のみ（message を持たない）',
    JSON.stringify(info1) === '{"name":"Error","kind":null,"status":null}',
    JSON.stringify(info1),
  )
  const info2 = safeErrorInfo(new ConsultSendError('timeout', FAKE_KEY))
  check(
    'safeErrorInfo: ConsultSendError は kind を記録する',
    JSON.stringify(info2) ===
      '{"name":"ConsultSendError","kind":"timeout","status":null}',
    JSON.stringify(info2),
  )
  const info3 = safeErrorInfo({ name: 'WeirdError', message: FAKE_KEY })
  check(
    'safeErrorInfo: 未知のエラー名は unknown に寄せる',
    JSON.stringify(info3) === '{"name":"unknown","kind":null,"status":null}',
    JSON.stringify(info3),
  )
  const mapped = mapUpstreamError({ name: 'Error', status: 500, message: FAKE_KEY })
  check(
    'mapUpstreamError: 上流メッセージを引き継がない（種別のみ）',
    mapped instanceof ConsultSendError &&
      mapped.kind === 'server' &&
      !mapped.message.includes(FAKE_KEY),
    mapped.message,
  )

  console.log(`\nverify-p9-3: ${failed === 0 ? 'ALL PASSED' : `${failed} 件失敗`}`)
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`)
    process.exitCode = 1
  }
}

void main()