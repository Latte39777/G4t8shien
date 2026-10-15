/**
 * アンケートフォームの入力状態・バリデーション・送信データ変換（純関数）。
 *
 * - UI（components/Form.tsx）から切り出して回帰テストしやすくしている
 * - 任意項目は未入力のままでも通過する（推測しない）
 */
import type {
  BirthTiming,
  ChildRow,
  DisabilityInHousehold,
  IncomeBandId,
  PlanStatus,
  SimulationInput,
  WorkAfterBirth,
} from "@/lib/simulation";
import { buildRegion } from "@/lib/regions";

/** 1世帯あたりの子ども行の上限 */
export const MAX_CHILDREN = 10;

/** 入力エラー（フィールドキー → メッセージ） */
export type FieldErrors = Record<string, string>;

/** フォームの入力状態（数値欄は未入力を許容するため文字列で保持） */
export type FormState = {
  planStatus: PlanStatus | null;
  existing: ChildRow[];
  planned: ChildRow[];
  desiredChildCount: string;
  firstBirthTiming: BirthTiming | null;
  incomeBand: IncomeBandId | null;
  annualIncome: string;
  monthlyTakeHome: string;
  livingExpense: string;
  housingCost: string;
  savings: string;
  /** 都道府県コード（"" は未選択） */
  prefectureCode: string;
  /** 市区町村名（"" は未選択） */
  municipalityName: string;
  householdType: "single" | "couple" | "other" | null;
  schoolCourse: "public" | "private" | null;
  universityCourse: "national" | "public" | "private" | null;
  workAfterBirth: WorkAfterBirth | null;
  usedSupportProgramIds: string[];
  disabilityInHousehold: DisabilityInHousehold;
  targetAmount: string;
};

export const initialFormState: FormState = {
  planStatus: null,
  existing: [],
  planned: [],
  desiredChildCount: "",
  firstBirthTiming: null,
  incomeBand: null,
  annualIncome: "",
  monthlyTakeHome: "",
  livingExpense: "",
  housingCost: "",
  savings: "",
  prefectureCode: "",
  municipalityName: "",
  householdType: null,
  schoolCourse: null,
  universityCourse: null,
  workAfterBirth: null,
  usedSupportProgramIds: [],
  disabilityInHousehold: null,
  targetAmount: "",
};

/** 文字列 → 数値（未入力は null。推測しない） */
export function toNumberOrNull(raw: string): number | null {
  return raw.trim() === "" ? null : Number(raw);
}

/** 子ども行の要約（折りたたみ時に表示する。「2人（8歳・3歳）」など） */
export function summarizeChildren(rows: ChildRow[]): string | null {
  if (rows.length === 0) return null;
  const parts = rows.map((row) =>
    row.kind === "existing"
      ? row.ageYears === null
        ? "年齢未入力"
        : `${row.ageYears}歳`
      : row.birthInYears === null
        ? "時期未定"
        : `あと${row.birthInYears}年後`,
  );
  return `${rows.length}人（${parts.join("・")}）`;
}

/** 「詳しい家計・世帯情報（任意）」で入力済みの項目ラベル */
export function answeredDetailLabels(form: FormState): string[] {
  const labels: string[] = [];
  if (form.incomeBand !== null) labels.push("世帯年収の目安");
  if (form.annualIncome.trim() !== "") labels.push("世帯年収（金額）");
  if (form.monthlyTakeHome.trim() !== "") labels.push("月の手取り収入");
  if (form.livingExpense.trim() !== "") labels.push("月々の生活費");
  if (form.housingCost.trim() !== "") labels.push("家賃・住宅ローン");
  if (form.householdType !== null) labels.push("世帯構成");
  if (form.schoolCourse !== null) labels.push("教育方針（幼稚園〜高校）");
  if (form.universityCourse !== null) labels.push("大学の区分");
  if (form.workAfterBirth !== null) labels.push("出産後の働き方");
  if (form.usedSupportProgramIds.length > 0) labels.push("利用中の支援制度");
  if (form.disabilityInHousehold !== null) labels.push("障害の有無");
  return labels;
}

/**
 * 入力の目安（「あと何項目」表示）。
 * 試算に必要・または結果の解釈に重要な項目だけを数え、任意項目は数えない。
 */
