"use client";

/**
 * 支援制度一覧（M4）
 *
 * - 既存の /api/supports からモックデータを取得して制度カードを表示する
 * - モックデータは未確認情報を含むため、確定済みの事実として表示しない
 *   （「モック・未確認」「要確認」バッジ、URL未確認のリンクは公式リンクとして扱わない）
 * - 「この制度について相談する」ボタンは M5 の相談画面につながる
 *   （親から渡す onConsult コールバックを呼び出す）
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { supportProgramSchema, type SupportProgram } from "@/lib/types/support";
import type { SupportEffect } from "@/lib/finance/supports";
import { formatYen } from "@/lib/simulation";

const ELIGIBILITY_LABELS: Record<string, string> = {
  likely: "受給できる可能性あり（目安）",
  possible: "可能性あり（要確認）",
  unconfirmed: "未確認",
  ineligible: "対象外の可能性",
};

const CATEGORY_LABELS: Record<string, string> = {
  cash_benefit: "現金給付",
  fee_reduction: "費用の減免",
  loan: "貸付（返済義務あり）",
  tax: "税制",
};

const UNIT_LABELS: Record<string, string> = {
  yen_per_month: "月額",
  yen_per_year: "年額",
  yen_one_time: "一時金",
  other: "単位不明",
};

function periodText(program: SupportProgram): string {
  const { startAgeYears, endAgeYears, durationMonths } = program.period;
  const age =
    startAgeYears === null && endAgeYears === null
      ? "対象年齢の記載なし（要確認）"
      : `${startAgeYears ?? 0}歳〜${endAgeYears ?? "上限なし"}歳`;
  const duration =
    durationMonths !== null ? `（支給期間の上限：${durationMonths}か月）` : "";
  return `${age}${duration}`;
}

function amountText(program: SupportProgram): string {
  const { value, unit } = program.amount;
  if (value === null || unit === "other") return "金額未確認（要確認）";
  return `${formatYen(value)}（${UNIT_LABELS[unit]}）`;
}

export type SupportCardProps = {
  program: SupportProgram;
  /** 入力内容から再判定した効果（見込額・対象条件の確認状況） */
  effect: SupportEffect | undefined;
  /** 現在利用中の制度かどうか */
  isUsed: boolean;
  /** 「この制度について相談する」ボタン押下時（M5 の相談画面へ） */
  onConsult: (program: SupportProgram) => void;
};

