/**
 * シミュレーション結果のビューモデル（M4・純関数）
 *
 * - 計算エンジン（lib/finance/）は無変更のまま読み取り、表示用の集計・整形のみを行う
 * - 子ども別の費用と世帯全体の合計を区別して保持し、
 *   「Σ 子ども別 = 世帯合計 = projectCashflow の childCostTotalYen」が常に成立する
 * - 費用の確認状況（basis: reference / assumed）を必ず区別して保持し、
 *   未確認の費用総額を確定値として扱わない（hasUnverified フラグ）
 * - 妊娠・出産の費用はコストマスタにデータがないため 0 円扱いとし、未整備と明示する
 */
import type {
  CashflowProjection,
  ChildInput,
  FamilyPlan,
  Stage,
  UniversityCourse,
} from "./types/finance";
import {
  annualChildCosts,
  COST_MASTER,
  entranceCostYen,
  STAGE_YEARS,
  stageForAge,
} from "./finance/costs";
import { allocateSelfFunding, projectCashflow } from "./finance/cashflow";
import {
  allocateSupportByStage,
  calculateSupportEffects,
  type SupportCalcResult,
  type SupportEffect,
  type UnallocatedSupport,
} from "./finance/supports";
import type { SupportProgram } from "./types/support";
import type { ChildRow, SimulationInput, WorkAfterBirth } from "./simulation";
import {
  toFamilyPlan,
  WORK_INCOME_CHANGE_RULES,
} from "./simulation";

/** 結果画面の教育段階（横棒グラフの区分） */
export type DisplayStageKey =
  | "pregnancy"
  | "infancy"
  | "elementary"
  | "junior_high"
  | "high_school"
  | "university";

export type DisplayStageDef = {
  key: DisplayStageKey;
  label: string;
  ageLabel: string;
  engineStages: Stage[];
  /** 費用データが未整備の段階 */
  dataMissing: boolean;
};

export const DISPLAY_STAGES: DisplayStageDef[] = [
  {
    key: "pregnancy",
    label: "妊娠・出産",
    ageLabel: "妊娠〜出産",
    engineStages: [],
    dataMissing: true,
  },
  {
    key: "infancy",
    label: "乳幼児",
    ageLabel: "0〜5歳",
    engineStages: ["infant", "preschool"],
    dataMissing: false,
  },
  {
    key: "elementary",
    label: "小学校",
    ageLabel: "6〜11歳",
    engineStages: ["elementary"],
    dataMissing: false,
  },
  {
    key: "junior_high",
    label: "中学校",
    ageLabel: "12〜14歳",
    engineStages: ["junior_high"],
    dataMissing: false,
  },
  {
    key: "high_school",
    label: "高校",
    ageLabel: "15〜17歳",
    engineStages: ["high_school"],
    dataMissing: false,
  },
  {
    key: "university",
    label: "大学・専門学校",
    ageLabel: "18〜21歳",
    engineStages: ["university"],
    dataMissing: false,
  },
];

/** 段階の内訳1行（コストマスタのエントリ＋対象年数） */
export type CostLineItem = {
  id: string;
  label: string;
  category: string;
  /** 年額（entrance は一時金） */
  annualYen: number;
  /** このシミュレーションに含まれる対象年数 */
  years: number;
  subtotalYen: number;
  basis: "reference" | "assumed";
  sourceTitle: string | null;
  sourceOrganization: string | null;
  sourceUrl: string | null;
  sourceUrlVerified: boolean;
  note: string | null;
};

/** 大学の区分別比較（国立・公立・私立を区別して表示するため） */
export type UniversityOption = {
  course: UniversityCourse;
  label: string;
  annualYen: number;
  entranceYen: number;
  basis: "reference" | "assumed";
};

/**
 * 教育段階ごとの費用を「どうまかなうか」（支援ON/OFF表示用）。
 * 内訳（自前資金＋充当した支援＋不足額）は常に totalYen と一致する。
 */
export type StageFunding = {
  /** 青：自分で用意できる資金（現在の貯蓄と各年の収支から段階ごとに配分。重複計上なし） */
  selfFundedYen: number;
  /** 確定している支援額（この段階に配分した額） */
  supportConfirmedYen: number;
  /** 推定・要確認の支援額（この段階に配分した額） */
  supportEstimatedYen: number;
  /** 支援OFF時の不足額（必要額 − 自前資金） */
  shortageWithoutSupportYen: number;
  /** 不足に充当した確定支援額（緑のうち確定分） */
  supportConfirmedAppliedYen: number;
  /** 不足に充当した推定支援額（緑のうち推定・要確認分） */
  supportEstimatedAppliedYen: number;
  /** 不足に充当した支援額の合計（緑） */
  supportAppliedYen: number;
  /** 支援ON時も残る不足額（赤） */
  shortageWithSupportYen: number;
  /** 必要額を上回った支援額（棒には描画しない） */
  supportSurplusYen: number;
  /** この段階に配分した制度 ID */
  supportProgramIds: string[];
};

