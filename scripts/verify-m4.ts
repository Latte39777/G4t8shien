/**
 * M4 検証スクリプト：結果画面のビューモデル・家計収支の対応関係・支援の区分表示
 * 実行: npx tsx scripts/verify-m4.ts
 */
import type { ChildRow, HouseholdInput, SimulationInput } from "../lib/simulation";
import { SAMPLE_INPUT, toFamilyPlan, WORK_INCOME_CHANGE_RULES } from "../lib/simulation";
import { projectCashflow } from "../lib/finance/cashflow";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
import { buildSimulationResult } from "../lib/result";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.error(`NG: ${name}`);
  }
}

function makeInput(over: {
  children?: ChildRow[];
  savings?: number;
  household?: Partial<HouseholdInput>;
}): SimulationInput {
  return {
    childCount: over.children?.length ?? 0,
    savings: over.savings ?? 1_000_000,
    targetAmount: 10_000_000,
    planStatus: "have",
    children: over.children ?? [],
    desiredChildCount: null,
    firstBirthTiming: null,
    household: {
      annualIncomeYen: 6_000_000,
      incomeBand: null,
      monthlyTakeHomeYen: 350_000,
      monthlyLivingExpenseYen: 220_000,
      monthlyHousingCostYen: 90_000,
      municipality: "東京都世田谷区",
      householdType: "couple",
      schoolCourse: "public",
      universityCourse: "national",
      workAfterBirth: "unchanged",
      usedSupportProgramIds: [],
      ...over.household,
    },
  };
}

const c = (id: string, ageYears: number): ChildRow => ({
  id,
  kind: "existing",
  ageYears,
  birthInYears: null,
});
const planned = (id: string, birthInYears: number | null): ChildRow => ({
  id,
  kind: "planned",
  ageYears: null,
  birthInYears,
});

// ── 1. 子ども0人・1人・複数人の場合の表示 ──
const r0 = buildSimulationResult(makeInput({}), MOCK_SUPPORT_PROGRAMS);
check("子ども0人: children 空", r0.children.length === 0);
check("子ども0人: 費用総額 0", r0.costTotals.totalYen === 0);
check("子ども0人: 年次行なし", r0.yearly.length === 0);
check("子ども0人: 残高推移なし", r0.savingsSeries.length === 0);
check("子ども0人: 世帯の段階別合計は 0 円", r0.householdStages.every((s) => s.totalYen === 0));

const r1 = buildSimulationResult(
  makeInput({ children: [c("c1", 8)] }),
  MOCK_SUPPORT_PROGRAMS,
);
check("子ども1人: children 1件", r1.children.length === 1);
check("子ども1人: 費用総額 > 0", r1.costTotals.totalYen > 0);
check("子ども1人: 年次行あり", r1.yearly.length > 0);

const multi = [
  c("c1", 8),
  c("c2", 3),
  planned("c3", 2),
  planned("c4", null), // 出産予定時期が未定＝計算対象外
];
const r3 = buildSimulationResult(makeInput({ children: multi }), MOCK_SUPPORT_PROGRAMS);
check("複数人: children 4件（未定含む）", r3.children.length === 4);
check(
  "複数人: 未定の子は計算対象外フラグ",
  r3.children[3].excludedFromCalc === true && r3.children[3].totalYen === 0,
);
check(
  "複数人: 未定の子の扱いを明示",
  r3.unenteredNotices.some((n) => n.includes("出産予定時期が未定")),
);