export function SupportCard({
  program,
  effect,
  isUsed,
  onConsult,
}: SupportCardProps) {
  const eligibility = effect?.eligibility ?? program.eligibility;
  const missing = effect?.program.missingInformation ?? program.missingInformation;
  return (
    <li
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid={`support-card-${program.id}`}
    >
      {/* 制度名・区分・未確認バッジ */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold text-slate-900">{program.name}</h3>
        {program.mock && (
          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-600">
            モック・未確認
          </span>
        )}
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {CATEGORY_LABELS[program.category]}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {program.level === "national" ? "国の制度" : "自治体の制度"}
        </span>
        {isUsed && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-600">
            利用中
          </span>
        )}
      </div>

      {/* 支援内容 */}
      <p className="mt-2 text-xs leading-5 text-slate-600">{program.summary}</p>

      {/* 金額と対象期間 */}
      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <dt className="text-[10px] font-semibold text-slate-400">金額</dt>
          <dd className="mt-0.5 text-sm font-bold text-slate-800">
            {amountText(program)}
          </dd>
          <dd className="mt-1 flex items-center gap-1.5">
            {program.amount.basis === "estimated" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                推定・要確認
              </span>
            )}
            {program.amount.basis === "unknown" && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-600">
                未確認
              </span>
            )}
            {program.amount.basis === "confirmed" && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                確認済み
              </span>
            )}
          </dd>
          <dd className="mt-1 text-[11px] leading-4 text-slate-500">
            {program.amount.description}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <dt className="text-[10px] font-semibold text-slate-400">対象期間</dt>
          <dd className="mt-0.5 text-xs font-semibold text-slate-800">
            {periodText(program)}
          </dd>
          {effect && (
            <dd className="mt-1 text-[11px] text-slate-500">
              この世帯の見込額：
              {effect.estimatedTotalYen === null
                ? "計算不能（金額未確認）"
                : formatYen(effect.estimatedTotalYen)}
            </dd>
          )}
        </div>
      </dl>

      {/* 対象条件の確認状況 */}
      <div className="mt-3 rounded-xl border border-slate-100 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold text-slate-400">
            対象条件の確認状況
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              eligibility === "likely"
                ? "bg-emerald-100 text-emerald-700"
                : eligibility === "possible"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-slate-100 text-slate-500"
            }`}
          >
            {ELIGIBILITY_LABELS[eligibility]}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-slate-500">
          {effect?.program.eligibilityNote ?? program.eligibilityNote}
          （これは目安であり、正式な受給資格の決定ではありません）
        </p>
        {missing.length > 0 && (
          <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
            <span className="font-semibold text-amber-600">不足情報：</span>
            {missing.join("・")}（不足＝対象外ではなく、確認が必要な項目です）
          </p>
        )}
        <ul className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-slate-500">
          {program.conditions.incomeLimitNote && (
            <li>・{program.conditions.incomeLimitNote}</li>
          )}
          {program.conditions.householdNote && (
            <li>・{program.conditions.householdNote}</li>
          )}
          {program.conditions.other.map((note) => (
            <li key={note}>・{note}</li>
          ))}
        </ul>
        {effect?.excludedReason && (
          <p className="mt-1.5 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] leading-4 text-slate-600">
            {effect.excludedReason}
          </p>
        )}
      </div>

      {/* 根拠法令・申請情報 */}
      <dl className="mt-3 space-y-2 text-[11px] leading-4">
        <div>
          <dt className="font-semibold text-slate-400">
            根拠法令
            <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
              要確認
            </span>
          </dt>
          <dd className="mt-0.5 text-slate-600">
            {program.legalBasis.lawName ?? "法令名は未確認"}
            {program.legalBasis.ordinanceName &&
              `／${program.legalBasis.ordinanceName}`}
            {program.legalBasis.note && `（${program.legalBasis.note}）`}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-400">申請期限・申請時期</dt>
          <dd className="mt-0.5 text-slate-600">
            {program.application.deadlineNote ?? "記載なし（要確認）"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-400">申請先</dt>
          <dd className="mt-0.5 text-slate-600">
            {program.application.where ?? "記載なし（要確認）"}
          </dd>
          {program.application.documents.length > 0 && (
            <dd className="mt-0.5 text-slate-500">
              必要書類：{program.application.documents.join("・")}
            </dd>
          )}
        </div>
      </dl>

      {/* 公式情報へのリンク（URL未確認は公式リンクとして扱わない） */}
      <div className="mt-3">
        <p className="text-[10px] font-semibold text-slate-400">公式情報</p>
        <ul className="mt-1 space-y-1">
          {program.sources.map((source) => (
            <li key={source.title} className="text-[11px] leading-4">
              {source.url !== null && source.urlVerified ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 underline"
                >
                  {source.title}（{source.organization}）
                </a>
              ) : (
                <span className="text-slate-500">
                  {source.title}（{source.organization}）—{" "}
                  <span className="font-semibold text-amber-600">
                    URL未確認（公式リンクとして扱いません）
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-slate-400">
          情報の確認日：{program.checkedAt}
        </p>
      </div>

      {/* M5 の相談画面につながるボタン */}
      <button
        type="button"
        onClick={() => onConsult(program)}
        data-testid={`consult-button-${program.id}`}
        className="mt-4 w-full rounded-full border border-blue-500 px-5 py-3 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-50"
      >
        この制度について相談する
      </button>
    </li>
  );
}

type SupportListProps = {
  /** 入力内容から再判定した効果（id → SupportEffect） */
  effectById: Map<string, SupportEffect>;
  /** 現在利用中の制度 ID */
  usedProgramIds: string[];
  onConsult: (program: SupportProgram) => void;
};

export default function SupportList({
  effectById,
  usedProgramIds,
  onConsult,
}: SupportListProps) {
  const [programs, setPrograms] = useState<SupportProgram[] | null>(null);
  const [disclaimer, setDisclaimer] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/supports")
      .then((res) => res.json())
      .then((body: unknown) => {
        const data = body as {
          disclaimer?: string;
          programs?: unknown;
        };
        const parsed = z.array(supportProgramSchema).safeParse(data.programs);
        if (!parsed.success) {
          if (!cancelled) setError("制度データの形式が不正です（要確認）");
          return;
        }
        if (!cancelled) {
          setPrograms(parsed.data);
          setDisclaimer(data.disclaimer ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("制度データの取得に失敗しました。時間をおいて再度お試しください。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      {/* モックデータであることを必ず明示 */}
      <p className="rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">
        {disclaimer ||
          "この制度情報はモックデータです。金額・対象条件・根拠法令・申請期限は未確認の仮データであり、確定情報ではありません。"}
      </p>

      {error && (
        <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700">
          {error}
        </p>
      )}
      {!error && programs === null && (
        <p className="mt-4 text-xs text-slate-400" data-testid="supports-loading">
          制度データを読み込んでいます…
        </p>
      )}
      {programs !== null && (
        <ul className="mt-4 space-y-4">
          {programs.map((program) => (
            <SupportCard
              key={program.id}
              program={program}
              effect={effectById.get(program.id)}
              isUsed={usedProgramIds.includes(program.id)}
              onConsult={onConsult}
            />
          ))}
        </ul>
      )}
    </div>
  );
}