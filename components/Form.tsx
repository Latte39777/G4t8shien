"use client";

import { useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  BirthTiming,
  ChildRow,
  ChildRowKind,
  IncomeBandId,
  PlanStatus,
  SimulationInput,
  WorkAfterBirth,
} from "@/lib/simulation";
import {
  BIRTH_TIMINGS,
  INCOME_BANDS,
  SAMPLE_INPUT,
  WORK_AFTER_BIRTH_OPTIONS,
  formatYen,
} from "@/lib/simulation";
import { getSupportPrograms } from "@/lib/supports/registry";
import { listMunicipalities, listPrefectures } from "@/lib/regions";
import {
  MAX_CHILDREN,
  answeredDetailLabels,
  initialFormState,
  remainingRecommendedItems,
  summarizeChildren,
  toSimulationInput,
  validateForm,
  type FieldErrors,
  type FormState,
} from "@/lib/form/model";

const PLAN_STATUS_OPTIONS: Array<{ id: PlanStatus; label: string }> = [
  { id: "have", label: "すでに子どもがいる" },
  { id: "planning", label: "これから子どもを持つ予定" },
  { id: "undecided", label: "未定" },
];

const DISABILITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "未回答" },
  { value: "none", label: "いいえ（障害のある方はいない）" },
  { value: "present", label: "はい（障害のある方がいる）" },
];

const inputClass =
  "w-full rounded-xl border bg-white px-4 py-3 pr-14 text-base font-semibold text-slate-900 outline-none transition focus:ring-2";
const selectClass =
  "w-full rounded-xl border bg-white px-4 py-3 text-base font-semibold text-slate-900 outline-none transition focus:ring-2";
const labelClass = "text-sm font-semibold text-slate-700";
const hintClass = "mt-1.5 text-xs leading-5 text-slate-400";
const errorClass = "mt-1.5 text-xs font-medium text-red-500";
const okBorder = "border-slate-300 focus:border-blue-400 focus:ring-blue-100";
const ngBorder = "border-red-300 focus:border-red-400 focus:ring-red-100";

const OptionalBadge = () => (
  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
    任意
  </span>
);

/** 金額入力（円）。未入力可の項目は optional */
function MoneyField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  optional?: boolean;
}) {
  return (
    <div>
      <label htmlFor={props.id} className={labelClass}>
        {props.label}
        {props.optional && <OptionalBadge />}
      </label>
      <div className="relative mt-1.5">
        <input
          id={props.id}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          aria-invalid={props.error ? true : undefined}
          className={`${inputClass} ${props.error ? ngBorder : okBorder}`}
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
          円
        </span>
      </div>
      {props.error ? (
        <p className={errorClass}>{props.error}</p>
      ) : props.hint ? (
        <p className={hintClass}>{props.hint}</p>
      ) : null}
    </div>
  );
}
/** 選択式入力 */
function SelectField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
  hint?: string;
  optional?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div>
      <label htmlFor={props.id} className={labelClass}>
        {props.label}
        {props.optional && <OptionalBadge />}
      </label>
      <select
        id={props.id}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.error ? true : undefined}
        data-testid={props.testId}
        className={`${selectClass} mt-1.5 ${
          props.disabled
            ? "border-slate-200 bg-slate-50 text-slate-400"
            : props.error
              ? ngBorder
              : okBorder
        }`}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.error ? (
        <p className={errorClass}>{props.error}</p>
      ) : props.hint ? (
        <p className={hintClass}>{props.hint}</p>
      ) : null}
    </div>
  );
}

/**
 * 折りたたみ（アコーディオン）。
 * 押す前から中身が分かるラベルと、入力済みの要約を必ず表示する。
 */
