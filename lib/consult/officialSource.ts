/**
 * 公式情報の「検索・取得」と「出典検証」の接続点（M6-E: 設計・接続準備のみ）
 *
 * 【責務の分離（AI 生成と Web 検索の分離）】
 * - AI モデルへの質問は lib/consult/iniadAdvisor.ts（chat.completions のみ）。
 *   このモジュールは AI クライアントを一切 import しない。
 * - 逆に iniadAdvisor.ts もこのモジュールを import しない（AI が自分で
 *   公式サイトを検索・取得したかのように振る舞う経路を持たない）。
 * - 「検索（候補 URL の発見）」と「取得（特定 URL の本文取得）」を別関数に
 *   分ける。検索ヒット＝取得済みとは扱わない。取得できた情報だけを出典検証
 *   （lib/supports/evidence.ts）にかけ、url あり・urlVerified・official を
 *   満たすものだけを確認済み扱いにする。
 *
 * 【M6-E の制約（重要）】
 * - 本モジュールに外部通信は実装しない。既定クライアントは常に
 *   「未実装（利用不可）」を返すだけで、ネットワークへ一切触れない。
 * - Web 検索が使えない場合、AI の学習知識だけで給付額・法令・申請期限を
 *   確定しない（方針は iniadAdvisor のシステムプロンプトと replySchema で担保）。
 *   公式情報を取得できない場合は既存の未確認表示（hasUnverified 等）を維持する。
 * - 実装・有効化は INIAD API の仕様確認と G2 承認後。設計は
 *   docs/consult-m6e-design.md を参照。
 */
import { createSourceRecord, isOfficialLink } from '../supports/evidence'
import { buildKnowledgeBase, type KbProgramEntry } from '../supports/kb'
import type { SupportSource } from '../types/support'

/** 公式サイトから取得できた情報（出典検証を受ける前の生レコード） */
export type OfficialSourceRecord = {
  title: string
  organization: string
  /** URL（取得できなければ null。推測・補完しない） */
  url: string | null
  /** URL の実在確認済みフラグ。検証レイヤでのみ true にする */
  urlVerified: boolean
  /** 国・自治体などの公式情報か */
  official: boolean
  /** 確認日（YYYY-MM-DD） */
  checkedAt: string
  /** 取得本文からの抜粋（取得できた場合のみ） */
  excerpt: string | null
}

/** 検索で見つかった候補（まだ取得していない） */
export type OfficialSearchCandidate = {
  url: string
  title: string
  organization: string
}

/** 検索・取得ができない理由（未確認情報を確定扱いしないための分類） */
export type OfficialSourceUnavailableReason =
  | 'not-implemented'
  | 'network-error'
  | 'http-error'
  | 'invalid-content'
  | 'not-official'
  | 'unverified-url'

export type OfficialSearchOutcome =
  | { ok: true; candidates: OfficialSearchCandidate[] }
  | { ok: false; reason: OfficialSourceUnavailableReason; detail: string }

export type SourceFetchOutcome =
  | { ok: true; record: OfficialSourceRecord }
  | { ok: false; reason: OfficialSourceUnavailableReason; detail: string }

/**
 * 公式サイトの検索・取得クライアント（実装は次工程）。
 * - search と fetchSource は別機能（検索ヒット＝取得済みとは扱わない）
 * - 実装時も AI クライアントとクライアント・経路を共有しないこと
 */
export type OfficialSourceClient = {
  /** 公式サイト内の検索（候補 URL の発見のみ。取得は fetchSource） */
  search(query: string): Promise<OfficialSearchOutcome>
  /** 特定 URL からの本文取得（取得後に出典検証を受ける） */
  fetchSource(url: string): Promise<SourceFetchOutcome>
}

/**
 * 既定クライアント: 未実装（外部通信を一切行わない）。
 * 取得できない情報はすべて「未確認」のまま扱う。
 */
export const UNAVAILABLE_OFFICIAL_SOURCE_CLIENT: OfficialSourceClient = {
  async search(): Promise<OfficialSearchOutcome> {
    return {
      ok: false,
      reason: 'not-implemented',
      detail: '公式サイトの検索は未実装（G2 承認・仕様確認後に実装）',
    }
  },
  async fetchSource(): Promise<SourceFetchOutcome> {
    return {
      ok: false,
      reason: 'not-implemented',
      detail: '公式サイトの取得は未実装（G2 承認・仕様確認後に実装）',
    }
  },
}

/** 取得レコードを出典レコードへ正規化（evidence の URL ポリシーを適用） */
export function toSupportSource(record: OfficialSourceRecord): SupportSource {
  return createSourceRecord({
    title: record.title,
    organization: record.organization,
    url: record.url,
    urlVerified: record.urlVerified,
    official: record.official,
    checkedAt: record.checkedAt,
    extractionMethod: 'manual',
  })
}

/**
 * 確認済み（公式リンクとして扱える）か。
 * url なし・urlVerified=false・非公式のいずれかなら false（未確認扱い）。
 */