// ── 2. 子どもごとの費用と世帯合計の整合性 ──
const sumChildTotals = r3.children.reduce((s, ch) => s + ch.totalYen, 0);
check(
  "Σ 子ども別合計 = 世帯合計 = projectCashflow 総額",
  sumChildTotals === r3.costTotals.totalYen &&
    r3.costTotals.totalYen === r3.projection.totals.childCostTotalYen,
);
check(
  "各子どもの Σ 段階別 = 子ども合計",
  r3.children.every(
    (ch) => ch.stages.reduce((s, st) => s + st.totalYen, 0) === ch.totalYen,
  ),
);
check(
  "世帯の段階別合計 = Σ 子ども別の段階別",
  r3.householdStages.every(
    (st, i) => st.totalYen === r3.children.reduce((s, ch) => s + ch.stages[i].totalYen, 0),
  ),
);
check(
  "Σ 世帯の段階別 = 世帯合計",
  r3.householdStages.reduce((s, st) => s + st.totalYen, 0) === r3.costTotals.totalYen,
);
check(
  "確認済み出典 + 仮定値 = 費用総額",
  r3.costTotals.assumedYen + r3.costTotals.referenceYen === r3.costTotals.totalYen,
);
check(
  "段階別 items の小計 = 段階合計",
  r3.children.every((ch) =>
    ch.stages.every(
      (st) => st.items.reduce((s, i) => s + i.subtotalYen, 0) === st.totalYen,
    ),
  ),
);
check(
  "Σ 子ども別の支援見込 = 世帯の支援見込",
  r3.children.reduce((s, ch) => s + ch.supportConfirmedYen, 0) ===
    r3.supportTotals.confirmedYen &&
    r3.children.reduce((s, ch) => s + ch.supportEstimatedYen, 0) ===
      r3.supportTotals.estimatedYen,
);

// ── 3. 月の手取り収入と世帯年収の使い分け ──
const incomeInput = makeInput({
  children: [c("c1", 5)],
  household: { annualIncomeYen: 10_000_000, monthlyTakeHomeYen: 200_000 },
});
const incomePlan = toFamilyPlan(incomeInput);
const incomeProj = projectCashflow(incomePlan);
check(
  "家計収支の収入 = 月の手取り × 12（世帯年収1,000万円は使わない）",
  incomeProj.rows[0].incomeYen === 200_000 * 12 &&
    incomeProj.rows[0].incomeYen !== 10_000_000,
);
check(
  "世帯年収は annualIncome に保持（受給条件用）",
  incomePlan.annualIncome === 10_000_000,
);

const noIncomeInput = makeInput({
  children: [c("c1", 5)],
  household: { annualIncomeYen: null },
});
const withIncome = buildSimulationResult(
  makeInput({ children: [c("c1", 5)], household: { annualIncomeYen: 6_000_000 } }),
  MOCK_SUPPORT_PROGRAMS,
);
const withoutIncome = buildSimulationResult(noIncomeInput, MOCK_SUPPORT_PROGRAMS);
const effWith = withIncome.supports.effects.find((e) => e.program.id === "mock-child-allowance");
const effWithout = withoutIncome.supports.effects.find((e) => e.program.id === "mock-child-allowance");
check(
  "世帯年収あり: 所得制限の確認で判定保留にしない",
  effWith !== undefined && effWith.eligibility === "likely" &&
    !effWith.program.missingInformation.includes("世帯収入"),
);
check(
  "世帯年収なし: 所得制限あり制度は保留＋不足情報「世帯収入」",
  effWithout !== undefined && effWithout.eligibility === "possible" &&
    effWithout.program.missingInformation.includes("世帯収入"),
);
check(
  "手取り未入力: 収入0円として扱い影響を明示",
  buildSimulationResult(
    makeInput({ children: [c("c1", 5)], household: { monthlyTakeHomeYen: null } }),
    MOCK_SUPPORT_PROGRAMS,
  ).unenteredNotices.some((n) => n.includes("手取り収入") && n.includes("0 円")),
);

