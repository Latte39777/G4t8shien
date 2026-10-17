/**
 * 支援見込額の「計算」レイヤ（M6-B・純関数）
 *
 * 責務:
 * - 公式資料で確認できる金額・単位・対象期間・対象条件とユーザー入力から
 *   見込額を計算する。金額の正は既存の決定論計算
 *   lib/finance/supports.ts::calculateSupportEffects に一本化し、本モジュールは
 *   それを使いこなす形にとどめる（既存計算ロジックは書き換えない）。
 * - 月額・年額・一時金を区別した内訳（unitBreakdown）を返す
 * - 貸付（返済が必要）・費用減免・現金給付を区別する
 * - 二重計上の防止（既存ルールをそのまま適用）:
 *   - 子ども別の合計 = 世帯合計（同一の perChildYearly から積み上げ）
 *   - 併用不可（combinedWith）は金額の大きい方のみ
 *   - 利用中の制度（excludeProgramIds）は加算しない
 *   - 世帯全体と子ども別で同じ金額を二重に足さない
 * - 金額・条件が不明な制度は推測して確定値にしない
 *   （basis: 'unknown' は合計対象外・計算不能は null のまま）
 *
 * 【外部通信なし】AI API・fetch は行わない。
 */
import type {
  AmountBasis,
  SupportCategory,
  SupportProgram,
} from '../types/support'
import type { FamilyPlan } from '../types/finance'
import {
  calculateSupportEffects,
  type SupportCalcResult,
  type SupportEffect,
} from '../finance/supports'
import { matchProgramToPlan, type ProgramMatch } from './matching'

/** 単位別の見込額内訳（月額・年額・一時金を区別する） */
export type UnitBreakdown = {
  /** 金額の単位 */
  unit: SupportProgram['amount']['unit']
  /** 1単位あたりの金額（未確認は null） */
  baseAmountYen: number | null
  /**
   * 計上した単位の数。
   * - 月額: 計上月数（支給期間上限を反映した実数）
   * - 年額: 計上年数（子ども×年）
   * - 一時金: 計上回数（子どもごとに最大1回ずつ）
   * 金額未確認（baseAmountYen=null）なら 0。
   */
  countedUnits: number
  /** 単位表記（表示用） */
  unitLabel: string
  /** 見込額合計（計算不能は null） */
  totalYen: number | null
}

export type SupportEstimate = {
  program: SupportProgram
  /** ユーザー条件との照合結果 */
  match: ProgramMatch
  /** 既存計算の結果（金額の正） */
  effect: SupportEffect
  /** 単位別の内訳 */
  unitBreakdown: UnitBreakdown
  /** 子どもごとの見込額合計 */
  perChild: Array<{ childId: string; totalYen: number | null }>
  /** 世帯合計（Σ子ども別と一致する。二重計上しない） */
  householdTotalYen: number | null
  /** 現金給付・費用減免・貸付・税制の区分 */
  benefitKind: SupportCategory
  /** 返済が必要な貸付か（貸付は見込額の合計に含めない） */
  isRepaymentRequired: boolean
  /** 金額の確度（未確認を確定にしない） */
  amountBasis: AmountBasis
  /** 見込額の合計に含めたか */
  countedInTotal: boolean
  /** 合計に含めない理由 */
  excludedReason: string | null
}

export type SupportEstimateResult = {
  estimates: SupportEstimate[]
  /** 合計に含めた確定額 */
  confirmedTotalYen: number
  /** 合計に含めた推定額 */
  estimatedTotalYen: number
  /** 合計に含めなかった制度（理由付き） */
  uncounted: SupportEstimate[]
  /** 適用した二重計上防止・除外の内容 */
  doubleCountGuards: string[]
  /** 既存計算の生結果（結果画面の配分などに使用） */
  calc: SupportCalcResult
}

const UNIT_LABELS: Record<SupportProgram['amount']['unit'], string> = {
  yen_per_month: '月額',
  yen_per_year: '年額',
  yen_one_time: '一時金',
  other: '単位不明',
}

/** 単位別の内訳を計算する（合計額は既存計算の結果をそのまま使う） */
function unitBreakdownOf(
  program: SupportProgram,
  effect: SupportEffect,
): UnitBreakdown {
  const { value, unit } = program.amount
  const unitLabel = UNIT_LABELS[unit]
  if (value === null || value === 0 || unit === 'other') {
    return {
      unit,
      baseAmountYen: value ?? null,
      countedUnits: 0,
      unitLabel,
      totalYen: effect.estimatedTotalYen,
    }
  }
  const totalYen = effect.estimatedTotalYen
  // 既存計算は「1単位あたり金額 × 単位数」で各年に積み上げるため、
  // 単位数は合計額 ÷ 1単位金額で一意に求まる（支給期間の上限も反映済み）。
  const countedUnits = totalYen === null ? 0 : Math.round(totalYen / value)
  return {
    unit,
    baseAmountYen: value,
    countedUnits,
    unitLabel,
    totalYen,
  }
}

/**
 * 制度一覧とユーザー入力から支援見込額を計算する（純関数）。
 *
 * options.excludeProgramIds: 現在利用中の制度 ID（現在の家計に反映済みのため
 * 見込み額に加算しない＝二重計上防止）。
 */
export function estimateSupports(
  plan: FamilyPlan,
  programs: readonly SupportProgram[],
  options?: { excludeProgramIds?: string[] },
): SupportEstimateResult {
  // 金額計算は既存の決定論計算に一本化（月額/年額/一時金、対象期間×年齢、
  // 複数子ども、併用不可、利用中除外、貸付・金額未確認の合計除外を含む）
  const calc = calculateSupportEffects(plan, [...programs], options)

  const estimates: SupportEstimate[] = calc.effects.map((effect) => {
    const match = matchProgramToPlan(effect.program, plan)
    return {
      program: effect.program,
      match,
      effect,
      unitBreakdown: unitBreakdownOf(effect.program, effect),
      perChild: effect.perChild,
      householdTotalYen: effect.estimatedTotalYen,
      benefitKind: effect.program.category,
      isRepaymentRequired: effect.program.category === 'loan',
      amountBasis: effect.program.amount.basis,
      countedInTotal: effect.includedInTotal,
      excludedReason: effect.excludedReason,
    }
  })

  const doubleCountGuards = estimates
    .filter((e) => !e.countedInTotal && e.excludedReason !== null)
    .map((e) => `${e.program.name}: ${e.excludedReason}`)

  return {
    estimates,
    confirmedTotalYen: calc.confirmedTotalYen,
    estimatedTotalYen: calc.estimatedTotalYen,
    uncounted: estimates.filter((e) => !e.countedInTotal),
    doubleCountGuards,
    calc,
  }
}
