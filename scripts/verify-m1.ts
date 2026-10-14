/**
 * M1 検証スクリプト：計算エンジンの数値スポットチェックと zod スキーマ検証
 * 実行: npx tsx scripts/verify-m1.ts
 */
import {
  annualChildCosts,
  entranceCostYen,
  lifetimeCostBreakdown,
  stageForAge,
  validateCostMaster,
} from "../lib/finance/costs";
import type { CourseSelection } from "../lib/finance/costs";
import {
  childAgeAt,
  projectCashflow,
  projectionHorizon,
} from "../lib/finance/cashflow";
import { calculateSupportEffects } from "../lib/finance/supports";
import { supportProgramSchema } from "../lib/types/support";
import type { SupportProgram } from "../lib/types/support";
import type { FamilyPlan } from "../lib/types/finance";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.error(`NG: ${name}`);
  }
}

// ── stageForAge ──
check("stageForAge(0) = infant", stageForAge(0) === "infant");
check("stageForAge(2) = infant", stageForAge(2) === "infant");
check("stageForAge(3) = preschool", stageForAge(3) === "preschool");
check("stageForAge(11) = elementary", stageForAge(11) === "elementary");
check("stageForAge(12) = junior_high", stageForAge(12) === "junior_high");
check("stageForAge(15) = high_school", stageForAge(15) === "high_school");
check("stageForAge(18) = university", stageForAge(18) === "university");
check(
  "stageForAge(22) = after_university",
  stageForAge(22) === "after_university",
);

// ── costs ──
const COURSE_PUB_NAT: CourseSelection = { school: "public", university: "national" };
const COURSE_PRI_PRI: CourseSelection = { school: "private", university: "private" };
const elemPublic = annualChildCosts("elementary", COURSE_PUB_NAT);
check("elementary/public 年額 = 550k+320k", elemPublic.totalYen === 870_000);
const uniPrivate = annualChildCosts("university", COURSE_PRI_PRI);
check(
  "university/private 年額 = 900k+1,267,283（S3確認値の2年目以降年額）",
  uniPrivate.totalYen === 2_167_283,
);
check(
  "university/national 入学料 = 282k",
  entranceCostYen("university", COURSE_PUB_NAT) === 282_000,
);
check(
  "university/private 入学料 = 240,365（S3確認値）",
  entranceCostYen("university", COURSE_PRI_PRI) === 240_365,
);

// ── cashflow: 5歳1人（公立） ──
const planA: FamilyPlan = {
  municipality: "東京都",
  householdType: "couple",
  annualIncome: 6_000_000,
  monthlyBaseExpense: 200_000,
  savings: 3_000_000,
  children: [
    {
      id: "c1",
      currentAgeYears: 5,
      birthInYears: null,
      course: "public",
      universityCourse: "national",
    },
  ],
};
check("horizon(5歳) = 17", projectionHorizon(planA) === 17);
const projA = projectCashflow(planA);
check("rows = 18（5〜22歳）", projA.rows.length === 18);
check(
  "row0 の子費用 = 470k（5歳は preschool）",
  projA.rows[0].childCostTotalYen === 470_000,
);
const row13 = projA.rows[13]; // 13年後 = 18歳
check("18歳の年に大学入学料 282k", row13.children[0].oneTimeYen === 282_000);
check(
  "18歳の年費用 = 900k+535.8k+282k",
  row13.childCostTotalYen === 900_000 + 535_800 + 282_000,
);
check(
  "totals.childCost = 各年の合計",
  projA.totals.childCostTotalYen ===
    projA.rows.reduce((s, r) => s + r.childCostTotalYen, 0),
);
check(
  "savingsEnd = savings + 各年net",
  projA.totals.savingsEndYen ===
    3_000_000 + projA.rows.reduce((s, r) => s + r.netYen, 0),
);

