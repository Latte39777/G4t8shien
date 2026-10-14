/**
 * 家計推移（キャッシュフロー）の計算（M1・決定論。M4で収入・支出の対応を変更）
 *
 * - 子供ごとに「年齢 → 教育段階 → コストマスタの年額」を適用
 * - 大学入学（18歳の年）に入学料を一時加算
 * - 支援額は確定（confirmed）と推定（estimated）を分けて集計し、
 *   貯蓄推移には確定分のみを反映する
 *
 * 【収入・支出の対応関係（M4・要確認事項の承認に基づく変更）】
 * - 収入（incomeYen）= 月の手取り収入 × 12 × 収入変化係数（incomeChange）。
 *   世帯年収（annualIncome）は受給条件の確認専用で、家計収支には使わない。
 * - 支出 = 世帯生活費（monthlyBaseExpense × 12。住居費を含む前提）＋ 子供費用。
 *   住居費を別途加算すると二重計上になるため、住居費は monthlyBaseExpense 側に
 *   含めて受け取る（変換層 lib/simulation.ts の toFamilyPlan で制御）。
 * - 現在の貯蓄額（savings）を初期残高として残高推移を計算する。
 */
import type {
  CashflowProjection,
  CashflowTotals,
  ChildInput,
  ChildYearCost,
  FamilyPlan,
  YearRow,
} from '../types/finance'
import { annualChildCosts, entranceCostYen, stageForAge } from './costs'
import type { SupportSchedule } from './supports'

/** 養育費の対象とする上限年齢（大学卒業時点） */
export const MAX_CHILD_AGE = 22

/** ある年の子どもの年齢。未出生・対象期間外は null */
export function childAgeAt(
  child: ChildInput,
  yearOffset: number,
): number | null {
  if (child.currentAgeYears !== null) {
    const age = child.currentAgeYears + yearOffset
    return age <= MAX_CHILD_AGE ? age : null
  }
  const age = yearOffset - (child.birthInYears ?? 0)
  return age >= 0 && age <= MAX_CHILD_AGE ? age : null
}

/** 現在から、最長の子が養育対象外（22歳）になるまでの年数 */
export function projectionHorizon(plan: FamilyPlan): number {
  let horizon = 0
  for (const c of plan.children) {
    const ageNow =
      c.currentAgeYears !== null ? c.currentAgeYears : -(c.birthInYears ?? 0)
    horizon = Math.max(horizon, MAX_CHILD_AGE - ageNow)
  }
  return horizon
}

function childYearCost(child: ChildInput, yearOffset: number): ChildYearCost {
  const empty = {
    childId: child.id,
    ageYears: null,
    stage: null,
    livingYen: 0,
    educationYen: 0,
    universityYen: 0,
    oneTimeYen: 0,
    totalYen: 0,
  }
  const ageYears = childAgeAt(child, yearOffset)
  if (ageYears === null) return empty
  const stage = stageForAge(ageYears)
  if (stage === 'after_university') return { ...empty, ageYears, stage }
  const course = {
    school: child.course,
    university: child.universityCourse,
  }
  const annual = annualChildCosts(stage, course)
  // 大学入学時（18歳の年）に入学料を一時加算
  const oneTimeYen =
    ageYears === 18 ? entranceCostYen('university', course) : 0
  return {
    childId: child.id,
    ageYears,
    stage,
    livingYen: annual.livingYen,
    educationYen: annual.educationYen,
    universityYen: annual.universityYen,
    oneTimeYen,
    totalYen: annual.totalYen + oneTimeYen,
  }
}

/** ある年の世帯収入（円）。手取り×12に収入変化係数を適用（世帯年収は不使用） */
function incomeForYear(
  plan: FamilyPlan,
  yearOffset: number,
): { incomeYen: number; multiplier: number } {
  const base = (plan.monthlyTakeHomeYen ?? 0) * 12
  const change = plan.incomeChange
  if (!change) return { incomeYen: base, multiplier: 1 }
  const inWindow =
    yearOffset >= change.fromYearOffset &&
    (change.durationYears === null ||
      yearOffset < change.fromYearOffset + change.durationYears)
  const multiplier = inWindow ? change.multiplier : 1
  return { incomeYen: Math.round(base * multiplier), multiplier }
}

/**
 * 家計推移を計算する（純関数）
 * supportSchedule を渡すと、確定支援を各年の収支に反映する
 */
export function projectCashflow(
  plan: FamilyPlan,
  supportSchedule?: SupportSchedule,
): CashflowProjection {
  const horizonYears = projectionHorizon(plan)
  const baseExpenseYen = plan.monthlyBaseExpense * 12

  if (plan.children.length === 0) {
    return {
      rows: [],
      totals: {
        childCostTotalYen: 0,
        baseExpenseTotalYen: 0,
        supportConfirmedTotalYen: 0,
        supportEstimatedTotalYen: 0,
        incomeTotalYen: 0,
        netTotalYen: 0,
        savingsEndYen: plan.savings,
      },
      horizonYears: 0,
    }
  }

  const rows: YearRow[] = []
  let savings = plan.savings
  for (let yearOffset = 0; yearOffset <= horizonYears; yearOffset += 1) {
    const children = plan.children.map((c) => childYearCost(c, yearOffset))
    const childCostTotalYen = children.reduce((s, c) => s + c.totalYen, 0)
    const supportConfirmedYen =
      supportSchedule?.confirmedByYear[yearOffset] ?? 0
    const supportEstimatedYen =
      supportSchedule?.estimatedByYear[yearOffset] ?? 0
    const { incomeYen, multiplier } = incomeForYear(plan, yearOffset)
    const netYen =
      incomeYen - baseExpenseYen - childCostTotalYen + supportConfirmedYen
    const netWithEstimatedYen = netYen + supportEstimatedYen
    savings += netYen
    rows.push({
      yearOffset,
      children,
      childCostTotalYen,
      baseExpenseYen,
      supportConfirmedYen,
      supportEstimatedYen,
      incomeYen,
      incomeMultiplier: multiplier,
      netYen,
      netWithEstimatedYen,
      savingsEndYen: savings,
    })
  }

  const sum = (pick: (r: YearRow) => number) =>
    rows.reduce((s, r) => s + pick(r), 0)
  const totals: CashflowTotals = {
    childCostTotalYen: sum((r) => r.childCostTotalYen),
    baseExpenseTotalYen: sum((r) => r.baseExpenseYen),
    supportConfirmedTotalYen: sum((r) => r.supportConfirmedYen),
    supportEstimatedTotalYen: sum((r) => r.supportEstimatedYen),
    incomeTotalYen: sum((r) => r.incomeYen),
    netTotalYen: sum((r) => r.netYen),
    savingsEndYen: rows[rows.length - 1].savingsEndYen,
  }
  return { rows, totals, horizonYears }
}