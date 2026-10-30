/**
 * 表示用「説明文」の生成（M6-B・純関数）
 *
 * 責務:
 * - 制度の内容・金額・条件・確度・根拠（公式情報）の表示文言を一元的に作る
 * - 確度（確認済み/推定・要確認/未確認）を必ず金額とセットで表示する
 * - URL 未確認の出典は公式リンクとして扱わない文言にする（lib/supports/evidence.ts と連携）
 * - AI の推測とされる根拠法令名・未確認の申請期限を、確定した事実のように表示しない
 *
 * このモジュールは文言生成のみで、計算（estimate）・照合（matching）・
 * 根拠保存（evidence）には干渉しない。外部通信も行わない。
 */
import type {
  AmountBasis,
  LegalBasis,
  SupportAmount,
  SupportLevel,
  SupportPeriod,
  SupportProgram,
} from '../types/support'
import type { SupportEffect } from '../finance/supports'
import type { SupportEstimate } from './estimate'
import { latestCheckedAt, sourceDisplayEntry, hasVerifiedOfficialSource } from './evidence'
import { formatYen } from '../simulation'

export const AMOUNT_BASIS_LABELS: Record<AmountBasis, string> = {
  confirmed: '確認済み',
  estimated: '推定・要確認',
  unknown: '未確認',
}

export const UNIT_LABELS: Record<SupportAmount['unit'], string> = {
  yen_per_month: '月額',
  yen_per_year: '年額',
  yen_one_time: '一時金',
  other: '単位不明',
}

export const LEVEL_LABELS: Record<SupportLevel, string> = {
  national: '国の制度',
  tokyo: '東京都の制度',
  municipal: '自治体の制度',
  ward: '区独自の制度',
}

/** 金額の表示（未確認は「金額未確認」として確定額っぽく見せない） */
export function amountText(program: SupportProgram): string {
  const { value, unit, basis } = program.amount
  if (value === null || unit === 'other' || basis === 'unknown') {
    return '金額未確認（要確認）'
  }
  return `${formatYen(value)}（${UNIT_LABELS[unit]}）`
}

/** M7-K: 金額の確度を短く示すラベル（金額の近くに表示する） */
export const ACCURACY_LABELS = {
  confirmed: '確認済み',
  estimated: '推定・要確認',
  unknown: '金額未確認',
  capOnly: '上限額のみ確認',
  excluded: '計算対象外',
} as const

export type AccuracyKey = keyof typeof ACCURACY_LABELS

/** 金額の確度ラベル（M7-K） */
export function accuracyOf(program: SupportProgram): AccuracyKey {
  if (program.amount.capOnly === true) return 'capOnly'
  if (program.amount.basis === 'confirmed') return 'confirmed'
  if (program.amount.basis === 'estimated') return 'estimated'
  return 'unknown'
}

/**
 * 上限額のみ判明している制度の金額表示（M7-K）。
 * 上限額を実際の受給見込額と誤認させない文言にする。
 */
export function capOnlyAmountText(program: SupportProgram): string {
  const { value } = program.amount
  return value === null
    ? '金額未確認（要確認）'
    : `最大${formatYen(value)}（上限額のみ確認済み・実際の補助額は対象工事費などによって決まります）`
}

/** 金額の表示（上限額のみの制度は capOnlyAmountText に切り替える） */
export function amountDisplayText(program: SupportProgram): string {
  return program.amount.capOnly === true
    ? capOnlyAmountText(program)
    : amountText(program)
}

/** 単位別の内訳表示（月額・年額・一時金の区別を明示） */
export function unitBreakdownText(estimate: SupportEstimate): string {
  const b = estimate.unitBreakdown
  const basis = AMOUNT_BASIS_LABELS[estimate.amountBasis]
  if (b.baseAmountYen === null || b.unit === 'other' || estimate.amountBasis === 'unknown') {
    return `金額未確認（${basis}）`
  }
  const unitText = `${b.unitLabel} ${formatYen(b.baseAmountYen)}`
  if (b.unit === 'yen_per_month') {
    return `${unitText} × ${b.countedUnits}か月（${basis}）`
  }
  if (b.unit === 'yen_per_year') {
    return `${unitText} × ${b.countedUnits}年（${basis}）`
  }
  return `${unitText} × ${b.countedUnits}回（${basis}）`
}

/** 対象期間の表示 */
export function periodText(program: SupportProgram): string {
  return periodTextOf(program.period)
}

export function periodTextOf(period: SupportPeriod): string {
  const { startAgeYears, endAgeYears, durationMonths } = period
  const age =
    startAgeYears === null && endAgeYears === null
      ? '対象年齢の記載なし（要確認）'
      : `${startAgeYears ?? 0}歳〜${endAgeYears ?? '上限なし'}歳`
  const duration =
    durationMonths !== null ? `（支給期間の上限：${durationMonths}か月）` : ''
  return `${age}${duration}`
}