// ── cashflow: 3歳（私立）＋2年後に出生予定 ──
const planB: FamilyPlan = {
  ...planA,
  children: [
    {
      id: "c1",
      currentAgeYears: 3,
      birthInYears: null,
      course: "private",
      universityCourse: "private",
    },
    {
      id: "c2",
      currentAgeYears: null,
      birthInYears: 2,
      course: "public",
      universityCourse: "national",
    },
  ],
};
check("horizon(3歳＋未出生) = 24", projectionHorizon(planB) === 24);
check("childAgeAt(c2, 1) = null", childAgeAt(planB.children[1], 1) === null);
check("childAgeAt(c2, 2) = 0", childAgeAt(planB.children[1], 2) === 0);
const projB = projectCashflow(planB);
check("rows = 25", projB.rows.length === 25);
check(
  "未出生の年の子費用 = 長子のみ",
  projB.rows[0].children[1].totalYen === 0 &&
    projB.rows[0].children[0].totalYen === 870_000,
);
// ── supports ──
function program(over: Partial<SupportProgram>): SupportProgram {
  const base: SupportProgram = {
    id: "base",
    name: "テスト制度",
    category: "cash_benefit",
    level: "national",
    summary: "テスト用の制度",
    amount: {
      value: 10_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "月10,000円",
    },
    period: { startAgeYears: 0, endAgeYears: 15, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: null,
      householdNote: null,
      other: [],
    },
    application: {
      where: "市区町村",
      documents: [],
      deadlineNote: null,
      steps: [],
    },
    eligibility: "likely",
    eligibilityNote: null,
    legalBasis: { lawName: "テスト法", ordinanceName: null, note: null },
    sources: [
      {
        title: "テスト出典",
        organization: "テスト",
        url: null,
        urlVerified: false,
        official: true,
        checkedAt: "2026-10-13",
      },
    ],
    checkedAt: "2026-10-13",
    missingInformation: [],
    mock: true,
  };
  return { ...base, ...over };
}

const basic = calculateSupportEffects(planA, [program({})]);
check(
  "児童手当モック: 5〜15歳の11年 × 120k = 1,320k",
  basic.effects[0].estimatedTotalYen === 1_320_000,
);
check(
  "推定額は estimatedTotalYen に集計",
  basic.estimatedTotalYen === 1_320_000 && basic.confirmedTotalYen === 0,
);

const unknown = calculateSupportEffects(planA, [
  program({
    id: "p-unknown",
    amount: {
      value: null,
      unit: "other",
      basis: "unknown",
      description: "未確認",
    },
  }),
]);
check(
  "金額未確認は合計対象外",
  !unknown.effects[0].includedInTotal &&
    unknown.effects[0].estimatedTotalYen === null,
);

const loan = calculateSupportEffects(planA, [
  program({ id: "p-loan", category: "loan" }),
]);
check(
  "貸付制度は合計対象外",
  !loan.effects[0].includedInTotal &&
    loan.effects[0].excludedReason === "貸付制度のため合計対象外",
);

const dup = calculateSupportEffects(planA, [
  program({ id: "pA" }),
  program({
    id: "pB",
    amount: {
      value: 20_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "月20,000円",
    },
    conditions: {
      combinedWith: ["pA"],
      incomeLimitNote: null,
      householdNote: null,
      other: [],
    },
  }),
]);
const effectA = dup.effects.find((e) => e.program.id === "pA");
const effectB = dup.effects.find((e) => e.program.id === "pB");
check(
  "併用不可ペアは金額の大きい方のみ",
  !effectA?.includedInTotal &&
    !!effectB?.includedInTotal &&
    dup.estimatedTotalYen === 2_640_000,
);

const planNoIncome: FamilyPlan = { ...planA, annualIncome: null };
const income = calculateSupportEffects(planNoIncome, [
  program({
    conditions: {
      combinedWith: [],
      incomeLimitNote: "所得制限あり",
      householdNote: null,
      other: [],
    },
  }),
]);
check(
  "収入未入力＋所得制限 → likely→possible・不足情報に世帯収入",
  income.effects[0].eligibility === "possible" &&
    income.effects[0].program.missingInformation.includes("世帯収入"),
);

const ageOut = calculateSupportEffects(planA, [
  program({
    period: { startAgeYears: 0, endAgeYears: 2, durationMonths: null },
  }),
]);
check(
  "対象年齢と重複しなければ ineligible",
  ageOut.effects[0].eligibility === "ineligible",
);

const unborn = calculateSupportEffects(planB, [program({})]);
check(
  "未出生の子の将来年齢は対象になり ineligible にしない",
  unborn.effects.some((e) => e.eligibility !== "ineligible"),
);

