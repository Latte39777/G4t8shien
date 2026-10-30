/**
 * M7-J1 検証スクリプト: 一時金計上バグ・地域条件・参考費用負値・支援区分分離
 *
 * 実行: npx tsx scripts/verify-m7j1.ts
 *
 * 確認項目:
 * - F-1: 一時金が t=0 / t=1 / 既存の子 / 0歳児 / 出生予定児童で正しく1回だけ計上される
 * - 支給単位: 世帯・申請・工事単位の制度（住宅リフォーム支援）は世帯で1回のみ計上される
 * - 上限額のみ確認済みの制度（capOnly）を確定支援額として計上しない
 * - 地域条件: 居住自治体が対象地域外の世帯に地域限定制度を計上しない。
 *   居住地が未入力・未定の場合は確定額として扱わない
 * - F-2: comparison.afterAllYen が 0 以下にならない。上回る分は supportSurplusYen に分離
 * - 支援の区分: 現金給付・費用軽減・貸付の合計が混ざらない
 * - 回帰: 児童手当の代表値（推定）計算・レジストリ全体の従来合計が変わらない
 */
import type { SupportProgram } from "../lib/types/support";
import type { ChildInput, FamilyPlan } from "../lib/types/finance";
import {
  SAMPLE_INPUT,
  type ChildRow,
  type SimulationInput,
} from "../lib/simulation";
import { getSupportPrograms } from "../lib/supports/registry";
import { calculateSupportEffects } from "../lib/finance/supports";
import { estimateSupports } from "../lib/supports/estimate";
import { buildSimulationResult } from "../lib/result";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok" : "NG"}: ${name}${cond || !detail ? "" : ` -- ${detail}`}`);
  if (!cond) {
    failed += 1;
  }
}
function section(title: string): void {
  console.log("");
  console.log(`── ${title} ──`);
}

// ── フィクスチャ（テスト専用。制度データは変更しない） ──
const child = (id: string, age: number | null): ChildInput => ({
  id,
  currentAgeYears: age,
  birthInYears: null,
  course: "public",
  universityCourse: "national",
});
const planned = (id: string, birthInYears: number): ChildInput => ({
  id,
  currentAgeYears: null,
  birthInYears,
  course: "public",
  universityCourse: "national",
});

const planOf = (
  children: ChildInput[],
  municipality = "東京都文京区",
): FamilyPlan => ({
  municipality,
  householdType: "couple",
  annualIncome: 5_000_000,
  monthlyBaseExpense: 200_000,
  savings: 1_000_000,
  children,
  monthlyTakeHomeYen: 300_000,
  incomeChange: null,
});

const fixtureProgram = (
  over: Partial<SupportProgram> & { id: string; name: string },
): SupportProgram => ({
  category: "cash_benefit",
  level: "national",
  summary: "テスト用フィクスチャ",
  amount: {
    value: 10_000,
    unit: "yen_per_month",
    basis: "estimated",
    description: "テスト用（推定）",
  },
  period: { startAgeYears: 0, endAgeYears: 17, durationMonths: null },
  conditions: {
    combinedWith: [],
    incomeLimitNote: null,
    householdNote: null,
    other: [],
  },
  application: {
    where: "窓口",
    documents: [],
    deadlineNote: null,
    steps: [],
    deadlineDate: null,
  },
  eligibility: "possible",
  eligibilityNote: "テスト用",
  legalBasis: { lawName: null, ordinanceName: null, note: null },
  sources: [
    {
      title: "テスト出典",
      organization: "テスト",
      url: null,
      urlVerified: false,
      official: true,
      checkedAt: "2026-10-27",
    },
  ],
  checkedAt: "2026-10-27",
  missingInformation: [],
  mock: true,
  ...over,
});

/** 開いた対象期間（年齢記載なし）の一時金フィクスチャ */
const oneTimeOpen = (value: number, id = "fx-one-time-open"): SupportProgram =>
  fixtureProgram({
    id,
    name: "一時金テスト（期間なし）",
    amount: {
      value,
      unit: "yen_one_time",
      basis: "estimated",
      description: "一時金テスト（推定）",
    },
    period: { startAgeYears: null, endAgeYears: null, durationMonths: null },
  });

