"use client";

/**
 * 支援制度一覧（M4 / M6-C）
 *
 * - 既存の /api/supports から制度データを取得して制度カードを表示する
 * - 未確認情報を確定済みの事実として表示しない
 *   （「モック・未確認」「要確認」バッジ、URL未確認のリンクは公式リンクとして扱わない）
 * - M6-C: 公式確認済みの制度と未確認のモック制度をバッジで区別する。
 *   確認済み項目・未確認項目（理由付き）・適用年度・対象地域を区別して表示する
 * - 「この制度について相談する」ボタンは M5 の相談画面につながる
 *   （親から渡す onConsult コールバックを呼び出す）
 */
import { useEffect, useState } from "react";
import { z } from "zod";
import { supportProgramSchema, type SupportProgram } from "@/lib/types/support";
import type { SupportEffect } from "@/lib/finance/supports";
import { formatYen } from "@/lib/simulation";
import {
  amountBandsText,
  amountText,
  checkedAtText,
  fiscalYearLabel,
  legalBasisText,
  LEVEL_LABELS,
  periodText,
  sourceEntryText,
  unconfirmedItemsText,
  verificationBadgeText,
} from "@/lib/supports/display";
import { jurisdictionText } from "@/lib/supports/region";

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
  const legal = legalBasisText(program.legalBasis);
  const [open, setOpen] = useState(false);
  const detailId = `support-detail-${program.id}`;
  return (
    <li
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid={`support-card-${program.id}`}
    >
      {/* 制度名・区分・確認状況バッジ（確認済み／未確認を必ず区別する） */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold text-slate-900">{program.name}</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            verificationBadgeText(program) === "公式確認済み"
              ? "bg-emerald-100 text-emerald-700"
              : verificationBadgeText(program) === "公式確認済み（一部要確認）"
                ? "bg-amber-100 text-amber-700"
                : "bg-rose-100 text-rose-600"
          }`}
        >
          {verificationBadgeText(program)}
        </span>
        {/* 金額の確度（初期表示で確認できるようにする） */}
        {program.amount.basis === "confirmed" && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
            確認済み
          </span>
        )}
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
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {CATEGORY_LABELS[program.category]}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {LEVEL_LABELS[program.level]}
        </span>
        {isUsed && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-600">
            利用中
          </span>
        )}
      </div>

      {/* 支援内容 */}
      <p className="mt-2 text-xs leading-5 text-slate-600">{program.summary}</p>

      {/* 概要（常に表示）：見込額・対象可能性・注意 */}
      <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <dt className="text-[10px] font-semibold text-slate-400">
            この世帯の見込額
          </dt>
          <dd className="mt-0.5 text-sm font-bold text-slate-800">
            {effect
              ? effect.estimatedTotalYen === null
                ? "計算不能（金額未確認）"
                : formatYen(effect.estimatedTotalYen)
              : "未計算（要確認）"}
          </dd>
          <dd className="mt-1 text-[11px] leading-4 text-slate-500">
            {program.mock
              ? "モック・未確認データに基づく目安です。支給が確定した金額ではありません。"
              : "確認済みの公式情報と推定値に基づく目安です。受給資格は未判定（要確認）であり、支給が確定した金額ではありません。"}
          </dd>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <dt className="text-[10px] font-semibold text-slate-400">
            対象条件の確認状況
          </dt>
          <dd className="mt-1">
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
          </dd>
          <dd className="mt-1 text-[11px] leading-4 text-slate-500">
            （これは目安であり、正式な受給資格の決定ではありません）
          </dd>
        </div>
      </dl>
      {effect?.excludedReason && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-600">
          {effect.excludedReason}
        </p>
      )}

      {/* 開閉コントロール（キーボード操作可・状態は aria-expanded で明示） */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailId}
        data-testid={`support-detail-toggle-${program.id}`}
        className="mt-3 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-full border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <span>{open ? "詳細を閉じる" : "詳細を見る"}</span>
        <span aria-hidden="true" className="text-slate-400">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {/* 詳細（開閉）：金額・期間・条件・根拠法令・申請・公式情報 */}
      <div
        id={detailId}
        data-testid={detailId}
        className={open ? "mt-4" : "hidden"}
      >

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
          <dd className="mt-1 text-[11px] leading-4 text-slate-500">
            {fiscalYearLabel(program.amount.fiscalYear)}
          </dd>
          {amountBandsText(program) !== null && (
            <dd className="mt-1 text-[11px] leading-4 text-emerald-700">
              {amountBandsText(program)}
            </dd>
          )}
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

      {/* 根拠法令・対象地域・申請情報 */}
      <dl className="mt-3 space-y-2 text-[11px] leading-4">
        <div>
          <dt className="font-semibold text-slate-400">対象地域</dt>
          <dd className="mt-0.5 text-slate-600">
            {jurisdictionText(program.jurisdiction)}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-400">
            根拠法令
            {legal.needsCheck && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                要確認
              </span>
            )}
          </dt>
          <dd className="mt-0.5 text-slate-600">{legal.text}</dd>
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

      {/* 未確認の項目と理由（確認済みと未確認を明確に区別する） */}
      {unconfirmedItemsText(program).length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold text-amber-700">
            未確認の項目と理由
          </p>
          <ul className="mt-1 space-y-0.5 text-[11px] leading-4 text-amber-800">
            {unconfirmedItemsText(program).map((line) => (
              <li key={line}>・{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 公式情報へのリンク（URL未確認は公式リンクとして扱わない） */}
      <div className="mt-3">
        <p className="text-[10px] font-semibold text-slate-400">公式情報</p>
        <ul className="mt-1 space-y-1">
          {program.sources.map((source) => {
            const entry = sourceEntryText(source);
            return (
              <li key={source.title} className="text-[11px] leading-4">
                {entry.isLink && entry.href !== null ? (
                  <a
                    href={entry.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 underline"
                  >
                    {entry.label}
                  </a>
                ) : (
                  <span className="text-slate-500">
                    {entry.label}—{" "}
                    <span className="font-semibold text-amber-600">
                      {entry.unverifiedText}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[11px] text-slate-400">
          {checkedAtText(program)}
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
      </div>
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
  const [verificationNote, setVerificationNote] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/supports")
      .then((res) => res.json())
      .then((body: unknown) => {
        const data = body as {
          disclaimer?: string;
          verificationNote?: string;
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
          setVerificationNote(data.verificationNote ?? "");
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
      {verificationNote !== "" && (
        <p className="mt-2 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          {verificationNote}
        </p>
      )}

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
        <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
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