// ── zod スキーマ ──
check(
  "supportProgramSchema: 正常データを受理",
  supportProgramSchema.safeParse(program({})).success,
);
check(
  "supportProgramSchema: sources なしを拒否",
  !supportProgramSchema.safeParse(program({ sources: [] })).success,
);
check(
  "supportProgramSchema: 金額null＋basis unknown を受理",
  supportProgramSchema.safeParse(
    program({
      amount: {
        value: null,
        unit: "other",
        basis: "unknown",
        description: "未確認",
      },
    }),
  ).success,
);
// ── 累計監査（0歳から22歳まで。費用計上は0〜21歳の22年分） ──
// 手計算（各段階の年数: 0〜2歳=3年 / 3〜5歳=3年 / 小学校=6年 / 中学校=3年 / 高校=3年 / 大学=4年）:
//   生活費      = 40万×3 + 42万×3 + 55万×6 + 65万×3 + 75万×3 + 90万×4 = 13,560,000円
//   学習費(公立) = 12万×3 + 5万×3 + 32万×6 + 48万×3 + 45万×3           =  5,220,000円
//   大学学費(国立)= 53.58万×4                                          =  2,143,200円
//   入学料(国立) = 282,000円（18歳の年に一時計上）
//   → 公立＋国立コース累計 = 21,205,200円（2,120.52万）
//   学習費(私立) = 12万×3 + 45万×3 + 150万×6 + 135万×3 + 105万×3       = 17,910,000円
//   大学学費(私立)= 1,267,283×4（S3確認値）                            =  5,069,132円
//   入学料(私立) = 240,365円（S3確認値）
//   → 私立コース累計 = 36,779,497円
//   ※ 私立はS3確認値への差し替え前は 36,120,000円（3,612万）。値更新による差分で、
//     計算式（年数の掛け算）は同一。旧値での検証結果は報告書に記録済み。
function lifetimePlan(
  school: "public" | "private",
  university: "national" | "public" | "private",
): FamilyPlan {
  return {
    municipality: "東京都",
    householdType: "couple",
    annualIncome: 0,
    monthlyBaseExpense: 0,
    savings: 0,
    children: [
      {
        id: "c1",
        currentAgeYears: 0,
        birthInYears: null,
        course: school,
        universityCourse: university,
      },
    ],
  };
}
const auditPub = projectCashflow(lifetimePlan("public", "national"));
check(
  "監査: 公立＋国立コース0〜22歳の子費用累計 = 21,205,200円（2,120.52万）",
  auditPub.totals.childCostTotalYen === 21_205_200,
);
const auditPri = projectCashflow(lifetimePlan("private", "private"));
check(
  "監査: 私立コース0〜22歳の子費用累計 = 36,779,497円（S3確認値反映後）",
  auditPri.totals.childCostTotalYen === 36_779_497,
);
check(
  "監査: 費用計上は0〜21歳の22年分（22歳行は0円）",
  auditPub.rows.filter((r) => r.childCostTotalYen > 0).length === 22 &&
    auditPub.rows[22].childCostTotalYen === 0,
);
check(
  "監査: 大学の計上は18〜21歳の4年分",
  auditPub.rows.filter((r) => r.children[0].stage === "university").length === 4,
);
check(
  "監査: 入学料は18歳の年に1回のみ",
  auditPub.rows.filter((r) => r.children[0].oneTimeYen > 0).length === 1 &&
    auditPub.rows[18].children[0].oneTimeYen === 282_000,
);
const twins: FamilyPlan = {
  ...lifetimePlan("public", "national"),
  children: [
    {
      id: "c1",
      currentAgeYears: 0,
      birthInYears: null,
      course: "public",
      universityCourse: "national",
    },
    {
      id: "c2",
      currentAgeYears: 0,
      birthInYears: null,
      course: "public",
      universityCourse: "national",
    },
  ],
};
check(
  "監査: 複数子の合算 = 各子の合計（2×21,205,200）",
  projectCashflow(twins).totals.childCostTotalYen === 2 * 21_205_200,
);
check("validateCostMaster: 二重計上・不整合なし", validateCostMaster().length === 0);
const breakdownPub = lifetimeCostBreakdown(COURSE_PUB_NAT);
const breakdownPri = lifetimeCostBreakdown(COURSE_PRI_PRI);
check(
  "クローズドフォーム = エンジン累計（公立＋国立）",
  breakdownPub.totalYen === auditPub.totals.childCostTotalYen,
);
check(
  "クローズドフォーム = エンジン累計（私立）",
  breakdownPri.totalYen === auditPri.totals.childCostTotalYen,
);
check("costYears = 22（0〜21歳）", breakdownPub.costYears === 22);
check(
  "内訳整合（公立＋国立）: living 13,560,000 / 学習費 5,220,000 / 大学 2,143,200 / 入学料 282,000",
  breakdownPub.livingYen === 13_560_000 &&
    breakdownPub.educationYen === 5_220_000 &&
    breakdownPub.universityYen === 2_143_200 &&
    breakdownPub.entranceYen === 282_000,
);
check(
  "内訳整合（私立）: living 13,560,000 / 学習費 17,910,000 / 大学 5,069,132 / 入学料 240,365",
  breakdownPri.livingYen === 13_560_000 &&
    breakdownPri.educationYen === 17_910_000 &&
    breakdownPri.universityYen === 5_069_132 &&
    breakdownPri.entranceYen === 240_365,
);

console.log(
  failed === 0
    ? "\nM1 verification: ALL PASSED"
    : `\nM1 verification: ${failed} FAILED`,
);
if (failed > 0) process.exit(1);
