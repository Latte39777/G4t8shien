/**
 * M3 検証スクリプト：フォーム入力 → 計算エンジン入力（FamilyPlan）変換の整合性
 *
 * 実行: npx tsx scripts/verify-m3.ts
 *
 * 検証内容:
 * - 子ども0人 / 1人 / 複数人の入力動作と変換結果
 * - 現在の子・予定の子の区別（予定の子の出産予定時期が未定なら計算対象外）
 * - 年齢が「満年齢の整数」のまま ChildInput に渡り、計算側の意味が変わらないこと
 * - 教育方針（公立/私立・大学区分）のマッピングと暫定既定値
 * - 世帯年収（受給条件用）と月の手取り収入（収支用）の分離
 * - 子ども行の削除後に古いデータが残らないこと
 * - childInputSchema / familyPlanSchema によるスキーマ検証
 *
 * 注: 費用データ・計算ロジック（lib/finance/costs.ts / cashflow.ts）は
 * 承認待ちのため本スクリプトからも変更していない（読み取りのみ）。
 */
import { childInputSchema, familyPlanSchema } from "../lib/types/finance";
import type { ChildRow, HouseholdInput, SimulationInput } from "../lib/simulation";
import {
  SAMPLE_INPUT,
  calculateSimulation,
  toFamilyPlan,
} from "../lib/simulation";
import { projectCashflow } from "../lib/finance/cashflow";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}`);
  }
}

const baseHousehold: HouseholdInput = {
  annualIncomeYen: null,
  incomeBand: null,
  monthlyTakeHomeYen: null,
  monthlyLivingExpenseYen: null,
  monthlyHousingCostYen: null,
  municipality: null,
  householdType: null,
  schoolCourse: null,
  universityCourse: null,
  workAfterBirth: null,
  usedSupportProgramIds: [],
};

function makeInput(overrides: Partial<SimulationInput>): SimulationInput {
  return {
    childCount: 0,
    savings: 1_000_000,
    targetAmount: 10_000_000,
    planStatus: null,
    children: [],
    desiredChildCount: null,
    firstBirthTiming: null,
    household: { ...baseHousehold },
    ...overrides,
  };
}

function main(): void {
  console.log("M3 検証: フォーム入力 → FamilyPlan 変換");

  // ── 1. 子ども0人 ──
  console.log("\n[1] 子ども0人の入力動作");
  const p0 = toFamilyPlan(makeInput({ childCount: 0 }));
  check("children が空配列になる", p0.children.length === 0);
  check("familyPlanSchema を通過", familyPlanSchema.safeParse(p0).success);
  check("居住地未入力は「未定」（推測しない）", p0.municipality === "未定");
  check("生活費未入力は 0 円（エンジン必須の暫定値・要確認）", p0.monthlyBaseExpense === 0);
  check("世帯構成未選択は other（エンジン必須の暫定値・要確認）", p0.householdType === "other");
  check("世帯年収未入力は null", p0.annualIncome === null);
  const sim0 = calculateSimulation(makeInput({ childCount: 0 }));
  check("既存のモック計算（childCount=0）が壊れない", sim0.supportTotal === 0);

  // ── 2. 子ども1人 ──
  console.log("\n[2] 子ども1人の入力動作（第1子：8歳）");
  const one: ChildRow = {
    id: "existing-1",
    kind: "existing",
    ageYears: 8,
    birthInYears: null,
  };
  const p1 = toFamilyPlan(makeInput({ childCount: 1, children: [one] }));
  check("満年齢8歳が currentAgeYears=8 でそのまま渡る", p1.children[0]?.currentAgeYears === 8);
  check("birthInYears は null", p1.children[0]?.birthInYears === null);
  check("方針未選択 → course=public（暫定・要確認）", p1.children[0]?.course === "public");
  check("方針未選択 → universityCourse=national（暫定・要確認）", p1.children[0]?.universityCourse === "national");
  check("ChildInput スキーマを通過", childInputSchema.safeParse(p1.children[0]).success);

  // ── 3. 複数人（第1子8歳・第2子3歳＋予定の子） ──
  console.log("\n[3] 複数人の入力動作（第1子：8歳、第2子：3歳＋予定の子）");
  const rows: ChildRow[] = [
    { id: "existing-1", kind: "existing", ageYears: 8, birthInYears: null },
    { id: "existing-2", kind: "existing", ageYears: 3, birthInYears: null },
    { id: "planned-1", kind: "planned", ageYears: null, birthInYears: 2 },
    { id: "planned-2", kind: "planned", ageYears: null, birthInYears: null },
  ];
  const p3 = toFamilyPlan(makeInput({ childCount: 4, children: rows }));
  check("計算対象は3人（出産予定時期が未定の予定子は除外）", p3.children.length === 3);
  check(
    "第1子8歳・第2子3歳がそのまま渡る",
    p3.children[0]?.currentAgeYears === 8 && p3.children[1]?.currentAgeYears === 3,
  );
  check(
    "予定の子は birthInYears=2 で区別される",
    p3.children[2]?.currentAgeYears === null && p3.children[2]?.birthInYears === 2,
  );
  check("全 ChildInput がスキーマを通過", p3.children.every((c) => childInputSchema.safeParse(c).success));
  check("familyPlanSchema を通過", familyPlanSchema.safeParse(p3).success);
  check("フォーム入力（children）は4行のまま保持される", rows.length === 4);
  const projected = projectCashflow(p3);
  check("計算エンジンで実行できる（horizon=24年）", projected.horizonYears === 24);
  check("計算エンジンの行数は 25", projected.rows.length === 25);

  // ── 4. 行削除後の再変換（古い入力データの残存なし） ──
  console.log("\n[4] 子ども行の削除後の変換");
  const afterRemoval = toFamilyPlan(
    makeInput({ children: rows.filter((r) => r.id !== "existing-1") }),
  );
  check("削除した子（existing-1）は計算に残らない", !afterRemoval.children.some((c) => c.id === "existing-1"));
  check("残りの2人は維持される", afterRemoval.children.length === 2);

  // ── 5. 教育方針のマッピング ──
  console.log("\n[5] 教育方針（公立/私立・大学区分）");
  const privatePlan = toFamilyPlan(
    makeInput({
      children: [one],
      household: { ...baseHousehold, schoolCourse: "private", universityCourse: "private" },
    }),
  );
  check(
    "私立/私立が ChildInput に反映される",
    privatePlan.children[0]?.course === "private" &&
      privatePlan.children[0]?.universityCourse === "private",
  );

  // ── 6. 世帯年収と月の手取りの分離 ──
  console.log("\n[6] 世帯年収（受給条件用）と月の手取り（収支用）の分離");
  const pIncome = toFamilyPlan(
    makeInput({
      household: { ...baseHousehold, annualIncomeYen: 6_000_000, monthlyTakeHomeYen: 350_000 },
    }),
  );
  check("世帯年収が annualIncome に入る", pIncome.annualIncome === 6_000_000);
  check("月の手取り（×12）は annualIncome に混入しない", pIncome.annualIncome !== 350_000 * 12);
  const pTakeHomeOnly = toFamilyPlan(
    makeInput({ household: { ...baseHousehold, monthlyTakeHomeYen: 350_000 } }),
  );
  check("世帯年収未入力なら annualIncome=null（手取りで代用しない）", pTakeHomeOnly.annualIncome === null);

  // ── 7. 子ども0人時の希望人数・出産予定時期 ──
  console.log("\n[7] 子ども0人時の希望情報（未定でも進める）");
  const desired = makeInput({ desiredChildCount: 2, firstBirthTiming: "in1to2" });
  const pDesired = toFamilyPlan(desired);
  check("希望情報から子どもを推測生成しない", pDesired.children.length === 0);
  check("希望情報はフォーム入力に保持される", desired.desiredChildCount === 2 && desired.firstBirthTiming === "in1to2");
  const undecided = makeInput({ desiredChildCount: null, firstBirthTiming: null });
  check("希望情報が未定でも変換できる", toFamilyPlan(undecided).children.length === 0);

  // ── 8. サンプルデータ ──
  console.log("\n[8] サンプルデータ（新入力形式）");
  check("childCount=2", SAMPLE_INPUT.childCount === 2);
  check(
    "「第1子：8歳、第2子：3歳」に対応",
    SAMPLE_INPUT.children[0]?.ageYears === 8 && SAMPLE_INPUT.children[1]?.ageYears === 3,
  );
  const pSample = toFamilyPlan(SAMPLE_INPUT);
  check("familyPlanSchema を通過", familyPlanSchema.safeParse(pSample).success);
  check("世帯年収 600万円が渡る", pSample.annualIncome === 6_000_000);
  check("利用中支援はモック制度IDで保持", SAMPLE_INPUT.household.usedSupportProgramIds.includes("mock-child-allowance"));

  console.log(`\nM3 verify: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();