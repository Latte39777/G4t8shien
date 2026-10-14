/**
 * 養育費・公的支援シミュレーター 用の型定義・モックデータ・計算ロジック
 * ※ 公的支援額はプロトタイプ用のモックであり、実際の制度・支給額とは異なります。
 */

import type { ChildInput, FamilyPlan } from "./types/finance";

/**
 * 現在の状況：すでに子どもがいる / これから子どもを持つ予定 / 未定
 */
export const PLAN_STATUSES = ["have", "planning", "undecided"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 子ども1行の種別：現在の子 / 将来生まれる予定の子 */
export type ChildRowKind = "existing" | "planned";

/**
 * 子ども1人分の入力行（M3）。
 *
 * - 年齢は「満年齢の整数（歳）」に統一する（生年月日は使わない）。
 *   既存の ChildInput.currentAgeYears / birthInYears と同じ意味・同じ形式。
 * - 現在の子（existing）: ageYears（0〜22歳の整数）
 * - 予定の子（planned）: birthInYears（あと N 年後に生まれる。0〜10。未定は null）
 */
export type ChildRow = {
  id: string;
  kind: ChildRowKind;
  /** 現在の年齢（歳・0〜22の整数）。kind="existing" のとき必須 */
  ageYears: number | null;
  /** あと N 年後に生まれる子。kind="planned" のとき。未定は null */
  birthInYears: number | null;
};

/** 受給条件の確認用・世帯年収の金額帯（詳細金額が未入力でも選べる） */
export const INCOME_BANDS = [
  { id: "lt300", label: "〜300万円" },
  { id: "300to500", label: "300万円 〜 500万円未満" },
  { id: "500to800", label: "500万円 〜 800万円未満" },
  { id: "800to1000", label: "800万円 〜 1,000万円未満" },
  { id: "gte1000", label: "1,000万円以上" },
  { id: "unspecified", label: "未定・未入力" },
] as const;
export type IncomeBandId = (typeof INCOME_BANDS)[number]["id"];

/** 第一子の出産予定時期（子ども0人のときの任意入力。未定でも先に進める） */
export const BIRTH_TIMINGS = [
  { id: "within1", label: "1年以内" },
  { id: "in1to2", label: "1〜2年後" },
  { id: "in3to5", label: "3〜5年後" },
  { id: "after5", label: "5年以降" },
  { id: "undecided", label: "未定" },
] as const;
export type BirthTiming = (typeof BIRTH_TIMINGS)[number]["id"];

/** 出産後の働き方・収入変化 */
export const WORK_AFTER_BIRTH_OPTIONS = [
  { id: "unchanged", label: "変わらない" },
  { id: "parental_leave", label: "育児休業中は収入が減る" },
  { id: "part_time", label: "時短勤務などに変わる" },
  { id: "quit", label: "退職する" },
  { id: "undecided", label: "未定" },
] as const;
export type WorkAfterBirth = (typeof WORK_AFTER_BIRTH_OPTIONS)[number]["id"];

/** 家計・生活情報（M3）。多くの項目は任意で、未入力は null のまま保持し推測しない */
export type HouseholdInput = {
  /**
   * 世帯年収（円）。受給条件（所得制限など）の確認用。
   * 月の手取り収入とは区別する。未入力は null。
   */
  annualIncomeYen: number | null;
  /** 世帯年収の金額帯（受給条件の確認用）。未選択は null */
  incomeBand: IncomeBandId | null;
  /**
   * 月の手取り収入（円）。家計収支の計算用。世帯年収とは区別する。
   * 未入力は null。
   */
  monthlyTakeHomeYen: number | null;
  /** 月々の生活費（円・子供を除く世帯の月間生活費）。未入力は null */
  monthlyLivingExpenseYen: number | null;
  /** 家賃・住宅ローン（円/月）。未入力は null */
  monthlyHousingCostYen: number | null;
  /** 居住地・自治体（例：東京都世田谷区）。未入力・未定は null */
  municipality: string | null;
  /** 世帯構成。未選択は null */
  householdType: "single" | "couple" | "other" | null;
  /** 教育方針（幼稚園〜高校）。未選択は null */
  schoolCourse: "public" | "private" | null;
  /** 大学の区分（学校段階の教育方針とは別に指定）。未選択は null */
  universityCourse: "national" | "public" | "private" | null;
  /** 出産後の働き方・収入変化。未選択は null */
  workAfterBirth: WorkAfterBirth | null;
  /** 現在利用している支援制度（制度ID）。支給見込みの重複防止に使用 */
  usedSupportProgramIds: string[];
};

export type SimulationInput = {
  /** 子どもの合計人数（現在＋予定＝children の件数。0人でも可） */
  childCount: number;
  /** 現在の貯蓄額（円） */
  savings: number;
  /** 目標とする養育資金額（円） */
  targetAmount: number;

  /** 現在の状況（未選択は null） */
  planStatus: PlanStatus | null;
  /** 子ども一人ひとり（現在の子・予定の子を区別して保持） */
  children: ChildRow[];
  /**
   * 子ども0人のときの希望人数（任意・未定でも進める）。
   * 「4人以上」を選ぶと 4 が入る（4以上の意味）。
   */
  desiredChildCount: number | null;
  /** 子ども0人のときの第一子の出産予定時期（任意・未定でも進める） */
  firstBirthTiming: BirthTiming | null;

  /** 家計・生活情報 */
  household: HouseholdInput;
};

export type SupportProgram = {
  id: string;
  /** 支援制度名 */
  name: string;
  /** 制度の説明（モック） */
  description: string;
  /** 見込額（円） */
  amount: number;
};

/**
 * テスト用のサンプルデータ（ワンクリック自動入力に使用）
 * 例：「第1子：8歳、第2子：3歳」＋家計情報
 */
export const SAMPLE_INPUT: SimulationInput = {
  childCount: 2,
  savings: 5_000_000,
  targetAmount: 20_000_000,
  planStatus: "have",
  children: [
    { id: "child-1", kind: "existing", ageYears: 8, birthInYears: null },
    { id: "child-2", kind: "existing", ageYears: 3, birthInYears: null },
  ],
  desiredChildCount: null,
  firstBirthTiming: null,
  household: {
    annualIncomeYen: 6_000_000,
    incomeBand: "500to800",
    monthlyTakeHomeYen: 350_000,
    monthlyLivingExpenseYen: 220_000,
    monthlyHousingCostYen: 90_000,
    municipality: "東京都世田谷区",
    householdType: "couple",
    schoolCourse: "public",
    universityCourse: "national",
    workAfterBirth: "parental_leave",
    usedSupportProgramIds: ["mock-child-allowance"],
  },
};

/**
 * 子供の人数に応じた公的支援額（モック）を返す
 */
export function calculateSupport(childCount: number): SupportProgram[] {
  return [
    {
      id: "jidoteate",
      name: "児童手当",
      description: "0歳〜中学生修了まで（月10,000円 × 12ヶ月 × 15年）",
      amount: 10_000 * 12 * 15 * childCount,
    },
    {
      id: "kosodate-ouenkin",
      name: "自治体の子育て応援金",
      description: "出生・進学時などに支給される一時金（見込）",
      amount: 500_000 * childCount,
    },
    {
      id: "shogaku-kyufukin",
      name: "高校生等奨学給付金",
      description: "高校在学中の学費支援（3年間の見込）",
      amount: 300_000 * childCount,
    },
    {
      id: "iryouhi-jojo",
      name: "乳幼児医療費助成",
      description: "医療費の自己負担分に対する助成（見込）",
      amount: 250_000 * childCount,
    },
  ];
}

/**
 * 入力値とモックの公的支援額からシミュレーション結果を計算する
 */
export function calculateSimulation(input: SimulationInput) {
  const supportPrograms = calculateSupport(input.childCount);
  const supportTotal = supportPrograms.reduce((sum, program) => sum + program.amount, 0);
  const covered = input.savings + supportTotal;
  const shortfall = Math.max(input.targetAmount - covered, 0);
  const coverageRate =
    input.targetAmount > 0 ? (covered / input.targetAmount) * 100 : 0;

  return { supportPrograms, supportTotal, covered, shortfall, coverageRate };
}

/** 金額を「1,234,567円」の形式に整形する */
export function formatYen(amount: number): string {
  return `${Math.round(amount).toLocaleString("ja-JP")}円`;
}

/**
 * 出産後の働き方・収入変化を手取り収入の係数に変換するための仮定値（M4・要確認）。
 *
 * 【重要】これらは公式根拠を確認していない仮定値であり、確定情報として扱わない。
 * - parental_leave: 育児休業中の手取り減を「1年間 × 0.6」と単純化した仮定
 * - part_time: 時短勤務への転換を「小学校入学までの6年間 × 0.75」とした仮定
 * - quit: 就労収入がなくなる期間を「小学校入学までの6年間 × 0」とした仮定
 *   （小学校入学後の復職は未定のため、以降は元の手取りに戻る想定）
 * - unchanged / undecided / 未選択: 収入変化なしとして計算（要確認）
 *
 * 適用タイミング: 「出産後の」変化なので、これから生まれる予定の子の出生年から
 * 適用する。すでに子どもがいる場合は、現在の手取りが変化後の金額を反映済みと
 * みなして追加の減額を行わない（二重減額の防止。要確認）。
 */
export const WORK_INCOME_CHANGE_RULES: Record<
  WorkAfterBirth,
  { multiplier: number; durationYears: number | null } | null
> = {
  unchanged: null,
  parental_leave: { multiplier: 0.6, durationYears: 1 },
  part_time: { multiplier: 0.75, durationYears: 6 },
  quit: { multiplier: 0, durationYears: 6 },
  undecided: null,
};

/** 働き方の選択から FamilyPlan.incomeChange を組み立てる（純関数） */
export function computeIncomeChange(
  input: SimulationInput,
): { fromYearOffset: number; multiplier: number; durationYears: number | null } | null {
  const work = input.household.workAfterBirth;
  if (work === null) return null;
  const rule = WORK_INCOME_CHANGE_RULES[work];
  if (rule === null) return null;
  const plannedBirths = input.children
    .filter((r) => r.kind === "planned" && r.birthInYears !== null)
    .map((r) => r.birthInYears as number);
  if (plannedBirths.length === 0) return null;
  return {
    fromYearOffset: Math.min(...plannedBirths),
    multiplier: rule.multiplier,
    durationYears: rule.durationYears,
  };
}

/**
 * フォーム入力（SimulationInput）を計算エンジンの FamilyPlan に変換する（純関数・M3、M4拡張）。
 *
 * 変換ルール（「推測しない」方針。やむを得ない既定値は明示）:
 * - 年齢は「満年齢の整数」を ChildInput.currentAgeYears にそのまま渡す（意味の変更なし）
 * - 予定の子で出産予定時期が未定（birthInYears=null）の行は、ChildInput の条件
 *   （currentAgeYears か birthInYears が必要）を満たさないため計算対象から除外し、
 *   フォーム入力（children）には残す
 * - 教育方針が未選択のときは ChildInput の既定値に合わせ schoolCourse="public" /
 *   universityCourse="national" で暫定計算する（要確認。フォーム側の未選択表示は保持）
 * - 世帯構成が未選択のときは FamilyPlan の必須フィールドのため "other" を暫定適用（要確認）
 * - 月々の生活費が未入力のときは 0 円で計算する（エンジン必須フィールドのため。要確認）。
 *   ただし住居費（家賃・住宅ローン）が入力されている場合は、住居費を固定支出として
 *   月間生活費に代用する（0円回避。要確認）。生活費が入力済みの場合、住居費は
 *   「生活費に含まれる前提」として加算しない（二重計上の防止）。
 * - 世帯年収（受給条件用）は annualIncome に渡す。家計収支の収入には使わない。
 *   収入は monthlyTakeHomeYen（月の手取り）× 12 を cashflow.ts で使用する（M4変更・承認済み）。
 * - 出産後の働き方（workAfterBirth）は WORK_INCOME_CHANGE_RULES の仮定値で
 *   incomeChange に変換する（予定の子の出生年から適用。要確認）。
 */
export function toFamilyPlan(input: SimulationInput): FamilyPlan {
  const policy = input.household;
  const children: ChildInput[] = [];
  for (const row of input.children) {
    if (row.kind === "existing" && row.ageYears !== null) {
      children.push({
        id: row.id,
        currentAgeYears: row.ageYears,
        birthInYears: null,
        course: policy.schoolCourse ?? "public",
        universityCourse: policy.universityCourse ?? "national",
      });
    } else if (row.kind === "planned" && row.birthInYears !== null) {
      children.push({
        id: row.id,
        currentAgeYears: null,
        birthInYears: row.birthInYears,
        course: policy.schoolCourse ?? "public",
        universityCourse: policy.universityCourse ?? "national",
      });
    }
  }
  return {
    municipality: policy.municipality ?? "未定",
    householdType: policy.householdType ?? "other",
    annualIncome: policy.annualIncomeYen,
    // 二重計上防止：生活費が入力済みなら住居費は「生活費に含む」前提で加算しない。
    // 生活費未入力・住居費入力ありの場合は住居費を固定支出として代用する（要確認）。
    monthlyBaseExpense:
      policy.monthlyLivingExpenseYen ??
      policy.monthlyHousingCostYen ??
      0,
    savings: input.savings,
    children,
    monthlyTakeHomeYen: policy.monthlyTakeHomeYen,
    incomeChange: computeIncomeChange(input),
  };
}
