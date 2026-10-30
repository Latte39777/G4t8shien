/**
 * M6-B 検証スクリプト：公的支援制度の公式情報を扱う基盤
 * 実行: npx tsx scripts/verify-m6b.tsx
 *
 * 検証範囲:
 * 1. 金額未確認の制度を誤って確定額にしない（AI候補の正規化・計算・表示）
 * 2. 月額・年額・一時金の計算が区別される
 * 3. 対象年齢・対象期間が一致しない場合に誤計上しない
 * 4. 複数の子ども・複数の制度で二重計上しない
 * 5. 公式URL未確認の制度を公式リンクとして表示しない
 * 6. モックデータでも既存の画面・相談機能が引き続き動作する
 *
 * 外部サイトへのアクセス・AI API 呼び出し・APIキー設定は行わない。
 */
import { renderToString } from "react-dom/server";
import { z } from "zod";
import { supportProgramSchema, type SupportProgram } from "../lib/types/support";
import type { ChildInput, FamilyPlan } from "../lib/types/finance";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
import {
  attachSources,
  createSourceRecord,
  isOfficialLink,
  latestCheckedAt,
  recordRetrieval,
  sourceDisplayEntry,
} from "../lib/supports/evidence";
import { normalizeResearchCandidate } from "../lib/supports/research";
import { matchProgramToPlan } from "../lib/supports/matching";
import { estimateSupports } from "../lib/supports/estimate";
import {
  amountText,
  legalBasisText,
  sourceEntryText,
  unitBreakdownText,
} from "../lib/supports/display";
import { GET } from "../app/api/supports/route";
import { SupportCard } from "../components/SupportList";
import {
  buildInitialMessages,
  toConsultContextProgram,
} from "../lib/consult/conversation";
import { buildMockReply } from "../lib/consult/mockAdvisor";
import type { ConsultRequest } from "../lib/consult/types";
import { SAMPLE_INPUT, toFamilyPlan } from "../lib/simulation";
import { buildSimulationResult } from "../lib/result";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok" : "NG"}: ${name}${cond || !detail ? "" : ` -- ${detail}`}`);
  if (!cond) {
    failed += 1;
    console.error(`NG: ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── フィクスチャ（テスト用の入力・制度データ。モックデータは変更しない）──
const child = (
  id: string,
  age: number | null,
  birthInYears: number | null = null,
): ChildInput => ({
  id,
  currentAgeYears: age,
  birthInYears,
  course: "public",
  universityCourse: "national",
});

const planOf = (
  children: ChildInput[],
  annualIncome: number | null = 5_000_000,
): FamilyPlan => ({
  municipality: "東京都文京区",
  householdType: "couple",
  annualIncome,
  monthlyBaseExpense: 200_000,
  savings: 1_000_000,
  children,
  monthlyTakeHomeYen: 300_000,
  incomeChange: null,
});

const UNVERIFIED_SOURCE = {
  title: "公式資料（テスト）",
  organization: "テスト機関",
  url: null,
  urlVerified: false,
  official: true,
  checkedAt: "2026-10-13",
} as const;

const programOf = (
  over: Partial<SupportProgram> & { id: string; name: string },
): SupportProgram => ({
  category: "cash_benefit",
  level: "national",
  summary: "テスト制度",
  amount: {
    value: 10_000,
    unit: "yen_per_month",
    basis: "estimated",
    description: "月額（推定・要確認）",
  },
  period: { startAgeYears: 0, endAgeYears: 22, durationMonths: null },
  conditions: {
    combinedWith: [],
    incomeLimitNote: null,
    householdNote: null,
    other: [],
  },
  application: { where: null, documents: [], deadlineNote: null, steps: [] },
  eligibility: "likely",
  eligibilityNote: "テスト判定",
  legalBasis: { lawName: null, ordinanceName: null, note: "根拠法令は未確認" },
  sources: [{ ...UNVERIFIED_SOURCE }],
  checkedAt: "2026-10-13",
  missingInformation: [],
  mock: true,
  ...over,
});

// ══════════════════════════════════════════════════════════════
// 1. 金額未確認の制度を誤って確定額にしない
// ══════════════════════════════════════════════════════════════
section("1. 金額未確認の制度を誤って確定額にしない");

// 1-A. AI 候補が「確認済み」を主張しても、検証済み公式出典がなければ確定にしない
const aiCandidate = {
  name: "テスト手当",
  summary: "AIが抽出した候補",
  category: "cash_benefit",
  level: "tokyo",
  amount: {
    value: 15_000,
    unit: "yen_per_month",
    claimedBasis: "confirmed" as const,
    description: "月15,000円（AI主張の確認済み）",
  },
  period: { startAgeYears: 0, endAgeYears: 17 },
  application: {
    where: "区役所",
    deadlineNote: "出生から30日以内（AI主張）",
    deadlineDate: "2027-03-31",
  },
  legalBasis: {
    lawName: "AIが推測した法律名",
    ordinanceName: "AIが推測した条例名",
    note: null,
  },
  sources: [
    {
      title: "公式ページ（未検証）",
      organization: "テスト自治体",
      url: "https://example.invalid/program",
      urlVerified: true, // AI が自己申告した検証済みフラグ（信用しない）
      official: true,
      checkedAt: "2026-10-13",
    },
  ],
  checkedAt: "2026-10-13",
};
const normalized = normalizeResearchCandidate(aiCandidate);
check(
  "AI候補: 正規化結果がスキーマを通過",
  normalized.program !== null,
  normalized.problems.join(" / "),
);
const np = normalized.program;
if (np) {
  check(
    "AI候補: 検証済み出典なしでは金額を confirmed にしない",
    np.amount.basis !== "confirmed",
    `basis=${np.amount.basis}`,
  );
  check(
    "AI候補: 金額の値は保持するが推定扱い（estimated）",
    np.amount.value === 15_000 && np.amount.basis === "estimated",
  );
  check(
    "AI候補: 根拠法令名・条例名を採用しない（AI推測を確定表示しない）",
    np.legalBasis.lawName === null && np.legalBasis.ordinanceName === null,
  );
  check(
    "AI候補: 申請期限を確定させない",
    np.application.deadlineNote === null && np.application.deadlineDate === null,
  );
  check(
    "AI候補: 受給資格を確定させない（unconfirmed 固定）",
    np.eligibility === "unconfirmed",
    `eligibility=${np.eligibility}`,
  );
  check(
    "AI候補: URL を公式リンク扱いしない",
    np.sources.every((s) => !isOfficialLink(s)),
  );
  check(
    "AI候補: 未確認項目に理由が記録される",
    (np.unconfirmedItems ?? []).length >= 3 &&
      (np.unconfirmedItems ?? []).every((u) => u.reason.length > 0),
  );
  const legalShown = legalBasisText(np.legalBasis);
  check(
    "AI候補: 表示文言で法令名を「未確認」とする",
    legalShown.text.includes("未確認") && legalShown.needsCheck,
    legalShown.text,
  );
}

// 1-B. 検証済み公式出典がある場合のみ confirmed を許容（対照ケース）
const verifiedCandidate = {
  ...aiCandidate,
  name: "テスト手当（検証済み出典あり）",
};
const normalizedVerified = normalizeResearchCandidate(verifiedCandidate, {
  trustVerification: true,
});
check(
  "検証済み出典あり: 確認済み主張を confirmed として扱える",
  normalizedVerified.program?.amount.basis === "confirmed",
  `basis=${normalizedVerified.program?.amount.basis}`,
);

// 1-C. 金額が無い候補は unknown/null（推測で補完しない）
const noAmount = normalizeResearchCandidate({
  name: "金額不明制度",
  sources: [{ title: "資料", organization: "機関", checkedAt: "2026-10-13" }],
  checkedAt: "2026-10-13",
});
check(
  "金額なし候補: value=null / basis=unknown（補完しない）",
  noAmount.program?.amount.value === null &&
    noAmount.program?.amount.basis === "unknown",
);

// 1-D. 確認日・制度名が無い候補は保存しない
const noCheckedAt = normalizeResearchCandidate({
  name: "確認日なし制度",
  sources: [{ title: "資料", organization: "機関" }],
});
check(
  "確認日なし候補: 保存せず問題として返す",
  noCheckedAt.program === null && noCheckedAt.problems.length > 0,
);
const noName = normalizeResearchCandidate({
  sources: [{ title: "資料", organization: "機関", checkedAt: "2026-10-13" }],
});
check("制度名なし候補: 保存せず問題として返す", noName.program === null);

// 1-E. 計算: 金額未確認（basis: unknown）を合計に含めない
const plan2 = planOf([child("c1", 0)]);
const unknownAmountProgram = programOf({
  id: "unknown-amount",
  name: "金額未確認制度",
  amount: {
    value: 50_000,
    unit: "yen_per_month",
    basis: "unknown",
    description: "金額未確認",
  },
});
const unknownResult = estimateSupports(plan2, [unknownAmountProgram]);
const unknownEstimate = unknownResult.estimates[0];
check(
  "計算: 金額未確認は合計に含めない",
  unknownEstimate !== undefined && !unknownEstimate.countedInTotal,
);
check(
  "計算: 除外理由に金額未確認が記録される",
  (unknownEstimate?.excludedReason ?? "").includes("金額が未確認"),
  unknownEstimate?.excludedReason ?? "",
);
check(
  "計算: 未確認金額を推測して合計に足さない（合計0円）",
  unknownResult.confirmedTotalYen === 0 && unknownResult.estimatedTotalYen === 0,
);
check(
  "表示: 未確認金額は「金額未確認」と表示",
  amountText(unknownAmountProgram) === "金額未確認（要確認）",
  amountText(unknownAmountProgram),
);
check(
  "表示: 単位別内訳も未確認を明示",
  unitBreakdownText(unknownEstimate!).includes("金額未確認"),
);

// ══════════════════════════════════════════════════════════════
// 2. 月額・年額・一時金の計算が区別される
// ══════════════════════════════════════════════════════════════
section("2. 月額・年額・一時金の計算が区別される");

const planOneInfant = planOf([child("c1", 0)]);
const monthlyP = programOf({
  id: "p-monthly",
  name: "月額制度",
  amount: {
    value: 10_000,
    unit: "yen_per_month",
    basis: "estimated",
    description: "月額1万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const annualP = programOf({
  id: "p-annual",
  name: "年額制度",
  amount: {
    value: 100_000,
    unit: "yen_per_year",
    basis: "estimated",
    description: "年額10万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const lumpP = programOf({
  id: "p-lump",
  name: "一時金制度",
  amount: {
    value: 500_000,
    unit: "yen_one_time",
    basis: "estimated",
    description: "一時金50万円",
  },
  period: { startAgeYears: 0, endAgeYears: 2, durationMonths: null },
});

const unitResult = estimateSupports(planOneInfant, [monthlyP, annualP, lumpP]);
const monthlyE = unitResult.estimates.find((e) => e.program.id === "p-monthly")!;
const annualE = unitResult.estimates.find((e) => e.program.id === "p-annual")!;
const lumpE = unitResult.estimates.find((e) => e.program.id === "p-lump")!;

check(
  "月額: 月1万円×12か月=年12万円（対象年のみ）",
  monthlyE.effect.yearlyYen[0] === 120_000 && monthlyE.householdTotalYen === 120_000,
  `yearly[0]=${monthlyE.effect.yearlyYen[0]} total=${monthlyE.householdTotalYen}`,
);
check(
  "年額: 年10万円×1年=10万円",
  annualE.effect.yearlyYen[0] === 100_000 && annualE.householdTotalYen === 100_000,
);
check(
  "一時金: 初回の対象年に1回のみ計上（2年目・3年目は0円）",
  lumpE.effect.yearlyYen[0] === 500_000 &&
    lumpE.effect.yearlyYen[1] === 0 &&
    lumpE.effect.yearlyYen[2] === 0 &&
    lumpE.householdTotalYen === 500_000,
  `yearly=${lumpE.effect.yearlyYen.slice(0, 3).join(",")}`,
);
check(
  "単位区別: 月額の計上単位数は12か月",
  monthlyE.unitBreakdown.unit === "yen_per_month" &&
    monthlyE.unitBreakdown.countedUnits === 12,
);
check(
  "単位区別: 年額の計上単位数は1年",
  annualE.unitBreakdown.unit === "yen_per_year" &&
    annualE.unitBreakdown.countedUnits === 1,
);
check(
  "単位区別: 一時金の計上単位数は1回",
  lumpE.unitBreakdown.unit === "yen_one_time" &&
    lumpE.unitBreakdown.countedUnits === 1,
);
check(
  "単位区別: 内訳表示に単位が明示される",
  unitBreakdownText(monthlyE).includes("月額") &&
    unitBreakdownText(annualE).includes("年額") &&
    unitBreakdownText(lumpE).includes("一時金"),
);

// 支給期間の上限（月数）が正しく効く
const cappedP = programOf({
  id: "p-capped",
  name: "支給期間上限つき月額",
  amount: {
    value: 10_000,
    unit: "yen_per_month",
    basis: "estimated",
    description: "月額・24か月上限",
  },
  period: { startAgeYears: 0, endAgeYears: 22, durationMonths: 24 },
});
const cappedResult = estimateSupports(planOneInfant, [cappedP]);
check(
  "支給期間上限: 月額×24か月で頭打ち（1人24万円）",
  cappedResult.estimates[0].householdTotalYen === 240_000,
  `total=${cappedResult.estimates[0].householdTotalYen}`,
);

// ══════════════════════════════════════════════════════════════
// 3. 対象年齢・対象期間が一致しない場合に誤計上しない
// ══════════════════════════════════════════════════════════════
section("3. 対象年齢・対象期間が一致しない場合に誤計上しない");

// 3-A. 対象年齢（0〜2歳）に誰も該当しない世帯 → 対象外・0円
const planOlder = planOf([child("c1", 5), child("c2", 10)]);
const infantOnlyP = programOf({
  id: "p-infant-only",
  name: "0〜2歳限定制度",
  period: { startAgeYears: 0, endAgeYears: 2, durationMonths: null },
});
const mismatchResult = estimateSupports(planOlder, [infantOnlyP]);
const mismatchE = mismatchResult.estimates[0];
check(
  "年齢不一致: 見込額は0円",
  mismatchE.householdTotalYen === 0,
  `total=${mismatchE.householdTotalYen}`,
);
check(
  "年齢不一致: 合計に含めない",
  !mismatchE.countedInTotal && mismatchResult.estimatedTotalYen === 0,
);
check(
  "年齢不一致: 照合結果も対象外（計算と判定が一致）",
  mismatchE.match.eligibility === "ineligible" &&
    mismatchE.effect.eligibility === "ineligible",
);
check(
  "年齢不一致: 照合で対象年齢の重なりなしと判定",
  mismatchE.match.perChild.every((m) => !m.overlaps),
);

// 3-B. 一部の子どもだけが対象年齢 → 対象外の子どもを誤計上しない
const planMixed = planOf([child("c1", 0), child("c2", 10)]);
const age0OnlyP = programOf({
  id: "p-age0-only",
  name: "0歳児のみ制度",
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const mixedResult = estimateSupports(planMixed, [age0OnlyP]);
const mixedE = mixedResult.estimates[0];
const mixedC1 = mixedE.perChild.find((p) => p.childId === "c1")!;
const mixedC2 = mixedE.perChild.find((p) => p.childId === "c2")!;
check(
  "年齢部分一致: 対象の子のみ計上（c1=12万円, c2=0円）",
  mixedC1.totalYen === 120_000 && mixedC2.totalYen === 0,
  `c1=${mixedC1.totalYen} c2=${mixedC2.totalYen}`,
);
check(
  "年齢部分一致: 対象外の子は照合でも重なりなし",
  mixedE.match.perChild.find((m) => m.childId === "c2")?.overlaps === false &&
    mixedE.match.perChild.find((m) => m.childId === "c1")?.overlaps === true,
);

// 3-C. 対象期間の前後（支給期間外の年）に誤計上しない
const cappedEffect = cappedResult.estimates[0];
check(
  "対象期間外: 24か月上限を超えて計上しない",
  (cappedEffect.effect.yearlyYen.reduce((a, b) => a + b, 0)) === 240_000,
);

// 3-D. 条件が不明な場合、満たす/満たさないを推測しない（照合レイヤ）
const incomeLimitedP = programOf({
  id: "p-income-limited",
  name: "所得制限つき制度",
  conditions: {
    combinedWith: [],
    incomeLimitNote: "世帯所得の制限あり（基準額は未確認）",
    householdNote: null,
    other: [],
  },
});
const noIncomePlan = planOf([child("c1", 0)], null);
const incomeMatch = matchProgramToPlan(incomeLimitedP, noIncomePlan);
check(
  "条件不明: 所得条件を満たすと推測しない（unknown）",
  incomeMatch.incomeMatch === "unknown",
  `incomeMatch=${incomeMatch.incomeMatch}`,
);
check(
  "条件不明: 不足情報を理由付きで記録",
  incomeMatch.missing.includes("世帯収入") && incomeMatch.reasons.length > 0,
);
check(
  "条件不明: 「受給できる可能性あり」に確定させない",
  incomeMatch.eligibility !== "likely",
  `eligibility=${incomeMatch.eligibility}`,
);
const householdLimitedMatch = matchProgramToPlan(
  programOf({
    id: "p-household-limited",
    name: "世帯条件つき制度",
    conditions: {
      combinedWith: [],
      incomeLimitNote: null,
      householdNote: "ひとり親世帯向け",
      other: [],
    },
  }),
  noIncomePlan,
);
check(
  "条件不明: 世帯構成条件も推測しない（unknown）",
  householdLimitedMatch.householdMatch === "unknown",
);

// ══════════════════════════════════════════════════════════════
// 4. 複数の子ども・複数の制度で二重計上しない
// ══════════════════════════════════════════════════════════════
section("4. 複数の子ども・複数の制度で二重計上しない");

// 4-A. 子ども別の合計 = 世帯合計（Σ年次とも一致）
const fullPeriodMonthlyP = programOf({
  id: "p-full-monthly",
  name: "0〜22歳の月額制度",
});
const multiResult = estimateSupports(planMixed, [fullPeriodMonthlyP]);
const multiE = multiResult.estimates[0];
const perChildSum = multiE.perChild.reduce(
  (a, p) => a + (p.totalYen ?? 0),
  0,
);
const yearlySum = multiE.effect.yearlyYen.reduce((a, b) => a + b, 0);
check(
  "複数子ども: Σ子ども別 = 世帯合計",
  perChildSum === multiE.householdTotalYen,
  `ΣperChild=${perChildSum} household=${multiE.householdTotalYen}`,
);
check(
  "複数子ども: Σ年次 = 世帯合計（二重計上なし）",
  yearlySum === multiE.householdTotalYen,
  `Σyearly=${yearlySum}`,
);
check(
  "複数子ども: 実額も正しい（c1=0〜22歳23年分＋c2=10〜22歳13年分）",
  multiE.householdTotalYen === 23 * 120_000 + 13 * 120_000,
  `total=${multiE.householdTotalYen}`,
);

// 4-B. 併用不可（combinedWith）は金額の大きい方のみ計上
const conflictA = programOf({
  id: "p-conflict-a",
  name: "併用不可A",
  amount: {
    value: 100_000,
    unit: "yen_per_year",
    basis: "estimated",
    description: "年額10万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
  conditions: {
    combinedWith: ["p-conflict-b"],
    incomeLimitNote: null,
    householdNote: null,
    other: [],
  },
});
const conflictB = programOf({
  id: "p-conflict-b",
  name: "併用不可B",
  amount: {
    value: 200_000,
    unit: "yen_per_year",
    basis: "estimated",
    description: "年額20万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const conflictResult = estimateSupports(planOneInfant, [conflictA, conflictB]);
check(
  "併用不可: 大きい方（B=20万円）のみ合計",
  conflictResult.estimatedTotalYen === 200_000,
  `total=${conflictResult.estimatedTotalYen}`,
);
const conflictAE = conflictResult.estimates.find((e) => e.program.id === "p-conflict-a")!;
check(
  "併用不可: 小さい方（A）は理由付きで除外",
  !conflictAE.countedInTotal &&
    (conflictAE.excludedReason ?? "").includes("併用不可"),
  conflictAE.excludedReason ?? "",
);

// 4-C. 利用中の制度（現在の家計に反映済み）は加算しない
const usedResult = estimateSupports(planOneInfant, [conflictA, conflictB], {
  excludeProgramIds: ["p-conflict-a"],
});
check(
  "利用中制度: 見込み額に含めない（20万円のみ）",
  usedResult.estimatedTotalYen === 200_000,
  `total=${usedResult.estimatedTotalYen}`,
);
check(
  "利用中制度: 除外理由に現在利用中が記録される",
  (usedResult.estimates.find((e) => e.program.id === "p-conflict-a")
    ?.excludedReason ?? "").includes("現在利用中"),
);

// 4-D. 重複のない複数制度は正しく合算（Σ制度＝合計）
const plainA = programOf({
  id: "p-plain-a",
  name: "通常制度A",
  amount: {
    value: 100_000,
    unit: "yen_per_year",
    basis: "estimated",
    description: "年額10万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const plainB = programOf({
  id: "p-plain-b",
  name: "通常制度B",
  amount: {
    value: 200_000,
    unit: "yen_per_year",
    basis: "estimated",
    description: "年額20万円",
  },
  period: { startAgeYears: 0, endAgeYears: 0, durationMonths: null },
});
const noConflictResult = estimateSupports(planOneInfant, [plainA, plainB]);
check(
  "複数制度: 併用不可条件が無ければ合算（30万円）",
  noConflictResult.estimatedTotalYen === 300_000,
  `total=${noConflictResult.estimatedTotalYen}`,
);

// 4-E. 貸付は現金給付と同じ扱いにしない（合計対象外・返済必須）
const loanP = programOf({
  id: "p-loan",
  name: "貸付制度",
  category: "loan",
  amount: {
    value: 300_000,
    unit: "yen_one_time",
    basis: "estimated",
    description: "貸付30万円",
  },
});
const loanResult = estimateSupports(planOneInfant, [loanP]);
const loanE = loanResult.estimates[0];
check(
  "貸付: 合計に含めない",
  !loanE.countedInTotal && loanResult.estimatedTotalYen === 0,
);
check(
  "貸付: 返済が必要と明示（現金給付と区別）",
  loanE.isRepaymentRequired &&
    (loanE.excludedReason ?? "").includes("貸付"),
  loanE.excludedReason ?? "",
);

// 4-F. 費用減免と現金給付の区分を保持
const feeP = programOf({
  id: "p-fee",
  name: "費用減免制度",
  category: "fee_reduction",
});
check(
  "費用減免: 区分を保持（現金給付と区別できる）",
  feeP.category === "fee_reduction" &&
    estimateSupports(planOneInfant, [feeP]).estimates[0].benefitKind ===
      "fee_reduction",
);

// ══════════════════════════════════════════════════════════════
// 5. 公式URL未確認の制度を公式リンクとして表示しない
// ══════════════════════════════════════════════════════════════
section("5. 公式URL未確認の制度を公式リンクとして表示しない");

const verifiedSource = createSourceRecord({
  title: "公式ページ",
  organization: "テスト自治体",
  url: "https://example.invalid/official",
  urlVerified: true,
  official: true,
  checkedAt: "2026-10-13",
  retrievedAt: "2026-10-13T00:00:00Z",
  extractionMethod: "manual",
});
check(
  "URL検証済み: 公式リンクとして扱う",
  isOfficialLink(verifiedSource),
);
const unverifiedWithUrl = createSourceRecord({
  title: "未検証ページ",
  organization: "テスト自治体",
  url: "https://example.invalid/maybe",
  urlVerified: false,
  official: true,
  checkedAt: "2026-10-13",
});
check(
  "URL未確認: URL文字列があっても公式リンクとして扱わない",
  !isOfficialLink(unverifiedWithUrl),
);
check(
  "URL未確認: 表示はリンクにせず未確認文言",
  (() => {
    const e = sourceDisplayEntry(unverifiedWithUrl);
    return (
      !e.isLink &&
      e.href === null &&
      e.unverifiedText === "URL未確認（公式リンクとして扱いません）"
    );
  })(),
);
check(
  "非公式出典: official=false は公式リンクにしない",
  !isOfficialLink(
    createSourceRecord({
      title: "非公式",
      organization: "民間",
      url: "https://example.invalid/private",
      urlVerified: true,
      official: false,
      checkedAt: "2026-10-13",
    }),
  ),
);
check(
  "URL欠落: url なしに urlVerified 主張しても検証済みにしない",
  !isOfficialLink(
    createSourceRecord({
      title: "URLなし",
      organization: "テスト",
      url: null,
      urlVerified: true,
      official: true,
      checkedAt: "2026-10-13",
    }),
  ),
);
check(
  "取得記録: 取得日時を保存でき、検証状態は変わらない",
  (() => {
    const r = recordRetrieval(unverifiedWithUrl, {
      retrievedAt: "2026-10-14T00:00:00Z",
      extractionMethod: "ai-extraction",
    });
    return (
      r.retrievedAt === "2026-10-14T00:00:00Z" &&
      r.extractionMethod === "ai-extraction" &&
      !isOfficialLink(r)
    );
  })(),
);
check(
  "出典保存: 重複登録しない・確認日を更新",
  (() => {
    const base = programOf({ id: "p-evidence", name: "根拠テスト" });
    const updated = attachSources(base, [
      base.sources[0],
      {
        ...verifiedSource,
        checkedAt: "2026-10-20",
      },
    ]);
    return (
      updated.sources.length === 2 &&
      latestCheckedAt(updated) === "2026-10-20"
    );
  })(),
);
const entryVerified = sourceEntryText(verifiedSource);
check(
  "表示: 検証済みのみリンク先を返す",
  entryVerified.isLink && entryVerified.href === "https://example.invalid/official",
);
const entryUnverified = sourceEntryText(unverifiedWithUrl);
check(
  "表示: 未確認URLは公式リンク文言（href なし）",
  !entryUnverified.isLink &&
    entryUnverified.href === null &&
    entryUnverified.unverifiedText === "URL未確認（公式リンクとして扱いません）",
);

// ══════════════════════════════════════════════════════════════
// 6. モックデータでも既存の画面・相談機能が引き続き動作する
// ══════════════════════════════════════════════════════════════
async function main(): Promise<void> {
section("6. モックデータでも既存の画面・相談機能が引き続き動作する");

// 6-A. モックデータが拡張後のスキーマでも検証を通過（後方互換）
const mockParsed = z.array(supportProgramSchema).safeParse(MOCK_SUPPORT_PROGRAMS);
check(
  "モックデータ: 拡張後スキーマを全件通過",
  mockParsed.success,
  mockParsed.success ? "" : JSON.stringify(mockParsed.error.issues[0]),
);

// 6-B. /api/supports（モックのみ・外部通信なし）
const routeRes = await GET();
check("GET /api/supports: status 200", routeRes.status === 200);
const routeBody = (await routeRes.json()) as {
  mock: boolean;
  programs: SupportProgram[];
};
check(
  "GET /api/supports: モックデータを返す",
  routeBody.mock === true && routeBody.programs.length >= 4,
);

// 6-C. 既存の結果計算（buildSimulationResult）が動作し、合計が整合
const sampleResult = buildSimulationResult(SAMPLE_INPUT, MOCK_SUPPORT_PROGRAMS);
const includedEffects = sampleResult.supports.effects.filter(
  (e) => e.includedInTotal,
);
const sumEstimated = includedEffects
  .filter((e) => e.program.amount.basis !== "confirmed")
  .reduce((a, e) => a + (e.estimatedTotalYen ?? 0), 0);
const sumConfirmed = includedEffects
  .filter((e) => e.program.amount.basis === "confirmed")
  .reduce((a, e) => a + (e.estimatedTotalYen ?? 0), 0);
check(
  "既存計算: Σ制度（推定）＝推定合計（二重計上なし）",
  sumEstimated === sampleResult.supports.estimatedTotalYen,
  `Σ=${sumEstimated} total=${sampleResult.supports.estimatedTotalYen}`,
);
check(
  "既存計算: Σ制度（確定）＝確定合計",
  sumConfirmed === sampleResult.supports.confirmedTotalYen,
);
check(
  "既存計算: モックでは確定額0円・推定のみ計上",
  sampleResult.supports.confirmedTotalYen === 0 &&
    sampleResult.supports.estimatedTotalYen > 0,
);
const mockLoan = sampleResult.supports.uncounted.find(
  (e) => e.program.category === "loan",
);
check(
  "既存計算: モックの貸付制度は合計対象外",
  mockLoan !== undefined && (mockLoan.excludedReason ?? "").includes("貸付"),
);
const mockUnknown = sampleResult.supports.uncounted.find(
  (e) => e.program.amount.basis === "unknown",
);
check(
  "既存計算: モックの金額未確認制度は合計対象外",
  mockUnknown !== undefined,
);

// 6-D. 新レイヤ（estimate）でもモックが正しく扱える
const samplePlan = toFamilyPlan(SAMPLE_INPUT);
const mockEstimateResult = estimateSupports(samplePlan, MOCK_SUPPORT_PROGRAMS, {
  excludeProgramIds: SAMPLE_INPUT.household.usedSupportProgramIds,
});
check(
  "estimate: 既存計算と合計が一致",
  mockEstimateResult.estimatedTotalYen ===
    sampleResult.supports.estimatedTotalYen &&
    mockEstimateResult.confirmedTotalYen ===
      sampleResult.supports.confirmedTotalYen,
  `estimated=${mockEstimateResult.estimatedTotalYen}`,
);
check(
  "estimate: 二重計上防止の適用記録を返す",
  mockEstimateResult.doubleCountGuards.length > 0,
);

// 6-E. 支援制度カード（既存画面）の表示が継続
const cardHtml = renderToString(
  <SupportCard
    program={MOCK_SUPPORT_PROGRAMS[0]}
    effect={sampleResult.supports.effects[0]}
    isUsed={SAMPLE_INPUT.household.usedSupportProgramIds.includes(
      MOCK_SUPPORT_PROGRAMS[0].id,
    )}
    onConsult={() => {}}
  />,
);
for (const s of [
  "モック・未確認",
  "URL未確認（公式リンクとして扱いません）",
  "情報の確認日",
  "この世帯の見込額",
  "正式な受給資格の決定ではありません",
  "この制度について相談する",
]) {
  check(`SupportCard 表示: 「${s}」`, cardHtml.includes(s));
}
check(
  "SupportCard 表示: 未確認URLをリンクタグにしない",
  !cardHtml.includes('href="'),
);

// 6-F. 相談機能（モック）が引き続き動作
const contextProgram = toConsultContextProgram(MOCK_SUPPORT_PROGRAMS[0]);
check(
  "相談連携: 制度情報の引き継ぎが生成される",
  contextProgram.id === MOCK_SUPPORT_PROGRAMS[0].id &&
    contextProgram.amountDescription ===
      MOCK_SUPPORT_PROGRAMS[0].amount.description,
);
const initialMessages = buildInitialMessages({
  program: contextProgram,
  userContext: null,
});
check(
  "相談連携: 開始メッセージが生成される（制度名を明示しモック・未確認の扱いを維持）",
  initialMessages.length === 1 &&
    initialMessages[0].text.includes("児童手当（モック）") &&
    initialMessages[0].text.includes("について相談中です") &&
    initialMessages[0].hasUnverified &&
    (initialMessages[0].relatedPrograms[0]?.sourceType ?? null) === "mock" &&
    (initialMessages[0].relatedPrograms[0]?.note ?? "").includes("未確認"),
);
const consultReply = buildMockReply({
  message: "この制度の金額を教えてください",
  history: [],
  program: contextProgram,
  userContext: {
    childCount: SAMPLE_INPUT.children.length,
    hasAnnualIncome: SAMPLE_INPUT.household.annualIncomeYen !== null,
    usedProgramIds: SAMPLE_INPUT.household.usedSupportProgramIds,
  },
} satisfies ConsultRequest);
check(
  "相談応答: モック応答が生成され未確認情報を明示",
  consultReply.isMock && consultReply.hasUnverified && consultReply.text.length > 0,
);

// ── 総括 ──
if (failed > 0) {
  console.error(`\nM6-B 検証: ${failed} 件のチェックが失敗`);
  process.exit(1);
}
console.log("\nM6-B 検証: すべてのチェックに合格（外部通信なし）");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