export type StageCostDetail = {
  key: DisplayStageKey;
  label: string;
  ageLabel: string;
  /** このシミュレーションに含まれる対象年数 */
  years: number;
  /** 費用計上の全体年数（参考） */
  fullYears: number;
  totalYen: number;
  assumedYen: number;
  referenceYen: number;
  items: CostLineItem[];
  /** 計算条件（公立/私立など）・要確認事項 */
  note: string | null;
  dataMissing: boolean;
  /** 大学段階のみ：国立・公立・私立の区分別金額 */
  universityOptions?: UniversityOption[];
  /** 費用のまかなえ方（自前資金・支援・不足額） */
  funding: StageFunding;
};

/** 子ども1人分の結果 */
export type ChildResult = {
  childId: string;
  /** 「第1子」など */
  label: string;
  kind: ChildRow["kind"];
  /** 「現在 8歳」「予定：2年後に出産」など */
  statusText: string;
  /** 幼稚園〜高校の教育方針（公立/私立） */
  courseLabel: string;
  /** 大学の区分（国立/公立/私立） */
  universityLabel: string;
  /** 予定の子で出産予定時期が未定＝計算対象外 */
  excludedFromCalc: boolean;
  stages: StageCostDetail[];
  totalYen: number;
  assumedYen: number;
  referenceYen: number;
  supportConfirmedYen: number;
  supportEstimatedYen: number;
};

/** 段階別の資金配分の前提・要確認事項（UI への明示用） */
export type FundingMeta = {
  /** 自分で用意できる資金の計算前提・予測の限界 */
  selfFundingNotes: string[];
  /** 支援の段階別配分の前提・要確認事項 */
  supportAllocationNotes: string[];
  /** 段階別に配分できなかった支援（理由付き） */
  unallocatedSupports: UnallocatedSupport[];
};

/** 計算に使用した前提条件（仮定値・未確認値の区別つき） */
export type AssumptionItem = {
  label: string;
  valueText: string;
  /** assumed=仮定値（要確認） / unverified=未確認 / reference=確認済 */
  flag: "assumed" | "unverified" | "reference";
  note: string | null;
};

/** 年ごとの収入・支出・収支・貯蓄残高（表示用） */
export type YearlyRowView = {
  yearOffset: number;
  yearLabel: string;
  childAgeText: string;
  incomeYen: number;
  incomeMultiplier: number;
  livingExpenseYen: number;
  childCostYen: number;
  expenseYen: number;
  supportConfirmedYen: number;
  supportEstimatedYen: number;
  netYen: number;
  savingsEndYen: number;
  /** 推定支援も反映した場合の残高（参考） */
  savingsWithEstimatedYen: number;
};

export type SimulationResult = {
  plan: FamilyPlan;
  projection: ReturnType<typeof projectCashflow>;
  supports: SupportCalcResult;
  children: ChildResult[];
  /** 世帯全体の段階別合計 */
  householdStages: StageCostDetail[];
  costTotals: {
    totalYen: number;
    assumedYen: number;
    referenceYen: number;
    /** 仮定値・未確認値を含むか（true の場合、総額を確定値として表示しない） */
    hasUnverified: boolean;
  };
  supportTotals: {
    confirmedYen: number;
    estimatedYen: number;
    /** 合計に含めなかった制度（理由付き） */
    uncounted: SupportEffect[];
    usedProgramIds: string[];
  };
  comparison: {
    grossCostYen: number;
    afterConfirmedYen: number;
    afterAllYen: number;
  };
  /**
   * 目標とする養育資金額のカバー状況（未入力は null）。
   * 現在の貯蓄（確定）と支援見込額（未確認・推定を含む）は確度が異なるため、
   * 画面では区別して表示する。
   */
  goalCoverage: {
    targetYen: number;
    savingsYen: number;
    supportConfirmedYen: number;
    supportEstimatedYen: number;
    supportTotalYen: number;
    /** 目標との差額（正=不足、負=目標を上回る金額） */
    gapYen: number;
  } | null;
  yearly: YearlyRowView[];
  savingsSeries: {
    yearOffset: number;
    label: string;
    savingsEndYen: number;
    savingsWithEstimatedYen: number;
  }[];
  /** 段階別の資金配分の前提・要確認事項 */
  fundingMeta: FundingMeta;
  assumptions: AssumptionItem[];
  /** 未入力を 0 円等で扱った場合の影響（ユーザーへの明示用） */
  unenteredNotices: string[];
  /** 出産後の働き方による収入変化の扱い（明示用） */
  incomeChangeNote: string | null;
};

