/**
 * API 送信前の個人情報マスキング（M6）
 *
 * - 相談文・履歴に含まれうる個人情報をマスキングしてから API へ送る
 * - 最小限の情報のみを渡す方針（金額は渡さない）は types.ts の
 *   ConsultUserContext で構造的に保証している
 * - マスキングは保守側の誤検知（過剰マスク）を許容する（安全側に倒す）
 */

/** 個人情報らしきパターン → プレースホルダ（上から順に適用） */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // メールアドレス
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［メールアドレス］'],
  // マイナンバー等（4-4-4 の 12 桁）。電話番号より先に判定する
  [/\d{4}[-ー−]\d{4}[-ー−]\d{4}/g, '［番号］'],
  // 電話番号（0 始まりの区切り付き）
  [/0\d{1,4}[-ー−]\d{1,4}[-ー−]\d{3,4}/g, '［電話番号］'],
  // 電話番号（区切りなし 10〜11 桁）や長めの連続数字
  [/\d{8,}/g, '［数字］'],
] as const

/** テキストから個人情報らしきパターンをマスクする */
export function redactText(text: string): string {
  let out = text
  for (const [pattern, placeholder] of REDACTIONS) {
    out = out.replace(pattern, placeholder)
  }
  return out
}

/** マスキング＋長さ制限（API 送信直前の最終処理） */
export function redactForApi(text: string, maxChars: number): string {
  const redacted = redactText(text)
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted
}