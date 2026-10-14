/**
 * 子育て費用の静的コストマスタ（M1〜M2）
 *
 * 【金額の確度】
 * - basis: 'reference' … 公式資料のWebページで数値を直接確認済み（S3のみ）
 * - basis: 'assumed'   … 仮定値（要確認）。ページは確認済みでも数値が未抽出の
 *   もの・一次確認が未了のものはこのまま仮定値として扱い、確定表示しない。
 *
 * 【二重計上の防止】
 * - 費用は category で「生活費(living)」「学習費(education=幼稚園〜高校)」
 *   「大学学費(university)」「入学料(entrance)」を分離する。
 * - (stage, course, category) ごとにエントリは1つだけ（validateCostMaster で検証）。
 * - S2（成育医療研究センター）は生活費・教育費の合計調査で本文に年齢別の
 *   内訳数値がないため、費用エントリの根拠には用いず、整合チェック用の
 *   ベンチマーク（COST_BENCHMARKS）としてのみ保持する（年額への加算はしない）。
 *
 * 【期間の表現】
 * - 「0〜22歳」= 年齢ラベル 0,1,…,22（23個）。うち費用計上は 0〜21歳。
 * - 「22年分」= 費用計上の年数（3年+3年+6年+3年+3年+4年=22年）。
 */
import type {
  EducationCourse,
  Stage,
  UniversityCourse,
} from '../types/finance'

/** 費用の種別（出典の対象範囲と一致させる） */
export type CostCategory = 'living' | 'education' | 'university' | 'entrance'

/** 根拠資料 */
export type CostSourceInfo = {
  title: string
  organization: string
  /** 未確認は null（UI では「URL要確認」と表示する） */
  url: string | null
  urlVerified: boolean
  surveyYear: string
  /** 調査の対象範囲・定義 */
  scope: string
}

export type CostEntry = {
  id: string
  label: string
  stage: Stage
  /** 'common' は全コース共通。大学のみ national/public/private を区別 */
  course: 'common' | EducationCourse | UniversityCourse
  category: CostCategory
  /** 年額（category が 'entrance' の場合は一時金） */
  amountYen: number
  basis: 'reference' | 'assumed'
  source: CostSourceInfo | null
  note: string | null
}

/**
 * 根拠資料
 * S1: 幼稚園〜高校の学習費（学習費総額の年額）。金額は掲載PDFのため未抽出＝要確認
 * S2: 0歳〜高校3年生の年間費用（生活費＋教育費の合計）。合計値のみ確認済み。公的統計ではない
 * S3: 私立大学の学生納付金（内訳をWebページで確認済み）
 * S4: 国立大学標準額。URL未確認。大学ごとの実額とは異なる
 */
const SRC_GAKUSHUHI: CostSourceInfo = {
  title: '令和5年度子供の学習費調査（結果の概要）',
  organization: '文部科学省',
  url: 'https://www.mext.go.jp/b_menu/toukei/chousa03/gakushuuhi/kekka/k_detail/mext_00002.html',
  urlVerified: true,
  surveyYear: '令和5年度調査（公表 令和6年12月25日／訂正版差替 令和8年1月16日）',
  scope:
    '在園児・在学者1人あたりの学習費総額の年額（学校教育費＋給食費＋学校外活動費）。大学の学費・一般的な生活費は含まない。数値は掲載PDF（訂正版）に記載のため未抽出',
}
const SRC_NCCHD: CostSourceInfo = {
  title: '0歳～高校3年生の子育てにかかる年間費用の調査結果（プレスリリース）',
  organization: '国立成育医療研究センター',
  url: 'https://www.ncchd.go.jp/press/2025/1016.html',
  urlVerified: true,
  surveyYear:
    '2024年11月ウェブアンケート調査（日本公衆衛生雑誌2025年10月掲載・DOI:10.11236/jph.25-023）',
  scope:
    '第一子0歳〜18歳（出生〜高校3年生）の年間費用（生活費・教育費等を含む合計）。大学費用は対象外。ウェブ調査研究であり政府の公的統計ではない。年齢・学年別の内訳は図1にあり本文から未抽出',
}
const SRC_DAIGAKU_PRIVATE: CostSourceInfo = {
  title: '私立大学等の令和7年度入学者に係る学生納付金等調査結果',
  organization: '文部科学省',
  url: 'https://www.mext.go.jp/a_menu/koutou/shinkou/07021403/1412031_00006.htm',
  urlVerified: true,
  surveyYear: '令和7年度入学者（隔年実施・前回令和5年度）',
  scope:
    '私立大学（学部）592大学の初年度学生納付金平均（授業料・入学料・施設設備費・実験実習料・その他）。初年度総額を2年目以降の年額には使用しない',
}
const SRC_DAIGAKU_NATIONAL: CostSourceInfo = {
  title: '国立大学等の授業料その他の費用の額（標準額）',
  organization: '文部科学省',
  url: null,
  urlVerified: false,
  surveyYear: '平成25年度以降の標準額（要確認）',
  scope:
    '国立大学の標準額（授業料535,800円/年・入学料282,000円）の想定。大学ごとに実額は異なる。公立大学は別区分（公立大学の標準額・地域内外の別額は要確認）',
}

