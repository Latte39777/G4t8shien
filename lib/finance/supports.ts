/**
 * 公的支援の計算（M1・決定論）
 *
 * ルール:
 * - 対象年齢と重ならない制度は ineligible（未出生の子の将来の年齢も考慮）
 * - 世帯収入が未入力で所得制限のある制度は判定を緩める（likely→possible）し、
 *   不足情報に「世帯収入」を追加する（不足＝対象外とはしない）
 * - category が 'loan' の制度、金額未確認（basis: 'unknown' / 金額 null / 単位不明）は
 *   合計に含めない
 * - 併用不可（combinedWith）同士が重複する場合、見込額が大きい方のみを合計に含める
 * - basis: 'estimated' は推定として別枠で集計し、確定額と区別する
 */
import type { Eligibility, SupportProgram } from '../types/support'
import type { ChildInput, FamilyPlan } from '../types/finance'
import { childAgeAt, projectionHorizon } from './cashflow'

export type SupportEffect = {
  program: SupportProgram
  /** 入力情報から再判定した受給可能性 */
  eligibility: Eligibility
  /** 見込額合計（円）。計算不能は null */
  estimatedTotalYen: number | null
  includedInTotal: boolean
  excludedReason: string | null
  perChild: Array<{ childId: string; totalYen: number | null }>
  /** 各年の見込額（yearOffset 順） */
  yearlyYen: number[]
}

export type SupportSchedule = {
  confirmedByYear: number[]
  estimatedByYear: number[]
}

export type SupportCalcResult = {
  effects: SupportEffect[]
  /** 合計に含めた確定額 */
  confirmedTotalYen: number
  /** 合計に含めた推定額 */
  estimatedTotalYen: number
  /** 合計に含めなかった制度（理由付き） */
  uncounted: SupportEffect[]
  schedule: SupportSchedule
}
function inPeriod(age: number, period: SupportProgram['period']): boolean {
  if (period.startAgeYears !== null && age < period.startAgeYears) return false
  if (period.endAgeYears !== null && age > period.endAgeYears) return false
  return true
}

function overlapsPeriod(
  child: ChildInput,
  period: SupportProgram['period'],
  horizon: number,
): boolean {
  if (period.startAgeYears === null && period.endAgeYears === null) return true
  for (let t = 0; t <= horizon; t += 1) {
    const age = childAgeAt(child, t)
    if (age !== null && inPeriod(age, period)) return true
  }
  return false
}

function recomputeEligibility(
  plan: FamilyPlan,
  program: SupportProgram,
): { eligibility: Eligibility; missing: string[] } {
  const missing = [...program.missingInformation]
  if (program.eligibility === 'ineligible') {
    return { eligibility: 'ineligible', missing }
  }
  const horizon = projectionHorizon(plan)
  const periodDefined =
    program.period.startAgeYears !== null || program.period.endAgeYears !== null
  const hasTargetChild = plan.children.some((c) =>
    overlapsPeriod(c, program.period, horizon),
  )
  if (periodDefined && !hasTargetChild) {
    return { eligibility: 'ineligible', missing }
  }
  let eligibility = program.eligibility
  if (
    program.conditions.incomeLimitNote !== null &&
    plan.annualIncome === null
  ) {
    if (eligibility === 'likely') eligibility = 'possible'
    if (!missing.includes('世帯収入')) missing.push('世帯収入')
  }
  return { eligibility, missing }
}

/** 1子について、対象期間の各年の見込額を返す */
function perChildYearly(
  child: ChildInput,
  program: SupportProgram,
  horizon: number,
): number[] {
  const yearly: number[] = new Array(horizon + 1).fill(0)
  const value = program.amount.value
  if (value === null || program.amount.unit === 'other') return yearly

  for (let t = 0; t <= horizon; t += 1) {
    const age = childAgeAt(child, t)
    if (age === null || !inPeriod(age, program.period)) continue
    if (program.amount.unit === 'yen_per_month') {
      yearly[t] += value * 12
    } else if (program.amount.unit === 'yen_per_year') {
      yearly[t] += value
    } else if (program.amount.unit === 'yen_one_time') {
      const prevAge = childAgeAt(child, t - 1)
      const prevInPeriod = prevAge !== null && inPeriod(prevAge, program.period)
      if (!prevInPeriod) yearly[t] += value
    }
  }

  // 支給期間の上限（例：24ヶ月支給）を適用
  if (
    program.amount.unit === 'yen_per_month' &&
    program.period.durationMonths !== null
  ) {
    const cap = value * program.period.durationMonths
    let sum = 0
    for (let t = 0; t <= horizon; t += 1) {
      const remaining = cap - sum
      const y = Math.min(yearly[t], Math.max(remaining, 0))
      yearly[t] = y
      sum += y
    }
  }
  return yearly
}
/**
 * 入力内容と制度データから支援の効果を計算する（純関数）
 *
 * options.excludeProgramIds: 現在利用中など、見込み額に含めない制度 ID。
 * 現在の家計（手取り収入）に反映済みの制度を二重に見込まないための除外指定。
 */