const UNIVERSITY_LABELS: Record<UniversityCourse, string> = {
  national: "国立",
  public: "公立",
  private: "私立",
};

/** 大学の区分別（国立・公立・私立）の金額（比較表示用） */
function universityOptions(): UniversityOption[] {
  return (["national", "public", "private"] as UniversityCourse[]).map(
    (course) => {
      const annual =
        annualChildCosts("university", { school: "public", university: course })
          .universityYen;
      const entrance = entranceCostYen("university", {
        school: "public",
        university: course,
      });
      return {
        course,
        label: UNIVERSITY_LABELS[course],
        annualYen: annual,
        entranceYen: entrance,
        basis: course === "private" ? "reference" : "assumed",
      };
    },
  );
}

type ChildAgg = {
  yearsByStage: Partial<Record<Stage, number>>;
  oneTimeByStage: Partial<Record<Stage, number>>;
};

/** プロジェクション結果から、子どもごとの段階別年数・一時金を集計 */
function aggregateChildStages(
  childId: string,
  projection: CashflowProjection,
): ChildAgg {
  const yearsByStage: Partial<Record<Stage, number>> = {};
  const oneTimeByStage: Partial<Record<Stage, number>> = {};
  for (const row of projection.rows) {
    for (const c of row.children) {
      if (c.childId !== childId || c.stage === null) continue;
      if (c.stage === "after_university") continue;
      yearsByStage[c.stage] = (yearsByStage[c.stage] ?? 0) + 1;
      if (c.oneTimeYen > 0) {
        oneTimeByStage[c.stage] = (oneTimeByStage[c.stage] ?? 0) + c.oneTimeYen;
      }
    }
  }
  return { yearsByStage, oneTimeByStage };
}

/** 1人の段階別内訳（グラフ・詳細パネル用。funding は呼び出し側で配分結果を付与する） */
function buildStageDetails(
  child: ChildInput,
  agg: ChildAgg,
): Omit<StageCostDetail, "funding">[] {
  const course = { school: child.course, university: child.universityCourse };
  return DISPLAY_STAGES.map((def) => {
    const items: CostLineItem[] = [];
    for (const engineStage of def.engineStages) {
      const years = agg.yearsByStage[engineStage] ?? 0;
      const annual = annualChildCosts(engineStage, course);
      for (const entry of annual.entries) {
        items.push({
          id: entry.id,
          label: entry.label,
          category: entry.category,
          annualYen: entry.amountYen,
          years,
          subtotalYen: entry.amountYen * years,
          basis: entry.basis,
          sourceTitle: entry.source?.title ?? null,
          sourceOrganization: entry.source?.organization ?? null,
          sourceUrl: entry.source?.url ?? null,
          sourceUrlVerified: entry.source?.urlVerified ?? false,
          note: entry.note,
        });
      }
      // 入学料（大学入学の年に1回。entry 単位で basis・出典を保持）
      const oneTime = agg.oneTimeByStage[engineStage] ?? 0;
      if (oneTime > 0) {
        const entranceEntries = COST_MASTER.filter(
          (e) =>
            e.category === "entrance" &&
            e.stage === engineStage &&
            (e.course === "common" || e.course === course.university),
        );
        for (const entry of entranceEntries) {
          items.push({
            id: entry.id,
            label: entry.label,
            category: entry.category,
            annualYen: entry.amountYen,
            years: 1,
            subtotalYen: oneTime,
            basis: entry.basis,
            sourceTitle: entry.source?.title ?? null,
            sourceOrganization: entry.source?.organization ?? null,
            sourceUrl: entry.source?.url ?? null,
            sourceUrlVerified: entry.source?.urlVerified ?? false,
            note: entry.note,
          });
        }
      }
    }
    const totalYen = items.reduce((s, i) => s + i.subtotalYen, 0);
    const assumedYen = items
      .filter((i) => i.basis === "assumed")
      .reduce((s, i) => s + i.subtotalYen, 0);
    const years = def.engineStages.reduce(
      (s, st) => s + (agg.yearsByStage[st] ?? 0),
      0,
    );
    const fullYears = def.engineStages.reduce(
      (s, st) => s + ((STAGE_YEARS as Record<string, number>)[st] ?? 0),
      0,
    );
    const courseNote =
      def.key === "university"
        ? `計算条件：大学の区分＝${UNIVERSITY_LABELS[child.universityCourse]}（入学料は18歳の年に1回計上）`
        : `計算条件：幼稚園〜高校＝${child.course === "public" ? "公立" : "私立"}`;
    return {
      key: def.key,
      label: def.label,
      ageLabel: def.ageLabel,
      years,
      fullYears,
      totalYen,
      assumedYen,
      referenceYen: totalYen - assumedYen,
      items,
      note: def.dataMissing
        ? "費用データ未整備（要確認）：コストマスタに該当エントリがないため 0 円として扱っています"
        : courseNote,
      dataMissing: def.dataMissing,
      ...(def.key === "university"
        ? { universityOptions: universityOptions() }
        : {}),
    };
  });
}

