/**
 * 公式情報の根拠（エビデンス）保存と URL ポリシー（M6-B・純関数）
 *
 * 責務:
 * - 公式資料の出典レコード（タイトル・URL・情報提供元・確認日・取得日時）を保存する
 * - URL の検証状態を管理し、未確認 URL を公式リンクとして扱わない
 *
 * 【URL ポリシー】
 * - 公式リンクとして扱う条件は「url があり・urlVerified=true・official=true」のすべて
 * - urlVerified=false の URL は保持してもリンクとして扱わず、表示は「URL未確認」とする
 *   （実在・内容を確認できない URL を公式リンクとして表示しない）
 *
 * 【外部通信なし】
 * - このモジュールは保存・整形・判定のみを行い、fetch や AI API を行わない
 *   （URL の実在確認は将来の検証レイヤの責務で、本モジュールは検証済みフラグのみ信用する）
 */
import type { SupportProgram, SupportSource } from '../types/support'

/** 出典レコードの作成入力 */
export type SourceRecordInput = {
  title: string
  organization: string
  /** URL（未確認でも保持可。ただし公式リンクとしては扱わない） */
  url?: string | null
  /**
   * URL の実在確認済みフラグ。
   * AI の文章生成結果だけでは true にしないこと（検証レイヤでのみ設定する）。
   */
  urlVerified?: boolean
  /** 国・自治体などの公式情報か */
  official?: boolean
  /** 確認日（YYYY-MM-DD） */
  checkedAt: string
  /** 取得日時（ISO 8601。取得できる場合のみ） */
  retrievedAt?: string | null
  /** 取得方法 */
  extractionMethod?: 'manual' | 'ai-extraction' | 'mock'
  /** URL・内容の照合メモ（M6-C）。どのように照合したかの記録 */
  verificationNote?: string | null
}

/**
 * 公式リンクとして扱ってよいか。
 * url 未検証・url なし・非公式のいずれかなら false（リンクとして表示しない）。
 */
export function isOfficialLink(source: SupportSource): boolean {
  return source.url !== null && source.urlVerified && source.official
}

/**
 * 出典レコードを保存用に正規化する。
 * - url が未検証なら urlVerified=false として保持する（URL を勝手に推測・補完しない）
 * - url が無いのに urlVerified=true が主張されていたら false に落とす
 */
export function createSourceRecord(input: SourceRecordInput): SupportSource {
  const url = input.url ?? null
  const urlVerified = url !== null && input.urlVerified === true
  return {
    title: input.title,
    organization: input.organization,
    url,
    urlVerified,
    official: input.official === true,
    checkedAt: input.checkedAt,
    ...(input.retrievedAt !== undefined ? { retrievedAt: input.retrievedAt } : {}),
    ...(input.extractionMethod !== undefined
      ? { extractionMethod: input.extractionMethod }
      : {}),
    ...(input.verificationNote !== undefined && input.verificationNote !== null
      ? { verificationNote: input.verificationNote }
      : {}),
  }
}

/**
 * 取得記録を出典に付与する（根拠の保存）。
 * 検証状態（urlVerified/official）は変更しない＝取得記録だけで確定扱いにしない。
 */
export function recordRetrieval(
  source: SupportSource,
  retrieval: {
    retrievedAt: string
    extractionMethod?: 'manual' | 'ai-extraction' | 'mock'
  },
): SupportSource {
  return {
    ...source,
    retrievedAt: retrieval.retrievedAt,
    ...(retrieval.extractionMethod !== undefined
      ? { extractionMethod: retrieval.extractionMethod }
      : {}),
  }
}

/**
 * 出典を制度に紐付けて保存する。
 * - 重複（title+organization+url）は追加しない
 * - checkedAt は最も新しい確認日に更新する
 */
export function attachSources(
  program: SupportProgram,
  sources: readonly SupportSource[],
): SupportProgram {
  const merged = [...program.sources]
  for (const source of sources) {
    const exists = merged.some(
      (s) =>
        s.title === source.title &&
        s.organization === source.organization &&
        s.url === source.url,
    )
    if (!exists) merged.push(source)
  }
  const checkedAt = merged.reduce(
    (latest, s) => (s.checkedAt > latest ? s.checkedAt : latest),
    program.checkedAt,
  )
  return { ...program, sources: merged, checkedAt }
}

/** 制度の情報確認日（sources の最新確認日と program.checkedAt の新しい方） */
export function latestCheckedAt(program: SupportProgram): string | null {
  if (program.sources.length === 0) return program.checkedAt ?? null
  return program.sources.reduce(
    (latest, s) => (s.checkedAt > latest ? s.checkedAt : latest),
    program.checkedAt,
  )
}

/** 検証済み公式出典があるか（確定情報を扱える根拠があるか） */
export function hasVerifiedOfficialSource(program: SupportProgram): boolean {
  return program.sources.some(isOfficialLink)
}

/** URL 未確認の出典（表示で「URL未確認」とする対象） */
export function unverifiedSources(program: SupportProgram): SupportSource[] {
  return program.sources.filter((s) => !isOfficialLink(s))
}

/** 表示用の出典エントリ（リンクにするか・未確認表記にするかの判定込み） */
export type SourceDisplayEntry = {
  title: string
  organization: string
  /** 公式リンクとして扱うか */
  isLink: boolean
  /** isLink=true のときのリンク先 */
  href: string | null
  /** isLink=false のとき表示する未確認文言 */
  unverifiedText: string | null
}

export function sourceDisplayEntry(source: SupportSource): SourceDisplayEntry {
  if (isOfficialLink(source)) {
    return {
      title: source.title,
      organization: source.organization,
      isLink: true,
      href: source.url,
      unverifiedText: null,
    }
  }
  return {
    title: source.title,
    organization: source.organization,
    isLink: false,
    href: null,
    unverifiedText: 'URL未確認（公式リンクとして扱いません）',
  }
}
