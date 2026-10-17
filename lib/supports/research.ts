/**
 * 公式資料からの情報「抽出・整理」の正規化（M6-B・純関数）
 *
 * 【責務】
 * - 将来 AI（外部 API）が公式資料から抽出した候補データを受け取り、
 *   SupportProgram スキーマの形に整理する。本モジュール自体は API・fetch を行わない。
 * - AI の文章生成結果だけを根拠に、確定金額・根拠法令・申請期限・受給資格を確定しない。
 *   「検証済みの公式出典（urlVerified かつ official）」が裏付けとなる項目のみ
 *   confirmed 扱いにし、それ以外は推定（estimated）または未確認（unknown）に落とす。
 * - 不足している情報は null / 未確認ステータスとし、根拠のない値を補完しない。
 *
 * 【確定にできる条件】
 * - 金額: 候補の主張が confirmed かつ検証済み公式出典あり
 * - 根拠法令・条例名: 検証済み公式出典あり（AI の推測名は採用しない）
 * - 申請期限: 検証済み公式出典あり
 * - 受給資格: いかなる場合も候補から確定しない（'unconfirmed' に固定し、
 *   ユーザー条件との照合は lib/supports/matching.ts が機械的に行う）
 *
 * 【保存先の型】
 * - 出典・確認日・取得日時は lib/supports/evidence.ts のレコードで保持する
 */
import { z } from 'zod'
import {
  SUPPORT_CATEGORIES,
  SUPPORT_LEVELS,
  supportProgramSchema,
  type SupportProgram,
} from '../types/support'
import { createSourceRecord } from './evidence'

/** AI が抽出した「候補」の入力（未検証・緩い型。正規化で厳密な型に変換する） */
const researchSourceCandidateSchema = z.object({
  title: z.string().min(1),
  organization: z.string().min(1),
  /** 未検証でも候補として保持可（公式リンクとしては扱わない） */
  url: z.string().min(1).nullable().optional(),
  /**
   * URL 検証済みフラグ。AI の主張だけでは true にしないこと。
   * normalizeResearchCandidate は options.trustVerification が true の場合のみ信用する。
   */
  urlVerified: z.boolean().optional(),
  official: z.boolean().optional(),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  retrievedAt: z.string().nullable().optional(),
  /** URL・内容の照合メモ（M6-C）。検証済みフラグの根拠にはならない（記録のみ） */
  verificationNote: z.string().min(1).nullable().optional(),
})

export const researchCandidateSchema = z.object({
  name: z.string().min(1),
  summary: z.string().nullable().optional(),
  category: z.enum(SUPPORT_CATEGORIES).nullable().optional(),
  level: z.enum(SUPPORT_LEVELS).nullable().optional(),
  amount: z
    .object({
      value: z.number().nonnegative().nullable().optional(),
      unit: z
        .enum(['yen_per_month', 'yen_per_year', 'yen_one_time', 'other'])
        .nullable()
        .optional(),
      /** 候補が主張する確度（検証済み出典なしでは confirmed にしない） */
      claimedBasis: z.enum(['confirmed', 'estimated', 'unknown']).nullable().optional(),
      description: z.string().nullable().optional(),
      scope: z.enum(['per_child', 'per_household']).nullable().optional(),
    })
    .optional(),
  period: z
    .object({
      startAgeYears: z.number().nullable().optional(),
      endAgeYears: z.number().nullable().optional(),
      durationMonths: z.number().int().positive().nullable().optional(),
    })
    .optional(),
  conditions: z
    .object({
      combinedWith: z.array(z.string()).optional(),
      incomeLimitNote: z.string().nullable().optional(),
      householdNote: z.string().nullable().optional(),
      other: z.array(z.string()).optional(),
    })
    .optional(),
  application: z
    .object({
      where: z.string().nullable().optional(),
      documents: z.array(z.string()).optional(),
      deadlineNote: z.string().nullable().optional(),
      deadlineDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      steps: z.array(z.string()).optional(),
    })
    .optional(),
  legalBasis: z
    .object({
      lawName: z.string().nullable().optional(),
      ordinanceName: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
    })
    .optional(),
  sources: z.array(researchSourceCandidateSchema).min(1),
  checkedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  missingInformation: z.array(z.string()).optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  /** 候補データがモック/仮データか */
  mock: z.boolean().optional(),
})
export type ResearchCandidate = z.infer<typeof researchCandidateSchema>

