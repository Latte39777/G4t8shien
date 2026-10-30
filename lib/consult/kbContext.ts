/**
 * 相談処理 × 公式情報KB の接続レイヤ（M6-G / P1）
 *
 * 責務（純関数のみ・外部通信なし。fetch・AI API は行わない）:
 * - resolveKbConsultContext: 相談対象の制度を KB から決定論的に解決し、
 *   確認済み情報・未確認項目・出典・確認日を分離した「事実カード」を作る
 * - enrichReplyWithKb: 既存の応答に、KB から機械的に導いた出典・関連制度情報を付与する
 *
 * 【対象制度の解決規則（決定論的。AI 生成文は使わない）】
 * 1. 制度 ID（制度カードからの引き継ぎ）
 * 2. 質問文に制度名の中核名（（…）注記を除いた名前）が完全に含まれること
 *    （lib/consult/mockAdvisor.ts の findProgramInMessage と同一規則）
 *    - 名称の部分一致では追加しない・KB に無い制度は追加しない
 *
 * 【不変の制約】
 * - URL・金額・確認状態・制度名は AI 生成文から採用しない（KB と URL 台帳の状態のみ）
 * - URL の検証状態は台帳の状態をそのまま引き継ぎ、未検証 URL を検証済みに昇格させない
 *   （判定条件は lib/consult/officialSource.ts の createKbOfficialSourceClient と同一。
 *     scripts/verify-m6g.tsx が両者の一致を検証する）
 * - eligibility（受給資格）は常に未確認のまま扱い、受給資格の自動判定をしない
 * - amountBands は表示・根拠提示専用。合計・換算・給付額計算には使わない
 *   （金額計算は lib/finance/* の既存プログラム側。KB_AMOUNT_CALCULATION_POLICY 参照）
 * - 給付（cash_benefit）・授業料減免（fee_reduction）・貸与（loan）・税（tax）の区分を保持し、混同しない
 * - KB に無い制度・根拠の無い情報は付与しない
 * - reviewOutdated・確認日・未確認項目など、既存の provenance・確認状態を失わない
 */
import {
  KB_AMOUNT_CALCULATION_POLICY,
  buildKbAiContext,
  buildKnowledgeBase,
  type KbProgramEntry,
  type KbSourceView,
} from '../supports/kb'
import { getSupportPrograms } from '../supports/registry'
import {
  SUPPORT_CATEGORIES,
  type ProgramVerification,
  type SupportCategory,
  type SupportProgram,
  type UnconfirmedItem,
} from '../types/support'
import type {
  ConsultCitation,
  ConsultRelatedProgram,
  ConsultReply,
} from './types'

/** 相談用に機械的に整形した KB の事実カード（1 制度 = 1 件） */
export type KbFactCard = {
  programId: string
  name: string
  /**
   * 制度区分（給付/授業料減免/貸与/税。混同防止に使い分ける）。
   * 既存の区分値に該当しない場合は null（分類を推測しない）
   */
  category: SupportCategory | null
  /** 公式情報の確認状態（項目の確度から機械的に導出。ProgramVerification と同義の 3 値） */
  verification: ProgramVerification['status']
  /** 情報確認日 YYYY-MM-DD（出典の最新確認日。確認記録が無ければ null） */
  checkedAt: string | null
  /** 出典の照合が古い（= 再確認が必要） */
  reviewOutdated: boolean
  /** 確認済み（confidence=confirmed）の事実のみ。出典・provenance 付き（buildKbAiContext 形式） */
  confirmedFacts: string[]
  /** 未確認の項目（「確認できる公式情報がありません」等。eligibility は常にこちら側） */
  unconfirmedNotes: string[]
  /** 未確認項目の一覧（項目と理由） */
  unconfirmedItems: UnconfirmedItem[]
  /** 出典（URL 検証状態を引き継ぐ。urlVerified=true のみリンク扱いにしてよい） */
  citations: ConsultCitation[]
}