function childStatusText(row: ChildRow): string {
  if (row.kind === "existing") return `現在 ${row.ageYears}歳`;
  if (row.birthInYears === null) return "予定：出産予定時期が未定（計算対象外）";
  return row.birthInYears === 0
    ? "予定：今年出産"
    : `予定：${row.birthInYears}年後に出産`;
}

const WORK_LABELS: Record<WorkAfterBirth, string> = {
  unchanged: "変わらない",
  parental_leave: "育児休業中は収入が減る",
  part_time: "時短勤務などに変わる",
  quit: "退職する",
  undecided: "未定",
};

/** 出産後の働き方による収入変化の扱い（ユーザーへの明示用） */
export function buildIncomeChangeNote(input: SimulationInput): string | null {
  const work = input.household.workAfterBirth;
  if (work === null) return null;
  const rule = WORK_INCOME_CHANGE_RULES[work];
  const planned = input.children.filter(
    (r) => r.kind === "planned" && r.birthInYears !== null,
  );
  if (rule === null) {
    return `出産後の働き方「${WORK_LABELS[work]}」：収入変化なしとして計算しています（要確認）。`;
  }
  if (planned.length === 0) {
    return `出産後の働き方「${WORK_LABELS[work]}」：すでに生まれているお子さまへの適用は、現在の手取り収入に変化後の金額が反映済みとみなして行いません（要確認）。`;
  }
  const from = Math.min(...planned.map((r) => r.birthInYears as number));
  const dur =
    rule.durationYears === null ? "期間の上限なし" : `${rule.durationYears}年間`;
  return `出産後の働き方「${WORK_LABELS[work]}」：${from}年後（予定の子の出生）から${dur}、手取り収入に係数 ${rule.multiplier} を適用しています（仮定値・要確認）。`;
}

/** 未入力を 0 円等で扱った場合の影響（ユーザーへの明示用） */
export function buildUnenteredNotices(input: SimulationInput): string[] {
  const h = input.household;
  const notices: string[] = [];
  if (h.monthlyTakeHomeYen === null) {
    notices.push(
      "月の手取り収入が未入力のため、家計収支の収入は 0 円として計算しています。",
    );
  }
  if (h.monthlyLivingExpenseYen === null) {
    if (h.monthlyHousingCostYen !== null) {
      notices.push(
        "月々の生活費が未入力のため、家賃・住宅ローンの金額を世帯の固定支出として反映しています（要確認）。",
      );
    } else {
      notices.push(
        "月々の生活費が未入力のため、世帯の生活費は 0 円として計算しています。",
      );
    }
  } else if (h.monthlyHousingCostYen !== null) {
    notices.push(
      "家賃・住宅ローンは「月々の生活費に含まれる」前提で追加差し引きしていません（二重計上の防止。生活費に住居費を含めない場合は、生活費に住居費を含めない金額で入力してください）。",
    );
  }
  if (h.annualIncomeYen === null) {
    notices.push(
      "世帯年収が未入力のため、所得制限のある支援制度は判定を保留（要確認）にしています。",
    );
  }
  if (h.municipality === null) {
    notices.push("居住地が未入力のため「未定」で計算しています（自治体独自制度の判定は保留）。");
  }
  if (h.householdType === null) {
    notices.push("世帯構成が未選択のため「その他」で計算しています（要確認）。");
  }
  if (h.schoolCourse === null) {
    notices.push("教育方針（幼稚園〜高校）が未選択のため「公立」で暫定計算しています（要確認）。");
  }
  if (h.universityCourse === null) {
    notices.push("大学の区分が未選択のため「国立」で暫定計算しています（要確認）。");
  }
  const undetermined = input.children.filter(
    (r) => r.kind === "planned" && r.birthInYears === null,
  );
  if (undetermined.length > 0) {
    notices.push(
      `出産予定時期が未定のお子さまが ${undetermined.length} 人います。計算には含めていません。`,
    );
  }
  return notices;
}