const registry = getSupportPrograms();
function programById(id: string): SupportProgram {
  const found = registry.find((p) => p.id === id);
  if (!found) {
    throw new Error(`registry に ${id} がありません`);
  }
  return found;
}
const shinjukuGift = programById("disc-8ee179e3b51b"); // 新宿区子育て応援臨時給付金
const reformGrant = programById("disc-a774a5cf4134"); // 子育て世帯住宅リフォーム支援制度
const childAllowance = programById("mock-child-allowance");

const rowOf = (id: string, age: number): ChildRow => ({
  id,
  kind: "existing",
  ageYears: age,
  birthInYears: null,
});
const inputOf = (
  children: ChildRow[],
  municipality: string | null,
): SimulationInput => ({
  ...SAMPLE_INPUT,
  childCount: children.length,
  children,
  targetAmount: null,
  household: {
    ...SAMPLE_INPUT.household,
    municipality,
    usedSupportProgramIds: [],
  },
});

function main(): void {
  // ══════════════════════════════════════════════════════════
  section("A. 一時金の判定（F-1: t=0 / t=1 / 既存子 / 0歳児 / 出生予定）");
  // ══════════════════════════════════════════════════════════
  // 既存の子（8歳）でも、対象期間の記載がない一時金は t=0 に1回計上される
  const open8 = calculateSupportEffects(planOf([child("c1", 8)]), [
    oneTimeOpen(50_000, "fx-open-8"),
  ]).effects[0];
  check(
    "一時金（期間なし）: 既存の子（8歳）に t=0 で1回計上（0円計上にならない）",
    open8.estimatedTotalYen === 50_000 && open8.yearlyYen[0] === 50_000,
    `${open8.estimatedTotalYen}円 / yearly[0]=${open8.yearlyYen[0]}`,
  );
  check(
    "一時金（期間なし）: 2年目以降は再計上しない（1子1回）",
    open8.yearlyYen.slice(1).every((y) => y === 0),
    open8.yearlyYen.slice(0, 3).join(","),
  );

  // 0歳児も t=0 に1回計上される
  const open0 = calculateSupportEffects(planOf([child("c1", 0)]), [
    oneTimeOpen(50_000, "fx-open-0"),
  ]).effects[0];
  check(
    "一時金（期間なし）: 0歳児に t=0 で1回計上",
    open0.estimatedTotalYen === 50_000 && open0.yearlyYen[0] === 50_000,
    `${open0.estimatedTotalYen}円`,
  );

  // 対象期間が 1〜2歳の一時金は、対象に入った t=1 に1回計上される
  const bounded = fixtureProgram({
    id: "fx-one-time-bounded",
    name: "一時金テスト（1〜2歳）",
    amount: {
      value: 50_000,
      unit: "yen_one_time",
      basis: "estimated",
      description: "一時金テスト（推定）",
    },
    period: { startAgeYears: 1, endAgeYears: 2, durationMonths: null },
  });
  const b0 = calculateSupportEffects(planOf([child("c1", 0)]), [bounded])
    .effects[0];
  check(
    "一時金（1〜2歳）: t=0 は0円・対象に入った t=1 に1回計上",
    b0.yearlyYen[0] === 0 &&
      b0.yearlyYen[1] === 50_000 &&
      b0.estimatedTotalYen === 50_000,
    b0.yearlyYen.slice(0, 3).join(","),
  );

  // 出生予定の子は、出生年に1回計上される
  const p1 = calculateSupportEffects(planOf([planned("c1", 1)]), [
    oneTimeOpen(50_000, "fx-open-p1"),
  ]).effects[0];
  check(
    "一時金（期間なし）: 出生予定児童（1年後）に出生年（t=1）で1回計上",
    p1.yearlyYen[1] === 50_000 && p1.estimatedTotalYen === 50_000,
    p1.yearlyYen.slice(0, 3).join(","),
  );
  const p2 = calculateSupportEffects(planOf([planned("c1", 2)]), [
    oneTimeOpen(50_000, "fx-open-p2"),
  ]).effects[0];
  check(
    "一時金（期間なし）: 出生予定児童（2年後）に出生年（t=2）で1回計上",
    p2.yearlyYen[2] === 50_000 && p2.estimatedTotalYen === 50_000,
    p2.yearlyYen.slice(0, 4).join(","),
  );

  // 新宿区子育て応援臨時給付金（対象児童1人につき1回限り・10,000円・確認済み）
  const sj2 = calculateSupportEffects(
    planOf([child("a", 8), child("b", 3)], "東京都新宿区"),
    [shinjukuGift],
  );
  check(
    "新宿区臨時給付金: 2人世帯は1人10,000円×2人＝20,000円（子ども単位・確定額）",
    sj2.effects[0].estimatedTotalYen === 20_000 &&
      sj2.confirmedTotalYen === 20_000 &&
      sj2.estimatedTotalYen === 0,
    `effect=${sj2.effects[0].estimatedTotalYen}円 / confirmed=${sj2.confirmedTotalYen}円 / estimated=${sj2.estimatedTotalYen}円`,
  );
  check(
    "新宿区臨時給付金: Σ子ども別 = 世帯合計（二重計上なし）",
    sj2.effects[0].perChild.reduce((s, c) => s + (c.totalYen ?? 0), 0) ===
      20_000,
    sj2.effects[0].perChild.map((c) => String(c.totalYen)).join(","),
  );
  const sj0 = calculateSupportEffects(planOf([child("a", 0)], "東京都新宿区"), [
    shinjukuGift,
  ]);
  check(
    "新宿区臨時給付金: 0歳児に1回計上（0円計上にならない）",
    sj0.confirmedTotalYen === 10_000 && sj0.effects[0].yearlyYen[0] === 10_000,
    `confirmed=${sj0.confirmedTotalYen}円`,
  );
  const sjP = calculateSupportEffects(
    planOf([planned("a", 1)], "東京都新宿区"),
    [shinjukuGift],
  );
  check(
    "新宿区臨時給付金: 出生予定児童にも支給対象として計上（出生年 t=1）",
    sjP.confirmedTotalYen === 10_000 && sjP.effects[0].yearlyYen[1] === 10_000,
    `confirmed=${sjP.confirmedTotalYen}円 / yearly=${sjP.effects[0].yearlyYen.slice(0, 3).join(",")}`,
  );

  // ══════════════════════════════════════════════════════════
  section("B. 支給単位: 世帯・申請・工事単位の制度は1回のみ計上");
  // ══════════════════════════════════════════════════════════
  // 子育て世帯住宅リフォーム支援制度（工事費1/3・上限20万円＝申請・工事1件につき1回）
  const rf2 = calculateSupportEffects(
    planOf([child("a", 8), child("b", 3)], "東京都台東区"),
    [reformGrant],
  );
  check(
    "リフォーム支援: 2人以上の子どもがいる世帯でも1回だけ計上（200,000円×子の数にならない）",
    rf2.estimatedTotalYen === 200_000,
    `${rf2.estimatedTotalYen}円`,
  );
  check(
    "リフォーム支援: 子ども別の合計も世帯合計と一致（Σ=200,000円）",
    rf2.effects[0].perChild.reduce((s, c) => s + (c.totalYen ?? 0), 0) ===
      200_000,
    rf2.effects[0].perChild.map((c) => String(c.totalYen)).join(","),
  );
  const rfEst = estimateSupports(
    planOf([child("a", 8), child("b", 3)], "東京都台東区"),
    [reformGrant],
  );
  check(
    "リフォーム支援: 計上単位は1（世帯・申請・工事で1回）",
    rfEst.estimates[0].unitBreakdown.countedUnits === 1,
    JSON.stringify(rfEst.estimates[0].unitBreakdown),
  );
  check(
    "リフォーム支援: 上限額のみ確認済み（capOnly）のため確定額にせず推定枠へ計上",
    rf2.confirmedTotalYen === 0 && rf2.estimatedTotalYen === 200_000,
    `confirmed=${rf2.confirmedTotalYen} / estimated=${rf2.estimatedTotalYen}`,
  );

  // ══════════════════════════════════════════════════════════
  section("C. 地域条件（対象地域外・居住地未入力）");
  // ══════════════════════════════════════════════════════════
  const sjOther = calculateSupportEffects(
    planOf([child("a", 8), child("b", 3)], "東京都世田谷区"),
    [shinjukuGift],
  );
  check(
    "新宿区の制度を対象地域外の世帯（世田谷区）に計上しない",
    !sjOther.effects[0].includedInTotal &&
      sjOther.estimatedTotalYen === 0 &&
      (sjOther.effects[0].excludedReason ?? "").includes("対象地域外"),
    sjOther.effects[0].excludedReason ?? "",
  );
  const rfOther = calculateSupportEffects(
    planOf([child("a", 8)], "東京都世田谷区"),
    [reformGrant],
  );
  check(
    "台東区のリフォーム支援を対象地域外の世帯に計上しない",
    !rfOther.effects[0].includedInTotal &&
      rfOther.estimatedTotalYen === 0 &&
      (rfOther.effects[0].excludedReason ?? "").includes("対象地域外"),
    rfOther.effects[0].excludedReason ?? "",
  );
  const unknownRegion = calculateSupportEffects(planOf([child("a", 0)], "未定"), [
    shinjukuGift,
    reformGrant,
  ]);
  check(
    "居住地が未入力・未定なら地域限定制度を確定額として扱わない（合計0円・理由付き）",
    unknownRegion.confirmedTotalYen === 0 &&
      unknownRegion.estimatedTotalYen === 0 &&
      unknownRegion.uncounted.length === 2 &&
      unknownRegion.uncounted.every((e) =>
        (e.excludedReason ?? "").includes("居住地"),
      ),
    unknownRegion.uncounted.map((e) => e.excludedReason ?? "").join(" / "),
  );

  // ══════════════════════════════════════════════════════════
  section("D. 参考費用の負値（F-2）");
  // ══════════════════════════════════════════════════════════
  // 22歳（費用0円）の子＋50万円の一時金 → 支援が費用を上回る
  const surplusResult = buildSimulationResult(
    inputOf([rowOf("a", 22)], "東京都文京区"),
    [oneTimeOpen(500_000, "fx-surplus")],
  );
  check(
    "支援>費用: afterAllYen は 0円以下にならない（0円で表示）",
    surplusResult.comparison.afterAllYen === 0,
    String(surplusResult.comparison.afterAllYen),
  );
  check(
    "支援>費用: 上回る分は supportSurplusYen に分離（内部計算と表示が整合）",
    surplusResult.comparison.supportSurplusYen === 500_000,
    String(surplusResult.comparison.supportSurplusYen),
  );
  check(
    "支援>費用: afterConfirmedYen も負値にならない",
    surplusResult.comparison.afterConfirmedYen >= 0 &&
      surplusResult.comparison.afterAllYen >= 0,
    `${surplusResult.comparison.afterConfirmedYen} / ${surplusResult.comparison.afterAllYen}`,
  );
  const sampleResult = buildSimulationResult(
    inputOf([rowOf("a", 8), rowOf("b", 3)], "東京都世田谷区"),
    registry,
  );
  check(
    "通常ケース: 費用>支援のときは従来どおり（afterAllYen=費用−確定−推定、surplus=0）",
    sampleResult.comparison.afterAllYen ===
      sampleResult.comparison.grossCostYen -
        sampleResult.supportTotals.confirmedYen -
        sampleResult.supportTotals.estimatedYen &&
      sampleResult.comparison.supportSurplusYen === 0,
    `gross=${sampleResult.comparison.grossCostYen} after=${sampleResult.comparison.afterAllYen}`,
  );

  // ══════════════════════════════════════════════════════════
  section("E. 現金給付・費用軽減・貸付の合計分離");
  // ══════════════════════════════════════════════════════════
  const cashP = fixtureProgram({
    id: "fx-cash",
    name: "現金給付テスト",
    category: "cash_benefit",
    amount: {
      value: 10_000,
      unit: "yen_per_month",
      basis: "confirmed",
      description: "月額10,000円（確認済み・テスト）",
    },
    period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
  });
  const feeP = fixtureProgram({
    id: "fx-fee",
    name: "費用軽減テスト",
    category: "fee_reduction",
    amount: {
      value: 5_000,
      unit: "yen_per_month",
      basis: "confirmed",
      description: "月額5,000円分の軽減（確認済み・テスト）",
    },
    period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
  });
  const loanP = fixtureProgram({
    id: "fx-loan",
    name: "貸付テスト",
    category: "loan",
    amount: {
      value: 100_000,
      unit: "yen_per_year",
      basis: "estimated",
      description: "年額100,000円（推定・テスト）",
    },
    period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
  });
  const splitResult = buildSimulationResult(
    inputOf([rowOf("a", 0)], "東京都文京区"),
    [cashP, feeP, loanP],
  );
  const st = splitResult.supportTotals;
  check(
    "現金給付は現金給付としてのみ集計（10,000円/月×12か月=120,000円・確定）",
    st.cashBenefit.confirmedYen === 120_000 && st.cashBenefit.estimatedYen === 0,
    JSON.stringify(st.cashBenefit),
  );
  check(
    "費用軽減は費用軽減としてのみ集計（5,000円/月×12か月=60,000円・確定）",
    st.feeReduction.confirmedYen === 60_000 && st.feeReduction.estimatedYen === 0,
    JSON.stringify(st.feeReduction),
  );
  check(
    "貸付は合計に含めず参考額として分離（100,000円・返済が必要）",
    st.loanReferenceYen === 100_000 &&
      st.confirmedYen === 180_000 &&
      st.estimatedYen === 0,
    `loan=${st.loanReferenceYen} confirmed=${st.confirmedYen}`,
  );
  check(
    "貸付は合計に含めない（uncounted に理由付き）",
    st.uncounted.some(
      (e) =>
        e.program.id === "fx-loan" && (e.excludedReason ?? "").includes("貸付"),
    ),
    st.uncounted.map((e) => e.program.id).join(","),
  );

  // ══════════════════════════════════════════════════════════
  section("F. 回帰（既存の計算・合計が変わらない）");
  // ══════════════════════════════════════════════════════════
  const e0 = calculateSupportEffects(planOf([child("c1", 0)]), [childAllowance])
    .effects[0];
  check(
    "児童手当: 0歳から0〜17歳の18年分（代表値120,000円/年・推定のまま）",
    e0.estimatedTotalYen === 2_160_000 &&
      childAllowance.amount.basis === "estimated",
    `${e0.estimatedTotalYen}円 / basis=${childAllowance.amount.basis}`,
  );
  const regCalc = calculateSupportEffects(planOf([child("c1", 0)]), registry);
  check(
    "レジストリ全体（文京区想定）: 確定額0円・推定2,516,400円のまま（地域条件で新宿区・台東区は対象外）",
    regCalc.confirmedTotalYen === 0 && regCalc.estimatedTotalYen === 2_516_400,
    `confirmed=${regCalc.confirmedTotalYen} / estimated=${regCalc.estimatedTotalYen}`,
  );
  const regSj = calculateSupportEffects(
    planOf([child("c1", 0)], "東京都新宿区"),
    registry,
  );
  check(
    "新宿区在住・0歳児: 臨時給付金10,000円が確定額に計上される（F-1解消）",
    regSj.confirmedTotalYen === 10_000 && regSj.estimatedTotalYen === 2_516_400,
    `confirmed=${regSj.confirmedTotalYen} / estimated=${regSj.estimatedTotalYen}`,
  );
  const estSj = estimateSupports(
    planOf([child("a", 8), child("b", 3)], "東京都新宿区"),
    [shinjukuGift],
  );
  const estRf = estimateSupports(
    planOf([child("a", 8), child("b", 3)], "東京都台東区"),
    [reformGrant],
  );
  check(
    "estimate と calculate の合計一致（新宿区20,000円は確定／台東区リフォーム200,000円は推定）",
    estSj.confirmedTotalYen === 20_000 &&
      estSj.estimatedTotalYen === 0 &&
      estRf.confirmedTotalYen === 0 &&
      estRf.estimatedTotalYen === 200_000,
    `sj=${estSj.confirmedTotalYen}/${estSj.estimatedTotalYen} rf=${estRf.confirmedTotalYen}/${estRf.estimatedTotalYen}`,
  );
}

main();

if (failed > 0) {
  console.error(`\nNG: ${failed} 件のチェックが失敗しました`);
  process.exit(1);
}
console.log(
  "\nPASS: M7-J1 一時金計上・地域条件・支援区分分離の検証はすべて成功しました",
);
