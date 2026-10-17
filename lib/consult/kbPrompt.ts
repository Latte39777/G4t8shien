/**
 * KB → AI プロンプト変換（P6。純関数・外部通信なし・入力を変更しない）
 *
 * 責務: サーバー側 KB から解決した事実カード（KbFactCard）を、ライブ AI の
 * プロンプトに載せる「KB ブロック」文字列へ変換する。回答本文の生成や、
 * 出典・確認状態の UI 付与は行わない（そちらは replySchema / api.attachKbContext
 * / kbContext.enrichReplyWithKb の責務のまま）。
 * また P10 で、AI による支援制度提案（programIds）用の「支援制度候補リスト」を
 * サーバー側レジストリから組み立てる（buildProgramCandidateList。ID・名称・区分のみ）。
 *
 * 【安全方針（このモジュールの不変条件）】
 * - 確認済みの事実（confirmedFacts。buildKbAiContext 形式・出典・provenance 付き）と
 *   未確認の事項（unconfirmedNotes）を明確に分離し、混在させない
 * - eligibility（受給資格・利用資格）は常に未確認として扱う
 *   （KB の confidence 規則で confirmed にならない上、明示行も出す）
 * - AI 用プロンプトに URL を含めない（出典は title / 機関名 / URL 検証状態のみ。
 *   リンク表示はサーバー側 citations → UI の責務）
 * - KB 未特定（cards 空）ならブロックごと省略し、無関係な制度情報を渡さない
 * - 制度名・出典・URL を新規に創作しない（KB の値の転記のみ）
 *
 * 【長さ制限】
 * - 制限単位は「文字数」（JS の code unit 長）。モデルのトークン上限は
 *   大学 API 側で未確認のため（docs/consult-m6e-design.md）、トークン換算は行わない。
 *   KB_PROMPT_MAX_CHARS は送信量を抑える工学的なバジェットであり、モデルの上限の推測ではない。
 * - 切り詰めは「事実 1 行」を単位に行い、行の途中では切らない。制度の基本情報
 *   （名称・区分・確認状態・確認日・受給資格の未確認行）と「未確認の事項」「出典」は
 *   必ず丸ごと含めるため、未確認事項が確認済み情報として誤表示されない。
 *   確認済みの事実だけが行単位で省略され、その旨を明示する。制度 1 件が丸ごと
 *   入らない場合は制度単位で省略し、その旨を明示する（先頭の制度を優先）。
 */
import { KB_AMOUNT_CALCULATION_POLICY } from '../supports/kb'
import { getSupportPrograms } from '../supports/registry'
import type { SupportProgram } from '../types/support'
import type { KbConsultContext, KbFactCard } from './kbContext'
import { categoryLabel } from './mockAdvisor'

/** KB ブロックの最大長（文字数。トークン数ではない） */
export const KB_PROMPT_MAX_CHARS = 8000

/** 確認状態のラベル（components/Consult.tsx の表示と文言を揃える） */
const VERIFICATION_LABELS: Record<string, string> = {
  'official-verified': '公式情報で確認済み',
  partial: '一部未確認',
  unverified: '未確認',
}

/** 制度区分のラベル（既存の categoryLabel を再利用。未知区分は推測しない） */
function categoryLine(category: string | null): string {
  return category === null
    ? '区分: 未確認（推測で分類しない）'
    : `区分: ${categoryLabel(category as Parameters<typeof categoryLabel>[0])}`
}

/** 確認日・再確認要否の行（確認日は KB の値のみ。推測で埋めない） */
function checkedLine(card: KbFactCard): string {
  const date = card.checkedAt ?? '未確認'
  return card.reviewOutdated
    ? `確認日: ${date}（この制度は再確認が必要な情報があります）`
    : `確認日: ${date}`
}

/**
 * 出典の行（URL は載せない。検証状態と再確認要否のみ）。
 * KB 由来の出典以外は書き出さない。
 */
