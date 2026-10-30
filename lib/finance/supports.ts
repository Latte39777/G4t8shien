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
import { TOKYO_WARD_LABELS } from '../supports/region'

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
  /** 子どもごと・各年の見込額（yearOffset 順。教育段階への配分に使用する） */
  perChildYearly: Array<{ childId: string; yearlyYen: number[] }>
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

/**
 * 1子について、対象期間の各年の見込額を返す。
 *
 * 一時金（M7-J1）: 「対象期間に入った最初の年」＝投影期間（t=0〜horizon）内で
 * 最初に対象期間となった年に 1 回だけ計上する。
 * t=0 の時点で既に対象期間内の子（既存の子・0歳児）も、その年に 1 回計上する
 * （旧実装は t-1 年の年齢判定で t=0 を過去扱いし 0 円になっていた）。
 */
function perChildYearly(
  child: ChildInput,
  program: SupportProgram,
  horizon: number,
): number[] {
  const yearly: number[] = new Array(horizon + 1).fill(0)
  const value = program.amount.value
  if (value === null || program.amount.unit === 'other') return yearly

  let countedOneTime = false
  for (let t = 0; t <= horizon; t += 1) {
    const age = childAgeAt(child, t)
    if (age === null || !inPeriod(age, program.period)) continue
    if (program.amount.unit === 'yen_per_month') {
      yearly[t] += value * 12
    } else if (program.amount.unit === 'yen_per_year') {
      yearly[t] += value
    } else if (program.amount.unit === 'yen_one_time') {
      if (!countedOneTime) {
        yearly[t] += value
        countedOneTime = true
      }
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
 * 世帯単位（per_household）の制度の各年の見込額を返す（M7-J1）。
 *
 * 支給単位が「世帯・申請・工事1件につき」の制度（例: 住宅リフォーム助成）は、
 * 子どもの数を掛けず、世帯で 1 回（一時金）または各年に 1 回のみ計上する。
 * 一時金は、投影期間内で最初に対象子が現れた年に 1 回だけ計上する。
 */
function householdYearly(
  plan: FamilyPlan,
  program: SupportProgram,
  horizon: number,
): number[] {
  const yearly: number[] = new Array(horizon + 1).fill(0)
  const value = program.amount.value
  if (value === null || program.amount.unit === 'other') return yearly

  let countedOneTime = false
  for (let t = 0; t <= horizon; t += 1) {
    const inPeriodThisYear = plan.children.some((c) => {
      const age = childAgeAt(c, t)
      return age !== null && inPeriod(age, program.period)
    })
    if (!inPeriodThisYear) continue
    if (program.amount.unit === 'yen_per_month') {
      yearly[t] += value * 12
    } else if (program.amount.unit === 'yen_per_year') {
      yearly[t] += value
    } else if (program.amount.unit === 'yen_one_time') {
      if (!countedOneTime) {
        yearly[t] += value
        countedOneTime = true
      }
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
 * 制度の対象地域と居住地の一致判定（M7-J1）。
 *
 * - 'match': 居住自治体が対象地域と一致（または地域限定の情報がない）→ 合計に含めうる
 * - 'mismatch': 居住自治体が対象地域外 → 合計に含めない
 * - 'unknown': 居住地が未入力・未定 → 合計に含めない（確定額として扱わない）
 *
 * 全国対象（nationwide）・対象地域未確認（unknown）の制度は絞り込まない
 * （推測で適用・不適用を決めない）。判定は lib/supports/region.ts の
 * filterProgramsByRegion と同じ考え方（区名・区コードのどちらでも一致判定）。
 */
function regionGate(
  program: SupportProgram,
  plan: FamilyPlan,
): 'match' | 'mismatch' | 'unknown' {
  const j = program.jurisdiction
  if (
    j === undefined ||
    j.coverage === 'nationwide' ||
    j.coverage === 'unknown'
  ) {
    return 'match'
  }
  const targetAreas: string[] = []
  if (j.coverage === 'prefecture' && j.prefecture !== null) {
    targetAreas.push(j.prefecture)
  }
  if (j.ward !== null) targetAreas.push(TOKYO_WARD_LABELS[j.ward])
  if (j.municipality !== null) targetAreas.push(j.municipality)
  // 対象自治体を特定できない場合は絞り込まない（推測しない）
  if (targetAreas.length === 0) return 'match'
  const userArea = plan.municipality
  if (userArea === null || userArea === '' || userArea === '未定') {
    return 'unknown'
  }
  return targetAreas.some((area) => userArea.includes(area))
    ? 'match'
    : 'mismatch'
}

/** 受付期限（YYYY-MM-DD）が今日より前なら期限切れ（M7-G） */
function isDeadlineExpired(program: SupportProgram, today: string): boolean {
  const deadline = program.application.deadlineDate ?? null
  return deadline !== null && deadline < today
}
/**
 * 入力内容と制度データから支援の効果を計算する（純関数）
 *
 * options.excludeProgramIds: 現在利用中など、見込み額に含めない制度 ID。
 * 現在の家計（手取り収入）に反映済みの制度を二重に見込まないための除外指定。
 * options.today: 期限切れ判定の基準日（YYYY-MM-DD。既定はシステム日付。テスト用）
 */
export function calculateSupportEffects(
  plan: FamilyPlan,
  programs: SupportProgram[],
  options?: { excludeProgramIds?: string[]; today?: string },
): SupportCalcResult {
  const horizon = projectionHorizon(plan)
  const excludeIds = options?.excludeProgramIds ?? []
  const today = options?.today ?? new Date().toISOString().slice(0, 10)

  const effects: SupportEffect[] = programs.map((program) => {
    const { eligibility, missing } = recomputeEligibility(plan, program)
    const yearly: number[] = new Array(horizon + 1).fill(0)
    const computable =
      program.amount.value !== null && program.amount.unit !== 'other'
    const scope = program.amount.scope ?? 'per_child'
    const childYearlyList: Array<{ childId: string; yearlyYen: number[] }> = []
    // 世帯単位（per_household）: 子どもの数を掛けず、世帯で 1 回のみ計上する（M7-J1）
    const householdUnitYearly =
      scope === 'per_household' && computable
        ? householdYearly(plan, program, horizon)
        : null
    for (const child of plan.children) {
      const childYearly =
        householdUnitYearly !== null
          ? new Array(horizon + 1).fill(0)
          : perChildYearly(child, program, horizon)
      childYearlyList.push({ childId: child.id, yearlyYen: childYearly })
    }
    if (householdUnitYearly !== null) {
      // Σ子ども別 = 世帯合計が成立するよう、計上額は最初に計上した年の
      // 最初の対象子に帰属させる（表示用の帰属。金額の合計は世帯で 1 回のみ）
      const countedYear = householdUnitYearly.findIndex((y) => y > 0)
      const target =
        countedYear >= 0
          ? plan.children.find((c) => {
              const age = childAgeAt(c, countedYear)
              return age !== null && inPeriod(age, program.period)
            })
          : undefined
      const entry = childYearlyList.find((e) => e.childId === target?.id)
      if (entry !== undefined) {
        for (let t = 0; t <= horizon; t += 1) {
          entry.yearlyYen[t] = householdUnitYearly[t]
        }
      }
      for (let t = 0; t <= horizon; t += 1) yearly[t] += householdUnitYearly[t]
    } else {
      for (const entry of childYearlyList) {
        for (let t = 0; t <= horizon; t += 1) yearly[t] += entry.yearlyYen[t]
      }
    }
    const perChild = plan.children.map((child, i) => ({
      childId: child.id,
      totalYen: computable
        ? childYearlyList[i].yearlyYen.reduce((a, b) => a + b, 0)
        : null,
    }))
    const total = computable ? yearly.reduce((a, b) => a + b, 0) : null

    let includedInTotal = true
    let excludedReason: string | null = null
    const region = regionGate(program, plan)
    if (program.category === 'loan') {
      includedInTotal = false
      excludedReason = '貸付制度のため合計対象外'
    } else if (region === 'mismatch') {
      // 居住自治体が対象地域外の制度は合計に含めない（M7-J1）
      includedInTotal = false
      excludedReason = '居住自治体が対象地域外のため合計対象外'
    } else if (isDeadlineExpired(program, today)) {
      // 受付期限が過ぎた制度を利用可能として案内しない（M7-G）
      includedInTotal = false
      excludedReason = `受付期限（${program.application.deadlineDate}）が過ぎているため合計対象外（次年度の受付は要確認）`
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
    } else if (region === 'unknown') {
      // 居住地が未入力・未定の場合、地域限定の制度を確定額として扱わない（M7-J1）
      includedInTotal = false
      excludedReason =
        '居住地が未入力・未定のため合計対象外（対象地域に該当するか要確認）'
    }

    return {
      program: { ...program, eligibility, missingInformation: missing },
      eligibility,
      estimatedTotalYen: total,
      includedInTotal,
      excludedReason,
      perChild,
      yearlyYen: yearly,
      perChildYearly: childYearlyList,
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
    // 上限額のみ確認済みの制度（capOnly。実額が未確認）は、
    // basis が confirmed でも確定額として扱わず推定枠に計上する（M7-J1）
    const isConfirmed =
      e.program.amount.basis === 'confirmed' &&
      e.program.amount.capOnly !== true
    const target = isConfirmed ? confirmedByYear : estimatedByYear
    for (let t = 0; t <= horizon; t += 1) target[t] += e.yearlyYen[t]
    const total = e.estimatedTotalYen ?? 0
    if (isConfirmed) confirmedTotalYen += total
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

/** 教育段階ごとの支援見込額（確定・推定は常に分離する） */
export type StageSupportBucket = {
  /** 確定している支援額（円） */
  confirmedYen: number
  /** 推定・要確認の支援額（円） */
  estimatedYen: number
  /** 配分に寄与した制度 ID */
  programIds: string[]
}

/** 段階別に配分できなかった支援（理由付きで UI に表示する） */
export type UnallocatedSupport = {
  programId: string
  programName: string
  category: SupportProgram['category']
  amountYen: number | null
  reason: string
  /** 世帯の支援見込額の合計に含まれていたか（Σ段階別＋この区分＝合計が成立する） */
  includedInTotal: boolean
}

export type SupportStageAllocation = {
  /** 教育段階キー → 配分額 */
  byStage: Map<string, StageSupportBucket>
  /** 子ども ID → 教育段階キー → 配分額 */
  byChild: Map<string, Map<string, StageSupportBucket>>
  /** 配分対象外・配分不能な制度 */
  unallocated: UnallocatedSupport[]
  /** 配分した確定支援額の合計（Σ段階別と一致する） */
  confirmedTotalYen: number
  /** 配分した推定支援額の合計（Σ段階別と一致する） */
  estimatedTotalYen: number
  /** 配分の前提・要確認事項 */
  notes: string[]
}

function emptyStageSupportBucket(): StageSupportBucket {
  return { confirmedYen: 0, estimatedYen: 0, programIds: [] }
}

/**
 * 支援見込額を、対象年齢と教育段階の重なりで教育段階へ配分する（純関数）。
 *
 * ルール（二重計上の防止）:
 * - 合計に含めた制度（includedInTotal）のみを配分対象とし、
 *   Σ 段階別の配分額 = 世帯全体の支援見込額（confirmedTotalYen / estimatedTotalYen）が厳密に成立する
 * - 各子ども・各年の見込額を、その年の子どもの年齢に対応する教育段階にのみ計上する
 *   （対象期間・支給期間・金額単位は calculateSupportEffects 側で各年に反映済み。
 *   同じ支援額を世帯全体と子ども別で二重に足さないよう、配分元は perChildYearly のみ）
 * - 貸付（loan）・金額未確認・対象外・現在利用中・併用不可の制度は配分せず、
 *   unallocated に理由付きで記録する（返済が必要な貸付を現金給付と同じ扱いにしない）
 * - 確定（confirmed）と推定（estimated）は常に分離する
 * - 情報不足で段階へ対応付けられない場合は、根拠のない比率では按分せず未配分・要確認とする
 * - 対象年齢の記載がない制度は、その年の年齢に対応する段階へ暫定配分し、notes に要確認として記録する
 */
export function allocateSupportByStage(
  plan: FamilyPlan,
  effects: SupportEffect[],
  options: {
    stageKeys: string[]
    /** 年齢→教育段階キー。ageYears=null は出生前の年（呼び出し側で妊娠・出産段階などに対応付ける） */
    stageKeyForAge: (ageYears: number | null) => string | null
  },
): SupportStageAllocation {
  const byStage = new Map<string, StageSupportBucket>()
  const byChild = new Map<string, Map<string, StageSupportBucket>>()
  for (const key of options.stageKeys) byStage.set(key, emptyStageSupportBucket())
  const unallocated: UnallocatedSupport[] = []
  const notes: string[] = []
  let confirmedTotalYen = 0
  let estimatedTotalYen = 0

  const bucketFor = (
    childId: string,
    stageKey: string,
  ): { stage: StageSupportBucket; child: StageSupportBucket } => {
    const stageBucket =
      byStage.get(stageKey) ?? emptyStageSupportBucket()
    byStage.set(stageKey, stageBucket)
    let childMap = byChild.get(childId)
    if (childMap === undefined) {
      childMap = new Map()
      byChild.set(childId, childMap)
    }
    const childBucket = childMap.get(stageKey) ?? emptyStageSupportBucket()
    childMap.set(stageKey, childBucket)
    return { stage: stageBucket, child: childBucket }
  }

  for (const effect of effects) {
    const program = effect.program
    if (!effect.includedInTotal) {
      unallocated.push({
        programId: program.id,
        programName: program.name,
        category: program.category,
        amountYen: effect.estimatedTotalYen,
        reason: effect.excludedReason ?? '合計に含めていないため段階別にも配分していません',
        includedInTotal: false,
      })
      continue
    }
    const periodUndefined =
      program.period.startAgeYears === null && program.period.endAgeYears === null
    if (periodUndefined) {
      notes.push(
        `「${program.name}」は対象年齢の記載がないため、各年の見込額をその年の年齢に対応する教育段階へ暫定配分しています（要確認）。`,
      )
    }
    for (const childYearly of effect.perChildYearly) {
      const child = plan.children.find((c) => c.id === childYearly.childId)
      if (child === undefined) continue
      for (let t = 0; t < childYearly.yearlyYen.length; t += 1) {
        const amount = childYearly.yearlyYen[t]
        if (amount <= 0) continue
        const age = childAgeAt(child, t)
        const stageKey = options.stageKeyForAge(age)
        if (stageKey === null) {
          unallocated.push({
            programId: program.id,
            programName: program.name,
            category: program.category,
            amountYen: amount,
            reason: '対象期間を教育段階に対応付けられないため未配分（要確認）',
            includedInTotal: true,
          })
          continue
        }
        const isConfirmed = program.amount.basis === 'confirmed'
        const buckets = bucketFor(child.id, stageKey)
        if (isConfirmed) {
          buckets.stage.confirmedYen += amount
          buckets.child.confirmedYen += amount
          confirmedTotalYen += amount
        } else {
          buckets.stage.estimatedYen += amount
          buckets.child.estimatedYen += amount
          estimatedTotalYen += amount
        }
        if (!buckets.stage.programIds.includes(program.id)) {
          buckets.stage.programIds.push(program.id)
        }
        if (!buckets.child.programIds.includes(program.id)) {
          buckets.child.programIds.push(program.id)
        }
      }
    }
  }

  return {
    byStage,
    byChild,
    unallocated,
    confirmedTotalYen,
    estimatedTotalYen,
    notes,
  }
}