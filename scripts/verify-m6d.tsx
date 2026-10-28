/**
 * M6-D 検証スクリプト: 制度データの統一と計算・表示の整合
 *
 * 実行: npx tsx scripts/verify-m6d.tsx
 *
 * 確認項目（タスク §6）:
 * - 制度データの取得元が結果画面（API）・制度一覧・相談・入力フォームで統一されている
 * - 年齢による金額の区別（0〜17歳・15〜17歳・18歳での打ち切り）が計算に反映される
 * - 子ども別の金額・回数が世帯合計と一致する（複数子ども・一時金）
 * - 未確認の金額・条件が確定額に混入しない（確定/推定/未確認の分離・二重計上防止）
 * - 金額内訳（amountBands）は表示専用で、計算は単一金額を代表値として使う
 * - 対象条件が未確認の制度を推測で「対象外」に振り分けない
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { SupportProgram } from "../lib/types/support";
import type { ChildInput, FamilyPlan } from "../lib/types/finance";
import { getSupportPrograms } from "../lib/supports/registry";
import { calculateSupportEffects } from "../lib/finance/supports";
import { estimateSupports } from "../lib/supports/estimate";
import { buildMockReply } from "../lib/consult/mockAdvisor";
import {
  buildInitialMessages,
  toConsultContextProgram,
} from "../lib/consult/conversation";
import type { ConsultRequest } from "../lib/consult/types";
import { GET } from "../app/api/supports/route";

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

// ── フィクスチャ（テスト専用。モックデータ・公式データは変更しない）──
const child = (id: string, age: number | null): ChildInput => ({
  id,
  currentAgeYears: age,
  birthInYears: null,
  course: "public",
  universityCourse: "national",
});

const planOf = (children: ChildInput[]): FamilyPlan => ({
  municipality: "東京都文京区",
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
      checkedAt: "2026-10-13",
    },
  ],
  checkedAt: "2026-10-13",
  missingInformation: [],
  mock: true,
  ...over,
});

const registry = getSupportPrograms();
function programById(id: string): SupportProgram {
  const found = registry.find((p) => p.id === id);
  if (!found) {
    throw new Error(`registry に ${id} がありません`);
  }
  return found;
}

const req = (
  message: string,
  overrides?: Partial<ConsultRequest>,
): ConsultRequest => ({
  message,
  history: [],
  program: null,
  userContext: null,
  ...overrides,
});

async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════
  section("A. 取得元の統一（レジストリが画面・相談・入力フォームの共通）");
  // ══════════════════════════════════════════════════════════
  const apiRes = await GET();
  const api = (await apiRes.json()) as {
    programs: SupportProgram[];
    verifiedProgramCount: number;
  };
  check(
    "API とレジストリが同一データ（件数・ID順）",
    api.programs.map((p) => p.id).join(",") ===
      registry.map((p) => p.id).join(","),
    `${api.programs.length}件 / ${registry.length}件`,
  );
  check(
    "API とレジストリが同一データ（名称・金額説明・確認状況）",
    api.programs.every(
      (p, i) =>
        p.name === registry[i].name &&
        p.amount.description === registry[i].amount.description &&
        p.mock === registry[i].mock,
    ),
  );
  check(
    "API の確認済み件数もレジストリと一致",
    api.verifiedProgramCount === registry.filter((p) => !p.mock).length,
  );

  const overviewReply = buildMockReply(
    req("子育てでもらえるお金には、どんなものがある？"),
  );
  check(
    "相談の制度一覧が全レジストリ制度名を含む（画面と同一名称）",
    registry.every((p) => overviewReply.text.includes(p.name)),
  );
  check(
    "相談の関連制度数がレジストリ件数と一致",
    overviewReply.relatedPrograms.length === registry.length,
  );
  check(
    "相談でも確認済み/未確認（モック）が区別される",
    overviewReply.text.includes("【公式確認済み（一部要確認）】") &&
      overviewReply.text.includes("【未確認（モック）】"),
  );
  check(
    "相談の詳細回答もレジストリの名称・金額説明を使う（全制度）",
    registry.every((p) => {
      const r = buildMockReply(req(`${p.name}の金額はいくら？`));
      return r.text.includes(p.name) && r.text.includes(p.amount.description);
    }),
  );
  check(
    "相談の関連制度 sourceType が mock フラグと一致（確認状況の混同なし）",
    overviewReply.relatedPrograms.every(
      (rp, i) => rp.sourceType === (registry[i].mock ? "mock" : "verified"),
    ),
  );

  const allowance = programById("mock-child-allowance");
  const scholarship = programById("mock-high-school-scholarship");
  const ctx = toConsultContextProgram(allowance);
  check(
    "引き継ぎ文脈がレジストリの名称・金額説明と一致（ID照合）",
    ctx.id === allowance.id &&
      ctx.name === allowance.name &&
      ctx.amountDescription === allowance.amount.description,
  );
  const kickoff = buildInitialMessages({ program: ctx, userContext: null })[0];
  check(
    "引き継ぎ開始メッセージもレジストリの制度名を使う",
    kickoff.text.includes(allowance.name),
  );

  // Disclosure 内部のため、入力フォームはソースで確認（verify-m5 の保存ガードと同じ方式）
  const formSource = readFileSync(
    join(process.cwd(), "components/Form.tsx"),
    "utf-8",
  );
  check(
    "入力フォーム（利用中の支援制度）はレジストリを参照（モック一覧の直接参照なし）",
    formSource.includes('from "@/lib/supports/registry"') &&
      !formSource.includes('from "@/lib/supports/mockPrograms"') &&
      formSource.includes("getSupportPrograms().map((program)"),
  );
  const advisorSource = readFileSync(
    join(process.cwd(), "lib/consult/mockAdvisor.ts"),
    "utf-8",
  );
  check(
    "相談（モック応答）もレジストリを参照（モック一覧の直接参照なし）",
    advisorSource.includes("from '../supports/registry'") &&
      !advisorSource.includes("MOCK_SUPPORT_PROGRAMS"),
  );
  // ══════════════════════════════════════════════════════════
  section("B. 年齢による金額の区別（境界）");
  // ══════════════════════════════════════════════════════════
  const effectOf = (
    p: SupportProgram,
    children: ChildInput[],
    options?: { excludeProgramIds?: string[] },
  ) => calculateSupportEffects(planOf(children), [p], options).effects[0];

  // 児童手当（0〜17歳・年額120,000円）
  const e17 = effectOf(allowance, [child("c1", 17)]);
  check(
    "児童手当（0〜17歳）: 17歳の年まで計上される（終了境界・含む）",
    e17.estimatedTotalYen === 120_000,
    String(e17.estimatedTotalYen),
  );
  const e18 = effectOf(allowance, [child("c1", 18)]);
  check(
    "児童手当: 18歳は計上されない（対象期間は18歳未満で打ち切り）",
    e18.estimatedTotalYen === 0 && e18.eligibility === "ineligible",
    `${e18.estimatedTotalYen}円 / ${e18.eligibility}`,
  );
  const e0 = effectOf(allowance, [child("c1", 0)]);
  check(
    "児童手当: 0歳から0〜17歳の18年分が計上される（開始境界・含む）",
    e0.estimatedTotalYen === 2_160_000,
    String(e0.estimatedTotalYen),
  );

  // 高校生等奨学給付金（15〜17歳・年額118,800円）
  const s14 = effectOf(scholarship, [child("c1", 14)]);
  check(
    "高校生等奨学給付金（15〜17歳）: 14歳は0円だが15・16・17歳の3年分は計上",
    s14.estimatedTotalYen === 356_400,
    String(s14.estimatedTotalYen),
  );
  const s17 = effectOf(scholarship, [child("c1", 17)]);
  check(
    "高校生等奨学給付金: 17歳の年まで（1年分のみ）で18歳は0",
    s17.estimatedTotalYen === 118_800,
    String(s17.estimatedTotalYen),
  );

  // 一時金の年齢境界（対象期間の最初の年に1回だけ）
  const oneTime = fixtureProgram({
    id: "fx-one-time",
    name: "一時金テスト",
    amount: {
      value: 50_000,
      unit: "yen_one_time",
      basis: "estimated",
      description: "一時金テスト（推定）",
    },
    period: { startAgeYears: 0, endAgeYears: 2, durationMonths: null },
  });
  const ot0 = effectOf(oneTime, [child("c1", 0)]);
  check(
    "一時金: 対象期間の最初の年に1回だけ計上される",
    ot0.estimatedTotalYen === 50_000,
    String(ot0.estimatedTotalYen),
  );
  const ot3 = effectOf(oneTime, [child("c1", 3)]);
  check(
    "一時金: 対象期間外の子は計上されない",
    ot3.estimatedTotalYen === 0 && ot3.eligibility === "ineligible",
    String(ot3.estimatedTotalYen),
  );

  // ══════════════════════════════════════════════════════════
  section("C. 子ども別の金額・回数（複数子ども）");
  // ══════════════════════════════════════════════════════════
  const mixed = effectOf(allowance, [child("a", 17), child("b", 0)]);
  check(
    "複数子ども: 世帯合計＝子別合計のΣ（二重計上なし）",
    mixed.estimatedTotalYen === 2_280_000 &&
      mixed.perChild.reduce((a, c) => a + (c.totalYen ?? 0), 0) ===
        mixed.estimatedTotalYen,
    String(mixed.estimatedTotalYen),
  );
  check(
    "複数子ども: 子どもごとの年齢区別が合計に反映（17歳=1年分・0歳=18年分）",
    (mixed.perChild[0].totalYen ?? 0) === 120_000 &&
      (mixed.perChild[1].totalYen ?? 0) === 2_160_000,
    mixed.perChild.map((c) => String(c.totalYen)).join(" / "),
  );
  const single5 = effectOf(allowance, [child("a", 5)]);
  const double5 = effectOf(allowance, [child("a", 5), child("b", 5)]);
  check(
    "同じ年齢の2子は1子の2倍（子ども数の区別）",
    double5.estimatedTotalYen === 2 * (single5.estimatedTotalYen ?? 0),
    `${double5.estimatedTotalYen} vs ${single5.estimatedTotalYen}`,
  );
  const ot2 = effectOf(oneTime, [child("a", 0), child("b", 0)]);
  check(
    "一時金は子どもごとに1回（2子なら2回まで）",
    ot2.estimatedTotalYen === 100_000,
    String(ot2.estimatedTotalYen),
  );
  const estTwo = estimateSupports(
    planOf([child("a", 0), child("b", 0)]),
    [oneTime],
  );
  check(
    "estimate の単位内訳も子ども別の回数と一致（一時金=2回・表示と計算の一致）",
    estTwo.estimates[0].unitBreakdown.countedUnits === 2 &&
      estTwo.estimates[0].householdTotalYen === 100_000 &&
      estTwo.estimates[0].perChild.reduce(
        (a, c) => a + (c.totalYen ?? 0),
        0,
      ) === estTwo.estimates[0].householdTotalYen,
  );
  // ══════════════════════════════════════════════════════════
  section("D. 未確認情報の非混入（確定/推定/未確認の分離・二重計上防止）");
  // ══════════════════════════════════════════════════════════
  const fxUnknown = fixtureProgram({
    id: "fx-unknown",
    name: "金額未確認テスト",
    amount: {
      value: 30_000,
      unit: "yen_per_month",
      basis: "unknown",
      description: "未確認テスト",
    },
  });
  const fxEstimated = fixtureProgram({
    id: "fx-estimated",
    name: "推定テスト",
    amount: {
      value: 10_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "推定テスト",
    },
  });
  const fxConfirmed = fixtureProgram({
    id: "fx-confirmed",
    name: "確認済みテスト",
    amount: {
      value: 5_000,
      unit: "yen_per_month",
      basis: "confirmed",
      description: "確認済みテスト",
    },
  });
  const u = calculateSupportEffects(planOf([child("c1", 0)]), [fxUnknown]);
  check(
    "金額未確認（basis=unknown）は確定・推定のどちらにも入らない",
    u.confirmedTotalYen === 0 &&
      u.estimatedTotalYen === 0 &&
      u.uncounted.length === 1 &&
      u.uncounted[0].excludedReason === "金額が未確認のため合計対象外",
    `${u.confirmedTotalYen} / ${u.estimatedTotalYen}`,
  );
  const estOnly = calculateSupportEffects(
    planOf([child("c1", 0)]),
    [fxEstimated],
  );
  check(
    "推定（estimated）は推定額のみ（確定0）",
    estOnly.confirmedTotalYen === 0 && estOnly.estimatedTotalYen === 2_160_000,
    `${estOnly.confirmedTotalYen} / ${estOnly.estimatedTotalYen}`,
  );
  const confOnly = calculateSupportEffects(
    planOf([child("c1", 0)]),
    [fxConfirmed],
  );
  check(
    "確認済み（confirmed）のみ確定額になる",
    confOnly.confirmedTotalYen === 1_080_000 &&
      confOnly.estimatedTotalYen === 0,
    `${confOnly.confirmedTotalYen} / ${confOnly.estimatedTotalYen}`,
  );

  const regCalc = calculateSupportEffects(planOf([child("c1", 0)]), registry);
  check(
    "レジストリ全体では確定額0円のまま（未確認の金額を確定にしない）",
    regCalc.confirmedTotalYen === 0,
    String(regCalc.confirmedTotalYen),
  );
  check(
    "推定額は児童手当＋高校生等奨学給付金のみ（貸付・金額未確認を含まない）",
    regCalc.estimatedTotalYen === 2_516_400,
    String(regCalc.estimatedTotalYen),
  );
  check(
    "貸付制度は理由付きで合計対象外（給付と混同しない）",
    regCalc.uncounted.filter(
      (e) => e.excludedReason === "貸付制度のため合計対象外",
    ).length === 2,
  );
  const excluded = calculateSupportEffects(
    planOf([child("c1", 0)]),
    registry,
    { excludeProgramIds: [allowance.id] },
  );
  check(
    "利用中の制度（フォームの選択ID）は二重計上されない（除外理由つき）",
    excluded.uncounted.some((e) =>
      (e.excludedReason ?? "").includes("現在利用中"),
    ) && excluded.estimatedTotalYen === 356_400,
    String(excluded.estimatedTotalYen),
  );
  const estGuard = estimateSupports(planOf([child("c1", 0)]), registry, {
    excludeProgramIds: [allowance.id],
  });
  check(
    "estimate の二重計上ガードも同じ除外理由を返す",
    estGuard.uncounted.some((e) =>
      (e.excludedReason ?? "").includes("現在利用中"),
    ),
  );
  const jassoGrant = programById("official-jasso-kyufu-shogakukin");
  const jassoEffect = regCalc.effects.find(
    (e) => e.program.id === jassoGrant.id,
  );
  check(
    "対象条件・金額が未確認の制度を推測で対象外にしない（eligibility を壊さない）",
    jassoEffect !== undefined &&
      jassoEffect.eligibility === jassoGrant.eligibility &&
      jassoEffect.eligibility !== "ineligible" &&
      jassoEffect.excludedReason === "金額が未確認のため合計対象外",
  );

  // ══════════════════════════════════════════════════════════
  section("E. 金額内訳（amountBands）の扱い（表示専用）");
  // ══════════════════════════════════════════════════════════
  check(
    "児童手当: 金額内訳（4区分）があっても計算は単一金額×年数を使う",
    (allowance.amountBands ?? []).length === 4 &&
      e0.estimatedTotalYen === (allowance.amount.value ?? 0) * 18,
    `bands=${(allowance.amountBands ?? []).length} / total=${e0.estimatedTotalYen}`,
  );
  check(
    "児童手当: 計算に使う代表金額は推定のまま（内訳の確認済み区分と混同しない）",
    allowance.amount.basis === "estimated" &&
      e0.estimatedTotalYen === 2_160_000,
  );

  // ══════════════════════════════════════════════════════════
  section("F. 期限切れ制度の非計上・期限基準日の注入（M7-G）");
  // ══════════════════════════════════════════════════════════
  const fxExpired = fixtureProgram({
    id: "fx-expired",
    name: "期限切れテスト",
    application: {
      where: "窓口",
      documents: [],
      deadlineNote: "受付期限 2020-01-01",
      steps: [],
      deadlineDate: "2020-01-01",
    },
  });
  const expiredCalc = calculateSupportEffects(planOf([child("c1", 0)]), [fxExpired]);
  const expiredEffect = expiredCalc.effects[0];
  check(
    "期限切れ（deadlineDate < 今日）の制度は合計に含めず、理由付きで案内しない",
    expiredEffect.includedInTotal === false &&
      (expiredEffect.excludedReason ?? "").includes("受付期限") &&
      (expiredEffect.excludedReason ?? "").includes("過ぎている") &&
      expiredCalc.confirmedTotalYen === 0 &&
      expiredCalc.estimatedTotalYen === 0,
    expiredEffect.excludedReason ?? "",
  );
  const fxFuture = fixtureProgram({
    id: "fx-future",
    name: "期限内テスト",
    application: {
      where: "窓口",
      documents: [],
      deadlineNote: "受付期限 2999-12-31",
      steps: [],
      deadlineDate: "2999-12-31",
    },
  });
  const futureCalc = calculateSupportEffects(planOf([child("c1", 0)]), [fxFuture]);
  check(
    "期限内の制度は従来どおり合計に含まれる（期限ガードの誤爆なし）",
    futureCalc.effects[0].includedInTotal === true &&
      futureCalc.estimatedTotalYen === 2_160_000,
    String(futureCalc.estimatedTotalYen),
  );
  const backdatedCalc = calculateSupportEffects(planOf([child("c1", 0)]), [fxExpired], {
    today: "2019-12-31",
  });
  check(
    "期限判定は基準日（today）を注入でき、基準日以前なら期限内として扱う",
    backdatedCalc.effects[0].includedInTotal === true,
    backdatedCalc.effects[0].excludedReason ?? "",
  );

  console.log(
    failed === 0
      ? "M6-D: すべての確認項目が成功"
      : `M6-D: ${failed} 件のNG`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});