/** 相談用に解決した KB 文脈 */
export type KbConsultContext = {
  /** KB から解決した対象制度（決定論的。programId と質問文の制度名完全一致のみ） */
  cards: KbFactCard[]
  /** 金額計算の既存方針（表示・根拠提示のみ。計算には使わない） */
  amountCalculationPolicy: string
}

/** resolveKbConsultContext への入力（AI 生成文は入れない） */
export type KbConsultContextInput = {
  /** 相談対象の制度 ID（制度カードからの引き継ぎ。自由相談は null） */
  programId?: string | null
  /** 質問文（制度名の完全一致にのみ使用する） */
  message?: string | null
}

/** 制度名の中核名（「（モック）」等の注記を除いたもの）。mockAdvisor と同一規則 */
function coreNameOf(name: string): string {
  return name.replace(/（[^）]*）/g, '')
}

/**
 * 既存の区分値に該当する場合のみ SupportCategory として扱う。
 * 該当しない場合は null（区分を推測しない）。
 */
function toKnownCategory(category: string): SupportCategory | null {
  return (SUPPORT_CATEGORIES as readonly string[]).includes(category)
    ? (category as SupportCategory)
    : null
}

/**
 * 確認状態の導出（純関数）。
 * - confidence 'confirmed' の項目が 0 件 → unverified
 * - 全項目が confirmed → official-verified
 * - それ以外 → partial
 * （eligibility は kbConfidenceFor の規則で常に unconfirmed のため、
 *   受給資格が確認済み扱いになることはなく、実質は partial 以下になる）
 */
function verificationFor(entry: KbProgramEntry): ProgramVerification['status'] {
  const confirmed = entry.fields.filter(
    (f) => f.confidence === 'confirmed' && f.value !== null,
  ).length
  if (confirmed === 0) return 'unverified'
  return confirmed === entry.fields.length ? 'official-verified' : 'partial'
}

/** 出典の確認日（officialSource.ts の record.checkedAt と同一: 人手照合日を優先し、無ければ取得日） */
function checkedAtForSource(source: KbSourceView): string | null {
  if (source.reviewedAt !== null) return source.reviewedAt
  return source.retrievedAt !== null ? source.retrievedAt.slice(0, 10) : null
}

/**
 * 出典ビューを相談用の出典表示に変換する（純関数）。
 * - urlVerified は createKbOfficialSourceClient（officialSource.ts）と同一条件
 *   （URL 確認済み・人手照合済み・照合が古くない）。アクセス可否では検証済みに昇格させない
 * - provenance は既存の KbProvenance をそのまま保持する
 */
function toCitation(source: KbSourceView): ConsultCitation {
  return {
    title: source.title,
    organization: source.organization,
    url: source.url,
    urlVerified:
      source.urlState === 'official-confirmed' &&
      source.contentState === 'reviewed' &&
      !source.reviewOutdated,
    checkedAt: checkedAtForSource(source),
    provenance: { ...source.provenance },
    reviewOutdated: source.reviewOutdated,
  }
}

/** KB エントリを事実カードに変換する（純関数） */
function toKbFactCard(entry: KbProgramEntry): KbFactCard {
  // 既存の整形（確認済み/未確認の分離・provenance 表記）をそのまま再利用する
  const ai = buildKbAiContext([entry])
  const checkedDates = entry.sources
    .map((s) => checkedAtForSource(s))
    .filter((d): d is string => d !== null)
  return {
    programId: entry.programId,
    name: entry.name,
    category: toKnownCategory(entry.category),
    verification: verificationFor(entry),
    checkedAt:
      checkedDates.length > 0
        ? checkedDates.reduce((latest, d) => (d > latest ? d : latest))
        : null,
    reviewOutdated: entry.sources.some((s) => s.reviewOutdated),
    confirmedFacts: ai.confirmedFacts,
    unconfirmedNotes: ai.unconfirmedNotes,
    unconfirmedItems: entry.unconfirmedItems.map((u) => ({
      field: u.field,
      reason: u.reason,
    })),
    citations: entry.sources.map((s) => toCitation(s)),
  }
}