export type ResearchNormalizeOptions = {
  /**
   * 出典の urlVerified を信用するか（既定: false）。
   * 将来の検証レイヤ（URL 実在確認など）を通した出典のみ true にする。
   * AI の自己申告だけでは検証済みにしない。
   */
  trustVerification?: boolean
  /** 制度 ID（候補に無い場合に採用する） */
  programId?: string
  /**
   * 出典の取得方法（既定: 'ai-extraction'）。
   * 人手の公式資料照合（M6-C）では 'manual' を指定する。
   */
  extractionMethod?: 'manual' | 'ai-extraction' | 'mock'
}

export type ResearchNormalizeResult = {
  /** 正規化された制度（スキーマ検証済み）。保存できない場合は null */
  program: SupportProgram | null
  /** 保存できなかった理由・要確認事項 */
  problems: string[]
  /** 未確認の項目と理由 */
  unconfirmedItems: Array<{ field: string; reason: string }>
}

/**
 * AI 抽出候補を SupportProgram に正規化する（純関数）。
 *
 * ルール:
 * - 制度名・確認日・出典が無ければ保存しない（推測で補完しない）
 * - 検証済み公式出典が無い場合:
 *   - 金額は confirmed にしない（値があれば estimated、無ければ unknown/null）
 *   - 根拠法令名・条例名は採用せず null（AI の推測名を表示しない）
 *   - 申請期限（note/date）は採用せず null
 * - 受給資格は常に 'unconfirmed'（AI の判定を確定扱いにしない）
 */
