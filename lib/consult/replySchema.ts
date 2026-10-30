/**
 * AI 応答の JSON スキーマ検証と安全化（M6 フェーズ1）
 *
 * 【方針】大学 API の structured outputs（JSON Schema 強制）は未確認のため
 * 使わない。プロンプトで JSON を要求し（CONSULT_AI_JSON_MODE=prompt）、
 * このモジュールで zod 検証する。
 *
 * 【フェーズ1の禁止事項の保証】
 * - 具体的制度情報フィールド（programs[] の金額・期限・条件など）は
 *   スキーマに存在せず、モデルが返しても破棄する（strip）
 * - 関連制度は AI に書かせない。AI が返すのは制度 ID（programIds）のみで、
 *   関連制度チップはサーバー側レジストリで ID を検証してから
 *   lib/consult/kbContext.ts の resolveAiProposedPrograms が生成する
 *   （不明な ID は破棄。制度名・出典・金額は AI 生成文から採用しない）
 * - hasUnverified は常に true（未確認ラベルを外さない）
 * - 本文中の URL は出典として扱わない（アンカー化しない）。URL を
 *   検出した場合は注記を付す
 */
import { z } from 'zod'
import type { ConsultReply } from './types'

/**
 * AI に要求する JSON の形（プロンプトで指示する）。
 * reply / clarificationQuestions / unsupported / programIds のみ許可し、
 * それ以外のフィールド（programs・amounts・sources など）は strip で破棄する。
 * programIds は制度 ID の文字列のみ（制度名・金額・URL は渡らせない）。
 * 採用はサーバー側でレジストリ検証してから（resolveAiProposedPrograms）。
 */
export const aiReplyJsonSchema = z.object({
  reply: z.string().min(1).max(4000),
  clarificationQuestions: z.array(z.string().min(1).max(200)).max(5).optional(),
  unsupported: z.boolean().optional(),
  programIds: z.array(z.string().min(1).max(100)).max(20).optional(),
})

export type AiReplyJson = z.infer<typeof aiReplyJsonSchema>

/** JSON 文字列から最初の JSON オブジェクト部分を切り出す */
export function extractJsonObject(raw: string): string | null {
  // ```json ... ``` のコードフェンスを剥がす
  const unfenced = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = unfenced.indexOf('{')
  if (start === -1) return null
  // 波括弧の対応を数えて最外のオブジェクトを取り出す
  let depth = 0
  for (let i = start; i < unfenced.length; i += 1) {
    const ch = unfenced[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return unfenced.slice(start, i + 1)
    }
  }
  return null
}

/** AI の生応答から許可フィールドのみを検証・抽出する（不正なら null） */
export function parseAiReplyJson(raw: string): AiReplyJson | null {
  const jsonText = extractJsonObject(raw)
  if (jsonText === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  // strip: スキーマ外フィールド（programs など）はここで破棄される
  const result = aiReplyJsonSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/** 回答本文に URL があれば出典として扱わない旨の注記を付す */
function urlCautionNote(text: string): string {
  return /https?:\/\/|www\./i.test(text)
    ? '\n\n※回答中の URL は未検証のため、出典として掲載していません。'
    : ''
}

/**
 * 検証済み AI JSON → ConsultReply（フェーズ1の固定制約を適用）。
 * - isMock: false / hasUnverified: true / relatedPrograms: [] を強制
 * - programIds からチップを付けるのは呼び出し側（iniadAdvisor）が
 *   resolveAiProposedPrograms でレジストリ検証してから行う。
 *   この関数自体は AI 生成の関連制度情報を一切返さない
 */
export function toConsultReplyFromAi(parsed: AiReplyJson): ConsultReply {
  let text = parsed.reply.trim()
  // 確認質問は最も役立つものを1つだけ（プロンプトで1つを指示済み。複数返された場合も先頭のみ採用）
  const questions = (parsed.clarificationQuestions ?? []).slice(0, 1)
  if (questions.length > 0) {
    text += `\n\n確認したいこと：\n${questions.map((q) => `・${q}`).join('\n')}`
  }
  text += urlCautionNote(text)
  return {
    text,
    isMock: false,
    hasUnverified: true,
    relatedPrograms: [],
    unsupported: parsed.unsupported ?? false,
    sourceType: 'ai',
    clarificationQuestions: questions,
    checkedAt: null,
  }
}

/** JSON 化できない生テキスト応答（jsonMode=off）を安全にラップする */
export function toConsultReplyFromRawText(raw: string): ConsultReply {
  const trimmed = raw.trim().slice(0, 4000)
  return {
    text: `${trimmed}${urlCautionNote(trimmed)}`,
    isMock: false,
    hasUnverified: true,
    relatedPrograms: [],
    unsupported: false,
    sourceType: 'ai',
    clarificationQuestions: [],
    checkedAt: null,
  }
}

/** パース失敗時に返す限定文（AI の生出力は破棄する） */
export const LIMITED_FALLBACK_REPLY: ConsultReply = {
  text: '回答を準備できませんでした。制度の正確な情報はお住まいの自治体の窓口・公式情報でご確認ください。',
  isMock: false,
  hasUnverified: true,
  relatedPrograms: [],
  unsupported: true,
  sourceType: 'ai',
  clarificationQuestions: [],
  checkedAt: null,
}