/**
 * 相談対象の制度を KB から決定論的に解決する（純関数・外部通信なし）。
 * - 制度 ID と、質問文に含まれる制度名の中核名の完全一致のみで対象を決める
 * - KB に無い制度・部分一致した名称は追加しない（根拠のない情報を付与しない）
 */
export function resolveKbConsultContext(
  input: KbConsultContextInput,
  entries: readonly KbProgramEntry[] = buildKnowledgeBase(),
): KbConsultContext {
  const selected = new Map<string, KbProgramEntry>()
  if (input.programId != null) {
    const hit = entries.find((e) => e.programId === input.programId)
    // KB 未収録の ID は追加しない
    if (hit !== undefined) selected.set(hit.programId, hit)
  }
  const message = input.message ?? ''
  if (message.length > 0) {
    for (const entry of entries) {
      const coreName = coreNameOf(entry.name)
      if (coreName.length >= 3 && message.includes(coreName)) {
        if (!selected.has(entry.programId)) selected.set(entry.programId, entry)
      }
    }
  }
  return {
    cards: [...selected.values()].map((e) => toKbFactCard(e)),
    amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
  }
}

/** 出典の重複を除く（同一の title + organization + url は 1 件に） */
function dedupeCitations(
  citations: readonly ConsultCitation[],
): ConsultCitation[] {
  const seen = new Set<string>()
  const result: ConsultCitation[] = []
  for (const c of citations) {
    const key = `${c.title}|${c.organization}|${c.url ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(c)
  }
  return result
}

/** KB で裏付けのある関連制度（新規追加分） */
function kbRelatedProgram(card: KbFactCard): ConsultRelatedProgram {
  return {
    id: card.programId,
    name: card.name,
    // 確認済みの事実が 1 件もないものは既存の未確認（mock）表示に合わせる
    sourceType: card.verification === 'unverified' ? 'mock' : 'verified',
    note: kbNoteFor(card),
    ...(card.category !== null ? { category: card.category } : {}),
    verification: card.verification,
    checkedAt: card.checkedAt,
    sources: card.citations,
  }
}

function kbNoteFor(card: KbFactCard): string {
  if (card.verification === 'unverified') {
    return '未確認の情報（モック・仮データ）。確定情報ではありません'
  }
  if (card.verification === 'official-verified') {
    return '公式情報で確認済み（確認日・出典を併記します）'
  }
  return '公式情報で確認済み（未確認の項目あり。窓口確認を推奨）'
}

/**
 * 既存の関連制度に KB の確認状態・出典を付与する（純関数・付加のみ）。
 * - 名称が KB と完全一致する制度にのみ付与する
 *   （AI 生成の架空の制度名に本物の出典を付けない）
 * - 既存の id / name / sourceType / note は変更しない
 */
function applyKbProvenance(
  existing: ConsultRelatedProgram,
  card: KbFactCard,
): ConsultRelatedProgram {
  if (existing.name !== card.name) return existing
  return {
    ...existing,
    ...(card.category !== null ? { category: card.category } : {}),
    verification: card.verification,
    checkedAt: card.checkedAt,
    sources: card.citations,
  }
}

/**
 * 既存の応答に KB 由来の出典・関連制度情報を付与する（純関数・外部通信なし）。
 * - citations は KB から機械的に導いたものだけを入れる
 *   （応答本文や AI 生成文の URL・制度名・金額は根拠として採用しない）
 * - relatedPrograms は既存のものを保持し、KB で裏付けのある制度にのみ確認状態・出典を付ける
 * - KB に無い制度には何も付与しない（根拠が無ければ付与しない）
 * - text / isMock / hasUnverified / unsupported / sourceType / checkedAt などの
 *   既存フィールドは変更しない（付加のみ）
 */
export function enrichReplyWithKb(
  reply: ConsultReply,
  context: KbConsultContext,
): ConsultReply {
  const cardsById = new Map(context.cards.map((c) => [c.programId, c]))
  const relatedPrograms: ConsultRelatedProgram[] = reply.relatedPrograms.map(
    (existing) => {
      const card = cardsById.get(existing.id)
      return card === undefined ? existing : applyKbProvenance(existing, card)
    },
  )
  for (const card of context.cards) {
    if (reply.relatedPrograms.some((p) => p.id === card.programId)) continue
    relatedPrograms.push(kbRelatedProgram(card))
  }
  return {
    ...reply,
    relatedPrograms,
    citations: dedupeCitations(context.cards.flatMap((c) => c.citations)),
  }
}

/** AI 提案として採用する最大件数（programIds の過剰分は破棄する） */
export const AI_PROPOSAL_MAX_PROGRAMS = 5

/** AI 提案チップに必ず付す注記（提案＝関連性の目安であって資格判定ではない） */
const AI_PROPOSAL_CAUTION = 'AI が関連の可能性を挙げた制度です。受給資格の判定ではありません'

function proposalNoteFor(card: KbFactCard | null): string {
  const base =
    card === null
      ? '未確認の情報です。確認できる公式情報がありません（確定情報ではありません）'
      : kbNoteFor(card)
  return `${base}（${AI_PROPOSAL_CAUTION}）`
}

/**
 * AI が提案した制度 ID を、サーバー側の既存レジストリで検証して関連制度チップに
 * 変換する（P10・純関数・外部通信なし）。
 *
 * 【不変の制約】
 * - AI が返すのは ID のみ。制度名・出典・金額・申請期限は AI 生成文から採用せず、
 *   レジストリ / KB の値だけを転記する
 * - レジストリに存在しない ID（AI の捏造）は破棄する
 * - KB に確認記録がない制度は未確認のまま扱い、確認済みにしない
 * - 重複 ID は 1 件にまとめ、AI_PROPOSAL_MAX_PROGRAMS 件を超える分は破棄する
 * - 提案は関連性の目安であり、受給資格の判定ではない（注記を必ず付す）
 * - 区分（給付/減免/貸与/税）はレジストリ・KB の値を保持し、混同しない
 */
export function resolveAiProposedPrograms(
  programIds: readonly string[],
  entries: readonly KbProgramEntry[] = buildKnowledgeBase(),
  programs: readonly SupportProgram[] = getSupportPrograms(),
): ConsultRelatedProgram[] {
  const entriesById = new Map(entries.map((e) => [e.programId, e]))
  const programsById = new Map(programs.map((p) => [p.id, p]))
  const chips: ConsultRelatedProgram[] = []
  const seen = new Set<string>()
  for (const id of programIds) {
    if (chips.length >= AI_PROPOSAL_MAX_PROGRAMS) break
    if (typeof id !== 'string' || id.trim().length === 0 || seen.has(id)) continue
    seen.add(id)
    // 不明な ID は破棄（AI の捏造 ID を採用しない）
    const program = programsById.get(id)
    if (program === undefined) continue
    const entry = entriesById.get(id)
    if (entry !== undefined) {
      // KB に確認記録がある制度: 確認状態・区分・確認日・出典は KB から付与
      const card = toKbFactCard(entry)
      const chip = kbRelatedProgram(card)
      chips.push({ ...chip, note: proposalNoteFor(card) })
      continue
    }
    // KB に確認記録がない制度: 未確認のまま扱う（確認済みにしない）
    chips.push({
      id: program.id,
      name: program.name,
      sourceType: 'mock',
      note: proposalNoteFor(null),
      category: program.category,
      verification: 'unverified',
      checkedAt: null,
      sources: [],
    })
  }
  return chips
}