// ── 4. 家賃・生活費の二重計上がないこと ──
const both = buildSimulationResult(
  makeInput({
    children: [c("c1", 5)],
    household: { monthlyLivingExpenseYen: 250_000, monthlyHousingCostYen: 80_000 },
  }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "生活費＋住居費入力: 支出は生活費×12のみ（住居費は加算しない＝二重計上なし）",
  both.yearly[0].livingExpenseYen === 250_000 * 12,
);
check(
  "生活費＋住居費入力: 二重計上の防止を明示",
  both.unenteredNotices.some((n) => n.includes("二重計上")),
);
check(
  "支出 = 生活費 + 子ども費用（内訳と一致）",
  both.yearly[0].expenseYen === both.yearly[0].livingExpenseYen + both.yearly[0].childCostYen,
);

const housingOnly = buildSimulationResult(
  makeInput({
    children: [c("c1", 5)],
    household: { monthlyLivingExpenseYen: null, monthlyHousingCostYen: 80_000 },
  }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "生活費未入力・住居費あり: 住居費×12を固定支出として反映",
  housingOnly.yearly[0].livingExpenseYen === 80_000 * 12,
);
check(
  "生活費未入力・住居費あり: その扱いを明示",
  housingOnly.unenteredNotices.some((n) => n.includes("家賃・住宅ローンの金額")),
);

const neither = buildSimulationResult(
  makeInput({
    children: [c("c1", 5)],
    household: { monthlyLivingExpenseYen: null, monthlyHousingCostYen: null },
  }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "生活費・住居費とも未入力: 生活費 0 円として扱う",
  neither.yearly[0].livingExpenseYen === 0,
);
check(
  "生活費・住居費とも未入力: 0 円扱いを明示",
  neither.unenteredNotices.some((n) => n.includes("世帯の生活費は 0 円")),
);

// ── 5. 確定済み支援と推定支援の区別 ──
const plain = buildSimulationResult(
  makeInput({ children: [c("c1", 5)] }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "モックは未確認: 確定支援 0 円",
  plain.supportTotals.confirmedYen === 0,
);
check(
  "推定支援は別枠で集計",
  plain.supportTotals.estimatedYen > 0,
);
check(
  "貸付制度は合計対象外（理由つき）",
  plain.supports.uncounted.some(
    (e) => e.program.category === "loan" && (e.excludedReason ?? "").includes("貸付"),
  ),
);
check(
  "金額未確認（unknown）は合計対象外（理由つき）",
  plain.supports.uncounted.some(
    (e) => e.program.amount.basis === "unknown" && (e.excludedReason ?? "").includes("未確認"),
  ),
);

const used = buildSimulationResult(
  makeInput({ children: [c("c1", 5)], household: { usedSupportProgramIds: ["mock-child-allowance"] } }),
  MOCK_SUPPORT_PROGRAMS,
);
const usedEffect = used.supports.effects.find((e) => e.program.id === "mock-child-allowance");
check(
  "現在利用中の制度は見込み額から除外（重複防止）",
  usedEffect !== undefined && usedEffect.includedInTotal === false &&
    (usedEffect.excludedReason ?? "").includes("現在利用中"),
);
check(
  "利用中制度の除外が支援総額に反映",
  used.supportTotals.estimatedYen < plain.supportTotals.estimatedYen,
);

// ── 6. 未確認の制度・費用・期限の表示（明示フラグ） ──
check(
  "費用総額に仮定値が含まれる場合は hasUnverified=true",
  plain.costTotals.hasUnverified === true,
);
check(
  "確認済み出典の金額: 公立/国立のみなら 0（すべて仮定値）",
  plain.costTotals.referenceYen === 0 &&
    plain.costTotals.assumedYen === plain.costTotals.totalYen,
);
const supportAssumption = plain.assumptions.find((a) => a.label === "公的支援の額");
check(
  "支援額は未確認フラグつきで表示",
  supportAssumption !== undefined && supportAssumption.flag === "unverified",
);
const costAssumption = plain.assumptions.find((a) => a.label === "子育て費用のデータ");
check(
  "費用データの仮定値を前提条件に明示",
  costAssumption !== undefined && (costAssumption.note ?? "").includes("仮定値"),
);
const pregnancy = plain.householdStages.find((s) => s.key === "pregnancy");
check(
  "妊娠・出産: 費用データ未整備として 0 円扱いを明示",
  pregnancy !== undefined && pregnancy.totalYen === 0 && pregnancy.dataMissing &&
    (pregnancy.note ?? "").includes("未整備"),
);
check(
  "大学: 国立・公立・私立を区別した比較データがある",
  pregnancy !== undefined &&
    plain.householdStages.find((s) => s.key === "university")?.universityOptions?.length === 3,
);
const uniOptions = plain.householdStages.find((s) => s.key === "university")?.universityOptions ?? [];
check(
  "大学: 国立と私立で金額が異なる",
  (uniOptions.find((o) => o.course === "national")?.annualYen ?? 0) !==
    (uniOptions.find((o) => o.course === "private")?.annualYen ?? 0),
);
const privateResult = buildSimulationResult(
  makeInput({
    children: [c("c1", 5)],
    household: { schoolCourse: "private", universityCourse: "private" },
  }),
  MOCK_SUPPORT_PROGRAMS,
);
const uniStage = privateResult.children[0].stages.find((s) => s.key === "university");
check(
  "私立大学の学費・入学料は確認済み出典（reference）として区別",
  uniStage !== undefined && uniStage.referenceYen > 0 && uniStage.assumedYen > 0,
);
check(
  "内訳の各行に確度（basis）と出典が保持される",
  uniStage !== undefined &&
    uniStage.items.every((i) => i.basis === "assumed" || i.basis === "reference"),
);

// ── 7. 出産後の収入変化の反映 ──
check(
  "収入変化の仮定値が定義されている（要確認）",
  WORK_INCOME_CHANGE_RULES.part_time?.multiplier === 0.75 &&
    WORK_INCOME_CHANGE_RULES.quit?.multiplier === 0,
);
const changeInput = makeInput({
  children: [planned("p1", 2)],
  household: { monthlyTakeHomeYen: 350_000, workAfterBirth: "part_time" },
});
const changeResult = buildSimulationResult(changeInput, MOCK_SUPPORT_PROGRAMS);
check(
  "予定の子: 出生年前の収入は手取り×12",
  changeResult.yearly[0].incomeYen === 350_000 * 12,
);
check(
  "予定の子: 出生年から6年間は ×0.75（仮定値）",
  changeResult.yearly[2].incomeYen === Math.round(350_000 * 12 * 0.75) &&
    changeResult.yearly[7].incomeYen === Math.round(350_000 * 12 * 0.75),
);
check(
  "予定の子: 期間終了後は元の手取りに戻る",
  changeResult.yearly[8].incomeYen === 350_000 * 12,
);
check(
  "収入変化の内容を明示",
  (changeResult.incomeChangeNote ?? "").includes("0.75"),
);

const existingOnly = buildSimulationResult(
  makeInput({ children: [c("c1", 5)], household: { workAfterBirth: "quit" } }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "既存の子のみ: 現在の手取りに反映済みとみなして追加減額しない",
  existingOnly.yearly.every((y) => y.incomeYen === 350_000 * 12) &&
    (existingOnly.incomeChangeNote ?? "").includes("反映済み"),
);

// ── 8. 貯蓄残高（初期残高）と年次収支の整合 ──
const savingsResult = buildSimulationResult(
  makeInput({ children: [c("c1", 5)], savings: 1_000_000 }),
  MOCK_SUPPORT_PROGRAMS,
);
check(
  "貯蓄残高: 初期残高 + 各年の収支",
  savingsResult.savingsSeries[0].savingsEndYen ===
    1_000_000 + savingsResult.yearly[0].netYen,
);
check(
  "年次収支: 収入 - 支出 + 確定支援 = netYen",
  savingsResult.yearly.every(
    (y) => y.incomeYen - y.expenseYen + y.supportConfirmedYen === y.netYen,
  ),
);

// ── サンプル入力での全体整合（複数人・既存2人） ──
const sample = buildSimulationResult(SAMPLE_INPUT, MOCK_SUPPORT_PROGRAMS);
check(
  "SAMPLE_INPUT: Σ 子ども別 = 世帯合計",
  sample.children.reduce((s, ch) => s + ch.totalYen, 0) === sample.costTotals.totalYen,
);
check(
  "SAMPLE_INPUT: 年次行 = 20（最年少の子が22歳になる19年後まで）",
  sample.yearly.length === 20,
);

console.log(
  failed === 0
    ? "\nM4 verification: ALL PASSED"
    : `\nM4 verification: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);