/** この世帯の見込額表示（計算不能・未計算を明示） */
export function estimateText(effect: SupportEffect | undefined): string {
  if (!effect) return '未計算（要確認）'
  return effect.estimatedTotalYen === null
    ? '計算不能（金額未確認）'
    : formatYen(effect.estimatedTotalYen)
}

/**
 * 根拠法令の表示。未確認の法令名は確定した事実として扱わない。
 * AI の推測名が入っている場合も、confidence が confirmed でなければ「要確認」を付す。
 */
export function legalBasisText(legalBasis: LegalBasis): {
  text: string
  needsCheck: boolean
} {
  const needsCheck = legalBasis.confidence !== 'confirmed'
  const head = legalBasis.lawName ?? '法令名は未確認'
  const ordinance =
    legalBasis.ordinanceName != null ? `／${legalBasis.ordinanceName}` : ''
  const note = legalBasis.note != null ? `（${legalBasis.note}）` : ''
  return { text: `${head}${ordinance}${note}`, needsCheck }
}

/**
 * 出典の表示。URL 未確認は公式リンクとして扱わない。
 * isLink=true のときのみ href を返し、それ以外は unverifiedText を返す。
 */
export function sourceEntryText(source: SupportProgram['sources'][number]): {
  label: string
  isLink: boolean
  href: string | null
  unverifiedText: string | null
} {
  const entry = sourceDisplayEntry(source)
  return {
    label: `${entry.title}（${entry.organization}）`,
    isLink: entry.isLink,
    href: entry.href,
    unverifiedText: entry.unverifiedText,
  }
}

/** 情報確認日の表示 */
export function checkedAtText(program: SupportProgram): string {
  return `情報の確認日：${latestCheckedAt(program) ?? '未確認'}`
}

/** 未確認の項目と理由の表示 */
export function unconfirmedItemsText(
  program: SupportProgram,
): string[] {
  return (program.unconfirmedItems ?? []).map((item) => `${item.field}: ${item.reason}`)
}

/** 見込額の要約（単位別内訳・確度・貸付注記を含む） */
export function estimateSummaryText(estimate: SupportEstimate): string {
  const parts = [unitBreakdownText(estimate)]
  if (estimate.isRepaymentRequired) {
    parts.push('貸付制度のため返済が必要です（給付とは別扱い）')
  } else if (estimate.benefitKind === 'fee_reduction') {
    parts.push('費用の減免（現金給付ではない）')
  }
  if (!estimate.countedInTotal && estimate.excludedReason !== null) {
    parts.push(estimate.excludedReason)
  }
  return parts.join('／')
}

/**
 * 確認状況バッジの文言（M6-C）。
 * 確認済みデータと未確認のモック・仮データを画面上で区別する。
 * - 'モック・未確認': モック・仮データ（既存の安全な表示を維持）
 * - '公式確認済み（一部要確認）': 公式出典で一部の項目を確認済み
 * - '公式確認済み': 記載項目を公式出典で確認済み
 * - '未確認': 公式出典で確認できていない
 */
export function verificationBadgeText(program: SupportProgram): string {
  if (program.mock) return 'モック・未確認'
  // 人手確認が未完了の制度は「確認済み」と表示しない（M7-G）
  if (program.verification?.humanConfirmed === false) {
    return 'AI確認済み・人手確認待ち'
  }
  const status = program.verification?.status
  if (status === 'official-verified') return '公式確認済み'
  if (status === 'partial' || hasVerifiedOfficialSource(program)) {
    return '公式確認済み（一部要確認）'
  }
  return '未確認'
}

/** 金額の適用年度の表示（年度が未確認なら未確認と明示する） */
export function fiscalYearLabel(
  fiscalYear: string | null | undefined,
): string {
  return fiscalYear
    ? `適用年度: ${fiscalYear}`
    : '適用年度: 未確認（要確認）'
}

/**
 * 年齢区分等の金額内訳（確認済み）の表示（M6-C）。
 * 内訳が無い制度は null を返す（表示しない）。
 */
export function amountBandsText(program: SupportProgram): string | null {
  const bands = program.amountBands ?? []
  if (bands.length === 0) return null
  const parts = bands.map((band) => {
    const amount =
      band.value === null ? '金額未確認' : `${formatYen(band.value)}（${UNIT_LABELS[band.unit]}）`
    return `${band.label}: ${amount}［${AMOUNT_BASIS_LABELS[band.basis]}・${
      band.fiscalYear ? `適用年度 ${band.fiscalYear}` : '適用年度 未確認'
    }］`
  })
  return `金額の内訳（区分別）: ${parts.join('／')}`
}