/** engine Stage を、結果画面の教育段階キーへ集約する（対応する段階がなければ null） */
function displayStageKeyForEngineStage(stage: Stage): DisplayStageKey | null {
  const def = DISPLAY_STAGES.find((d) => d.engineStages.includes(stage));
  return def === undefined ? null : def.key;
}

/**
 * 年齢→結果画面の教育段階キー。
 * ageYears=null は出生前の年で「妊娠・出産」段階に対応付ける（対象期間の重なりの規準）。
 */
function displayStageKeyForAge(
  ageYears: number | null,
): DisplayStageKey | null {
  if (ageYears === null) return "pregnancy";
  return displayStageKeyForEngineStage(stageForAge(ageYears));
}

/**
 * 教育段階ごとの「必要額のまかなえ方」を組み立てる。
 * - 自前資金は必要額を超えて充当されない（超過分も次の段階へ繰り越さない＝重複計上なし）
 * - 緑（支援）は不足部分に充当する形で表示し、確定支援を先に充当して推定はその残りから充当する
 * - 必要額を上回った支援は棒に描画せず supportSurplusYen として保持する
 * - selfFundedYen + supportAppliedYen + shortageWithSupportYen = totalYen が常に成立する
 */
function buildStageFunding(input: {
  totalYen: number;
  selfFundedYen: number;
  supportConfirmedYen: number;
  supportEstimatedYen: number;
  supportProgramIds: string[];
}): StageFunding {
  const totalYen = Math.max(input.totalYen, 0);
  const selfFundedYen = Math.min(Math.max(input.selfFundedYen, 0), totalYen);
  const shortageWithoutSupportYen = totalYen - selfFundedYen;
  const supportConfirmedAppliedYen = Math.min(
    input.supportConfirmedYen,
    shortageWithoutSupportYen,
  );
  const supportEstimatedAppliedYen = Math.min(
    input.supportEstimatedYen,
    shortageWithoutSupportYen - supportConfirmedAppliedYen,
  );
  const supportAppliedYen =
    supportConfirmedAppliedYen + supportEstimatedAppliedYen;
  const shortageWithSupportYen = shortageWithoutSupportYen - supportAppliedYen;
  const supportSurplusYen = Math.max(
    input.supportConfirmedYen + input.supportEstimatedYen - supportAppliedYen,
    0,
  );
  return {
    selfFundedYen,
    supportConfirmedYen: input.supportConfirmedYen,
    supportEstimatedYen: input.supportEstimatedYen,
    shortageWithoutSupportYen,
    supportConfirmedAppliedYen,
    supportEstimatedAppliedYen,
    supportAppliedYen,
    shortageWithSupportYen,
    supportSurplusYen,
    supportProgramIds: input.supportProgramIds,
  };
}

/**
 * フォーム入力と支援制度データから、結果画面のビューモデルを組み立てる（純関数）。
 * - 子ども別合計の総和 = 世帯合計 = projection.totals.childCostTotalYen（整合）
 * - 世帯年収（annualIncomeYen）は支援の対象条件確認にのみ使い、
 *   家計収支の収入には月の手取り収入 × 12 を使う
 * - 段階別の自前資金・支援額は、貯蓄・支援額を段階間で重複計上しないよう配分する
 */
