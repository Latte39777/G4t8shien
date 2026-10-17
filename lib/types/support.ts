/**
 * 公的支援制度の構造化データ型と zod スキーマ（M1 / M6-B で拡張）
 *
 * - AI が探索した制度情報は、このスキーマで検証してから計算・表示に使う
 * - 金額・期限・必要書類には根拠（sources）を紐付ける
 * - amount.basis が 'unknown' の金額や、category が 'loan' の制度は
 *   合計に含めない（lib/finance/supports.ts で制御）
 *
 * 【M6-B 拡張（すべて optional・後方互換）】
 * - 管轄区分に 'tokyo'（東京都の制度）/'ward'（区独自の制度）を追加
 * - 適用開始日・適用終了日（effectiveFrom/effectiveTo）を追加
 * - 未確認の項目と理由（unconfirmedItems）を追加
 * - 根拠法令・出典の確度・取得日時・取得方法を追加
 * - 金額の適用単位（scope: 子ども1人あたり / 世帯あたり）と申請期限日を追加
 *
 * 【M6-C 拡張（すべて optional・後方互換）】
 * - 適用年度（amount.fiscalYear）と、年齢区分等の金額内訳（amountBands）を追加
 * - 対象地域（jurisdiction）を追加（東京都23区までの絞り込み用。推測で補完しない）
 * - 確認状況（verification）を追加（公式確認済み／一部確認／未確認の区別）
 * - 出典に検証メモ（verificationNote）を追加
 *
 * 【確度の原則】
 * - confirmed（確認済み）＝公式資料で確認済み。estimated（推定）・unknown（未確認）と区別する
 * - 未確認の値は null とし、根拠のない値を補完しない
 * - AI の文章生成結果だけを根拠に、確定金額・法令・申請期限・受給資格を確定しない
 *   （lib/supports/research.ts の正規化で保証）
 * - 金額の適用年度が確認できない場合、fiscalYear は null のまま（年度を跨いで金額を混同しない）
 */
import { z } from 'zod'

export const SUPPORT_CATEGORIES = [
  'cash_benefit',
  'fee_reduction',
  'loan',
  'tax',
] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

/**
 * 制度の管轄区分。
 * - national: 国の制度
 * - tokyo: 東京都の制度
 * - municipal: 市区町村（自治体）の制度
 * - ward: 区独自の制度
 */
export const SUPPORT_LEVELS = ['national', 'tokyo', 'municipal', 'ward'] as const
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

/** 個別フィールドの確度（M6-B）。根拠なしに confirmed にしない */
export const FIELD_CONFIDENCE = ['confirmed', 'estimated', 'unconfirmed'] as const
export type FieldConfidence = (typeof FIELD_CONFIDENCE)[number]

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
  /** 取得日時（ISO 8601。取得できる場合のみ。M6-B） */
  retrievedAt: z.string().nullable().optional(),
  /** 取得方法（M6-B）。'ai-extraction' は AI による抽出で、検証は別途必要 */
  extractionMethod: z.enum(['manual', 'ai-extraction', 'mock']).optional(),
  /** URL・内容の照合メモ（M6-C）。どのように照合したかの記録 */
  verificationNote: z.string().min(1).nullable().optional(),
})
export type SupportSource = z.infer<typeof supportSourceSchema>

/** 根拠法令・条例 */
export const legalBasisSchema = z.object({
  lawName: z.string().min(1).nullable(),
  ordinanceName: z.string().min(1).nullable(),
  note: z.string().min(1).nullable(),
  /** 根拠そのものの確度（M6-B。AI の推測名は confirmed にしない） */
  confidence: z.enum(FIELD_CONFIDENCE).optional(),
})
export type LegalBasis = z.infer<typeof legalBasisSchema>

export const supportAmountSchema = z.object({
  /** 金額（円）。未確認は null */
  value: z.number().nonnegative().nullable(),
  unit: z.enum(['yen_per_month', 'yen_per_year', 'yen_one_time', 'other']),
  basis: z.enum(AMOUNT_BASES),
  /** 金額の前提（例：「月額10,000円（第3子以降15,000円）」） */
  description: z.string().min(1),
  /**
   * 金額の適用単位（M6-B）。
   * - per_child: 子ども1人あたり（既存計算 lib/finance/supports.ts はこの前提）
   * - per_household: 世帯あたり（子ども数を掛けない）
   * 省略時は per_child として扱う。
   */
  scope: z.enum(['per_child', 'per_household']).optional(),
  /**
   * 金額の適用年度（M6-C。例: '2025年度'）。
   * 公式資料で適用年度を確認できない場合は null（年度を推測しない）。
   */
  fiscalYear: z.string().min(1).nullable().optional(),
})
export type SupportAmount = z.infer<typeof supportAmountSchema>

