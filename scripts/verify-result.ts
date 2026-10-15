/**
 * 結果画面の段階別資金配分（必要額・自前資金・支援・不足額）の回帰テスト
 *
 * 実行: npx tsx scripts/verify-result.ts
 * - 教育段階ごとの内訳合計＝必要額（支援OFF/ONの両方）
 * - 共通目盛り（最大費用段階＝最大幅）と支援配分の重複計上なし
 * - 支援の対象年齢・対象期間・金額単位の反映と、確定/推定の分離
 * - 貸付・未確認・利用中制度の非配分と、未配分理由の保持
 * - 目標額カバー状況と比較グラフの整合
 */
import type { ChildRow, HouseholdInput, SimulationInput } from "../lib/simulation";
import { toFamilyPlan } from "../lib/simulation";
import {
  allocateSelfFunding,
  projectCashflow,
  projectionHorizon,
} from "../lib/finance/cashflow";
import {
  allocateSupportByStage,
  calculateSupportEffects,
} from "../lib/finance/supports";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
import {
  buildSimulationResult,
  DISPLAY_STAGES,
  type DisplayStageKey,
} from "../lib/result";

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
  targetAmount?: number | null;
  household?: Partial<HouseholdInput>;
}): SimulationInput {
  return {
    childCount: over.children?.length ?? 0,
    savings: over.savings ?? 1_000_000,
    targetAmount: over.targetAmount === undefined ? 10_000_000 : over.targetAmount,
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

const DISPLAY_KEYS: DisplayStageKey[] = DISPLAY_STAGES.map((d) => d.key);

// ── 1. 段階別の内訳合計＝必要額（支援OFF/ON）・不足額の非負 ──
{
  const r = buildSimulationResult(
    makeInput({ children: [c("a", 8), c("b", 5)], savings: 1_000_000 }),
    MOCK_SUPPORT_PROGRAMS,
  );
  for (const st of r.householdStages) {
    const f = st.funding;
    check(
      `${st.label}: 支援OFF内訳（自前＋不足）＝必要額 ${st.totalYen}`,
      f.selfFundedYen + f.shortageWithoutSupportYen === st.totalYen,
    );
    check(
      `${st.label}: 支援ON内訳（自前＋充当支援＋不足）＝必要額`,
      f.selfFundedYen + f.supportAppliedYen + f.shortageWithSupportYen ===
        st.totalYen,
    );
    check(
      `${st.label}: 充当支援＝確定充当＋推定充当`,
      f.supportAppliedYen ===
        f.supportConfirmedAppliedYen + f.supportEstimatedAppliedYen,
    );
    check(
      `${st.label}: 充当支援＋超過支援＝配分支援`,
      f.supportAppliedYen + f.supportSurplusYen ===
        f.supportConfirmedYen + f.supportEstimatedYen,
    );
    check(
      `${st.label}: 不足額・超過支援は非負`,
      f.shortageWithoutSupportYen >= 0 &&
        f.shortageWithSupportYen >= 0 &&
        f.supportSurplusYen >= 0,
    );
    check(
      `${st.label}: 自前資金は必要額を超えない`,
      f.selfFundedYen <= st.totalYen,
    );
    check(
      `${st.label}: 不足額は支援OFFで支援ON以上（支援は不足に充当される）`,
      f.shortageWithSupportYen <= f.shortageWithoutSupportYen,
    );
  }

  // ── 2. 共通目盛り（最大費用の段階＝最大幅。固定値なし・データ追随） ──
  const maxTotal = Math.max(...r.householdStages.map((s) => s.totalYen));
  const maxStages = r.householdStages.filter((s) => s.totalYen === maxTotal);
  check(
    "最大費用の段階が1つに定まり、その費用が共通目盛りの最大値",
    maxStages.length === 1 && maxStages[0].totalYen === maxTotal && maxTotal > 0,
  );
  check(
    "現行データでは大学・専門学校が最大費用段階",
    maxStages[0]?.key === "university",
  );
  const rPrivate = buildSimulationResult(
    makeInput({
      children: [c("a", 8)],
      household: { universityCourse: "private" },
    }),
    MOCK_SUPPORT_PROGRAMS,
  );
  const rNational1 = buildSimulationResult(
    makeInput({ children: [c("a", 8)] }),
    MOCK_SUPPORT_PROGRAMS,
  );
  const uniPrivate = rPrivate.householdStages.find((s) => s.key === "university");
  const uniNational = rNational1.householdStages.find((s) => s.key === "university");
  check(
    "大学の区分に応じて段階費用が変わる（データ追随・固定値なし）",
    uniPrivate !== undefined &&
      uniNational !== undefined &&
      uniPrivate.totalYen > uniNational.totalYen,
  );
  check(
    "私立でも最大費用段階は大学（内容に追随して比較できる）",
    Math.max(...rPrivate.householdStages.map((s) => s.totalYen)) ===
      uniPrivate?.totalYen,
  );
  // ── 3. Σ 子ども別＝世帯全体（自前資金・支援の重複計上なし） ──
  const sumChild = (pick: (f: (typeof r.householdStages)[0]["funding"]) => number) =>
    r.children.reduce(
      (s, ch) => s + ch.stages.reduce((t, st) => t + pick(st.funding), 0),
      0,
    );
  const sumHousehold = (
    pick: (f: (typeof r.householdStages)[0]["funding"]) => number,
  ) => r.householdStages.reduce((s, st) => s + pick(st.funding), 0);
  check(
    "Σ 子ども別の自前資金＝世帯全体の自前資金",
    sumChild((f) => f.selfFundedYen) === sumHousehold((f) => f.selfFundedYen),
  );
  check(
    "Σ 子ども別の確定支援＝世帯全体の確定支援（二重計上なし）",
    sumChild((f) => f.supportConfirmedYen) ===
      sumHousehold((f) => f.supportConfirmedYen),
  );
  check(
    "Σ 子ども別の推定支援＝世帯全体の推定支援（二重計上なし）",
    sumChild((f) => f.supportEstimatedYen) ===
      sumHousehold((f) => f.supportEstimatedYen),
  );
  check(
    "Σ 段階別の確定＋推定支援＝世帯の支援見込額＋未配分（合計の整合）",
    sumHousehold((f) => f.supportConfirmedYen + f.supportEstimatedYen) +
      r.fundingMeta.unallocatedSupports
        .filter((u) => u.includedInTotal)
        .reduce((s, u) => s + (u.amountYen ?? 0), 0) ===
      r.supportTotals.confirmedYen + r.supportTotals.estimatedYen,
  );

  // ── 4. 自前資金（貯蓄の重複使用なし） ──
  const plan = toFamilyPlan(
    makeInput({ children: [c("a", 8), c("b", 5)], savings: 1_000_000 }),
  );
  const supports = calculateSupportEffects(plan, MOCK_SUPPORT_PROGRAMS, {
    excludeProgramIds: [],
  });
  const projection = projectCashflow(plan, supports.schedule);
  const selfAlloc = allocateSelfFunding(plan, projection);
  const selfStageSum = [...selfAlloc.byStage.values()].reduce((s, v) => s + v, 0);
  check(
    "自前資金: Σ 段階別＝配分総額（重複計上なし）",
    selfStageSum === selfAlloc.allocatedTotalYen,
  );
  check(
    "自前資金: 充当＋未充当＝子供費用総額",
    selfAlloc.allocatedTotalYen + selfAlloc.uncoveredYen ===
      projection.totals.childCostTotalYen,
  );
  check(
    "自前資金: 充当総額は貯蓄＋Σ（収入−世帯生活費）を超えない",
    selfAlloc.allocatedTotalYen <=
      plan.savings +
        projection.rows.reduce(
          (s, row) => s + Math.max(row.incomeYen - row.baseExpenseYen, 0),
          0,
        ),
  );

  // ── 5. 支援の対象年齢・対象期間・金額単位の反映（年齢単位で検証） ──
  for (const effect of supports.effects) {
    const one = allocateSupportByStage(plan, [effect], {
      stageKeys: DISPLAY_KEYS,
      stageKeyForAge: (age) => (age === null ? "pregnancy" : `age-${age}`),
    });
    let sum = 0;
    let periodOk = true;
    for (const [key, bucket] of one.byStage) {
      sum += bucket.confirmedYen + bucket.estimatedYen;
      if (key === "pregnancy") continue;
      const age = Number(key.slice("age-".length));
      const p = effect.program.period;
      if (p.startAgeYears !== null && age < p.startAgeYears) periodOk = false;
      if (p.endAgeYears !== null && age > p.endAgeYears) periodOk = false;
    }
    const name = effect.program.name;
    check(`${name}: 配分先の年齢は対象期間内`, periodOk);
    if (effect.includedInTotal) {
      check(
        `${name}: 合計対象は Σ 段階別＝見込額 ${effect.estimatedTotalYen}円`,
        sum === (effect.estimatedTotalYen ?? 0),
      );
    } else {
      check(`${name}: 合計対象外は段階に配分しない`, sum === 0);
    }
    if (effect.includedInTotal && sum > 0) {
      if (effect.program.amount.basis === "confirmed") {
        check(
          `${name}: 確定額としてのみ配分される`,
          one.confirmedTotalYen === sum && one.estimatedTotalYen === 0,
        );
      } else {
        check(
          `${name}: 推定額としてのみ配分される（確定と混同しない）`,
          one.estimatedTotalYen === sum && one.confirmedTotalYen === 0,
        );
      }
    }
  }
  // ── 6. 貸付・未確認・利用中の非配分と理由 ──
  const allocAll = allocateSupportByStage(plan, supports.effects, {
    stageKeys: DISPLAY_KEYS,
    stageKeyForAge: (age) => (age === null ? "pregnancy" : `age-${age}`),
  });
  for (const effect of supports.effects) {
    const id = effect.program.id;
    const allocated = [...allocAll.byStage.values()].some((b) =>
      b.programIds.includes(id),
    );
    if (effect.program.category === "loan") {
      check(
        `${effect.program.name}: 貸付は現金給付と同じ扱いにせず配分しない`,
        !allocated &&
          allocAll.unallocated.some(
            (u) => u.programId === id && /貸付/.test(u.reason),
          ),
      );
    }
    if (effect.program.amount.basis === "unknown") {
      check(
        `${effect.program.name}: 金額未確認は確定額として配分しない`,
        !allocated && allocAll.unallocated.some((u) => u.programId === id),
      );
    }
  }
  const planUsed = toFamilyPlan(
    makeInput({
      children: [c("a", 8)],
      household: { usedSupportProgramIds: ["mock-child-allowance"] },
    }),
  );
  const supportsUsed = calculateSupportEffects(planUsed, MOCK_SUPPORT_PROGRAMS, {
    excludeProgramIds: ["mock-child-allowance"],
  });
  const allocUsed = allocateSupportByStage(planUsed, supportsUsed.effects, {
    stageKeys: DISPLAY_KEYS,
    stageKeyForAge: (age) => (age === null ? "pregnancy" : `age-${age}`),
  });
  check(
    "現在利用中の制度は二重に計上せず、理由付きで未配分",
    ![...allocUsed.byStage.values()].some((b) =>
      b.programIds.includes("mock-child-allowance"),
    ) &&
      allocUsed.unallocated.some(
        (u) => u.programId === "mock-child-allowance" && /利用中/.test(u.reason),
      ),
  );

  // ── 7. 予定の子（出生前）は妊娠・出産段階、0円・未整備の段階は理由で区別 ──
  const rPlanned = buildSimulationResult(
    makeInput({ children: [planned("p", 2)] }),
    MOCK_SUPPORT_PROGRAMS,
  );
  const pregnancy = rPlanned.householdStages.find((s) => s.key === "pregnancy");
  check(
    "妊娠・出産: 費用データ未整備として0円扱い",
    pregnancy !== undefined &&
      pregnancy.dataMissing &&
      pregnancy.totalYen === 0 &&
      pregnancy.funding.selfFundedYen === 0,
  );
  check(
    "妊娠・出産: 必要額0円に対し配分支援は充当されず超過として扱う（棒に描画しない）",
    pregnancy !== undefined &&
      pregnancy.funding.supportAppliedYen === 0 &&
      pregnancy.funding.supportSurplusYen ===
        pregnancy.funding.supportConfirmedYen +
          pregnancy.funding.supportEstimatedYen,
  );
  check(
    "出生前の期間の支援は「妊娠・出産」に配分され、理由が明示される",
    rPlanned.fundingMeta.supportAllocationNotes.some((n) =>
      n.includes("出生前の期間"),
    ),
  );
  check(
    "予定の子: 出生後（乳幼児）に児童手当（モック）の配分がある",
    rPlanned.householdStages.some(
      (s) =>
        s.key === "infancy" &&
        s.funding.supportEstimatedYen > 0 &&
        s.funding.supportProgramIds.includes("mock-child-allowance"),
    ),
  );

  // ── 8. 比較グラフ・目標カバー状況の整合 ──
  check(
    "比較: 支援なし＝費用総額",
    r.comparison.grossCostYen === r.costTotals.totalYen,
  );
  check(
    "比較: 確定支援のみ＝費用総額−確定支援（既存の比較計算と一致）",
    r.comparison.afterConfirmedYen ===
      r.comparison.grossCostYen - r.supportTotals.confirmedYen,
  );
  check(
    "比較: 確定＋推定＝費用総額−確定−推定（既存の比較計算と一致）",
    r.comparison.afterAllYen ===
      r.comparison.grossCostYen -
        r.supportTotals.confirmedYen -
        r.supportTotals.estimatedYen,
  );
  const goal = r.goalCoverage;
  check("目標額あり: カバー状況が計算される", goal !== null);
  check(
    "目標額あり: 差額＝目標−（現在の貯蓄＋支援見込額）",
    goal !== null &&
      goal.gapYen === goal.targetYen - goal.savingsYen - goal.supportTotalYen,
  );
  check(
    "目標額あり: 確定＋推定＝支援見込額（確度の区別を保持）",
    goal !== null &&
      goal.supportTotalYen ===
        goal.supportConfirmedYen + goal.supportEstimatedYen,
  );
  const rNoTarget = buildSimulationResult(
    makeInput({ children: [c("a", 8)], targetAmount: null }),
    MOCK_SUPPORT_PROGRAMS,
  );
  check(
    "目標額なし: カバー状況は null（エラー表示にしない）",
    rNoTarget.goalCoverage === null,
  );

  // ── 9. 年次予測の機能維持（折りたたみの中身） ──
  check(
    "年次行＝horizon+1 年（将来の家計予測が利用できる）",
    r.yearly.length === projectionHorizon(plan) + 1,
  );
  check(
    "貯蓄残高系列が保持される",
    r.savingsSeries.length === r.yearly.length &&
      r.savingsSeries[0].savingsEndYen === r.yearly[0].savingsEndYen,
  );
  check(
    "前提・限界の説明が fundingMeta に保持される",
    r.fundingMeta.selfFundingNotes.length > 0 &&
      r.fundingMeta.supportAllocationNotes.some((n) => n.includes("モック")),
  );
}

// ── 10. 0子・収入未入力は推測値を作らない ──
{
  const r = buildSimulationResult(makeInput({ savings: 500_000 }), MOCK_SUPPORT_PROGRAMS);
  check(
    "子ども0人: 段階別の費用・支援・不足はすべて0円",
    r.householdStages.every(
      (s) =>
        s.totalYen === 0 &&
        s.funding.selfFundedYen === 0 &&
        s.funding.shortageWithSupportYen === 0,
    ),
  );
  const rNoIncome = buildSimulationResult(
    makeInput({
      children: [c("a", 6)],
      savings: 0,
      household: {
        monthlyTakeHomeYen: null,
        monthlyLivingExpenseYen: null,
        monthlyHousingCostYen: null,
      },
    }),
    MOCK_SUPPORT_PROGRAMS,
  );
  check(
    "収入・生活費未入力: 自前資金は推測せず0円（推定を確定扱いしない）",
    rNoIncome.householdStages.every((s) => s.funding.selfFundedYen === 0) &&
      rNoIncome.fundingMeta.selfFundingNotes.some((n) =>
        n.includes("月の手取り収入が未入力"),
      ),
  );
}

console.log(`\nverify-result: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`);
if (failed > 0) {
  console.error(`NG: ${failed} 件失敗`);
  process.exitCode = 1;
}