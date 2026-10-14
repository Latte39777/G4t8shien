/**
 * 公的支援制度の構造化データ型と zod スキーマ（M1）
 *
 * - AI が探索した制度情報は、このスキーマで検証してから計算・表示に使う
 * - 金額・期限・必要書類には根拠（sources）を紐付ける
 * - amount.basis が 'unknown' の金額や、category が 'loan' の制度は
 *   合計に含めない（lib/finance/supports.ts で制御）
 */
import { z } from 'zod'

export const SUPPORT_CATEGORIES = [
  'cash_benefit',
  'fee_reduction',
  'loan',
  'tax',
] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

/** 国の制度か、自治体独自の制度か */
export const SUPPORT_LEVELS = ['national', 'municipal'] as const
export type SupportLevel = (typeof SUPPORT_LEVELS)[number]

/** 受給可能性の判定（AIの案内であり正式な受給資格の決定ではない） */
export const ELIGIBILITY_LEVELS = [
  'likely',
  'possible',
  'unconfirmed',
  'ineligible',
] as const
export type Eligibility = (typeof ELIGIBILITY_LEVELS)[number]

/** 金額の確度。unknown は合計に含めない */
export const AMOUNT_BASES = ['confirmed', 'estimated', 'unknown'] as const
export type AmountBasis = (typeof AMOUNT_BASES)[number]

/** 出典（公式情報を優先）。url が未確認なら url=null + urlVerified=false */
export const supportSourceSchema = z.object({
  title: z.string().min(1),
  organization: z.string().min(1),
  url: z.string().min(1).nullable(),
  /** URLが実在確認済みか（未確認の出典は「URL要確認」と表示する） */
  urlVerified: z.boolean(),
  /** 国・自治体などの公式情報か */
  official: z.boolean(),
  /** 確認日（YYYY-MM-DD） */
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type SupportSource = z.infer<typeof supportSourceSchema>

/** 根拠法令・条例 */
export const legalBasisSchema = z.object({
  lawName: z.string().min(1).nullable(),
  ordinanceName: z.string().min(1).nullable(),
  note: z.string().min(1).nullable(),
})
export type LegalBasis = z.infer<typeof legalBasisSchema>

export const supportAmountSchema = z.object({
  /** 金額（円）。未確認は null */
  value: z.number().nonnegative().nullable(),
  unit: z.enum(['yen_per_month', 'yen_per_year', 'yen_one_time', 'other']),
  basis: z.enum(AMOUNT_BASES),
  /** 金額の前提（例：「月額10,000円（第3子以降15,000円）」） */
  description: z.string().min(1),
})
export type SupportAmount = z.infer<typeof supportAmountSchema>

/** 対象期間（子どもの年齢ベース） */
export const supportPeriodSchema = z.object({
  startAgeYears: z.number().nullable(),
  endAgeYears: z.number().nullable(),
  /** 支給期間（月）。一時金等は null */
  durationMonths: z.number().int().positive().nullable(),
})
export type SupportPeriod = z.infer<typeof supportPeriodSchema>

export const supportConditionsSchema = z.object({
  /** 併用不可（同時受給できない）制度の ID */
  combinedWith: z.array(z.string()),
  incomeLimitNote: z.string().nullable(),
  householdNote: z.string().nullable(),
  other: z.array(z.string()),
})
export type SupportConditions = z.infer<typeof supportConditionsSchema>

export const supportApplicationSchema = z.object({
  /** 申請先 */
  where: z.string().nullable(),
  /** 必要書類 */
  documents: z.array(z.string()),
  /** 申請期限・申請時期 */
  deadlineNote: z.string().nullable(),
  /** 申請手順 */
  steps: z.array(z.string()),
})
export type SupportApplication = z.infer<typeof supportApplicationSchema>

export const supportProgramSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(SUPPORT_CATEGORIES),
  level: z.enum(SUPPORT_LEVELS),
  summary: z.string().min(1),
  amount: supportAmountSchema,
  period: supportPeriodSchema,
  conditions: supportConditionsSchema,
  application: supportApplicationSchema,
  /** 入力情報から機械的に再判定される（lib/finance/supports.ts） */
  eligibility: z.enum(ELIGIBILITY_LEVELS),
  eligibilityNote: z.string().nullable(),
  legalBasis: legalBasisSchema,
  /** 根拠となる公式情報（1件以上必須） */
  sources: z.array(supportSourceSchema).min(1),
  /** 情報の確認日（YYYY-MM-DD） */
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 判定に不足している情報（不足＝対象外ではない） */
  missingInformation: z.array(z.string()),
  /** モック／仮データであることを示す */
  mock: z.boolean(),
})
export type SupportProgram = z.infer<typeof supportProgramSchema>