/**
 * 公式ページ内のリンク探索（M7-D・純関数）
 *
 * 【責務】
 * - HTML からリンク（<a href>）を抽出し、相対 URL を正規化して絶対 URL 化する。
 *   JavaScript・埋め込みコードは実行せず、正規表現での文字列処理のみ
 *   （lib/supports/sourceFetch.ts の extractHtmlPage と同じ方針）。
 * - 発見した URL を「取得対象にしてよいか」を既存の取得ポリシー
 *   （evaluateFetchTarget: HTTPS 必須・許可ホスト完全一致・SSRF 対策）で判定する。
 *   許可リストに無いホストのリンクは取得対象に追加せず、拒否理由を返すだけにする。
 *
 * 【再利用】URL の許可判定・実体参照のデコードは lib/supports/sourceFetch.ts の
 * 既存実装を使う（判定ロジックを重複実装しない）。
 *
 * 【外部通信なし】純関数のみ。
 */
import {
  decodeHtmlEntities,
  evaluateFetchTarget,
  type FetchFailureCode,
} from '../supports/sourceFetch'

/** リンク 1 件（正規化後の URL とアンカーテキスト） */
export type ExtractedLink = {
  url: string
  anchorText: string
}

/** 取得対象にできないリンクの拒否理由 */
export type LinkRejection = {
  url: string
  code: FetchFailureCode
  reason: string
}

/** href として許可しないスキーム（リンク先に移動できないもの） */
const NON_NAVIGATION_SCHEMES = /^(javascript|mailto|tel|data|about):/i

/**
 * href 属性値を正規化して絶対 URL を返す（純関数）。
 * - 相対 URL は baseUrl を基準に解決する
 * - http/https 以外・解析不能な値は null（取得対象にしない）
 * - フラグメント（#...）は除去する（同一ページ内リンクは対象外）
 * - 実体参照（&amp; 等）はデコードしてから解決する
 */
export function normalizeLinkTarget(href: string, baseUrl: string): string | null {
  const trimmed = decodeHtmlEntities(href).trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('#')) return null
  if (NON_NAVIGATION_SCHEMES.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(trimmed, baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  return url.toString()
}

/** HTML からリンクを抽出する（純関数。タグ除去は anchorText 用のみ） */
export function extractHtmlLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const seen = new Set<string>()
  const anchorRe =
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorRe.exec(html)) !== null) {
    const rawHref = match[1] ?? match[2] ?? match[3] ?? ''
    const url = normalizeLinkTarget(rawHref, baseUrl)
    if (url === null) continue
    const anchorText = decodeHtmlEntities(match[4].replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    // 同一 URL の重複リンクは最初の 1 件だけ（重複排除）
    if (seen.has(url)) continue
    seen.add(url)
    links.push({ url, anchorText })
  }
  return links
}

/**
 * 取得済みページの href 属性値（FetchedPage.hrefs）を正規化したリンクにする（純関数）。
 * 相対 URL の解決・実体参照のデコード・重複排除は normalizeLinkTarget 基準で行う。
 */
export function linksFromHrefs(
  hrefs: readonly string[],
  baseUrl: string,
): ExtractedLink[] {
  const links: ExtractedLink[] = []
  const seen = new Set<string>()
  for (const href of hrefs) {
    const url = normalizeLinkTarget(href, baseUrl)
    if (url === null) continue
    if (seen.has(url)) continue
    seen.add(url)
    links.push({ url, anchorText: '' })
  }
  return links
}

export type ClassifiedLinks = {
  /** 取得対象として登録してよいリンク（許可ホストのみ） */
  acceptable: ExtractedLink[]
  /** 取得対象に追加しないリンクとその理由 */
  rejected: LinkRejection[]
}

/**
 * 発見リンクを取得対象の可否で分類する（純関数）。
 * - 取得ポリシー（evaluateFetchTarget）を通ったリンクだけを acceptable にする。
 *   未許可ホストのリンクを勝手に取得対象へ追加しない。
 * - リダイレクト後のホストも取得時に sourceFetch が再検証する。
 */
export function classifyDiscoveredLinks(
  links: readonly ExtractedLink[],
  options: { allowedHosts: ReadonlySet<string> },
): ClassifiedLinks {
  const acceptable: ExtractedLink[] = []
  const rejected: LinkRejection[] = []
  for (const link of links) {
    const decision = evaluateFetchTarget(link.url, options.allowedHosts)
    if (decision.allowed) {
      acceptable.push(link)
    } else {
      rejected.push({ url: link.url, code: decision.code, reason: decision.reason })
    }
  }
  return { acceptable, rejected }
}
