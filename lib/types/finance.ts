/**
 * 家計シミュレーションの入出力型（M1）
 *
 * - 計算はすべて決定論的な純関数（lib/finance/）
 * - AI の生成テキストは計算に入力しない
 */
import { z } from 'zod'

/** 進学コース（幼稚園〜高校の教育費区分に使用） */
export const EDUCATION_COURSES = ['public', 'private'] as const
export type EducationCourse = (typeof EDUCATION_COURSES)[number]

/** 大学の区分（国立・公立・私立は別区分として扱う） */
export const UNIVERSITY_COURSES = ['national', 'public', 'private'] as const
export type UniversityCourse = (typeof UNIVERSITY_COURSES)[number]

/**
 * 教育段階（年齢ラベルの範囲）
 * - infant: 0〜2歳（3年） / preschool: 3〜5歳（3年） / elementary: 6〜11歳（6年）
 * - junior_high: 12〜14歳（3年） / high_school: 15〜17歳（3年）
 * - university: 18〜21歳（4年） / after_university: 22歳（費用0）
 * 「0〜22歳」は年齢ラベル0〜22（23個）のこと。「22年分」は費用計上の年数
 * （0〜21歳の各年＝3+3+6+3+3+4=22年）を指し、両者は区別する。
 */
export const STAGES = [
  'infant',
  'preschool',
  'elementary',
  'junior_high',
  'high_school',
  'university',
  'after_university',
] as const
export type Stage = (typeof STAGES)[number]

export const childInputSchema = z
  .object({
    id: z.string().min(1),
    /** 現在の年齢（歳・0〜22）。未出生の子は null */
    currentAgeYears: z.number().int().min(0).max(22).nullable(),
    /** あと N 年後に生まれる子。currentAgeYears が null のとき必須 */
    birthInYears: z.number().int().min(0).max(10).nullable(),
    /** 幼稚園〜高校の進学コース */
    course: z.enum(EDUCATION_COURSES),
    /** 大学の区分（学校段階のコースとは別に指定） */
    universityCourse: z.enum(UNIVERSITY_COURSES).default('national'),
  })
  .refine((v) => v.currentAgeYears !== null || v.birthInYears !== null, {
    message: 'currentAgeYears か birthInYears のどちらかが必要です',
  })
export type ChildInput = z.infer<typeof childInputSchema>

/**
 * 収入変化の反映（M4・出産後の働き方を数値化したもの。すべて仮定値・要確認）。
 * - 収入は月の手取り収入 × 12 を基礎に、この窓の期間だけ multiplier を掛ける
 * - 世帯年収（annualIncome）は受給条件の確認専用で、家計収支には使わない
 */
export const incomeChangeSchema = z.object({
  /** 適用開始（現在から N 年後） */
  fromYearOffset: z.number().int().nonnegative(),
  /** 手取り収入の係数（1.0=変化なし。0〜1の仮定値） */
  multiplier: z.number().nonnegative(),
  /** 適用年数（null=終了しない） */
  durationYears: z.number().int().positive().nullable(),
})
export type IncomeChange = z.infer<typeof incomeChangeSchema>

export const familyPlanSchema = z.object({
  /** 居住地（M1は「東京都」固定の想定。M3で選択式に拡張） */
  municipality: z.string().min(1),
  householdType: z.enum(['single', 'couple', 'other']),
  /** 世帯年収（円）。受給条件（所得制限など）の確認専用。家計収支には使わない。未入力は null */
  annualIncome: z.number().nonnegative().nullable(),
  /** 子供以外の世帯の月間生活費（円/月。住居費を含む前提） */
  monthlyBaseExpense: z.number().nonnegative(),
  /** 現在の貯蓄額（円） */
  savings: z.number().nonnegative(),
  children: z.array(childInputSchema),
  /**
   * 月の手取り収入（円）。家計収支の収入は「この金額 × 12」（M4）。
   * 未入力は null（収入0円として扱い、結果画面に影響を明示する）。
   */
  monthlyTakeHomeYen: z.number().nonnegative().nullable().optional(),
  /** 出産後の働き方による収入変化（仮定値・要確認）。省略時は変化なし */
  incomeChange: incomeChangeSchema.nullable().optional(),
})
export type FamilyPlan = z.infer<typeof familyPlanSchema>

/** 1子・1年の費用内訳 */
export type ChildYearCost = {
  childId: string
  /** その年の年齢。未出生は null */
  ageYears: number | null
  stage: Stage | null
  livingYen: number
  /** 幼稚園〜高校の学習費 */
  educationYen: number
  /** 大学の学費 */
  universityYen: number
  /** 入学料などの一時金 */
  oneTimeYen: number
  totalYen: number
}

/** 家計推移の1行（現在から N 年後） */
export type YearRow = {
  yearOffset: number
  children: ChildYearCost[]
  childCostTotalYen: number
  /** 子供以外の世帯生活費（年額） */
  baseExpenseYen: number
  supportConfirmedYen: number
  supportEstimatedYen: number
  /** その年の世帯収入（月の手取り × 12 × 収入変化係数。世帯年収は使わない） */
  incomeYen: number
  /** 収入変化係数（出産後の働き方による仮定値。通常は1） */
  incomeMultiplier: number
  /** その年の収支（確定支援のみ反映） */
  netYen: number
  /** 推定支援も含めた場合の収支（参考） */
  netWithEstimatedYen: number
  savingsEndYen: number
}

export type CashflowTotals = {
  childCostTotalYen: number
  baseExpenseTotalYen: number
  supportConfirmedTotalYen: number
  supportEstimatedTotalYen: number
  incomeTotalYen: number
  netTotalYen: number
  savingsEndYen: number
}

export type CashflowProjection = {
  rows: YearRow[]
  totals: CashflowTotals
  /** 現在から最長の子が22歳になるまでの年数 */
  horizonYears: number
}