export function buildSimulationResult(
  input: SimulationInput,
  programs: SupportProgram[],
): SimulationResult {
  const plan = toFamilyPlan(input);
  const supports = calculateSupportEffects(plan, programs, {
    excludeProgramIds: input.household.usedSupportProgramIds,
  });
  const projection = projectCashflow(plan, supports.schedule);

  // 教育段階ごとの資金配分（自前資金・支援。貯蓄・支援額の重複計上をしない）
  const selfAllocation = allocateSelfFunding(plan, projection);
  const supportAllocation = allocateSupportByStage(plan, supports.effects, {
    stageKeys: DISPLAY_STAGES.map((d) => d.key),
    stageKeyForAge: displayStageKeyForAge,
  });
  const selfByDisplayStage = (
    byStage: Map<Stage, number> | undefined,
  ): Map<DisplayStageKey, number> => {
    const out = new Map<DisplayStageKey, number>();
    if (byStage === undefined) return out;
    for (const [engineStage, yen] of byStage) {
      const key = displayStageKeyForEngineStage(engineStage);
      if (key === null || yen <= 0) continue;
      out.set(key, (out.get(key) ?? 0) + yen);
    }
    return out;
  };
  const householdSelfByStage = selfByDisplayStage(selfAllocation.byStage);

  // 子ども別の支援見込額（確定/推定を分離。利用中制度は除外済み）
  const perChildConfirmed: Record<string, number> = {};
  const perChildEstimated: Record<string, number> = {};
  for (const effect of supports.effects) {
    if (!effect.includedInTotal) continue;
    for (const pc of effect.perChild) {
      if (pc.totalYen === null) continue;
      const target =
        effect.program.amount.basis === "confirmed"
          ? perChildConfirmed
          : perChildEstimated;
      target[pc.childId] = (target[pc.childId] ?? 0) + pc.totalYen;
    }
  }

  const policy = input.household;
  const children: ChildResult[] = input.children.map((row, index) => {
    const childInput =
      plan.children.find((c) => c.id === row.id) ??
      ({
        id: row.id,
        currentAgeYears: row.kind === "existing" ? row.ageYears : null,
        birthInYears: row.kind === "planned" ? row.birthInYears : null,
        course: policy.schoolCourse ?? "public",
        universityCourse: policy.universityCourse ?? "national",
      } as ChildInput);
    const stages = buildStageDetails(
      childInput,
      aggregateChildStages(row.id, projection),
    );
    // この子の段階別の自前資金・支援額を付与（世帯全体と二重に数えない）
    const childSelfByStage = selfByDisplayStage(selfAllocation.byChild.get(row.id));
    const childSupportByStage = supportAllocation.byChild.get(row.id);
    const stagesWithFunding: StageCostDetail[] = stages.map((st) => {
      const bucket = childSupportByStage?.get(st.key);
      return {
        ...st,
        funding: buildStageFunding({
          totalYen: st.totalYen,
          selfFundedYen: childSelfByStage.get(st.key) ?? 0,
          supportConfirmedYen: bucket?.confirmedYen ?? 0,
          supportEstimatedYen: bucket?.estimatedYen ?? 0,
          supportProgramIds: bucket?.programIds ?? [],
        }),
      };
    });
    const totalYen = stages.reduce((s, st) => s + st.totalYen, 0);
    const assumedYen = stages.reduce((s, st) => s + st.assumedYen, 0);
    return {
      childId: row.id,
      label: `第${index + 1}子`,
      kind: row.kind,
      statusText: childStatusText(row),
      courseLabel: childInput.course === "public" ? "公立" : "私立",
      universityLabel: UNIVERSITY_LABELS[childInput.universityCourse],
      excludedFromCalc: plan.children.every((c) => c.id !== row.id),
      stages: stagesWithFunding,
      totalYen,
      assumedYen,
      referenceYen: totalYen - assumedYen,
      supportConfirmedYen: perChildConfirmed[row.id] ?? 0,
      supportEstimatedYen: perChildEstimated[row.id] ?? 0,
    };
  });

  // 世帯全体の段階別合計（子ども別の合算＝projectCashflow の総額と一致）
  const householdStages: StageCostDetail[] = DISPLAY_STAGES.map((def, i) => {
    const parts = children.map((c) => c.stages[i]);
    const totalYen = parts.reduce((s, p) => s + p.totalYen, 0);
    const assumedYen = parts.reduce((s, p) => s + p.assumedYen, 0);
    const itemMap = new Map<string, CostLineItem>();
    for (const p of parts) {
      for (const item of p.items) {
        const prev = itemMap.get(item.id);
        if (prev === undefined) {
          itemMap.set(item.id, { ...item });
        } else {
          prev.years += item.years;
          prev.subtotalYen += item.subtotalYen;
        }
      }
    }
    return {
      key: def.key,
      label: def.label,
      ageLabel: def.ageLabel,
      years: parts.reduce((s, p) => s + p.years, 0),
      fullYears: parts.reduce((s, p) => s + p.fullYears, 0),
      totalYen,
      assumedYen,
      referenceYen: totalYen - assumedYen,
      items: [...itemMap.values()],
      note: parts[0]?.note ?? null,
      dataMissing: def.dataMissing,
      funding: buildStageFunding({
        totalYen,
        selfFundedYen: householdSelfByStage.get(def.key) ?? 0,
        supportConfirmedYen:
          supportAllocation.byStage.get(def.key)?.confirmedYen ?? 0,
        supportEstimatedYen:
          supportAllocation.byStage.get(def.key)?.estimatedYen ?? 0,
        supportProgramIds:
          supportAllocation.byStage.get(def.key)?.programIds ?? [],
      }),
      ...(def.key === "university"
        ? { universityOptions: universityOptions() }
        : {}),
    };
  });

  const costTotalYen = children.reduce((s, c) => s + c.totalYen, 0);
  const costAssumedYen = children.reduce((s, c) => s + c.assumedYen, 0);

  // 年ごとの収入・支出・収支・貯蓄残高（推定支援込みの残高は参考値）
  let savingsRef = plan.savings;
  const childLabelById = new Map(children.map((c) => [c.childId, c.label]));
  const yearly: YearlyRowView[] = projection.rows.map((r) => {
    savingsRef += r.netWithEstimatedYen;
    const childAgeText = r.children
      .filter((c) => c.ageYears !== null)
      .map((c) => `${childLabelById.get(c.childId) ?? ""} ${c.ageYears}歳`)
      .join("・");
    return {
      yearOffset: r.yearOffset,
      yearLabel: r.yearOffset === 0 ? "現在" : `${r.yearOffset}年後`,
      childAgeText,
      incomeYen: r.incomeYen,
      incomeMultiplier: r.incomeMultiplier,
      livingExpenseYen: r.baseExpenseYen,
      childCostYen: r.childCostTotalYen,
      expenseYen: r.baseExpenseYen + r.childCostTotalYen,
      supportConfirmedYen: r.supportConfirmedYen,
      supportEstimatedYen: r.supportEstimatedYen,
      netYen: r.netYen,
      savingsEndYen: r.savingsEndYen,
      savingsWithEstimatedYen: savingsRef,
    };
  });

  const h = input.household;
  const incomeChangeNote = buildIncomeChangeNote(input);
  const livingText =
    h.monthlyLivingExpenseYen !== null
      ? `${h.monthlyLivingExpenseYen}円/月 × 12か月${h.monthlyHousingCostYen !== null ? "（住居費を含む前提で、家賃・住宅ローンは追加差し引きしない）" : ""}`
      : h.monthlyHousingCostYen !== null
        ? `生活費未入力のため家賃・住宅ローン ${h.monthlyHousingCostYen}円/月 を固定支出として反映（要確認）`
        : "0円（未入力）";
  const assumptions: AssumptionItem[] = [
    {
      label: "子育て費用のデータ",
      valueText: `総額に含まれる金額：確認済み出典 ${costTotalYen - costAssumedYen}円／仮定値 ${costAssumedYen}円`,
      flag: costAssumedYen > 0 ? "assumed" : "reference",
      note: "コストマスタの大半は仮定値（要確認）。私立大学の学費・入学料のみ一次資料で数値確認済み。総額を確定値として扱わないでください",
    },
    {
      label: "幼稚園〜高校の教育方針",
      valueText:
        (h.schoolCourse === null
          ? "未選択（公立で暫定計算・要確認）"
          : h.schoolCourse === "public"
            ? "公立"
            : "私立"),
      flag: h.schoolCourse === null ? "assumed" : "reference",
      note: null,
    },
    {
      label: "大学の区分",
      valueText:
        h.universityCourse === null
          ? "未選択（国立で暫定計算・要確認）"
          : h.universityCourse === "national"
            ? "国立"
            : h.universityCourse === "public"
              ? "公立"
              : "私立",
      flag: h.universityCourse === null ? "assumed" : "reference",
      note: "大学は国立・公立・私立で金額を区別しています",
    },
    {
      label: "家計収支の収入",
      valueText: `月の手取り収入 × 12${incomeChangeNote !== null ? "（出産後の収入変化を適用）" : ""}`,
      flag: "reference",
      note: "世帯年収は支援の対象条件（所得制限など）の確認にのみ使用し、家計収支の収入には使いません",
    },
    {
      label: "家計収支の支出",
      valueText: livingText,
      flag: "assumed",
      note: "家賃・住宅ローンが生活費に含まれる場合、二重に差し引きしていません",
    },
    {
      label: "出産後の働き方・収入変化",
      valueText: incomeChangeNote ?? "収入変化なしとして計算",
      flag: "assumed",
      note: "収入変化の係数・期間はすべて仮定値（要確認）です",
    },
    {
      label: "公的支援の額",
      valueText: `確定 ${supports.confirmedTotalYen}円／推定 ${supports.estimatedTotalYen}円`,
      flag: "unverified",
      note: "モックデータに基づく未確認の試算です。確定した支給額ではありません",
    },
    {
      label: "妊娠・出産の費用",
      valueText: "0円（費用データ未整備）",
      flag: "unverified",
      note: "コストマスタに該当データがないため 0 円として扱っています（要確認）",
    },
    {
      label: "居住地・自治体",
      valueText: h.municipality ?? "未定（未入力）",
      flag: h.municipality === null ? "unverified" : "reference",
      note: "自治体独自の制度・助成の判定には詳細な居住地が必要です",
    },
    {
      label: "現在の貯蓄額",
      valueText: `${input.savings}円（残高推移の初期値）`,
      flag: "reference",
      note: null,
    },
  ];

  // 段階別資金配分の前提・要確認事項（推定値を確定扱いしないための明示）
  const fundingMeta: FundingMeta = {
    selfFundingNotes: [
      "「自分で用意できる資金」は、現在の貯蓄と各年の収支（手取り収入 − 世帯生活費）から、その年に支払える分だけを教育段階ごとに充当して計算しています（同じ貯蓄を複数の段階で重複して使っていません）。",
      ...(h.monthlyTakeHomeYen === null
        ? [
            "月の手取り収入が未入力のため収入0円として計算しています。将来の家計予測には予測の限界があり、自前資金も実際より少なくなる可能性があります（要確認）。",
          ]
        : []),
      ...(h.monthlyLivingExpenseYen === null
        ? [
            "月々の生活費が未入力のため、世帯生活費は暫定値で計算しています。将来の家計予測の精度には限界があります（要確認）。",
          ]
        : []),
      ...(selfAllocation.uncoveredYen > 0
        ? [
            `自前資金でまかなえない費用が ${selfAllocation.uncoveredYen}円 あります。不足額（赤）には、支援を反映しても残る費用が含まれます（要確認）。`,
          ]
        : []),
    ],
    supportAllocationNotes: [
      "教育段階ごとの支援額は、制度の対象年齢・対象期間と各年の子どもの年齢の重なりで配分しています（出生前の期間は「妊娠・出産」に計上）。",
      "貸付（返済が必要）・金額未確認・対象外・現在利用中の制度は配分せず、理由を付けて未配分としています。",
      "推定・要確認の支援を含みます。支給が確定した金額ではありません（モック・未確認データ）。",
      ...supportAllocation.notes,
    ],
    unallocatedSupports: supportAllocation.unallocated,
  };

  return {
    plan,
    projection,
    supports,
    children,
    householdStages,
    costTotals: {
      totalYen: costTotalYen,
      assumedYen: costAssumedYen,
      referenceYen: costTotalYen - costAssumedYen,
      hasUnverified: costAssumedYen > 0,
    },
    supportTotals: {
      confirmedYen: supports.confirmedTotalYen,
      estimatedYen: supports.estimatedTotalYen,
      uncounted: supports.uncounted,
      usedProgramIds: input.household.usedSupportProgramIds,
    },
    comparison: {
      grossCostYen: costTotalYen,
      afterConfirmedYen: costTotalYen - supports.confirmedTotalYen,
      afterAllYen:
        costTotalYen - supports.confirmedTotalYen - supports.estimatedTotalYen,
    },
    goalCoverage:
      input.targetAmount !== null && input.targetAmount > 0
        ? {
            targetYen: input.targetAmount,
            savingsYen: input.savings,
            supportConfirmedYen: supports.confirmedTotalYen,
            supportEstimatedYen: supports.estimatedTotalYen,
            supportTotalYen:
              supports.confirmedTotalYen + supports.estimatedTotalYen,
            gapYen:
              input.targetAmount -
              input.savings -
              supports.confirmedTotalYen -
              supports.estimatedTotalYen,
          }
        : null,
    yearly,
    savingsSeries: yearly.map((y) => ({
      yearOffset: y.yearOffset,
      label: y.yearLabel,
      savingsEndYen: y.savingsEndYen,
      savingsWithEstimatedYen: y.savingsWithEstimatedYen,
    })),
    fundingMeta,
    assumptions,
    unenteredNotices: buildUnenteredNotices(input),
    incomeChangeNote,
  };
}