function Disclosure(props: {
  id: string;
  title: string;
  description: string;
  summary?: string | null;
  openLabel: string;
  closeLabel: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        aria-controls={`${props.id}-panel`}
        data-testid={`${props.id}-toggle`}
        className="flex w-full items-start justify-between gap-3 rounded-2xl px-4 py-4 text-left transition hover:bg-slate-50 sm:px-5"
      >
        <span>
          <span className="block text-sm font-bold text-slate-800">
            {props.title}
          </span>
          <span className="mt-1 block text-xs leading-5 text-slate-500">
            {props.description}
          </span>
          {props.summary ? (
            <span className="mt-2 inline-block rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
              {`入力済み：${props.summary}`}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 shrink-0 rounded-full border border-slate-300 px-3.5 py-2 text-xs font-bold text-slate-600">
          {props.open ? props.closeLabel : props.openLabel}
        </span>
      </button>
      {props.open && (
        <div
          id={`${props.id}-panel`}
          className="space-y-4 border-t border-slate-100 px-4 pb-5 pt-4 sm:px-5"
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

/** 現在の状況ごとの子どもの情報の表示モード */
type ChildrenMode = "have" | "planning" | "undecided";

function childrenModeOf(planStatus: PlanStatus | null): ChildrenMode {
  if (planStatus === "have") return "have";
  if (planStatus === "planning") return "planning";
  return "undecided";
}

/** 現在の状況ごとの折りたたみ初期状態（表示切替でも入力値は消さない） */
function defaultOpenFor(planStatus: PlanStatus | null): Record<string, boolean> {
  const base: Record<string, boolean> = {
    "child-bundle": false,
    "children-existing": false,
    "children-planned": false,
    "children-desired": false,
    details: false,
  };
  if (planStatus === "have") return { ...base, "children-existing": true };
  if (planStatus === "planning") return { ...base, "children-desired": true };
  return base;
}
type FormProps = {
  /** 「結果を見る」ボタン押下時（バリデーション通過後に呼ばれる） */
  onSubmit: (input: SimulationInput) => void;
  /** 「トップへ戻る」ボタン押下時 */
  onBack: () => void;
  /** テスト用の初期値（部分指定可。通常は指定しない） */
  initial?: Partial<FormState>;
};

export default function Form({ onSubmit, onBack, initial }: FormProps) {
  const [form, setForm] = useState<FormState>(() => ({
    ...initialFormState,
    ...initial,
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    defaultOpenFor(initial?.planStatus ?? null),
  );
  const idCounter = useRef(0);

  /**
   * 「現在の状況」の切り替えで表示構成を変える（入力値は保持する）。
   * 表示の初期状態は状況を変える操作のときにだけ同期する（effect は使わない）。
   */
  const changePlanStatus = (status: PlanStatus) => {
    setField("planStatus", status);
    setOpen(defaultOpenFor(status));
  };

  const toggleSection = (id: string) => {
    setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const nextChildId = (kind: ChildRowKind) => {
    idCounter.current += 1;
    return `${kind}-${idCounter.current}`;
  };

  /** 単一フィールドの更新（変更したフィールドのエラーは消す＝古い状態を残さない） */
  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const errorKey = key as string;
      if (!(errorKey in prev)) return prev;
      const next = { ...prev };
      delete next[errorKey];
      return next;
    });
  }

  /** 子ども1行のエラーを消す */
  function dropChildError(id: string) {
    setErrors((prev) => {
      const errorKey = `child.${id}`;
      if (!(errorKey in prev)) return prev;
      const next = { ...prev };
      delete next[errorKey];
      return next;
    });
  }

  /** 子ども行の追加（現在の子・予定の子を区別して保持。表示切替では消さない） */
  const addRow = (kind: ChildRowKind) => {
    const id = nextChildId(kind);
    const row: ChildRow = { id, kind, ageYears: null, birthInYears: null };
    setForm((prev) => ({
      ...prev,
      existing: kind === "existing" ? [...prev.existing, row] : prev.existing,
      planned: kind === "planned" ? [...prev.planned, row] : prev.planned,
    }));
    setOpen((prev) => ({
      ...prev,
      "children-existing": kind === "existing" ? true : prev["children-existing"],
      "children-planned": kind === "planned" ? true : prev["children-planned"],
    }));
  };

  /** 子ども行の削除（その行の入力値・エラーも破棄） */
  const removeRow = (id: string) => {
    setForm((prev) => ({
      ...prev,
      existing: prev.existing.filter((c) => c.id !== id),
      planned: prev.planned.filter((c) => c.id !== id),
    }));
    dropChildError(id);
  };

  /** 現在いる子どもの人数をまとめて変更（入力欄の追加・削除を同期） */
  const setExistingCount = (count: number) => {
    const n = Math.max(
      0,
      Math.min(MAX_CHILDREN, Number.isFinite(count) ? Math.floor(count) : 0),
    );
    setForm((prev) => {
      const existing = [...prev.existing];
      while (existing.length > n) existing.pop();
      while (existing.length < n) {
        existing.push({
          id: nextChildId("existing"),
          kind: "existing",
          ageYears: null,
          birthInYears: null,
        });
      }
      return { ...prev, existing };
    });
    // 削除された行のエラーを破棄
    setErrors((prev) => {
      const next: FieldErrors = {};
      for (const [key, message] of Object.entries(prev)) {
        if (key.startsWith("child.") && !form.existing.some((c) => key === `child.${c.id}`)) {
          continue;
        }
        next[key] = message;
      }
      return next;
    });
  };

  /** 現在の子どもの年齢（満年齢の整数） */
  const setRowAge = (id: string, ageYears: number | null) => {
    setForm((prev) => ({
      ...prev,
      existing: prev.existing.map((c) => (c.id === id ? { ...c, ageYears } : c)),
    }));
    if (ageYears !== null) dropChildError(id);
  };

  /** 予定の子どもの出産予定時期（未定は null） */
  const setRowBirth = (id: string, birthInYears: number | null) => {
    setForm((prev) => ({
      ...prev,
      planned: prev.planned.map((c) => (c.id === id ? { ...c, birthInYears } : c)),
    }));
  };

  /** 現在利用している支援制度の選択切り替え */
  const toggleUsedSupport = (id: string) => {
    setForm((prev) => ({
      ...prev,
      usedSupportProgramIds: prev.usedSupportProgramIds.includes(id)
        ? prev.usedSupportProgramIds.filter((x) => x !== id)
        : [...prev.usedSupportProgramIds, id],
    }));
  };
  /** テスト用：サンプルデータをワンクリックで自動入力 */
  const fillSample = () => {
    // サンプルの行IDと通常追加の行IDが衝突しないようカウンタを離す
    idCounter.current = Math.max(idCounter.current, 100);
    setForm({
      ...initialFormState,
      planStatus: SAMPLE_INPUT.planStatus,
      existing: SAMPLE_INPUT.children.map((c) => ({ ...c })),
      incomeBand: SAMPLE_INPUT.household.incomeBand,
      annualIncome: String(SAMPLE_INPUT.household.annualIncomeYen ?? ""),
      monthlyTakeHome: String(SAMPLE_INPUT.household.monthlyTakeHomeYen ?? ""),
      livingExpense: String(SAMPLE_INPUT.household.monthlyLivingExpenseYen ?? ""),
      housingCost: String(SAMPLE_INPUT.household.monthlyHousingCostYen ?? ""),
      savings: String(SAMPLE_INPUT.savings),
      prefectureCode: SAMPLE_INPUT.household.region?.prefectureCode ?? "13",
      municipalityName: SAMPLE_INPUT.household.region?.municipalityName ?? "世田谷区",
      householdType: SAMPLE_INPUT.household.householdType,
      schoolCourse: SAMPLE_INPUT.household.schoolCourse,
      universityCourse: SAMPLE_INPUT.household.universityCourse,
      workAfterBirth: SAMPLE_INPUT.household.workAfterBirth,
      usedSupportProgramIds: [...SAMPLE_INPUT.household.usedSupportProgramIds],
      disabilityInHousehold: SAMPLE_INPUT.household.disabilityInHousehold ?? null,
      targetAmount: String(SAMPLE_INPUT.targetAmount ?? ""),
    });
    setOpen(defaultOpenFor(SAMPLE_INPUT.planStatus));
    setErrors({});
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onSubmit(toSimulationInput(form));
  };

  const childrenMode = childrenModeOf(form.planStatus);
  const existingSummary = summarizeChildren(form.existing);
  const plannedSummary = summarizeChildren(form.planned);
  const desiredSummary =
    form.desiredChildCount.trim() === "" && form.firstBirthTiming === null
      ? null
      : [
          form.desiredChildCount.trim() === ""
            ? "希望人数：未定"
            : `希望人数 ${form.desiredChildCount}人`,
          form.firstBirthTiming === null
            ? "出産予定時期：未定"
            : `出産予定時期 ${
                BIRTH_TIMINGS.find((t) => t.id === form.firstBirthTiming)?.label ??
                "未定"
              }`,
        ].join("・");
  const childrenBundleSummary =
    existingSummary || plannedSummary || desiredSummary
      ? [
          existingSummary && `現在の子 ${existingSummary}`,
          plannedSummary && `予定の子 ${plannedSummary}`,
          desiredSummary,
        ]
          .filter(Boolean)
          .join(" / ")
      : null;
  const remaining = remainingRecommendedItems(form);
  const answeredDetails = answeredDetailLabels(form);
  /** 現在の子：人数＋年齢の入力欄 */
  const existingRowsUI = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-800">現在いるお子さま</p>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            人数を指定すると、年齢の入力欄が増減します（0人でも進められます）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExistingCount(form.existing.length - 1)}
            aria-label="現在いるお子さまを1人減らす"
            disabled={form.existing.length === 0}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 text-xl font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            −
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_CHILDREN}
            step={1}
            value={form.existing.length}
            onChange={(e) => setExistingCount(Number(e.target.value))}
            aria-label="現在いるお子さまの人数"
            data-testid="existing-child-count"
            className="w-16 rounded-xl border border-slate-300 bg-white px-2 py-2 text-center text-lg font-bold text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={() => setExistingCount(form.existing.length + 1)}
            aria-label="現在いるお子さまを1人増やす"
            disabled={form.existing.length >= MAX_CHILDREN}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 text-xl font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            ＋
          </button>
          <span className="text-xs text-slate-400">人</span>
        </div>
      </div>

      <div className="space-y-3">
        {form.existing.map((row, index) => (
          <div
            key={row.id}
            className="rounded-2xl border border-slate-200 bg-white p-4"
            data-testid={`child-row-${row.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-slate-800">
                <span className="mr-2 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">
                  第{index + 1}子
                </span>
                現在の子ども
              </p>
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                className="text-xs font-semibold text-red-500 underline underline-offset-2 hover:text-red-600"
              >
                削除
              </button>
            </div>
            <SelectField
              id={`age-${row.id}`}
              label="年齢"
              value={row.ageYears === null ? "" : String(row.ageYears)}
              onChange={(v) => setRowAge(row.id, v === "" ? null : Number(v))}
              options={[
                { value: "", label: "選択してください" },
                ...Array.from({ length: 23 }, (_, age) => ({
                  value: String(age),
                  label: `${age}歳`,
                })),
              ]}
              error={errors[`child.${row.id}`]}
              hint="満年齢（0〜22歳）を選択してください"
            />
          </div>
        ))}
      </div>
    </>
  );
  /** 予定の子：出産予定時期の入力欄 */
  const plannedRowsUI = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-slate-800">
            これから生まれる予定のお子さま
          </p>
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            出産予定時期が未定でも追加できます（未定の行は計算に含めません）
          </p>
        </div>
        <button
          type="button"
          onClick={() => addRow("planned")}
          data-testid="add-planned-child-button"
          className="rounded-full border border-blue-300 bg-white px-4 py-2.5 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-50"
        >
          ＋ 予定のお子さまを追加
        </button>
      </div>

      <div className="space-y-3">
        {form.planned.map((row, index) => (
          <div
            key={row.id}
            className="rounded-2xl border border-slate-200 bg-white p-4"
            data-testid={`child-row-${row.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-bold text-slate-800">
                <span className="mr-2 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700">
                  予定
                </span>
                第{form.existing.length + index + 1}子
              </p>
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                className="text-xs font-semibold text-red-500 underline underline-offset-2 hover:text-red-600"
              >
                削除
              </button>
            </div>
            <SelectField
              id={`birth-${row.id}`}
              label="出産予定時期"
              value={row.birthInYears === null ? "" : String(row.birthInYears)}
              onChange={(v) => setRowBirth(row.id, v === "" ? null : Number(v))}
              options={[
                { value: "", label: "未定" },
                ...Array.from({ length: 11 }, (_, n) => ({
                  value: String(n),
                  label: n === 0 ? "今後1年以内" : `あと${n}年後`,
                })),
              ]}
              hint="出生までの年数です。未定のままで先に進めます"
            />
          </div>
        ))}
      </div>
    </>
  );

  /** 希望の情報（任意）：子どもの希望人数・第一子の出産予定時期 */
  const desiredFormUI = (
    <div>
      <p className="text-sm font-bold text-slate-800">ご希望の情報（任意）</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">
        未定のままで先に進めます。分かる範囲で入力してください。
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <SelectField
          id="desiredChildCount"
          label="希望する子どもの人数"
          optional
          value={form.desiredChildCount}
          onChange={(v) => setField("desiredChildCount", v)}
          options={[
            { value: "", label: "未定" },
            { value: "1", label: "1人" },
            { value: "2", label: "2人" },
            { value: "3", label: "3人" },
            { value: "4", label: "4人以上" },
          ]}
          error={errors.desiredChildCount}
        />
        <SelectField
          id="firstBirthTiming"
          label="第一子の出産予定時期"
          optional
          value={form.firstBirthTiming ?? ""}
          onChange={(v) =>
            setField("firstBirthTiming", v === "" ? null : (v as BirthTiming))
          }
          options={[
            { value: "", label: "未定" },
            ...BIRTH_TIMINGS.map((t) => ({ value: t.id, label: t.label })),
          ]}
        />
      </div>
    </div>
  );
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
      <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-9">
        <p className="text-xs font-bold tracking-widest text-blue-500">
          STEP 1 / 2
        </p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          シミュレーションに必要な情報を入力
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          お子さまと家計の情報を入力すると、現在の貯蓄と公的支援を合わせた試算結果を表示します。
          未定・不明の項目は空欄のままでも進められます。
        </p>

        {/* 入力の目安（あと何項目か分かる） */}
        <div
          className="mt-6 rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3"
          data-testid="remaining-items"
        >
          {remaining.length > 0 ? (
            <p className="text-sm leading-6 text-blue-900">
              <span className="font-bold">
                入力の目安：あと{remaining.length}項目
              </span>
              （{remaining.join("、")}）。任意項目は未入力でも結果を確認できます。
            </p>
          ) : (
            <p className="text-sm leading-6 text-blue-900">
              <span className="font-bold">必要な入力は完了しています。</span>
              任意項目は未入力でも結果を確認できます。
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-8 space-y-8">
          {/* ── ① お子さまについて ── */}
          <section className="space-y-5">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                ① お子さまについて
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                「現在の状況」に合わせて、必要な入力欄だけを表示します。
                表示を切り替えても、入力した内容は消えません。
              </p>
            </div>

            {/* 現在の状況 */}
            <div>
              <span className={labelClass}>現在の状況</span>
              <div
                role="radiogroup"
                aria-label="現在の状況"
                className="mt-1.5 grid gap-2 sm:grid-cols-3"
              >
                {PLAN_STATUS_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={form.planStatus === option.id}
                    onClick={() => changePlanStatus(option.id)}
                    data-testid={`plan-status-${option.id}`}
                    className={`rounded-xl border px-4 py-3 text-sm font-semibold transition ${
                      form.planStatus === option.id
                        ? "border-blue-500 bg-blue-50 text-blue-700"
                        : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {form.planStatus === null && (
                <p className={hintClass}>
                  選択すると、その状況に合う入力欄だけが表示されます（未選択でも試算は進められます）。
                </p>
              )}
            </div>

            {/* 子どもの情報（現在の状況に応じて表示を切り替える） */}
            {childrenMode === "undecided" ? (
              <Disclosure
                id="child-bundle"
                title="子どもの情報を追加する"
                description="現在の子の人数・年齢／これから生まれる予定の子の出産予定時期／希望する子どもの人数と出産予定時期を入力できます。"
                summary={childrenBundleSummary}
                openLabel={childrenBundleSummary ? "編集" : "追加する"}
                closeLabel="閉じる"
                open={open["child-bundle"]}
                onToggle={() => toggleSection("child-bundle")}
              >
                <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:p-5">
                  {existingRowsUI}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:p-5">
                  {plannedRowsUI}
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4 sm:p-5">
                  {desiredFormUI}
                </div>
              </Disclosure>
            ) : (
              <>
                <Disclosure
                  id="children-existing"
                  title="現在いるお子さま（人数・年齢）"
                  description="すでにいるお子さまの人数と満年齢を入力します（試算に使用します）。"
                  summary={existingSummary}
                  openLabel={existingSummary ? "編集" : "入力する"}
                  closeLabel="閉じる"
                  open={open["children-existing"]}
                  onToggle={() => toggleSection("children-existing")}
                >
                  {existingRowsUI}
                </Disclosure>
                <Disclosure
                  id="children-planned"
                  title="今後の出産予定（任意）"
                  description="これから生まれる予定のお子さまの人数・出産予定時期を入力します。折りたたんだままでも試算できます。"
                  summary={plannedSummary}
                  openLabel={plannedSummary ? "編集" : "追加する"}
                  closeLabel="閉じる"
                  open={open["children-planned"]}
                  onToggle={() => toggleSection("children-planned")}
                >
                  {plannedRowsUI}
                </Disclosure>
                {(childrenMode === "planning" || desiredSummary) && (
                  <Disclosure
                    id="children-desired"
                    title="希望する子どもの人数・出産予定時期（任意）"
                    description="子どもの希望人数と第一子の出産予定時期を入力します。未定でも先に進めます。"
                    summary={desiredSummary}
                    openLabel={desiredSummary ? "編集" : "入力する"}
                    closeLabel="閉じる"
                    open={open["children-desired"]}
                    onToggle={() => toggleSection("children-desired")}
                  >
                    {desiredFormUI}
                  </Disclosure>
                )}
              </>
            )}
          </section>
          {/* ── ② お住まいの地域（任意） ── */}
          <section className="space-y-5">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                ② お住まいの地域
                <OptionalBadge />
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                地域の支援制度の検索に使います。未選択のままでも試算できます。
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  id="prefecture"
                  label="都道府県"
                  optional
                  value={form.prefectureCode}
                  testId="region-prefecture"
                  onChange={(v) =>
                    setForm((prev) => ({
                      ...prev,
                      prefectureCode: v,
                      // 都道府県が変わると対応しない市区町村になるため選択を戻す（他欄は保持）
                      municipalityName: "",
                    }))
                  }
                  options={[
                    { value: "", label: "未選択" },
                    ...listPrefectures().map((p) => ({
                      value: p.code,
                      label: p.name,
                    })),
                  ]}
                  hint="お住まいの都道府県を選択してください"
                />
                <SelectField
                  id="municipality"
                  label="区市町村"
                  optional
                  value={form.municipalityName}
                  testId="region-municipality"
                  disabled={form.prefectureCode === ""}
                  onChange={(v) => setField("municipalityName", v)}
                  options={[
                    {
                      value: "",
                      label:
                        form.prefectureCode === ""
                          ? "都道府県を先に選択してください"
                          : "未選択",
                    },
                    ...listMunicipalities(form.prefectureCode).map((name) => ({
                      value: name,
                      label: name,
                    })),
                  ]}
                  hint="東京都は23区を個別に選択できます。一覧にない市区町村は未選択のままで進められます"
                />
              </div>
            </div>
          </section>

          {/* ── ③ 貯蓄と目標 ── */}
          <section className="space-y-5">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                ③ 貯蓄と目標
              </h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                試算に使う基本の金額です。
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <MoneyField
                id="savings"
                label="現在の貯蓄額"
                value={form.savings}
                onChange={(v) => setField("savings", v)}
                error={errors.savings}
                hint={
                  form.savings.trim() !== "" &&
                  !Number.isNaN(Number(form.savings)) &&
                  Number(form.savings) >= 0
                    ? formatYen(Number(form.savings))
                    : "将来の貯蓄残高の計算に使います"
                }
              />
              <div className="mt-4">
                <MoneyField
                  id="targetAmount"
                  label="目標とする養育資金額"
                  optional
                  value={form.targetAmount}
                  onChange={(v) => setField("targetAmount", v)}
                  error={errors.targetAmount}
                  hint={
                    form.targetAmount.trim() !== "" &&
                    !Number.isNaN(Number(form.targetAmount)) &&
                    Number(form.targetAmount) > 0
                      ? formatYen(Number(form.targetAmount))
                      : "用意したい養育資金の目標額です（例: 20,000,000円）。未入力でも結果は確認でき、目標との比較だけが表示されません"
                  }
                />
              </div>
            </div>
          </section>
          {/* ── ④ 詳しい家計・世帯情報（任意・折りたたみ） ── */}
          <Disclosure
            id="details"
            title="詳しい家計・世帯情報（任意）"
            description="世帯年収・月の手取り収入・月々の生活費・家賃／住宅ローン・世帯構成・教育方針・大学の区分・出産後の働き方・現在利用している支援制度・世帯に障害のある方の有無。必要な項目だけ開いて入力できます。未入力でも試算できます。"
            summary={
              answeredDetails.length > 0
                ? `${answeredDetails.length}項目（${answeredDetails.join("、")}）`
                : null
            }
            openLabel={answeredDetails.length > 0 ? "編集" : "開いて入力する"}
            closeLabel="閉じる"
            open={open["details"]}
            onToggle={() => toggleSection("details")}
          >
            {/* 収入（受給条件用の世帯年収と、収支計算用の月の手取りを区別） */}
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <p className={labelClass}>収入</p>
              <div className="mt-3">
                <SelectField
                  id="incomeBand"
                  label="世帯年収の目安"
                  optional
                  value={form.incomeBand ?? ""}
                  onChange={(v) =>
                    setField(
                      "incomeBand",
                      v === "" ? null : (v as IncomeBandId),
                    )
                  }
                  options={[
                    { value: "", label: "未選択" },
                    ...INCOME_BANDS.map((b) => ({ value: b.id, label: b.label })),
                  ]}
                  hint="受給条件（所得制限など）の確認に使います。金額が分からなくても選べます"
                />
              </div>
              <div className="mt-4">
                <MoneyField
                  id="annualIncome"
                  label="世帯年収（金額が分かる場合）"
                  optional
                  value={form.annualIncome}
                  onChange={(v) => setField("annualIncome", v)}
                  error={errors.annualIncome}
                  hint="受給条件の確認用です。月の手取り収入とは別に管理します"
                />
              </div>
              <div className="mt-4">
                <MoneyField
                  id="monthlyTakeHome"
                  label="月の手取り収入"
                  optional
                  value={form.monthlyTakeHome}
                  onChange={(v) => setField("monthlyTakeHome", v)}
                  error={errors.monthlyTakeHome}
                  hint="家計収支の計算に使う金額です。世帯年収とは別に管理します"
                />
              </div>
            </div>

            {/* 支出 */}
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <p className={labelClass}>支出</p>
              <div className="mt-3">
                <MoneyField
                  id="livingExpense"
                  label="月々の生活費"
                  optional
                  value={form.livingExpense}
                  onChange={(v) => setField("livingExpense", v)}
                  error={errors.livingExpense}
                  hint="子供を除く世帯の月間生活費の目安です"
                />
              </div>
              <div className="mt-4">
                <MoneyField
                  id="housingCost"
                  label="家賃・住宅ローン（月）"
                  optional
                  value={form.housingCost}
                  onChange={(v) => setField("housingCost", v)}
                  error={errors.housingCost}
                  hint="固定支出の確認に使います"
                />
              </div>
            </div>
            {/* 世帯・教育方針・働き方 */}
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <p className={labelClass}>世帯・教育・働き方</p>
              <div className="mt-3">
                <SelectField
                  id="householdType"
                  label="世帯構成"
                  optional
                  value={form.householdType ?? ""}
                  onChange={(v) =>
                    setField(
                      "householdType",
                      v === "" ? null : (v as "single" | "couple" | "other"),
                    )
                  }
                  options={[
                    { value: "", label: "未選択" },
                    { value: "single", label: "ひとり親・単身世帯" },
                    { value: "couple", label: "夫婦世帯" },
                    { value: "other", label: "その他" },
                  ]}
                  hint="ひとり親世帯などの受給条件の確認に使います"
                />
              </div>
              <div className="mt-4">
                <SelectField
                  id="schoolCourse"
                  label="教育方針（幼稚園〜高校）"
                  optional
                  value={form.schoolCourse ?? ""}
                  onChange={(v) =>
                    setField(
                      "schoolCourse",
                      v === "" ? null : (v as "public" | "private"),
                    )
                  }
                  options={[
                    { value: "", label: "未選択" },
                    { value: "public", label: "公立" },
                    { value: "private", label: "私立" },
                  ]}
                  hint="未選択の場合は公立で暫定計算します（要確認として扱います）"
                />
              </div>
              <div className="mt-4">
                <SelectField
                  id="universityCourse"
                  label="大学の区分"
                  optional
                  value={form.universityCourse ?? ""}
                  onChange={(v) =>
                    setField(
                      "universityCourse",
                      v === ""
                        ? null
                        : (v as "national" | "public" | "private"),
                    )
                  }
                  options={[
                    { value: "", label: "未選択" },
                    { value: "national", label: "国立" },
                    { value: "public", label: "公立" },
                    { value: "private", label: "私立" },
                  ]}
                  hint="未選択の場合は国立で暫定計算します（要確認として扱います）"
                />
              </div>
              <div className="mt-4">
                <SelectField
                  id="workAfterBirth"
                  label="出産後の働き方・収入変化"
                  optional
                  value={form.workAfterBirth ?? ""}
                  onChange={(v) =>
                    setField(
                      "workAfterBirth",
                      v === "" ? null : (v as WorkAfterBirth),
                    )
                  }
                  options={[
                    { value: "", label: "未選択" },
                    ...WORK_AFTER_BIRTH_OPTIONS.map((o) => ({
                      value: o.id,
                      label: o.label,
                    })),
                  ]}
                />
              </div>
            </div>
            {/* 現在利用している支援制度 */}
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <p className={labelClass}>
                現在利用している支援制度
                <OptionalBadge />
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                受けている制度を選ぶと、支給見込みの重複を防ぎます（結果画面の制度一覧と同じ内容です。確認状況は結果画面の制度カードに表示されます）。
              </p>
              <div className="mt-3 space-y-2">
                {getSupportPrograms().map((program) => {
                  const checked = form.usedSupportProgramIds.includes(
                    program.id,
                  );
                  return (
                    <label
                      key={program.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition ${
                        checked
                          ? "border-blue-400 bg-blue-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleUsedSupport(program.id)}
                        className="mt-0.5 h-5 w-5 rounded border-slate-300 text-blue-500 focus:ring-blue-400"
                      />
                      <span className="text-sm font-semibold text-slate-700">
                        {program.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 世帯に障害のある方の有無（任意・制度案内用。詳細は聞かない） */}
            <div className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <SelectField
                id="disabilityInHousehold"
                label="世帯に障害のある方はいますか"
                optional
                value={form.disabilityInHousehold ?? ""}
                testId="disability-select"
                onChange={(v) =>
                  setField(
                    "disabilityInHousehold",
                    v === "" ? null : (v as "none" | "present"),
                  )
                }
                options={DISABILITY_OPTIONS}
                hint="回答は利用できる支援制度の案内にのみ使います。障害の種類や診断名などの詳細は聞きません。未回答のままでも試算を進められます"
              />
            </div>
          </Disclosure>

          {/* サンプルデータ自動入力（テスト用） */}
          <div className="rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  入力に迷ったら、サンプルデータをお試しください
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  テスト用に、入力欄がワンクリックで埋まります（第1子8歳・第2子3歳の例）。
                </p>
              </div>
              <button
                type="button"
                onClick={fillSample}
                data-testid="sample-fill-button"
                className="flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-blue-300 bg-white px-5 py-2.5 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-50"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 5v14M5 12h14"
                  />
                </svg>
                サンプルデータで自動入力
              </button>
            </div>
          </div>

          {/* 送信ボタン */}
          <div className="flex flex-col gap-3 pt-2 sm:flex-row-reverse">
            <button
              type="submit"
              data-testid="show-result-button"
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-blue-500 px-6 py-4 text-base font-bold text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600"
            >
              結果を見る
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 7l5 5-5 5M6 12h12"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={onBack}
              className="rounded-full border border-slate-300 px-6 py-4 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              ← トップへ戻る
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}