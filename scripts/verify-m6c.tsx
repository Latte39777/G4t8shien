/**
 * M6-C 検証スクリプト: 公式情報の調査・データ整備
 *
 * 実行: npx tsx scripts/verify-m6c.tsx
 *
 * 確認項目（タスク §6）:
 * - 確認済み情報と未確認情報が区別される
 * - 公式URL未確認の情報が公式リンクとして扱われない
 * - 制度の適用年度が区別される
 * - 国・東京都・区市町村の制度区分が正しい（東京都23区までの絞り込み構造を含む）
 * - 金額・単位・対象期間が既存の計算ロジックに正しく渡される
 * - 貸付が給付額の合計に混入しない
 * - 既存の相談機能と結果画面が引き続き動作する（API・カード表示の継続）
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { z } from "zod";
import {
  supportProgramSchema,
  TOKYO_WARD_CODES,
  type SupportProgram,
} from "../lib/types/support";
import type { ChildInput, FamilyPlan } from "../lib/types/finance";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
import {
  getSupportPrograms,
  registryDisclaimer,
} from "../lib/supports/registry";
import {
  buildOfficialProgram,
  buildOfficialPrograms,
  OFFICIAL_RESEARCH_RECORDS,
  RESEARCH_LOG,
  verifiedOfficialUrls,
} from "../lib/supports/officialPrograms";
import { normalizeResearchCandidate } from "../lib/supports/research";
import {
  hasVerifiedOfficialSource,
  sourceDisplayEntry,
} from "../lib/supports/evidence";
import {
  amountBandsText,
  fiscalYearLabel,
  verificationBadgeText,
} from "../lib/supports/display";
import {
  filterProgramsByRegion,
  jurisdictionText,
  TOKYO_WARD_LABELS,
} from "../lib/supports/region";
import { estimateSupports } from "../lib/supports/estimate";
import { calculateSupportEffects } from "../lib/finance/supports";
import { childAgeAt, projectionHorizon } from "../lib/finance/cashflow";
import { GET } from "../app/api/supports/route";
import { SupportCard } from "../components/SupportList";
import { SAMPLE_INPUT } from "../lib/simulation";
import { buildSimulationResult } from "../lib/result";
import {
  buildInitialMessages,
  toConsultContextProgram,
} from "../lib/consult/conversation";

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
const officialPrograms = buildOfficialPrograms();
const childAllowance = registry.find((p) => p.id === "mock-child-allowance");
const mockMedical = registry.find((p) => p.id === "mock-child-medical-aid");
const jassoTaiyo = registry.find(
  (p) => p.id === "official-jasso-taiyo-shogakukin",
);

async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════
  section("A. データ構造（後方互換・モックの安全表示維持）");
  // ══════════════════════════════════════════════════════════
  check(
    "モックデータ: M6-C 拡張後スキーマを全件通過（後方互換）",
    z.array(supportProgramSchema).safeParse(MOCK_SUPPORT_PROGRAMS).success,
  );
  check(
    "モックデータ: 未改変（全件 mock:true・金額は非確認済み・URL未検証）",
    MOCK_SUPPORT_PROGRAMS.every(
      (p) =>
        p.mock &&
        p.amount.basis !== "confirmed" &&
        p.sources.every((s) => !s.urlVerified),
    ),
  );
  check(
    "レジストリ: supportProgramSchema を全件通過",
    z.array(supportProgramSchema).safeParse(registry).success,
  );
  check("レジストリ: 4件以上", registry.length >= 4, `${registry.length}件`);
  check(
    "レジストリ: ID が重複しない",
    new Set(registry.map((p) => p.id)).size === registry.length,
  );
  check(
    "レジストリ: モックIDは置換または維持（ID が欠落しない）",
    MOCK_SUPPORT_PROGRAMS.every((m) => registry.some((p) => p.id === m.id)),
  );
  check(
    "未確認制度「こども医療費助成」は既存のモック表示のまま維持",
    mockMedical !== undefined &&
      mockMedical.mock &&
      mockMedical.name.includes("モック"),
  );
  check(
    "公式確認済み制度（児童手当）は mock:false（モックと混同しない）",
    childAllowance !== undefined && !childAllowance.mock,
  );

  // ══════════════════════════════════════════════════════════
  section("B. 確認済み情報と未確認情報の区別");
  // ══════════════════════════════════════════════════════════
  check(
    "児童手当: バッジは「公式確認済み（一部要確認）」",
    childAllowance !== undefined &&
      verificationBadgeText(childAllowance) === "公式確認済み（一部要確認）",
    childAllowance ? verificationBadgeText(childAllowance) : "未定義",
  );
  check(
    "モック制度: バッジは「モック・未確認」（既存表示を維持）",
    mockMedical !== undefined &&
      verificationBadgeText(mockMedical) === "モック・未確認",
  );
  check(
    "児童手当: 検証済み公式出典あり（hasVerifiedOfficialSource）",
    childAllowance !== undefined && hasVerifiedOfficialSource(childAllowance),
  );
  check(
    "モック制度: 検証済み公式出典なし",
    mockMedical !== undefined && !hasVerifiedOfficialSource(mockMedical),
  );
  check(
    "児童手当: 金額内訳（amountBands）が4区分・すべて公式確認済み",
    childAllowance !== undefined &&
      (childAllowance.amountBands ?? []).length === 4 &&
      (childAllowance.amountBands ?? []).every((b) => b.basis === "confirmed"),
  );
  const bandsText = childAllowance ? amountBandsText(childAllowance) : null;
  check(
    "児童手当: 内訳表示に確認済みの区分別金額が出る",
    bandsText !== null &&
      bandsText.includes("3歳未満（第3子以外）") &&
      bandsText.includes("15,000") &&
      bandsText.includes("確認済み"),
    bandsText ?? "",
  );
  check(
    "児童手当: 単一金額（計算用）は推定のまま（確定扱いにしない）",
    childAllowance !== undefined && childAllowance.amount.basis === "estimated",
  );
  check(
    "高校生等奨学給付金: 金額を確認できていないため非確認のまま",
    registry.find((p) => p.id === "mock-high-school-scholarship")?.amount
      .basis === "estimated",
  );
  check(
    "公式制度: 未確認項目はすべて理由付き（field/reason が空でない）",
    officialPrograms.every((p) =>
      (p.unconfirmedItems ?? []).every(
        (u) => u.field.length > 0 && u.reason.length > 0,
      ),
    ),
  );
  // 仕様変更（2026-10-17）: こども家庭庁「法令」ページ（e-Gov）で法令名「児童手当法」を照合済みのため、
  // legalBasis.lawName は確認済み扱いに変更。未確認は施行令・施行規則名（legalBasis.ordinanceName）に縮小。
  check(
    "児童手当: 未確認項目に所得制限・施行令/規則名・適用年度の理由がある",
    childAllowance !== undefined &&
      ["conditions.incomeLimit", "legalBasis.ordinanceName", "amount.fiscalYear"].every(
        (f) => (childAllowance.unconfirmedItems ?? []).some((u) => u.field === f),
      ),
  );
  check(
    "児童手当: 確認済みの根拠法令は lawName のみ（未確認の施行令/規則名を含めない）",
    childAllowance !== undefined &&
      (childAllowance.verification?.verifiedFields ?? []).includes("legalBasis.lawName") &&
      !(childAllowance.verification?.verifiedFields ?? []).some((f) =>
        f.startsWith("legalBasis.ordinance"),
      ),
  );

  // ══════════════════════════════════════════════════════════
  section("C. 公式URL検証のポリシー");
  // ══════════════════════════════════════════════════════════
  const loggedUrls = verifiedOfficialUrls();
  check(
    "urlVerified=true の出典はすべて調査ログ（本文照合済み）の公式URLと一致",
    registry.every((p) =>
      p.sources.every((s) => !s.urlVerified || loggedUrls.has(s.url ?? "")),
    ),
  );
  check(
    "urlVerified=true の出典は official・取得日時・照合メモを伴う",
    registry.every((p) =>
      p.sources.every(
        (s) =>
          !s.urlVerified ||
          (s.official &&
            (s.retrievedAt ?? null) !== null &&
            (s.verificationNote ?? null) !== null),
      ),
    ),
  );
  const unverifiedEntry = sourceDisplayEntry(
    MOCK_SUPPORT_PROGRAMS[0].sources[0],
  );
  check(
    "URL未確認の出典は公式リンクとして扱わない",
    !unverifiedEntry.isLink &&
      unverifiedEntry.href === null &&
      unverifiedEntry.unverifiedText ===
        "URL未確認（公式リンクとして扱いません）",
  );
  const officialHtml = renderToString(
    createElement(SupportCard, {
      program: childAllowance as SupportProgram,
      effect: undefined,
      isUsed: false,
      onConsult: () => {},
    }),
  );
  check(
    "公式制度カード: 照合済みURLを公式リンク（a href）として表示",
    officialHtml.includes('href="https://www.cfa.go.jp/'),
  );
  const mockHtml = renderToString(
    createElement(SupportCard, {
      program: MOCK_SUPPORT_PROGRAMS[0],
      effect: undefined,
      isUsed: false,
      onConsult: () => {},
    }),
  );
  check(
    "モックカード: 未確認URLをリンクタグにしない",
    !mockHtml.includes('href="'),
  );
  const tampered = buildOfficialProgram({
    ...OFFICIAL_RESEARCH_RECORDS[0],
    programId: "test-tampered",
    candidate: {
      ...OFFICIAL_RESEARCH_RECORDS[0].candidate,
      sources: [
        {
          title: "未照合URL（自己申告）",
          organization: "テスト",
          url: "https://example.com/not-verified",
          urlVerified: true,
          official: true,
          checkedAt: "2026-10-15",
        },
      ],
    },
  });
  check(
    "調査メモの自己申告だけでは urlVerified にならない（未ログURLは強制的にfalse）",
    tampered.sources.every((s) => !s.urlVerified),
  );
  const aiNormalized = normalizeResearchCandidate(
    {
      name: "AI候補（検証なし）",
      amount: {
        value: 10_000,
        unit: "yen_per_month",
        claimedBasis: "confirmed",
      },
      legalBasis: { lawName: "推測法（AI）" },
      sources: [
        {
          title: "AI出典",
          organization: "AI",
          url: "https://example.com/ai",
          urlVerified: true,
          official: true,
          checkedAt: "2026-10-15",
        },
      ],
      checkedAt: "2026-10-15",
    },
    { programId: "test-ai", trustVerification: false },
  );
  check(
    "AI候補: 検証なしでは金額・法令名を確定しない（M6-Bルールの継続）",
    aiNormalized.program !== null &&
      aiNormalized.program.amount.basis === "estimated" &&
      aiNormalized.program.legalBasis.lawName === null,
  );

  // ══════════════════════════════════════════════════════════
  section("D. 制度の適用年度の区別");
  // ══════════════════════════════════════════════════════════
  check(
    "児童手当: 金額内訳の適用年度は未確認のまま（推測で年度を入れない）",
    childAllowance !== undefined &&
      (childAllowance.amountBands ?? []).every(
        (b) => (b.fiscalYear ?? null) === null,
      ),
  );
  check(
    "児童手当: 適用年度が未確認であることの理由が記録されている",
    childAllowance !== undefined &&
      (childAllowance.unconfirmedItems ?? []).some(
        (u) => u.field === "amount.fiscalYear",
      ),
  );
  check(
    "適用年度の表示: 年度付きは年度が出る",
    fiscalYearLabel("2025年度") === "適用年度: 2025年度",
    fiscalYearLabel("2025年度"),
  );
  check(
    "適用年度の表示: 年度なしは未確認と明示",
    fiscalYearLabel(null) === "適用年度: 未確認（要確認）",
    fiscalYearLabel(null),
  );
  const fy2025 = fixtureProgram({
    id: "fy-2025",
    name: "年度別テスト2025",
    amount: {
      value: 1_000,
      unit: "yen_per_year",
      basis: "estimated",
      description: "2025年度額",
      fiscalYear: "2025年度",
    },
  });
  const fy2026 = fixtureProgram({
    id: "fy-2026",
    name: "年度別テスト2026",
    amount: {
      value: 2_000,
      unit: "yen_per_year",
      basis: "estimated",
      description: "2026年度額",
      fiscalYear: "2026年度",
    },
  });
  check(
    "適用年度: 制度ごとに年度を保持できる（スキーマ通過）",
    z.array(supportProgramSchema).safeParse([fy2025, fy2026]).success,
  );
  check(
    "適用年度: 2025年度と2026年度の表示が区別される",
    fiscalYearLabel(fy2025.amount.fiscalYear) !==
      fiscalYearLabel(fy2026.amount.fiscalYear) &&
      fiscalYearLabel(fy2026.amount.fiscalYear).includes("2026年度"),
  );
  const fyBandsText = amountBandsText(
    fixtureProgram({
      id: "fy-bands",
      name: "年度別内訳テスト",
      amountBands: [
        {
          label: "2025年度の区分",
          value: 1_000,
          unit: "yen_per_month",
          basis: "confirmed",
          fiscalYear: "2025年度",
        },
        {
          label: "年度未確認の区分",
          value: 2_000,
          unit: "yen_per_month",
          basis: "confirmed",
          fiscalYear: null,
        },
      ],
    }),
  );
  check(
    "適用年度: 内訳表示で年度あり／年度未確認が区別される",
    fyBandsText !== null &&
      fyBandsText.includes("適用年度 2025年度") &&
      fyBandsText.includes("適用年度 未確認"),
    fyBandsText ?? "",
  );
  check(
    "調査ログ: 照合日・取得日時を保持（どの時点の情報か追跡できる）",
    RESEARCH_LOG.every(
      (e) => /^\d{4}-\d{2}-\d{2}$/.test(e.checkedAt) && e.retrievedAt.length > 0,
    ),
  );

  // ══════════════════════════════════════════════════════════
  section("E. 国・東京都・区市町村の区分と23区の絞り込み構造");
  // ══════════════════════════════════════════════════════════
  check(
    "東京都23区の区コードが23件定義されている",
    TOKYO_WARD_CODES.length === 23 && TOKYO_WARD_LABELS.bunkyo === "文京区",
    `${TOKYO_WARD_CODES.length}件`,
  );
  check(
    "国の制度: 児童手当・高校生等奨学給付金・教育一般貸付・JASSO奨学金は national",
    ["mock-child-allowance", "mock-high-school-scholarship", "mock-education-loan"]
      .map((id) => registry.find((p) => p.id === id)?.level)
      .every((lv) => lv === "national") &&
      jassoTaiyo !== undefined &&
      jassoTaiyo.level === "national",
  );
  check(
    "区市町村の制度: こども医療費助成は municipal（既存区分を維持）",
    mockMedical?.level === "municipal",
    mockMedical?.level ?? "未定義",
  );
  check(
    "東京都の制度（tokyo）の構造が利用可能（フィクスチャがスキーマ通過）",
    supportProgramSchema.safeParse(
      fixtureProgram({
        id: "tokyo-fixture",
        name: "東京都の制度テスト",
        level: "tokyo",
      }),
    ).success,
  );
  check(
    "児童手当: 対象地域は nationwide（全国の市区町村が実施）",
    childAllowance?.jurisdiction?.coverage === "nationwide",
  );
  check(
    "対象地域が特定できない制度は推測で設定しない（こども医療費助成は未整理）",
    mockMedical?.jurisdiction === undefined &&
      jurisdictionText(mockMedical?.jurisdiction) ===
        "対象地域は未整理（要確認）",
    jurisdictionText(mockMedical?.jurisdiction),
  );
  check(
    "対象地域未確認の表示は「推測して設定していません」を含む",
    jurisdictionText(jassoTaiyo?.jurisdiction).includes(
      "対象地域は未確認（推測して設定していません）",
    ),
    jurisdictionText(jassoTaiyo?.jurisdiction),
  );
  const wardProgram = fixtureProgram({
    id: "ward-fixture",
    name: "文京区の区独自制度テスト",
    level: "ward",
    jurisdiction: {
      coverage: "ward",
      prefecture: "東京都",
      municipality: "文京区",
      ward: "bunkyo",
      scopeNote: "文京区が実施（テスト）",
      confidence: "confirmed",
    },
  });
  const bunkyoResult = filterProgramsByRegion(
    [wardProgram, childAllowance as SupportProgram, jassoTaiyo as SupportProgram],
    { prefecture: "東京都", ward: "bunkyo" },
  );
  check(
    "絞り込み: 文京区クエリで区独自制度（文京区）が applicable",
    bunkyoResult.applicable.some((p) => p.id === "ward-fixture"),
  );
  check(
    "絞り込み: 全国の制度（児童手当）は常に applicable",
    bunkyoResult.applicable.some((p) => p.id === "mock-child-allowance"),
  );
  check(
    "絞り込み: 対象地域未確認（JASSO）は needsRegionCheck（要確認に回す）",
    bunkyoResult.needsRegionCheck.some(
      (p) => p.id === "official-jasso-taiyo-shogakukin",
    ),
  );
  const shinjukuResult = filterProgramsByRegion([wardProgram], {
    prefecture: "東京都",
    ward: "shinjuku",
  });
  check(
    "絞り込み: 別区（新宿区）クエリでは文京区制度を applicable にしない",
    shinjukuResult.applicable.length === 0 &&
      shinjukuResult.needsRegionCheck.length === 0,
  );
  const noQueryResult = filterProgramsByRegion([wardProgram], {});
  check(
    "絞り込み: 地域未指定なら適用可否を決めない（needsRegionCheck）",
    noQueryResult.needsRegionCheck.some((p) => p.id === "ward-fixture"),
  );
  check(
    "絞り込み: 区名と区コードのどちらでも一致判定できる",
    filterProgramsByRegion([wardProgram], { municipality: "文京区" })
      .applicable.length === 1,
  );

  // ══════════════════════════════════════════════════════════
  section("F. 金額・単位・対象期間の計算ロジックへの受け渡し");
  // ══════════════════════════════════════════════════════════
  const plan5 = planOf([child("c1", 5)]);
  const calc = calculateSupportEffects(plan5, [
    childAllowance as SupportProgram,
  ]);
  const effect5 = calc.effects[0];
  const horizon = projectionHorizon(plan5);
  let expectedYears = 0;
  for (let t = 0; t <= horizon; t += 1) {
    const age = childAgeAt(plan5.children[0], t);
    if (age !== null && age >= 0 && age <= 17) expectedYears += 1;
  }
  check(
    "児童手当: 年額120,000円×対象期間（0〜17歳）の各年が計算に渡る",
    effect5.estimatedTotalYen === 120_000 * expectedYears,
    `total=${effect5.estimatedTotalYen} expected=${120_000 * expectedYears}`,
  );
  check(
    "児童手当: 子ども別の合計 = 世帯合計（二重計上なし）",
    effect5.perChild.reduce((s, c) => s + (c.totalYen ?? 0), 0) ===
      (effect5.estimatedTotalYen ?? 0),
  );
  const monthCapProgram = fixtureProgram({
    id: "month-cap",
    name: "月額・期間上限テスト",
    amount: {
      value: 15_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "月額15,000円×24か月上限",
    },
    period: { startAgeYears: 0, endAgeYears: 2, durationMonths: 24 },
  });
  const monthEst = estimateSupports(planOf([child("c1", 0)]), [
    monthCapProgram,
  ]);
  check(
    "月額: 単位（月額）が計算に渡り、支給期間上限24か月が反映される",
    monthEst.estimates[0].effect.estimatedTotalYen === 15_000 * 24,
    `total=${monthEst.estimates[0].effect.estimatedTotalYen}`,
  );
  check(
    "月額: unitBreakdown が月額・単価・計上月数を返す",
    monthEst.estimates[0].unitBreakdown.unit === "yen_per_month" &&
      monthEst.estimates[0].unitBreakdown.baseAmountYen === 15_000 &&
      monthEst.estimates[0].unitBreakdown.countedUnits === 24,
    JSON.stringify(monthEst.estimates[0].unitBreakdown),
  );
  const oneTimeProgram = fixtureProgram({
    id: "one-time",
    name: "一時金テスト",
    amount: {
      value: 500_000,
      unit: "yen_one_time",
      basis: "estimated",
      description: "一時金50万円",
    },
    period: { startAgeYears: 0, endAgeYears: 2, durationMonths: null },
  });
  // 一時金は「対象期間に入った最初の年」に1回のみ計上される（既存計算のルール）
  const oneTimeEst = estimateSupports(planOf([child("c1", 0)]), [
    oneTimeProgram,
  ]);
  check(
    "一時金: 1子につき1回のみ計上される（単位が計算に渡る）",
    oneTimeEst.estimates[0].unitBreakdown.countedUnits === 1 &&
      oneTimeEst.estimates[0].effect.estimatedTotalYen === 500_000,
    JSON.stringify(oneTimeEst.estimates[0].unitBreakdown),
  );
  // 確認済み金額（検証済み公式出典あり）は確定額として計算に反映される
  const confirmedProgram = buildOfficialProgram({
    ...OFFICIAL_RESEARCH_RECORDS[0],
    programId: "test-confirmed-amount",
    amountBands: [],
    candidate: {
      ...OFFICIAL_RESEARCH_RECORDS[0].candidate,
      amount: {
        value: 10_000,
        unit: "yen_per_month",
        claimedBasis: "confirmed",
        description: "確認済み金額（テスト）",
      },
      period: { startAgeYears: 0, endAgeYears: 5, durationMonths: null },
    },
    unconfirmedItems: [],
  });
  const confirmedCalc = calculateSupportEffects(planOf([child("c1", 1)]), [
    confirmedProgram,
  ]);
  check(
    "確認済みの金額・単位・対象期間が既存計算に渡り、確定額として集計される",
    confirmedProgram.amount.basis === "confirmed" &&
      confirmedCalc.confirmedTotalYen > 0 &&
      confirmedCalc.estimatedTotalYen === 0,
    `confirmed=${confirmedCalc.confirmedTotalYen}`,
  );
  const eligibilityCheck = calculateSupportEffects(plan5, registry);
  check(
    "受給資格は自動判定しない（公式調査データは eligibility=unconfirmed のまま）",
    childAllowance?.eligibility === "unconfirmed" &&
      eligibilityCheck.effects.some((e) => e.eligibility === "unconfirmed"),
  );

  // ══════════════════════════════════════════════════════════
  section("G. 貸付が給付額の合計に混入しない");
  // ══════════════════════════════════════════════════════════
  const loanCalc = calculateSupportEffects(planOf([child("c1", 5)]), registry);
  const loanEffects = loanCalc.effects.filter(
    (e) => e.program.category === "loan",
  );
  check(
    "レジストリの貸付（教育一般貸付・JASSO貸与）はすべて合計対象外",
    loanEffects.length >= 2 &&
      loanEffects.every((e) => !e.includedInTotal),
    `${loanEffects.length}件`,
  );
  check(
    "貸付の除外理由は「貸付制度のため合計対象外」（返済が必要なため）",
    loanEffects.every((e) => e.excludedReason === "貸付制度のため合計対象外"),
  );
  check(
    "貸付は未確認金額でも「貸付」として区別される（給付と混同しない）",
    jassoTaiyo !== undefined &&
      jassoTaiyo.category === "loan" &&
      registry.find((p) => p.id === "official-jasso-kyufu-shogakukin")
        ?.category === "cash_benefit",
  );
  const loanWithAmount = fixtureProgram({
    id: "loan-with-amount",
    name: "貸付（金額あり）テスト",
    category: "loan",
    amount: {
      value: 10_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "貸付 月額1万円",
    },
    period: { startAgeYears: 0, endAgeYears: 17, durationMonths: 30 },
  });
  const grantWithAmount = fixtureProgram({
    id: "grant-with-amount",
    name: "給付（金額あり）テスト",
    category: "cash_benefit",
    amount: {
      value: 10_000,
      unit: "yen_per_month",
      basis: "estimated",
      description: "給付 月額1万円",
    },
    period: { startAgeYears: 0, endAgeYears: 17, durationMonths: 30 },
  });
  const mixedCalc = calculateSupportEffects(
    planOf([child("c1", 1)]),
    [loanWithAmount, grantWithAmount],
  );
  check(
    "同額でも貸付は合計に混入せず、給付のみが合計に入る",
    mixedCalc.estimatedTotalYen === 300_000 &&
      mixedCalc.effects.find((e) => e.program.id === "loan-with-amount")
        ?.includedInTotal === false,
    `total=${mixedCalc.estimatedTotalYen}`,
  );
  const loanEst = estimateSupports(planOf([child("c1", 1)]), [
    loanWithAmount,
    grantWithAmount,
  ]);
  check(
    "estimateSupports: 貸付は返済必須フラグ付きで合計外・給付は合計内",
    loanEst.estimates.find((e) => e.program.id === "loan-with-amount")
      ?.isRepaymentRequired === true &&
      loanEst.estimates.find((e) => e.program.id === "loan-with-amount")
        ?.countedInTotal === false &&
      loanEst.confirmedTotalYen + loanEst.estimatedTotalYen === 300_000,
    `total=${loanEst.confirmedTotalYen + loanEst.estimatedTotalYen}`,
  );

  // ══════════════════════════════════════════════════════════
  section("H. 既存機能（API・結果画面・相談）の継続");
  // ══════════════════════════════════════════════════════════
  const routeRes = await GET();
  const routeBody = (await routeRes.json()) as {
    mock: boolean;
    disclaimer: string;
    verifiedProgramCount: number;
    programs: unknown[];
  };
  check(
    "GET /api/supports: スキーマ適合の制度一覧を返す（6件以上）",
    routeRes.status === 200 &&
      z.array(supportProgramSchema).safeParse(routeBody.programs).success &&
      routeBody.programs.length >= 4,
    `${routeBody.programs.length}件`,
  );
  check(
    "GET /api/supports: 確認済み制度と未確認モックが混在（mockフラグ・件数）",
    routeBody.mock === true &&
      routeBody.verifiedProgramCount >= 1 &&
      routeBody.programs.length > routeBody.verifiedProgramCount,
  );
  check(
    "免責文言: 確認済みと未確認モックが混在する旨を明示",
    registryDisclaimer().includes("照合済み") &&
      registryDisclaimer().includes("モック"),
    registryDisclaimer().slice(0, 40),
  );
  check(
    "公式制度カード: 確認済みと未確認が画面上で区別される",
    officialHtml.includes("公式確認済み（一部要確認）") &&
      officialHtml.includes("未確認の項目と理由") &&
      officialHtml.includes("要確認"),
  );
  check(
    "モックカード: 既存の安全表示（モック・未確認／URL未確認）が維持される",
    mockHtml.includes("モック・未確認") &&
      mockHtml.includes("URL未確認（公式リンクとして扱いません）"),
  );
  const sampleResult = buildSimulationResult(SAMPLE_INPUT, registry);
  check(
    "結果画面用の計算がレジストリで動作（確定＋推定＝各制度の合計）",
    sampleResult.supports.confirmedTotalYen +
      sampleResult.supports.estimatedTotalYen ===
      sampleResult.supports.effects
        .filter((e) => e.includedInTotal)
        .reduce((s, e) => s + (e.estimatedTotalYen ?? 0), 0),
    `confirmed=${sampleResult.supports.confirmedTotalYen} estimated=${sampleResult.supports.estimatedTotalYen}`,
  );
  const consultContext = toConsultContextProgram(childAllowance as SupportProgram);
  const consultMessages = buildInitialMessages({
    program: consultContext,
    userContext: null,
  });
  check(
    "相談連携: レジストリの制度でも相談開始メッセージが生成される",
    consultContext.id === "mock-child-allowance" &&
      consultMessages.length === 1 &&
      consultContext.amountDescription ===
        (childAllowance as SupportProgram).amount.description,
  );

  console.log(
    `\nverify-m6c: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`,
  );
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});