function sourceLines(card: KbFactCard): string[] {
  const citations = card.citations ?? []
  if (citations.length === 0) return ['・出典の登録なし（推測で補完しない）']
  return citations.map((c) => {
    const urlState = c.url === null ? 'URL の登録なし' : c.urlVerified ? 'URL は公式確認済み' : 'URL は未確認（リンク掲載なし）'
    const outdated = c.reviewOutdated ? '・再確認が必要' : ''
    return `・${c.title || '（表題なし）'}（${c.organization || '機関名未確認'}）— ${urlState}${outdated}`
  })
}

/** 非空の文字列だけを採用（欠損・空文字は安全に無視する） */
function nonEmptyLines(lines: readonly string[] | undefined): string[] {
  return (lines ?? []).filter((l) => typeof l === 'string' && l.trim().length > 0)
}

/** 制度 1 件ぶんのセクション（基本情報・未確認・出典は丸ごと含める固定部分） */
function programSkeleton(card: KbFactCard): {
  head: string
  tail: string
} {
  const head = [
    '――――――――――――――',
    `制度: ${card.name || '（名称未確認）'}`,
    categoryLine(card.category ?? null),
    `確認状態: ${VERIFICATION_LABELS[card.verification] ?? '未確認'}`,
    checkedLine(card),
    '受給資格（利用資格）: 未確認（制度情報が確認済みでも、相談者本人の資格は確定しない）',
    '【確認済みの事実】（この範囲のみ根拠として説明してよい）',
  ].join('\n')
  const tail = [
    '【未確認の事項】（未確認と伝え、確認済みの事実に混ぜない）',
    ...nonEmptyLines(card.unconfirmedNotes),
    '【出典】（URL は提示しない。リンクはサーバー側の KB 情報から UI に表示される）',
    ...sourceLines(card),
  ].join('\n')
  return { head, tail }
}

/** 確認済みの事実の一部省略を明示する行 */
function factsOmittedNote(shown: number, total: number): string {
  return `※確認済みの事実は ${total} 行中 ${shown} 行のみ表示（長さ制限）。省略された行を推測で補完しないでください。`
}

/** 省略された制度の明示（省略された情報を未確認として扱わせる） */
function omittedNote(count: number): string {
  return `※制度 ${count} 件は長さ制限（${KB_PROMPT_MAX_CHARS} 文字）により省略しました。省略された情報を推測で補完せず「確認できる公式情報がありません」と扱ってください。`
}

/**
 * KB 文脈 → AI 用 KB ブロック（純関数）。
 * - cards が空（KB 未特定）なら '' を返す（ブロックごと省略）
 * - 入力（context）は変更しない
 * - 全体で KB_PROMPT_MAX_CHARS 文字以内に収める。切り詰めは事実の行単位
 *   （行の途中では切らない）。未確認の事項・出典は常に丸ごと表示するため、
 *   未確認情報が確認済みとして誤表示されることはない。省略はすべて明示する
 */
export function buildKbPromptBlock(context: KbConsultContext): string {
  const cards = Array.isArray(context?.cards) ? context.cards : []
  if (cards.length === 0) return ''
  const mandatory = [
    '【公式情報 KB（サーバー管理の確認記録）】',
    '以下にない制度情報は推測で補わないこと。',
    kbSafetyRules(context.amountCalculationPolicy),
  ].join('\n')
  const parts: string[] = [mandatory]
  // 制度の省略が生じる場合に備え、省略明示行ぶんの長さを常に予約する
  const noteReserve = omittedNote(cards.length).length + 2
  const budget = KB_PROMPT_MAX_CHARS - noteReserve
  let used = mandatory.length
  let omittedPrograms = 0
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]
    const { head, tail } = programSkeleton(card)
    const facts = nonEmptyLines(card.confirmedFacts)
    // 基本情報・未確認・出典（固定部分）＋確認済みの事実を行単位で組み立てる。
    // 収まらなくなったら事実の末尾から 1 行ずつ落とし、それでも無理なら
    // この制度を丸ごと省略する（行の途中では絶対に切らない）
    const assemble = (shown: number): string =>
      head +
      (shown > 0 ? `\n${facts.slice(0, shown).join('\n')}` : '') +
      (shown < facts.length
        ? `\n${factsOmittedNote(shown, facts.length)}`
        : '') +
      `\n${tail}`
    let shown = facts.length
    let section = assemble(shown)
    while (shown >= 0 && used + section.length + 2 > budget) {
      shown -= 1
      section = assemble(shown)
    }
    if (shown < 0) {
      omittedPrograms = cards.length - i
      break
    }
    parts.push(section)
    used += section.length + 2
  }
  // 省略が生じた場合は必ずその旨を明示する（省略情報を未確認として扱わせる）
  if (omittedPrograms > 0) parts.push(omittedNote(omittedPrograms))
  return parts.join('\n\n')
}