export function normalizeResearchCandidate(
  raw: unknown,
  options?: ResearchNormalizeOptions,
): ResearchNormalizeResult {
  const parsed = researchCandidateSchema.safeParse(raw)
  const unconfirmedItems: Array<{ field: string; reason: string }> = []
  const problems: string[] = []
  if (!parsed.success) {
    return {
      program: null,
      problems: [
        '候補データの形式が不正です（必須項目の不足・型不一致）',
        ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ],
      unconfirmedItems,
    }
  }
  const c = parsed.data

  // ── 出典の保存（URL は検証済みでなければ公式リンク扱いにしない）──
  const trust = options?.trustVerification === true
  const sources = c.sources.map((s) =>
    createSourceRecord({
      title: s.title,
      organization: s.organization,
      url: s.url ?? null,
      urlVerified: trust && s.urlVerified === true,
      official: s.official === true,
      checkedAt: s.checkedAt ?? c.checkedAt ?? '',
      retrievedAt: s.retrievedAt ?? null,
      extractionMethod: options?.extractionMethod ?? 'ai-extraction',
      verificationNote: s.verificationNote ?? null,
    }),
  )
  // 確認日が一切無い出典は落とす（根拠のない出典を保存しない）
  const validSources = sources.filter((s) => s.checkedAt !== '')
  if (validSources.length === 0) {
    problems.push('確認日（checkedAt）が不明な出典は保存できません')
    return { program: null, problems, unconfirmedItems }
  }
  const checkedAt =
    c.checkedAt ??
    validSources.reduce(
      (latest, s) => (s.checkedAt > latest ? s.checkedAt : latest),
      '',
    )

  const verifiedEvidence = validSources.some(
    (s) => s.url !== null && s.urlVerified && s.official,
  )
  if (!verifiedEvidence) {
    unconfirmedItems.push({
      field: 'sources',
      reason: '検証済みの公式出典（URL実在確認済み）がないため確定情報として扱いません',
    })
  }

  // ── 金額（未確認を確定にしない）──
  const rawValue = c.amount?.value ?? null
  const rawUnit = c.amount?.unit ?? 'other'
  let amountValue: number | null = null
  let amountUnit: 'yen_per_month' | 'yen_per_year' | 'yen_one_time' | 'other' = 'other'
  let amountBasis: 'confirmed' | 'estimated' | 'unknown' = 'unknown'
  if (rawValue === null || rawUnit === null || rawUnit === 'other') {
    amountValue = null
    amountBasis = 'unknown'
    unconfirmedItems.push({
      field: 'amount.value',
      reason: '金額が資料から確認できないため未確認（推測で補完しません）',
    })
  } else {
    amountValue = rawValue
    amountUnit = rawUnit
    if (c.amount?.claimedBasis === 'confirmed' && verifiedEvidence) {
      amountBasis = 'confirmed'
    } else {
      amountBasis = 'estimated'
      unconfirmedItems.push({
        field: 'amount.basis',
        reason:
          c.amount?.claimedBasis === 'confirmed'
            ? '確認済みと主張されていますが検証済み公式出典がないため推定扱いです'
            : '金額は推定値です（要確認）',
      })
    }
  }

  // ── 根拠法令・条例（AI 推測の名称を確定表示しない）──
  let lawName: string | null = null
  let ordinanceName: string | null = null
  let legalNote: string | null = c.legalBasis?.note ?? null
  if (c.legalBasis?.lawName != null || c.legalBasis?.ordinanceName != null) {
    if (verifiedEvidence) {
      lawName = c.legalBasis.lawName ?? null
      ordinanceName = c.legalBasis.ordinanceName ?? null
    } else {
      legalNote = '根拠法令は未確認（AI抽出候補の名称は検証済み出典がないため採用しません）'
      unconfirmedItems.push({
        field: 'legalBasis',
        reason: '根拠法令・条例名は検証済み公式出典で確認できるまで未確認',
      })
    }
  }

  // ── 申請期限（検証済み出典なしでは採用しない）──
  let deadlineNote: string | null = null
  let deadlineDate: string | null = null
  if (c.application?.deadlineNote != null || c.application?.deadlineDate != null) {
    if (verifiedEvidence) {
      deadlineNote = c.application.deadlineNote ?? null
      deadlineDate = c.application.deadlineDate ?? null
    } else {
      unconfirmedItems.push({
        field: 'application.deadline',
        reason: '申請期限は検証済み公式出典で確認できるまで未確認',
      })
    }
  }

  // ── 対象期間（不足は null のまま。推測しない）──
  const startAgeYears = c.period?.startAgeYears ?? null
  const endAgeYears = c.period?.endAgeYears ?? null
  if (startAgeYears === null && endAgeYears === null) {
    unconfirmedItems.push({
      field: 'period',
      reason: '対象年齢の記載が確認できないため未確認',
    })
  }

  const program: SupportProgram = {
    id: options?.programId ?? `research-${checkedAt}-${c.name.slice(0, 12)}`,
    name: c.name,
    category: c.category ?? 'cash_benefit',
    level: c.level ?? 'municipal',
    summary: c.summary ?? '概要は未確認（公式資料で要確認）',
    amount: {
      value: amountValue,
      unit: amountUnit,
      basis: amountBasis,
      description: c.amount?.description ?? '金額の前提は未確認（公式資料で要確認）',
      ...(c.amount?.scope != null ? { scope: c.amount.scope } : {}),
    },
    period: {
      startAgeYears,
      endAgeYears,
      durationMonths: c.period?.durationMonths ?? null,
    },
    conditions: {
      combinedWith: c.conditions?.combinedWith ?? [],
      incomeLimitNote: c.conditions?.incomeLimitNote ?? null,
      householdNote: c.conditions?.householdNote ?? null,
      other: c.conditions?.other ?? [],
    },
    application: {
      where: c.application?.where ?? null,
      documents: c.application?.documents ?? [],
      deadlineNote,
      steps: c.application?.steps ?? [],
      deadlineDate,
    },
    // 受給資格は AI の文章生成結果では確定しない
    eligibility: 'unconfirmed',
    eligibilityNote:
      'AI調査候補からの抽出。受給資格は未判定（正式な受給資格の決定ではありません）',
    legalBasis: {
      lawName,
      ordinanceName,
      note:
        legalNote ??
        (lawName === null && ordinanceName === null ? '根拠法令は未確認' : null),
      confidence: verifiedEvidence ? 'estimated' : 'unconfirmed',
    },
    sources: validSources,
    checkedAt,
    missingInformation: c.missingInformation ?? [],
    mock: c.mock ?? false,
    unconfirmedItems,
    ...(c.effectiveFrom !== undefined ? { effectiveFrom: c.effectiveFrom } : {}),
    ...(c.effectiveTo !== undefined ? { effectiveTo: c.effectiveTo } : {}),
  }

  const validated = supportProgramSchema.safeParse(program)
  if (!validated.success) {
    return {
      program: null,
      problems: [
        '正規化後のデータがスキーマ検証に失敗しました',
        ...validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ],
      unconfirmedItems,
    }
  }
  return { program: validated.data, problems, unconfirmedItems }
}