/**
 * 年齢区分・課程等による金額内訳（M6-C）。
 * 制度により金額が区分で異なる場合に、公式資料で確認した区分ごとの金額を記録する。
 * 【計算への影響】金額計算は amount（単一値）を既存計算に渡す。amountBands は
 * 表示・記録用の内訳であり、計算ロジックには干渉しない。
 */
export const amountBandSchema = z.object({
  /** 区分のラベル（例: '3歳未満（第3子以外）'） */
  label: z.string().min(1),
  /** 金額（円）。未確認は null */
  value: z.number().nonnegative().nullable(),
  unit: z.enum(['yen_per_month', 'yen_per_year', 'yen_one_time', 'other']),
  /** 区分ごとの金額の確度 */
  basis: z.enum(AMOUNT_BASES),
  /** 区分ごとの適用年度（未確認は null） */
  fiscalYear: z.string().min(1).nullable().optional(),
  /** 前提・補足（確認できなかった事項もここに記録） */
  note: z.string().min(1).nullable().optional(),
})
export type AmountBand = z.infer<typeof amountBandSchema>

/** 東京都23区の区コード（M6-C。将来の地域絞り込み用の識別子） */
export const TOKYO_WARD_CODES = [
  'chiyoda',
  'chuo',
  'minato',
  'shinjuku',
  'bunkyo',
  'taito',
  'sumida',
  'koto',
  'shinagawa',
  'meguro',
  'ota',
  'setagaya',
  'shibuya',
  'nakano',
  'suginami',
  'toshima',
  'kita',
  'arakawa',
  'itabashi',
  'nerima',
  'adachi',
  'katsushika',
  'edogawa',
] as const
export type TokyoWardCode = (typeof TOKYO_WARD_CODES)[number]

/** 制度の適用範囲（対象地域の絞り込みに使用）。特定できない場合は 'unknown'（推測しない） */
export const JURISDICTION_COVERAGE = [
  'nationwide',
  'prefecture',
  'municipality',
  'ward',
  'unknown',
] as const
export type JurisdictionCoverage = (typeof JURISDICTION_COVERAGE)[number]

/**
 * 制度の対象地域（M6-C）。
 * - 公式情報で対象地域を確認できない場合、coverage は 'unknown' とし、
 *   prefecture/municipality/ward は null のまま（推測で設定しない）
 */
export const jurisdictionSchema = z.object({
  coverage: z.enum(JURISDICTION_COVERAGE),
  /** 都道府県名（例: '東京都'）。不明なら null */
  prefecture: z.string().min(1).nullable(),
  /** 市区町村名（例: '文京区'）。不明なら null */
  municipality: z.string().min(1).nullable(),
  /** 東京都23区の区コード。23区以外・不明なら null */
  ward: z.enum(TOKYO_WARD_CODES).nullable(),
  /** 対象地域の補足（確認できた範囲・確認できなかった事項） */
  scopeNote: z.string().min(1).nullable(),
  /** 対象地域情報そのものの確度 */
  confidence: z.enum(FIELD_CONFIDENCE).optional(),
})
export type Jurisdiction = z.infer<typeof jurisdictionSchema>

/**
 * 制度の確認状況（M6-C）。
 * - official-verified: 記載項目がすべて公式資料で確認済み
 * - partial: 一部の項目のみ公式資料で確認済み（他は未確認）
 * - unverified: 公式資料で確認できていない（モック・仮データ）
 */
export const programVerificationSchema = z.object({
  status: z.enum(['official-verified', 'partial', 'unverified']),
  /** 確認日（YYYY-MM-DD） */
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** 公式資料で確認済みのフィールド名（確認できた項目のみ列挙） */
  verifiedFields: z.array(z.string()),
  /** 確認方法・確認範囲のメモ */
  note: z.string().min(1).nullable(),
})
export type ProgramVerification = z.infer<typeof programVerificationSchema>

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
  /** 申請期限日（YYYY-MM-DD。取得できる場合のみ。M6-B） */
  deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})
export type SupportApplication = z.infer<typeof supportApplicationSchema>

/** 未確認の項目と、その理由（M6-B） */
export const unconfirmedItemSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
})
export type UnconfirmedItem = z.infer<typeof unconfirmedItemSchema>

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
  /** 未確認の項目と理由（M6-B。missingInformation の理由付き） */
  unconfirmedItems: z.array(unconfirmedItemSchema).optional(),
  /** 制度の適用開始日（YYYY-MM-DD。取得できる場合のみ。M6-B） */
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** 制度の適用終了日（YYYY-MM-DD。取得できる場合のみ。M6-B） */
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** 対象地域（M6-C。推測で補完しない。省略時は対象地域が未整理） */
  jurisdiction: jurisdictionSchema.optional(),
  /** 年齢区分等の金額内訳（M6-C。表示・記録用。計算は amount を使用） */
  amountBands: z.array(amountBandSchema).optional(),
  /** 公式資料による確認状況（M6-C。確認済み／一部確認／未確認の区別） */
  verification: programVerificationSchema.optional(),
})
export type SupportProgram = z.infer<typeof supportProgramSchema>