export function remainingRecommendedItems(form: FormState): string[] {
  const items: string[] = [];
  if (form.planStatus === null) items.push("現在の状況");
  form.existing.forEach((row, index) => {
    if (row.ageYears === null) items.push(`第${index + 1}子の年齢`);
  });
  if (form.savings.trim() === "") items.push("現在の貯蓄額");
  return items;
}
/**
 * フォームの検証（純関数）。
 * - 必須: 現在の貯蓄額（残高推移の初期値）と、現在の子の年齢（計算に使用）
 * - 任意: 目標とする養育資金額を含むその他すべて。入力がある場合のみ書式を検証する
 */
export function validateForm(form: FormState): FieldErrors {
  const errors: FieldErrors = {};

  // 目標とする養育資金額（任意・未入力でも進められる）
  const targetRaw = form.targetAmount.trim();
  if (targetRaw !== "") {
    const target = Number(targetRaw);
    if (Number.isNaN(target) || !Number.isInteger(target) || target <= 0) {
      errors.targetAmount = "1円以上の整数で入力してください。";
    }
  }

  // 現在の貯蓄額（必須・残高推移の初期値に使う）
  const savings = Number(form.savings);
  if (form.savings.trim() === "" || Number.isNaN(savings)) {
    errors.savings = "現在の貯蓄額を入力してください。";
  } else if (!Number.isInteger(savings) || savings < 0) {
    errors.savings = "0以上の整数で入力してください。";
  }

  // 現在の子ども：年齢は計算に使うため必須（満年齢の整数に統一）
  for (const row of form.existing) {
    if (row.ageYears === null) {
      errors[`child.${row.id}`] = "年齢を選択してください。";
    }
  }

  // 任意の金額欄：入力がある場合のみ検証（未入力・未定は推測しない）
  const optionalMoney: Array<[string, string]> = [
    ["annualIncome", form.annualIncome],
    ["monthlyTakeHome", form.monthlyTakeHome],
    ["livingExpense", form.livingExpense],
    ["housingCost", form.housingCost],
  ];
  for (const [key, raw] of optionalMoney) {
    if (raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isNaN(value) || !Number.isInteger(value) || value < 0) {
      errors[key] = "0以上の整数で入力してください。";
    }
  }

  // 子ども0人のときの希望人数（任意）
  if (form.desiredChildCount.trim() !== "") {
    const n = Number(form.desiredChildCount);
    if (!Number.isInteger(n) || n < 0 || n > 20) {
      errors.desiredChildCount = "0以上の整数で入力してください。";
    }
  }

  return errors;
}

/**
 * フォーム入力 → シミュレーション入力（純関数）。
 * - 折りたたみ状態に関わらず、入力済みの子どもはすべて送る（対象が意図せず変わらない）
 * - 地域は都道府県＋市区町村の選択から正規化して保存する（municipality は互換の表示用文字列）
 * - 目標養育資金額は未入力なら null（計算には使わない）
 */
export function toSimulationInput(form: FormState): SimulationInput {
  const region = buildRegion(form.prefectureCode, form.municipalityName || null);
  return {
    childCount: form.existing.length + form.planned.length,
    savings: Number(form.savings),
    targetAmount: toNumberOrNull(form.targetAmount),
    planStatus: form.planStatus,
    children: [...form.existing, ...form.planned],
    desiredChildCount: toNumberOrNull(form.desiredChildCount),
    firstBirthTiming: form.firstBirthTiming,
    household: {
      annualIncomeYen: toNumberOrNull(form.annualIncome),
      incomeBand: form.incomeBand,
      monthlyTakeHomeYen: toNumberOrNull(form.monthlyTakeHome),
      monthlyLivingExpenseYen: toNumberOrNull(form.livingExpense),
      monthlyHousingCostYen: toNumberOrNull(form.housingCost),
      municipality: region ? region.label : null,
      region,
      householdType: form.householdType,
      schoolCourse: form.schoolCourse,
      universityCourse: form.universityCourse,
      workAfterBirth: form.workAfterBirth,
      usedSupportProgramIds: [...form.usedSupportProgramIds],
      disabilityInHousehold: form.disabilityInHousehold,
    },
  };
}