/**
 * M5（AI相談画面＋モック応答）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-m5.ts
 *
 * 確認項目:
 * - 制度を指定せず相談を開始できる
 * - 制度カードから開始すると正しい制度情報が引き継がれる
 * - 制度カード経由でも別の制度について質問できる
 * - モックと未確認情報が明確に区別される（確定情報として回答しない）
 * - 未対応の質問に根拠のない制度情報を生成しない
 * - 会話履歴をブラウザのメモリ以外に保存しない（非保存ガード）
 * - 会話ログ操作（リセット等）の純関数が正しく動作する
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendAssistantReply,
  appendUserMessage,
  buildInitialMessages,
  toConsultContextProgram,
  type ConsultSession,
} from '../lib/consult/conversation'
import { buildMockReply, mockConsultProvider } from '../lib/consult/mockAdvisor'
import { getConsultProvider } from '../lib/consult/provider'
import type { ConsultRequest } from '../lib/consult/types'
import { MOCK_SUPPORT_PROGRAMS } from '../lib/supports/mockPrograms'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

const childAllowance = MOCK_SUPPORT_PROGRAMS[0] // 児童手当（モック）

const ctxProgram = toConsultContextProgram(childAllowance)
const req = (
  message: string,
  overrides?: Partial<ConsultRequest>,
): ConsultRequest => ({
  message,
  history: [],
  program: null,
  userContext: null,
  ...overrides,
})

// ── 1. 相談UIと応答処理の分離（プロバイダ差し替え可能な構造） ──
const provider = getConsultProvider()
check(
  'M5 のプロバイダはモック（Live AI 未接続）',
  provider.isMock && provider.id === 'mock' && provider === mockConsultProvider,
)
check(
  'プロバイダのラベルがモックであることを明示',
  provider.label.includes('モック'),
)

// ── 2. 制度を指定せず相談を開始できる ──
const freeReply = buildMockReply(req('子育てでもらえるお金には、どんなものがある？'))
check(
  '自由相談: 制度指定なしでモック回答が返る',
  freeReply.isMock && freeReply.text.length > 0,
)
check(
  '自由相談: 全モック制度の名前を案内',
  MOCK_SUPPORT_PROGRAMS.every((p) => freeReply.text.includes(p.name)),
)
check(
  '自由相談: 関連制度はすべてモック（未確認）として区別',
  freeReply.relatedPrograms.length === MOCK_SUPPORT_PROGRAMS.length &&
    freeReply.relatedPrograms.every((p) => p.sourceType === 'mock'),
)
check(
  '自由相談: 回答が開発用モックサンプルであることを明示',
  freeReply.text.includes('【開発用モック応答】') &&
    freeReply.text.includes('開発用のサンプル'),
)
check(
  '自由相談: 公式サイトの検索を行ったかのような表示をしない',
  freeReply.text.includes('公式サイトの検索結果ではなく'),
)

// ── 3. 制度カードから開始すると正しい制度情報が引き継がれる ──
const kickoff = buildInitialMessages({ program: ctxProgram, userContext: null })[0]
check(
  '引き継ぎ: 開始メッセージに制度名と概要が含まれる',
  kickoff.text.includes('児童手当（モック）') &&
    kickoff.text.includes(childAllowance.summary),
)
check(
  '引き継ぎ: 制度はきっかけであり他制度も質問可能と明示',
  kickoff.text.includes('この制度以外の支援制度についても自由に質問できます'),
)
check(
  '引き継ぎ: モック制度は未確認として扱う',
  kickoff.relatedPrograms[0].sourceType === 'mock' && kickoff.hasUnverified,
)
check(
  '引き継ぎ情報は必要な項目のみ（金額などは含まない）',
  JSON.stringify(Object.keys(ctxProgram).sort()) ===
    JSON.stringify(
      ['id', 'name', 'summary', 'amountDescription', 'where', 'deadlineNote', 'missingInformation', 'mock'].sort(),
    ),
)

const applicationReply = buildMockReply(
  req('申請はどこですればいい？', { program: ctxProgram }),
)
check(
  '引き継ぎ: 選択した制度の申請情報が回答に反映',
  applicationReply.text.includes('児童手当（モック）') &&
    applicationReply.text.includes('市区町村'),
)
check(
  '引き継ぎ: 申請先・期限・必要書類はすべて「要確認」を明示',
  applicationReply.text.includes('申請先：市区町村（要確認）') &&
    applicationReply.text.includes('（要確認）') &&
    applicationReply.text.includes('必要書類'),
)
check(
  '引き継ぎ: 関連制度に選択した制度が含まれる',
  applicationReply.relatedPrograms.some((p) => p.id === childAllowance.id),
)

// ── 4. 制度カード経由でも別の制度について質問できる ──
const otherReply = buildMockReply(
  req('ほかに利用できる制度はある？', { program: ctxProgram }),
)
check(
  '他制度の質問: 別の制度を案内（選択制度以外）',
  otherReply.text.includes('高校生等奨学給付金（モック）') &&
    otherReply.text.includes('児童手当（モック）」以外にも'),
)
check(
  '他制度の質問: 関連制度に選択制度以外が含まれる',
  otherReply.relatedPrograms.some((p) => p.id !== childAllowance.id),
)
const crossReply = buildMockReply(
  req('高校生等奨学給付金の対象条件は？', { program: ctxProgram }),
)
check(
  '他制度の質問: 質問文で名指しした制度が優先される',
  crossReply.text.includes('高校生等奨学給付金（モック）') &&
    !crossReply.text.includes('児童手当（モック）」の対象条件'),
)
check(
  '他制度の質問: モックデータにない制度もある旨を明示',
  otherReply.text.includes('実際の利用可能な制度の一覧ではありません'),
)

// ── 5. モックと未確認情報の区別 ──
const detailReply = buildMockReply(
  req('児童手当の金額はいくら？', { program: ctxProgram }),
)
check(
  'モック/未確認の区別: 金額は「推定・要確認」と明示',
  detailReply.text.includes('【推定・要確認】') &&
    detailReply.text.includes('確定情報ではありません'),
)
const aidDetail = buildMockReply(
  req('こども医療費助成の金額はいくら？', { program: ctxProgram }),
)
check(
  'モック/未確認の区別: 金額未確認の制度は「未確認」と明示',
  aidDetail.text.includes('【未確認】'),
)
check(
  'モック/未確認の区別: 関連制度の注記に未確認が明記される',
  detailReply.relatedPrograms.every(
    (p) => p.sourceType === 'mock' && p.note.includes('未確認'),
  ),
)
check(
  '受給資格は確定情報として回答しない',
  buildMockReply(req('自分の状況で対象になりそうな支援は？', { program: ctxProgram }))
    .text.includes('正式な受給資格の決定ではありません'),
)
check(
  '申請情報は公式案内ではないと明示',
  applicationReply.text.includes('公式の申請案内ではありません'),
)

// ── 6. 未対応の質問に根拠のない制度情報を生成しない ──
const unsupportedReply = buildMockReply(req('今日の天気はどう？'))
check(
  '未対応の質問: 未対応であることを明示',
  unsupportedReply.unsupported && unsupportedReply.text.includes('未対応'),
)
check(
  '未対応の質問: 制度情報を生成しない（制度名・金額・申請先を出さない）',
  unsupportedReply.relatedPrograms.length === 0 &&
    !MOCK_SUPPORT_PROGRAMS.some((p) => unsupportedReply.text.includes(p.name)) &&
    !unsupportedReply.text.includes('市区町村') &&
    !/120[,，]?000|118[,，]?800/.test(unsupportedReply.text),
)

// ── 7. 入力情報は相談に必要な範囲のみ利用 ──
const eligibilityReply = buildMockReply(
  req('自分の状況で対象になりそうな支援は？', {
    program: ctxProgram,
    userContext: {
      childCount: 2,
      hasAnnualIncome: true,
      usedProgramIds: ['mock-child-allowance'],
    },
  }),
)
check(
  '入力情報の最小利用: 人数・年収入力有無・利用中制度のみ参照',
  eligibilityReply.text.includes('お子さま 2 人') &&
    eligibilityReply.text.includes('世帯年収の入力 あり') &&
    eligibilityReply.text.includes('利用中の制度 1 件'),
)
check(
  '入力情報の最小利用: 金額を渡さない旨を明示し、金額を回答に含めない',
  eligibilityReply.text.includes('収入・貯蓄の金額は相談機能に渡していません') &&
    !/\d{2}[,，]\d{3}/.test(eligibilityReply.text),
)

// ── 8. 決定論的なモック応答 ──
const again = buildMockReply(req('申請はどこですればいい？', { program: ctxProgram }))
check(
  '同じ質問には同じ回答が返る（決定論的）',
  again.text === applicationReply.text,
)

// ── 9. 会話履歴の非保存ガード（メモリ以外に保存しない） ──
const storagePattern =
  /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)|sessionStorage\s*\.\s*(getItem|setItem|removeItem|clear)|indexedDB\s*\.\s*(open|deleteDatabase)|document\.cookie/
const storageCheckedFiles = [
  'components/Consult.tsx',
  'lib/consult/useConsultChat.ts',
  'lib/consult/conversation.ts',
  'lib/consult/mockAdvisor.ts',
  'app/page.tsx',
]
const storageHits = storageCheckedFiles.filter((file) =>
  storagePattern.test(readFileSync(join(process.cwd(), file), 'utf-8')),
)
check(
  'localStorage / sessionStorage / IndexedDB / Cookie への保存なし',
  storageHits.length === 0,
  storageHits.join(', '),
)

// ── 10. 会話ログ操作の純関数（リセット等） ──
const session: ConsultSession = { program: ctxProgram, userContext: null }
const initial = buildInitialMessages(session)
check(
  '開始時メッセージは1件（制度引き継ぎ込み）',
  initial.length === 1 && initial[0].role === 'assistant',
)
const withUser = appendUserMessage(initial, '申請はどこですればいい？')
check(
  'ユーザー発言の追加（元の配列は変更しない）',
  withUser.length === 2 && initial.length === 1 && withUser[1].role === 'user',
)
const withReply = appendAssistantReply(withUser, applicationReply)
check(
  '応答の追加（元の配列は変更しない）',
  withReply.length === 3 && withUser.length === 2 &&
    withReply[2].isMock && withReply[2].hasUnverified,
)
const resetMessages = buildInitialMessages(session)
check(
  'リセットで開始時メッセージに戻る',
  resetMessages.length === 1 && resetMessages[0].text === initial[0].text,
)

console.log(
  failed === 0
    ? '\nM5 verification: ALL PASSED'
    : `\nM5 verification: ${failed} FAILED`,
)
process.exit(failed === 0 ? 0 : 1)