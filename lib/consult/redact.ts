/**
 * API 送信前の個人情報マスキング（M6 / P9-3）
 *
 * - 相談文・履歴に含まれうる個人情報をマスキングしてから API へ送る
 * - 最小限の情報のみを渡す方針（金額は渡さない）は types.ts の
 *   ConsultUserContext で構造的に保証している
 * - マスキングは保守側の誤検知（過剰マスク）を許容する（安全側に倒す）
 * - 【P9-3】マッチングは「1 文字→1 文字」の正規化コピー上で行い、置換は
 *   元の文字列の該当範囲に対してだけ行う（本文全体を正規化しない）。
 *   全角数字・全角/異体字のダッシュ・全角スペースをマッチング時に吸収する
 * - 【P9-3】7 桁以下の数字を一律にはマスクしない（金額・制度情報を守る）。
 *   郵便番号は「〒付き」または「3-4 の区切り形式」という形式で判定する
 * - 氏名・住所など自由記述中の個人情報を完全に検出できることは保証しない
 */

/** マッチング用正規化で置き換える文字（1 文字→1 文字。長さ・位置は変わらない） */
const NORMALIZE_CHARS: Readonly<Record<string, string>> = {
  // 全角数字
  '０': '0',
  '１': '1',
  '２': '2',
  '３': '3',
  '４': '4',
  '５': '5',
  '６': '6',
  '７': '7',
  '８': '8',
  '９': '9',
  // 全角スペース
  '　': ' ',
  // ダッシュ類（全角・異体字を半角ハイフンへ寄せる）
  '－': '-',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  'ー': '-',
  'ｰ': '-',
}

/** マッチング用正規化（1 ユニット→1 ユニット。元文字列とのインデックス対応を保つ） */
function normalizeForMatch(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    out += NORMALIZE_CHARS[ch] ?? ch
  }
  return out
}

/** 個人情報らしきパターン → プレースホルダ（正規化テキスト上で上から順に優先） */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // メールアドレス
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［メールアドレス］'],
  // マイナンバー等（4-4-4 の 12 桁）。電話番号より先に判定する
  [/\d{4}-\d{4}-\d{4}/g, '［番号］'],
  // 電話番号（0 始まりの区切り付き。区切りは半角スペース 1〜2 個またはハイフン。
  //   全角数字・全角/異体字のダッシュ・全角スペースは正規化で吸収される）
  [/0\d{1,4}[ \-]{1,2}\d{1,4}[ \-]{1,2}\d{3,4}/g, '［電話番号］'],
  // 郵便番号（〒付きは区切り省略可。記号なしは 3-4 の区切り形式のみで判定）
  [/〒\d{3}[ \-]?\d{4}/g, '［郵便番号］'],
  [/(?<![\d-])\d{3}[ \-]\d{4}(?![\d-])/g, '［郵便番号］'],
  // 電話番号（区切りなし 10〜11 桁）や長めの連続数字
  [/\d{8,}/g, '［数字］'],
] as const

/** テキストから個人情報らしきパターンをマスクする */
export function redactText(text: string): string {
  const normalized = normalizeForMatch(text)
  // パターン優先度順にマッチ範囲を記録（重複する範囲は先に記録した側を採用）
  const ranges: Array<{ start: number; end: number; placeholder: string }> = []
  for (const [pattern, placeholder] of REDACTIONS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(normalized)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (!ranges.some((r) => start < r.end && r.start < end)) {
        ranges.push({ start, end, placeholder })
      }
      if (match[0].length === 0) pattern.lastIndex += 1
    }
  }
  // 置換は元の文字列に対して行う（本文を正規化した形で出力しない）
  ranges.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const r of ranges) {
    out += text.slice(cursor, r.start) + r.placeholder
    cursor = r.end
  }
  return out + text.slice(cursor)
}

/** マスキング＋長さ制限（API 送信直前の最終処理） */
export function redactForApi(text: string, maxChars: number): string {
  const redacted = redactText(text)
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted
}