export function isConfirmedOfficialSource(
  record: OfficialSourceRecord,
): boolean {
  return isOfficialLink(toSupportSource(record))
}

/** AI への根拠供給用に確認済み/未確認を分離した結果 */
export type EvidenceContext = {
  /** 確認済み出典の1行要約（AI に供給してよい唯一の確定材料） */
  confirmedLines: string[]
  /** 未確認情報（確定材料にしない。AI は「未確認」と明示する） */
  unconfirmed: OfficialSourceRecord[]
  /** 確認済みが 1 件もない（＝AI は未確認表示を維持する） */
  allUnverified: boolean
}

/**
 * 出典レコード群 → 確認済み/未確認の分離（純関数・外部通信なし）。
 * 確認済みと未確認を混ぜない。未確認を確定材料にしない。
 */
export function buildEvidenceContext(
  records: readonly OfficialSourceRecord[],
): EvidenceContext {
  const confirmed = records.filter((r) => isConfirmedOfficialSource(r))
  const unconfirmed = records.filter((r) => !isConfirmedOfficialSource(r))
  return {
    confirmedLines: confirmed.map(
      (r) =>
        `・${r.title}（${r.organization}・確認日 ${r.checkedAt}）` +
        (r.excerpt === null || r.excerpt === '' ? '' : ` 抜粋: ${r.excerpt}`),
    ),
    unconfirmed,
    allUnverified: confirmed.length === 0,
  }
}

// ── M6-F: ナレッジベース背後のクライアント（実行時のネットワーク不使用）────

/** 取得失敗コード（sourceFetch）を OfficialSourceUnavailableReason に写像する */
function mapFetchFailureToReason(
  failure: string | null,
): OfficialSourceUnavailableReason {
  if (failure === null) return 'invalid-content'
  if (
    failure === 'timeout' ||
    failure === 'network-error' ||
    failure === 'robots-unavailable' ||
    failure === 'robots-disallowed'
  ) {
    return 'network-error'
  }
  if (failure === 'http-error') return 'http-error'
  if (failure === 'not-allowlisted' || failure === 'blocked-target') return 'not-official'
  return 'invalid-content'
}

/**
 * ナレッジベース背後の公式情報クライアント（M6-F）。
 *
 * - 取得済みのナレッジベース（lib/supports/kb.ts）だけを参照し、実行時の
 *   ネットワークアクセスは一切行わない（公式ページの取得は
 *   scripts/retrieve-official-sources.ts の手動実行で行う）。
 * - search と fetchSource は別機能のまま（検索ヒット＝取得済みではない）。
 * - URL の検証状態（urlState）と制度内容の確認状態（contentState）を区別し、
 *   「URL にアクセスできた」だけでは urlVerified にしない。
 *   urlVerified は公式確認済みかつ人手照合済みで、かつ再取得後で照合が
 *   古くない（reviewOutdated でない）URL のみ。
 * - 未取得・未照合の情報は ok: false（未確認のまま。AI の知識で補完しない）。
 */
export function createKbOfficialSourceClient(
  entries: readonly KbProgramEntry[] = buildKnowledgeBase(),
): OfficialSourceClient {
  return {
    async search(query: string): Promise<OfficialSearchOutcome> {
      const q = query.trim().toLowerCase()
      const candidates: OfficialSearchCandidate[] = []
      for (const entry of entries) {
        for (const s of entry.sources) {
          const haystack = `${s.title} ${s.url} ${s.organization} ${entry.name}`.toLowerCase()
          if (q === '' || haystack.includes(q)) {
            candidates.push({
              url: s.url,
              title: s.title,
              organization: s.organization,
            })
          }
        }
      }
      return { ok: true, candidates }
    },

    async fetchSource(url: string): Promise<SourceFetchOutcome> {
      for (const entry of entries) {
        const s = entry.sources.find((x) => x.url === url)
        if (s === undefined) continue
        if (s.retrievedAt === null || s.contentState === 'no-content') {
          return {
            ok: false,
            reason: mapFetchFailureToReason(s.lastFetchResult),
            detail: 'ページ本文を取得できていないため未確認のまま扱います（取得は手動実行）',
          }
        }
        const record: OfficialSourceRecord = {
          title: s.title,
          organization: s.organization,
          url: s.url,
          // 公式確認済み・人手照合済みでも、再取得後で照合が古い（reviewOutdated）
          // URL は未再確認のため urlVerified にしない
          urlVerified:
            s.urlState === 'official-confirmed' &&
            s.contentState === 'reviewed' &&
            !s.reviewOutdated,
          official: true,
          checkedAt: s.reviewedAt ?? s.retrievedAt.slice(0, 10),
          excerpt: s.excerpt,
        }
        return { ok: true, record }
      }
      return {
        ok: false,
        reason: 'unverified-url',
        detail: 'URL 台帳に未登録のため取得対象外です（未確認の URL は公式出典にしません）',
      }
    },
  }
}