/**
 * AI に守らせる必須ルール（P6 の安全要件 1〜9）。
 * 既存の安全指示（iniadAdvisor のシステムプロンプト）と矛盾しない形で
 * 組み、制約を緩めない。金額計算の方針は KB の既存方針をそのまま使う。
 */
export function kbSafetyRules(amountCalculationPolicy: string): string {
  const policy =
    typeof amountCalculationPolicy === 'string' &&
    amountCalculationPolicy.trim().length > 0
      ? amountCalculationPolicy
      : KB_AMOUNT_CALCULATION_POLICY
  return [
    '【公式情報 KB を使うときの必須ルール】',
    '1. 制度情報は「確認済みの事実」の範囲でのみ説明する。範囲外の内容は推測で補わない。',
    '2. 未確認の事項は「未確認」「確認できる公式情報がありません」と伝え、確認済みの事実として断定しない。',
    '3. 制度の一般情報が確認済みでも、相談者本人の受給資格・利用資格・申請可否は確定しない（受給資格は常に未確認）。',
    '4. 給付（返還不要）、減免・助成（返還不要）、貸与・貸付（返済が必要）、税制上の優遇を混同しない。',
    `5. 金額の合算・換算・資格判定を行わない。${policy}`,
    '6. KB にない制度名・出典・URL を作らない。AI の学習知識だけで制度情報を確定しない。',
    '7. URL やリンクを回答本文に書かない。出典リンクはサーバー側の KB 情報から UI へ渡る。',
    '8. KB の情報だけでは質問に答えられない場合は、推測で埋めず「確認できる公式情報がありません」と明示して公式窓口・公式サイトでの確認を案内する。',
    '9. 既存の安全指示と矛盾しない。確認済みの事実の範囲での説明を除き、既存の安全指示（具体的な資格・金額・期限・窓口の断定の禁止、「公式確認済み」「確定」の語で断定しないこと）を制約を緩めず守る。未確認の断定・受給資格の確定・金額の計算は常に禁止。',
  ].join('\n')
}

/**
 * 支援制度候補リスト（AI 提案用。P10・純関数）。
 *
 * 【不変の制約】
 * - 候補はサーバー側の既存レジストリ（getSupportPrograms）に存在する実在制度のみ
 * - ID・名称・区分のみを載せる。金額・申請期限・申請窓口・受給資格は含めない
 *   （未確認のまま扱わせ、AI に断定させないため。金額・期限は KB 確認済みの
 *   事実にのみ載せ、その範囲で説明させる既存方針と矛盾させない）
 * - URL は載せない（出典リンクはサーバー側 citations → UI の責務のまま）
 * - 制度名はレジストリの値の転記のみ（AI 生成文の制度名を混ぜない）
 */
export function buildProgramCandidateList(
  programs: readonly SupportProgram[] = getSupportPrograms(),
): string {
  if (programs.length === 0) return ''
  const lines = [
    '【支援制度候補リスト（サーバー管理の制度一覧）】',
    '・programIds に入れる ID はこのリストからのみ選ぶこと。リストにない ID・架空の制度は禁止。',
    '・ここには金額・申請期限・申請窓口・受給資格が含まれません。提案時にこれらを断定しないこと。',
    '・相談者の状況に関連する可能性がある制度があるときだけ programIds に入れる。関連する制度がなければ空配列にする。',
  ]
  for (const p of programs) {
    lines.push(
      `・ID: ${p.id} / 名称: ${p.name} / 区分: ${categoryLabel(p.category)}`,
    )
  }
  return lines.join('\n')
}