const NOTE_ASSUMED =
  '仮定値（要確認）：一次資料での数値確認後に差し替え。確定情報として扱わない'
const NOTE_ASSUMED_GAKUSHUHI = `${NOTE_ASSUMED}（S1の数値は掲載PDFにあり未抽出。学習費総額＝学校教育費＋給食費＋学校外活動費の年額）`
const NOTE_ASSUMED_LIVING = `${NOTE_ASSUMED}（S2は生活費・教育費の合計調査で生活費単独の内訳が確認できないため根拠資料なしの仮定値。S2の合計値は COST_BENCHMARKS で整合チェックのみに使用し二重計上しない）`

/**
 * コストマスタ（すべて仮定値）
 * 計算方法：各段階の年額 × 在籍年数。大学入学時に入学料を一時加算。
 */
export const COST_MASTER: CostEntry[] = [
  // ── 生活費（子供1人あたり追加分・年額。出典未確認のため根拠資料なしの仮定値） ──
  {
    id: 'living-infant',
    label: '生活費（0〜2歳）',
    stage: 'infant',
    course: 'common',
    category: 'living',
    amountYen: 400_000,
    basis: 'assumed',
    source: null,
    note: NOTE_ASSUMED_LIVING,
  },
  {
    id: 'living-preschool',
    label: '生活費（3〜5歳）',
    stage: 'preschool',
    course: 'common',
    category: 'living',
    amountYen: 420_000,
    basis: 'assumed',
    source: null,
    note: NOTE_ASSUMED_LIVING,
  },
  {
    id: 'living-elementary',
    label: '生活費（小学生）',
    stage: 'elementary',
    course: 'common',
    category: 'living',
    amountYen: 550_000,
    basis: 'assumed',
    source: null,
    note: NOTE_ASSUMED_LIVING,
  },
  {
    id: 'living-junior',
    label: '生活費（中学生）',
    stage: 'junior_high',
    course: 'common',
    category: 'living',
    amountYen: 650_000,
    basis: 'assumed',
    source: null,
    note: NOTE_ASSUMED_LIVING,
  },
  {
    id: 'living-high',
    label: '生活費（高校生）',
    stage: 'high_school',
    course: 'common',
    category: 'living',
    amountYen: 750_000,
    basis: 'assumed',
    source: null,
    note: NOTE_ASSUMED_LIVING,
  },
  {
    id: 'living-university',
    label: '生活費（大学生）',
    stage: 'university',
    course: 'common',
    category: 'living',
    amountYen: 900_000,
    basis: 'assumed',
    source: null,
    note: `${NOTE_ASSUMED_LIVING}（自宅通学前提。自宅外通学はより高額になる想定）`,
  },
  // ── 学習費（S1: 幼稚園〜高校の学習費総額・年額。大学学費・生活費とは別項目） ──
  {
    id: 'edu-infant',
    label: '教育・保育費（0〜2歳）',
    stage: 'infant',
    course: 'common',
    category: 'education',
    amountYen: 120_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: `${NOTE_ASSUMED_GAKUSHUHI}（保育料は世帯所得と自治体により変動）`,
  },
  {
    id: 'edu-preschool-public',
    label: '教育・保育費（3〜5歳・公立）',
    stage: 'preschool',
    course: 'public',
    category: 'education',
    amountYen: 50_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: `${NOTE_ASSUMED_GAKUSHUHI}（幼児教育・保育の無償化を前提とした実費相当）`,
  },
  {
    id: 'edu-preschool-private',
    label: '教育・保育費（3〜5歳・私立）',
    stage: 'preschool',
    course: 'private',
    category: 'education',
    amountYen: 450_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: `${NOTE_ASSUMED_GAKUSHUHI}（無償化の対象外費用（上乗せ保育料等）を含む想定）`,
  },
  {
    id: 'edu-elementary-public',
    label: '学習費（小学生・公立）',
    stage: 'elementary',
    course: 'public',
    category: 'education',
    amountYen: 320_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  {
    id: 'edu-elementary-private',
    label: '学習費（小学生・私立）',
    stage: 'elementary',
    course: 'private',
    category: 'education',
    amountYen: 1_500_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  {
    id: 'edu-junior-public',
    label: '学習費（中学生・公立）',
    stage: 'junior_high',
    course: 'public',
    category: 'education',
    amountYen: 480_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  {
    id: 'edu-junior-private',
    label: '学習費（中学生・私立）',
    stage: 'junior_high',
    course: 'private',
    category: 'education',
    amountYen: 1_350_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  {
    id: 'edu-high-public',
    label: '学習費（高校生・公立）',
    stage: 'high_school',
    course: 'public',
    category: 'education',
    amountYen: 450_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  {
    id: 'edu-high-private',
    label: '学習費（高校生・私立）',
    stage: 'high_school',
    course: 'private',
    category: 'education',
    amountYen: 1_050_000,
    basis: 'assumed',
    source: SRC_GAKUSHUHI,
    note: NOTE_ASSUMED_GAKUSHUHI,
  },
  // ── 大学の学費（S3/S4。S3は「初年度納付金」ではなく2年目以降も続く年額項目のみを加算） ──
  {
    id: 'uni-tuition-national',
    label: '学費（大学・国立／標準額）',
    stage: 'university',
    course: 'national',
    category: 'university',
    amountYen: 535_800,
    basis: 'assumed',
    source: SRC_DAIGAKU_NATIONAL,
    note: `${NOTE_ASSUMED}（標準額。大学ごとに実額は異なる）`,
  },
  {
    id: 'uni-tuition-public',
    label: '学費（大学・公立／標準額相当）',
    stage: 'university',
    course: 'public',
    category: 'university',
    amountYen: 535_800,
    basis: 'assumed',
    source: SRC_DAIGAKU_NATIONAL,
    note: `${NOTE_ASSUMED}（公立大学は国立大学と別区分。標準額相当の仮定値。実額は要確認）`,
  },
  {
    id: 'uni-tuition-private',
    label: '学費（大学・私立／2年目以降の年額）',
    stage: 'university',
    course: 'private',
    category: 'university',
    amountYen: 1_267_283,
    basis: 'reference',
    source: SRC_DAIGAKU_PRIVATE,
    note:
      'S3確認値：授業料968,069＋施設設備費172,550＋実験実習料30,290＋その他96,374＝1,267,283円/年。初年度納付金総額1,507,647円は2年目以降の年額として使用しない。文系/理系・昼夜間別の内訳は未確認',
  },
  // ── 入学料（一時金） ──
  {
    id: 'entrance-university-national',
    label: '入学料（大学・国立／標準額）',
    stage: 'university',
    course: 'national',
    category: 'entrance',
    amountYen: 282_000,
    basis: 'assumed',
    source: SRC_DAIGAKU_NATIONAL,
    note: `${NOTE_ASSUMED}（標準額。大学ごとに実額は異なる）`,
  },
  {
    id: 'entrance-university-public',
    label: '入学料（大学・公立）',
    stage: 'university',
    course: 'public',
    category: 'entrance',
    amountYen: 282_000,
    basis: 'assumed',
    source: SRC_DAIGAKU_NATIONAL,
    note: `${NOTE_ASSUMED}（公立大学は国立大学と別区分。地域内・地域外で異なる場合あり＝要確認）`,
  },
  {
    id: 'entrance-university-private',
    label: '入学料（大学・私立）',
    stage: 'university',
    course: 'private',
    category: 'entrance',
    amountYen: 240_365,
    basis: 'reference',
    source: SRC_DAIGAKU_PRIVATE,
    note:
      'S3確認値：入学料の平均240,365円（令和7年度入学者の初年度納付金の内訳）。文系/理系別の内訳は未確認',
  },
]
/**
 * 年齢（歳）→ 教育段階。22歳以降は養育費の対象外
 * 年齢ラベルの範囲: infant=0〜2 / preschool=3〜5 / elementary=6〜11 /
 * junior_high=12〜14 / high_school=15〜17 / university=18〜21 / after_university=22
 */
export function stageForAge(ageYears: number): Stage {
  if (ageYears < 3) return 'infant'
  if (ageYears < 6) return 'preschool'
  if (ageYears < 12) return 'elementary'
  if (ageYears < 15) return 'junior_high'
  if (ageYears < 18) return 'high_school'
  if (ageYears < 22) return 'university'
  return 'after_university'
}

/**
 * 教育段階ごとの年数（費用計上の年数）。
 * 合計 22年（0〜21歳）。「0〜22歳」の年齢ラベル23個とは区別する。
 */
export const STAGE_YEARS: Record<Exclude<Stage, 'after_university'>, number> = {
  infant: 3, // 0,1,2歳
  preschool: 3, // 3,4,5歳
  elementary: 6, // 6〜11歳
  junior_high: 3, // 12〜14歳
  high_school: 3, // 15〜17歳
  university: 4, // 18〜21歳
}

/** コース指定（学校段階と大学は区分が異なる） */
export type CourseSelection = {
  school: EducationCourse
  university: UniversityCourse
}

export type ChildAnnualCost = {
  livingYen: number
  /** 幼稚園〜高校の学習費（S1） */
  educationYen: number
  /** 大学の学費（S3/S4） */
  universityYen: number
  totalYen: number
  entries: CostEntry[]
}

/** ある段階・コースの年額費用（生活費＋学習費 or 大学学費） */
export function annualChildCosts(
  stage: Stage,
  course: CourseSelection,
): ChildAnnualCost {
  const wanted = stage === 'university' ? course.university : course.school
  const entries = COST_MASTER.filter(
    (e) =>
      e.stage === stage &&
      (e.category === 'living' ||
        (stage === 'university' && e.category === 'university') ||
        (stage !== 'university' && e.category === 'education')) &&
      (e.course === 'common' || e.course === wanted),
  )
  const sum = (category: CostCategory) =>
    entries
      .filter((e) => e.category === category)
      .reduce((s, e) => s + e.amountYen, 0)
  const livingYen = sum('living')
  const educationYen = sum('education')
  const universityYen = sum('university')
  return {
    livingYen,
    educationYen,
    universityYen,
    totalYen: livingYen + educationYen + universityYen,
    entries,
  }
}

/** その段階の開始時にかかる一時金（大学入学料のみ） */
export function entranceCostYen(
  stage: Stage,
  course: CourseSelection,
): number {
  const wanted = stage === 'university' ? course.university : course.school
  return COST_MASTER.filter(
    (e) =>
      e.category === 'entrance' &&
      e.stage === stage &&
      (e.course === 'common' || e.course === wanted),
  ).reduce((sum, e) => sum + e.amountYen, 0)
}

/**
 * コストマスタの整合検証（二重計上の防止）
 * - (stage, course, category) は一意であること
 * - category と stage の対応が正しいこと
 * - basis: 'reference' は出典確認済みであること
 */
export function validateCostMaster(): string[] {
  const issues: string[] = []
  const keys = new Set<string>()
  for (const e of COST_MASTER) {
    const key = `${e.stage}|${e.course}|${e.category}`
    if (keys.has(key)) issues.push(`重複エントリ（二重計上の恐れ）: ${key} (${e.id})`)
    keys.add(key)
    if (e.amountYen < 0) issues.push(`金額が負: ${e.id}`)
    if (e.basis === 'reference' && (!e.source || !e.source.urlVerified)) {
      issues.push(`basis=reference だが出典未確認: ${e.id}`)
    }
    if (e.category === 'education' && e.stage === 'university') {
      issues.push(`education は幼稚園〜高校専用（大学は university）: ${e.id}`)
    }
    if (e.category === 'university' && e.stage !== 'university') {
      issues.push(`university は大学専用: ${e.id}`)
    }
    if (e.category === 'entrance' && e.stage !== 'university') {
      issues.push(`entrance は大学専用: ${e.id}`)
    }
    if (e.course === 'national' && e.stage !== 'university') {
      issues.push(`national 区分は大学専用: ${e.id}`)
    }
  }
  return issues
}

export type LifetimeCostBreakdown = {
  livingYen: number
  educationYen: number
  universityYen: number
  entranceYen: number
  totalYen: number
  /** 費用計上の年数（0〜21歳の22年分） */
  costYears: number
}

/**
 * 出生から22歳までの子費用累計（クローズドフォーム）
 * 各段階の年額 × STAGE_YEARS + 入学料。エンジン（projectCashflow）の
 * 累計と一致することを verify-m1 で検証している。
 */
export function lifetimeCostBreakdown(
  course: CourseSelection,
): LifetimeCostBreakdown {
  let livingYen = 0
  let educationYen = 0
  let universityYen = 0
  let costYears = 0
  for (const stage of Object.keys(STAGE_YEARS) as (keyof typeof STAGE_YEARS)[]) {
    const years = STAGE_YEARS[stage]
    const annual = annualChildCosts(stage, course)
    livingYen += annual.livingYen * years
    educationYen += annual.educationYen * years
    universityYen += annual.universityYen * years
    costYears += years
  }
  const entranceYen = entranceCostYen('university', course)
  return {
    livingYen,
    educationYen,
    universityYen,
    entranceYen,
    costYears,
    totalYen: livingYen + educationYen + universityYen + entranceYen,
  }
}

/**
 * 整合チェック用ベンチマーク（S2）。
 * 費用の年額には加算しない（S2は生活費＋教育費の合計調査のため二重計上になる）。
 */
export type CostBenchmark = {
  id: string
  label: string
  /** 単一値が確認できないものは null */
  amountYen: number | null
  note: string
  source: CostSourceInfo
}
export const COST_BENCHMARKS: CostBenchmark[] = [
  {
    id: 's2-total-18y',
    label: '第一子 0歳〜高校3年生（18年間）の子育て費用合計',
    amountYen: 21_727_154,
    note: 'S2確認値：預貯金・保険を含まない場合（含む場合は25,701,956円）。生活費・教育費等を含む合計。大学費用は対象外',
    source: SRC_NCCHD,
  },
  {
    id: 's2-total-15y',
    label: '第一子 0歳〜中学3年生（15年間）の子育て費用合計',
    amountYen: 16_323_898,
    note: 'S2確認値：預貯金・保険を含まない場合（含む場合は19,530,626円）',
    source: SRC_NCCHD,
  },
  {
    id: 's2-high-living',
    label: '高校生の生活費（年額の目安）',
    amountYen: null,
    note: 'S2確認値：世帯収入によらず年間70〜100万円程度（レンジ。単一値は本文に記載なし）',
    source: SRC_NCCHD,
  },
]

/** 金額を「1,234,567円」の形式に整形する */
export function formatYen(amount: number): string {
  return `${Math.round(amount).toLocaleString('ja-JP')}円`
}