export function calculateSupportEffects(
  plan: FamilyPlan,
  programs: SupportProgram[],
  options?: { excludeProgramIds?: string[] },
): SupportCalcResult {
  const horizon = projectionHorizon(plan)
  const excludeIds = options?.excludeProgramIds ?? []

  const effects: SupportEffect[] = programs.map((program) => {
    const { eligibility, missing } = recomputeEligibility(plan, program)
    const yearly: number[] = new Array(horizon + 1).fill(0)
    const computable =
      program.amount.value !== null && program.amount.unit !== 'other'
    const perChild = plan.children.map((child) => {
      const childYearly = perChildYearly(child, program, horizon)
      for (let t = 0; t <= horizon; t += 1) yearly[t] += childYearly[t]
      return {
        childId: child.id,
        totalYen: computable ? childYearly.reduce((a, b) => a + b, 0) : null,
      }
    })
    const total = computable ? yearly.reduce((a, b) => a + b, 0) : null

    let includedInTotal = true
    let excludedReason: string | null = null
    if (program.category === 'loan') {
      includedInTotal = false
      excludedReason = '貸付制度のため合計対象外'
    } else if (program.amount.basis === 'unknown' || !computable) {
      includedInTotal = false
      excludedReason = '金額が未確認のため合計対象外'
    } else if (eligibility === 'ineligible') {
      includedInTotal = false
      excludedReason = '入力内容では対象外のため合計対象外'
    } else if (excludeIds.includes(program.id)) {
      includedInTotal = false
      excludedReason =
        '現在利用中のため見込み額に含めません（現在の家計に反映済みのため・要確認）'
    }

    return {
      program: { ...program, eligibility, missingInformation: missing },
      eligibility,
      estimatedTotalYen: total,
      includedInTotal,
      excludedReason,
      perChild,
      yearlyYen: yearly,
    }
  })

  // 併用不可（combinedWith）の重複は金額が大きい方のみ合計に含める
  for (const a of effects) {
    if (!a.includedInTotal) continue
    for (const b of effects) {
      if (a === b || !b.includedInTotal) continue
      const conflict =
        a.program.conditions.combinedWith.includes(b.program.id) ||
        b.program.conditions.combinedWith.includes(a.program.id)
      if (!conflict) continue
      const loser =
        (a.estimatedTotalYen ?? 0) >= (b.estimatedTotalYen ?? 0) ? b : a
      const winner = loser === a ? b : a
      loser.includedInTotal = false
      loser.excludedReason = `「${winner.program.name}」と併用不可のため合計対象外`
    }
  }

  const confirmedByYear: number[] = new Array(horizon + 1).fill(0)
  const estimatedByYear: number[] = new Array(horizon + 1).fill(0)
  let confirmedTotalYen = 0
  let estimatedTotalYen = 0
  for (const e of effects) {
    if (!e.includedInTotal) continue
    const target =
      e.program.amount.basis === 'confirmed' ? confirmedByYear : estimatedByYear
    for (let t = 0; t <= horizon; t += 1) target[t] += e.yearlyYen[t]
    const total = e.estimatedTotalYen ?? 0
    if (e.program.amount.basis === 'confirmed') confirmedTotalYen += total
    else estimatedTotalYen += total
  }

  return {
    effects,
    confirmedTotalYen,
    estimatedTotalYen,
    uncounted: effects.filter((e) => !e.includedInTotal),
    schedule: { confirmedByYear, estimatedByYear },
  }
}