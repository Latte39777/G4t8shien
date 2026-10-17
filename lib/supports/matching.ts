/**
 * ユーザーの条件と制度の条件の「照合」（M6-B・純関数）
 *
 * 責務:
 * - 子どもの年齢と制度の対象期間（対象年齢・支給期間）の照合
 * - 世帯構成・所得条件の照合（所得制限の判定）
 * - 照合結果と「確認できていない条件」を構造化して返す
 *
 * 【原則】
 * - 条件が不明な場合、満たす/満たさないを推測しない（'unknown' を返す）
 * - unknown ≠ 受給可能。受給資格の確定は行わず、目安（eligibility）のみ返す
 * - 金額計算は行わない（lib/supports/estimate.ts / lib/finance/supports.ts の責務）
 *
 * 年齢計算は lib/finance/cashflow.ts（計算エンジン・保護対象）の childAgeAt /
 * projectionHorizon を参照し、金額計算と同じ前提を使う。
 */
import type { Eligibility, SupportProgram } from '../types/support'
import type { ChildInput, FamilyPlan } from '../types/finance'
import { childAgeAt, projectionHorizon } from '../finance/cashflow'

/** 条件の照合結果。不明な条件は 'unknown'（推測で埋めない） */
export type MatchStatus = 'match' | 'mismatch' | 'unknown'

export type ChildAgeMatch = {
  childId: string
  /** 対象期間と子どもの年齢が重なるか（期間未定義なら true） */
  overlaps: boolean
  /** 対象期間に入る年の yearOffset 一覧 */
  matchedYearOffsets: number[]
}

export type ProgramMatch = {
  /** 子どもごとの対象年齢の照合 */
  perChild: ChildAgeMatch[]
  /** 対象年齢の記載があるか */
  periodDefined: boolean
  /** 所得条件の照合（所得制限の記載が無ければ 'match'） */
  incomeMatch: MatchStatus
  /** 世帯構成の照合（記載が無ければ 'match'、記載があって判定不能なら 'unknown'） */
  householdMatch: MatchStatus
  /** 受給可能性の目安（正式な受給資格の決定ではない） */
  eligibility: Eligibility
  /** 判定の理由（表示用） */
  reasons: string[]
  /** 判定に不足している情報（不足＝対象外ではない） */
  missing: string[]
}

function ageInPeriod(
  age: number,
  period: SupportProgram['period'],
): boolean {
  if (period.startAgeYears !== null && age < period.startAgeYears) return false
  if (period.endAgeYears !== null && age > period.endAgeYears) return false
  return true
}

/**
 * 制度の対象条件とユーザー入力（世帯・子ども）を照合する（純関数）。
 *
 * 金額計算（lib/finance/supports.ts::calculateSupportEffects）の対象年齢判定と
 * 同じ childAgeAt / period 前提を使うため、照合結果と計上結果は一致する。
 */
export function matchProgramToPlan(
  program: SupportProgram,
  plan: FamilyPlan,
): ProgramMatch {
  const horizon = projectionHorizon(plan)
  const periodDefined =
    program.period.startAgeYears !== null || program.period.endAgeYears !== null

  const perChild: ChildAgeMatch[] = plan.children.map((child: ChildInput) => {
    const matchedYearOffsets: number[] = []
    if (!periodDefined) {
      for (let t = 0; t <= horizon; t += 1) {
        if (childAgeAt(child, t) !== null) matchedYearOffsets.push(t)
      }
      return { childId: child.id, overlaps: true, matchedYearOffsets }
    }
    for (let t = 0; t <= horizon; t += 1) {
      const age = childAgeAt(child, t)
      if (age !== null && ageInPeriod(age, program.period)) matchedYearOffsets.push(t)
    }
    return {
      childId: child.id,
      overlaps: matchedYearOffsets.length > 0,
      matchedYearOffsets,
    }
  })

  const reasons: string[] = []
  const missing = [...program.missingInformation]

  // ── 所得条件 ──
  let incomeMatch: MatchStatus = 'match'
  if (program.conditions.incomeLimitNote !== null) {
    if (plan.annualIncome === null) {
      incomeMatch = 'unknown'
      reasons.push('世帯収入が未入力のため、所得制限の条件を確認できません')
      if (!missing.includes('世帯収入')) missing.push('世帯収入')
    } else {
      // 基準額が未確認の場合は満たす/満たさないを断定しない
      incomeMatch = 'unknown'
      reasons.push('所得制限の基準額が未確認のため、所得条件は要確認です')
    }
  }

  // ── 世帯構成の条件 ──
  let householdMatch: MatchStatus = 'match'
  if (program.conditions.householdNote !== null) {
    householdMatch = 'unknown'
    reasons.push('世帯構成に関する条件の確認が必要です')
  }

  // ── 受給可能性の目安 ──
  let eligibility: Eligibility = program.eligibility
  if (program.eligibility === 'ineligible') {
    reasons.push('制度情報の時点で対象外と判定されています（要確認）')
  } else if (periodDefined && perChild.every((m) => !m.overlaps)) {
    eligibility = 'ineligible'
    reasons.push('対象年齢と子どもの年齢が重ならないため対象外の可能性が高いです')
  } else if (incomeMatch === 'unknown' && eligibility === 'likely') {
    // 不足情報がある状態で「受給できる可能性あり」にしない
    eligibility = 'possible'
  }
  if (eligibility === 'unconfirmed') {
    reasons.push('受給資格は未判定です（正式な受給資格の決定ではありません）')
  }

  return {
    perChild,
    periodDefined,
    incomeMatch,
    householdMatch,
    eligibility,
    reasons,
    missing,
  }
}
