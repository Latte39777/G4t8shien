"use client";

/**
 * シミュレーション結果画面（M4 / レイアウト再設計 / M7-K UI整理）
 *
 * - PC では最大幅約 1520px を使い、次の順で全幅レイアウトに並べる（M7-K）：
 *   ① 結果サマリー（子育て費用の総額／支援制度の試算＝区分ごとに分離表示）
 *   ② 共通の注意書き（結果全体で1か所だけ）
 *   ③ 支援を反映した場合の費用比較（数値中心）と目標資金のカバー状況（2列）
 *   ④ 教育段階別の費用と支援（世帯全体/子ども別の切り替え・横棒グラフ・支援ON/OFF）
 *   ⑤ 計算の前提・詳細（将来の家計予測・前提条件は折りたたみ）
 *   ⑥ 利用できる可能性のある支援制度（カード2列）／⑦ 支援制度の相談／アクション
 * - 支援額は「確認済みの現金給付・費用軽減」「仮定額による参考試算」「貸付（別枠）」
 *   「上限額のみ確認の制度（別枠）」を分離して表示する（M7-K）。
 *   未確認の仮定額を受給見込み額のように大きく表示しない
 * - 費用比較は横棒グラフを使わず数値で表示し、支援による負担軽減の参考額を
 *   緑で強調する（金額はすべて buildSimulationResult の計算結果から取得し、
 *   ハードコードしない。UI 側で再計算しない）
 * - 子ども別の金額・教育方針・計算対象外の注意は教育段階別セクションの
 *   スコープ切り替え（ScopeSummary）に統合し、重複セクションは持たない
 * - 対象年数は「子ども年分（子どもN人の合計）」と表示し、年齢範囲の長さと
 *   混同させない（M7-K）
 * - 支援制度一覧（/api/supports）と制度カード・相談ボタン
 *   （制度カードは初期表示を名前・確認状態・種類・対象地域・金額に絞り、
 *    詳細は「詳細を見る」に集約する）
 * - 計算に使用した前提条件と、仮定値・未確認値を必ず明示する
 *   （未確認の費用総額を確定値のように表示しない）
 * - 複数の子どもがいる場合は、世帯全体の合計と子ども別の詳細を区別する
 */
import { useState, type ReactNode } from "react";
import type { SimulationInput } from "@/lib/simulation";
import { formatYen } from "@/lib/simulation";
import { getSupportPrograms } from "@/lib/supports/registry";
import type { SupportProgram } from "@/lib/types/support";
import type { SupportEffect } from "@/lib/finance/supports";
import {
  buildSimulationResult,
  type AssumptionItem,
  type SimulationResult,
  type YearlyRowView,
} from "@/lib/result";
import StageDetail from "@/components/StageDetail";
import SupportList from "@/components/SupportList";

type ResultProps = {
  input: SimulationInput;
  /** 「入力内容を修正する」ボタン押下時 */
  onEdit: () => void;
  /** 「最初からやり直す」ボタン押下時 */
  onReset: () => void;
  /**
   * 相談開始時のコールバック（M5 の相談画面へ）。
   * - 制度カードの「この制度について相談する」→ その制度を引き継いで開始
   * - 「支援制度の相談（制度を指定せず）」→ null で自由な相談を開始
   */
  onConsult: (program: SupportProgram | null) => void;
  /**
   * 制度一覧の上書き（スナップショット検証用の省略可能な引数）。
   * 指定時はこの一覧で計算・表示する。既定はレジストリ＋/api/supports（従来どおり）。
   */
  programs?: SupportProgram[];
};

/** 仮定値・未確認値を明示するバッジ（確定値と混同させないため） */
function FlagBadge({
  flag,
}: {
  flag: "assumed" | "unverified" | "reference";
}) {
  if (flag === "reference")
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
        確認済み
      </span>
    );
  if (flag === "assumed")
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
        仮定値・要確認
      </span>
    );
  return (
    <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-600">
      未確認
    </span>
  );
}

/** 将来の貯蓄残高の推移（横棒グラフ。負の残高は赤で表示） */
function SavingsChart({ rows }: { rows: SimulationResult["savingsSeries"] }) {
  const maxAbs = Math.max(
    ...rows.map((r) => Math.max(Math.abs(r.savingsEndYen), Math.abs(r.savingsWithEstimatedYen))),
    1,
  );
  return (
    <ul className="mt-4 space-y-1.5" data-testid="savings-chart">
      {rows.map((row) => {
        const width = Math.min((Math.abs(row.savingsEndYen) / maxAbs) * 100, 100);
        const negative = row.savingsEndYen < 0;
        return (
          <li key={row.yearOffset} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[10px] text-slate-400">
              {row.label}
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${negative ? "bg-rose-300" : "bg-sky-400"}`}
                style={{ width: `${Math.max(width, 1)}%` }}
                data-testid={`savings-bar-${row.yearOffset}`}
              />
            </div>
            <span
              className={`w-24 shrink-0 text-right text-[11px] font-semibold ${negative ? "text-rose-500" : "text-slate-700"}`}
            >
              {formatYen(row.savingsEndYen)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 年ごとの収入・支出・収支・貯蓄残高 */
function YearlyTable({ rows }: { rows: YearlyRowView[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs" data-testid="yearly-table">
        <thead>
          <tr className="text-[10px] text-slate-400">
            <th className="py-2 pr-2 font-semibold">年</th>
            <th className="py-2 pr-2 font-semibold">子どもの年齢</th>
            <th className="py-2 pr-2 text-right font-semibold">収入</th>
            <th className="py-2 pr-2 text-right font-semibold">支出</th>
            <th className="py-2 pr-2 text-right font-semibold">うち支援（確定）</th>
            <th className="py-2 pr-2 text-right font-semibold">収支</th>
            <th className="py-2 text-right font-semibold">貯蓄残高</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.yearOffset} className="border-t border-slate-100">
              <td className="py-2 pr-2 font-semibold text-slate-700">
                {row.yearLabel}
                {row.incomeMultiplier !== 1 && (
                  <span className="ml-1 text-[10px] font-bold text-amber-600">
                    ※収入変化
                  </span>
                )}
              </td>
              <td className="py-2 pr-2 text-slate-500">{row.childAgeText}</td>
              <td className="py-2 pr-2 text-right text-slate-700">
                {formatYen(row.incomeYen)}
              </td>
              <td className="py-2 pr-2 text-right text-slate-700">
                {formatYen(row.expenseYen)}
                <span className="block text-[9px] text-slate-400">
                  生活費 {formatYen(row.livingExpenseYen)}＋子 {formatYen(row.childCostYen)}
                </span>
              </td>
              <td className="py-2 pr-2 text-right text-slate-500">
                {formatYen(row.supportConfirmedYen)}
                <span className="block text-[9px] text-slate-400">
                  推定 {formatYen(row.supportEstimatedYen)}
                </span>
              </td>
              <td
                className={`py-2 pr-2 text-right font-semibold ${row.netYen < 0 ? "text-rose-500" : "text-slate-700"}`}
              >
                {formatYen(row.netYen)}
              </td>
              <td
                className={`py-2 text-right font-bold ${row.savingsEndYen < 0 ? "text-rose-500" : "text-slate-900"}`}
              >
                {formatYen(row.savingsEndYen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 計算に使用した前提条件（仮定値・未確認値の明示つき） */
function AssumptionList({ items }: { items: AssumptionItem[] }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="rounded-xl bg-slate-50 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold text-slate-800">{item.label}</p>
            <FlagBadge flag={item.flag} />
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600">{item.valueText}</p>
          {item.note && (
            <p className="mt-1 text-[11px] leading-4 text-slate-400">{item.note}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 折りたたみ可能なセクション（開閉状態は aria-expanded で明示。中身は常に DOM に存在する） */
function CollapsibleSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <span
          className="shrink-0 rounded-full border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-600"
          aria-hidden="true"
        >
          {open ? "閉じる" : "詳細を見る"}
        </span>
      </button>
      <div className={open ? "mt-3" : "hidden"}>{children}</div>
    </div>
  );
}

export default function Result({
  input,
  onEdit,
  onReset,
  onConsult,
  programs,
}: ResultProps) {
  const result: SimulationResult = buildSimulationResult(
    input,
    programs ?? getSupportPrograms(),
  );
  const { costTotals, supportTotals, comparison } = result;
  const effectById = new Map(
    result.supports.effects.map((e) => [e.program.id, e]),
  );
  const goal = result.goalCoverage;

  // ── M7-K 表示用の集計（計算ロジックには干渉しない。表示区分の分離のみ） ──
  // 上限額のみ確認（capOnly）の制度を、通常の参考試算から分けて表示する
  const capOnlyEffects = result.supports.effects.filter(
    (e) => e.program.amount.capOnly === true && e.includedInTotal,
  );
  const sumEstimated = (fx: SupportEffect[]): number =>
    fx.reduce((s, e) => s + (e.estimatedTotalYen ?? 0), 0);
  const capOnlyYen = sumEstimated(capOnlyEffects);
  const capOnlyCashYen = sumEstimated(
    capOnlyEffects.filter((e) => e.program.category === "cash_benefit"),
  );
  const capOnlyFeeYen = sumEstimated(
    capOnlyEffects.filter((e) => e.program.category === "fee_reduction"),
  );
  const estimatedShownYen = supportTotals.estimatedYen - capOnlyYen;
  const cashEstimatedShownYen =
    supportTotals.cashBenefit.estimatedYen - capOnlyCashYen;
  const feeEstimatedShownYen =
    supportTotals.feeReduction.estimatedYen - capOnlyFeeYen;

  return (
    <div className="mx-auto w-full max-w-[1520px] px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      {/* ヘッダー */}
      <div className="text-center">
        <p className="text-xs font-bold tracking-widest text-blue-500">STEP 2 / 2</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">
          シミュレーション結果
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          子育て費用の見込みと、利用できる可能性のある支援を試算しました。
        </p>
      </div>

      {/* 本文：PC では横幅を活かして全幅で配置し、スマートフォンでは1列表示 */}
      <div className="mt-6">
        {/* ① 結果サマリー（最上段・全幅：2カード横並び） */}
        <section className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-sm font-bold text-slate-900">結果のサマリー</h2>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          {/* 子育て費用の総額見込み（大きな数値1） */}
          <div className="rounded-2xl bg-indigo-50 p-4 sm:p-5" data-testid="cost-total">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-indigo-800">
                子育て費用の総額見込み（世帯合計）
              </p>
              <FlagBadge flag={costTotals.hasUnverified ? "assumed" : "reference"} />
            </div>
            <p className="mt-1 text-4xl font-bold tracking-tight text-indigo-900">
              {formatYen(costTotals.totalYen)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-indigo-700">
              うち確認済み出典の金額 {formatYen(costTotals.referenceYen)}／
              仮定値（要確認） {formatYen(costTotals.assumedYen)}
              （0〜22歳のうち、これからかかる分の合計）
            </p>
          </div>

          {/* 利用できる可能性のある支援額（M7-K：現金給付・費用軽減・貸付・上限額のみ確認を分離表示） */}
          <div className="rounded-2xl bg-rose-50 p-4 sm:p-5" data-testid="support-total">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-rose-800">
                利用できる可能性のある支援額
              </p>
            </div>

            {/* 確認済みの支援額（現金給付・費用軽減） */}
            <div className="mt-2 rounded-xl bg-white/80 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-[11px] font-semibold text-slate-700">
                  確認済みの支援額
                </p>
                <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  確認済み
                </span>
              </div>
              <p className="mt-0.5 text-xl font-bold tracking-tight text-slate-900">
                {formatYen(supportTotals.confirmedYen)}
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
                現金給付 {formatYen(supportTotals.cashBenefit.confirmedYen)}／
                費用軽減 {formatYen(supportTotals.feeReduction.confirmedYen)}
              </p>
              {supportTotals.confirmedYen === 0 && (
                <p className="mt-0.5 text-[11px] leading-4 text-rose-700">
                  計算に反映できる確認済みの金額が 0
                  円という意味です。制度が存在しないことや、支援額が 0
                  円と確認されたことを意味しません。
                </p>
              )}
            </div>

            {/* 仮定額による参考試算（現金給付・費用軽減） */}
            <div className="mt-2 rounded-xl bg-white/80 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-[11px] font-semibold text-slate-700">
                  仮定額による現金給付・費用軽減の参考試算
                </p>
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                  推定・要確認
                </span>
              </div>
              <p className="mt-0.5 text-xl font-bold tracking-tight text-slate-900">
                {formatYen(estimatedShownYen)}
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
                現金給付 {formatYen(cashEstimatedShownYen)}／
                費用軽減 {formatYen(feeEstimatedShownYen)}
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-rose-700">
                金額・対象条件が未確認の仮定値に基づく計算です。実際の受給額や受給資格を示すものではありません。
              </p>
            </div>

            {/* 上限額のみ判明している制度（通常の支援見込額とは別枠） */}
            {capOnlyEffects.length > 0 && (
              <div className="mt-2 rounded-xl border border-amber-200 bg-white/80 px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-[11px] font-semibold text-slate-700">
                    上限額のみ判明している制度（通常の支援見込額とは別枠）
                  </p>
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    上限額のみ確認
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {capOnlyEffects.map((e) => (
                    <li
                      key={e.program.id}
                      className="text-[11px] leading-4 text-slate-700"
                    >
                      {e.program.name}：最大 {formatYen(e.estimatedTotalYen ?? 0)}
                      （上限額のみ確認済み・実際の補助額は対象工事費などによって決まります）
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11px] leading-4 text-amber-700">
                  上限額は受給見込額ではありません。「支援を反映した場合の費用比較」の試算には、上限額いっぱいの場合の金額が含まれています（要確認）。
                </p>
              </div>
            )}

            {/* 貸付（返済が必要なため別枠） */}
            <div className="mt-2 rounded-xl bg-white/80 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-[11px] font-semibold text-slate-700">
                  貸付（返済が必要なため別枠）
                </p>
                <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                  計算対象外
                </span>
              </div>
              <p className="mt-0.5 text-xl font-bold tracking-tight text-slate-900">
                {formatYen(supportTotals.loanReferenceYen)}
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
                貸付は返済が必要なため、現金給付・費用軽減の合計には含めていません（参考額）。
              </p>
            </div>
          </div>
          </div>
        </section>

        {/* 共通の注意書き（M7-K：結果全体で1か所だけ表示する） */}
        <p
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"
          data-testid="common-notes"
        >
          <span className="font-bold">【要確認】</span>
          この結果は入力内容に基づく試算です。費用や支援額には仮定値・未確認情報が含まれる場合があります。受給資格・実際の金額・併用可否は確定していません。金額の確度（確認済み／推定・要確認／未確認）は各項目に表示しています。
        </p>

        {/* ② 中段2列：支援を反映した場合の費用比較（左）／目標とする養育資金額のカバー状況（右） */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 支援を反映した場合の費用比較（横棒グラフなし・数値中心） */}
        <section
          className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8"
          data-testid="comparison"
        >
          <h2 className="text-sm font-bold text-slate-900">
            支援を反映した場合の費用比較
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            同じ試算結果から計算した参考費用を、金額の形で比較しています
            （すべての金額はこのシミュレーションの計算結果です）。
          </p>
          <dl className="mt-3 overflow-hidden rounded-2xl border border-slate-100">
            <div className="flex items-center justify-between gap-3 bg-slate-50 px-4 py-2.5">
              <dt className="text-xs text-slate-500">支援なしの場合の費用総額</dt>
              <dd
                className="text-sm font-bold text-slate-900"
                data-testid="compare-gross"
              >
                {formatYen(comparison.grossCostYen)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5">
              <dt className="text-xs text-slate-500">
                確定支援のみを反映した場合の参考費用
                <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  確認済み
                </span>
              </dt>
              <dd
                className="text-sm font-bold text-slate-900"
                data-testid="compare-after-confirmed"
              >
                {formatYen(comparison.afterConfirmedYen)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5">
              <dt className="text-xs text-slate-500">
                確定支援と推定支援を反映した場合の参考費用
                <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                  推定・要確認
                </span>
              </dt>
              <dd
                className="text-sm font-bold text-slate-900"
                data-testid="compare-after-all"
              >
                {formatYen(comparison.afterAllYen)}
              </dd>
            </div>
          </dl>

          {/* 支援が費用を上回る場合は、上回る見込額を分離して参考表示する（負値は表示しない・M7-J1） */}
          {comparison.supportSurplusYen > 0 && (
            <p
              className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"
              data-testid="support-surplus"
            >
              支援が費用を上回る見込み額（参考）：
              {formatYen(comparison.supportSurplusYen)}
              。参考費用は 0 円として表示しています。この差額が現金で支給されるという意味ではありません（要確認）。
            </p>
          )}
          {/* 支援による負担軽減の参考額（緑で強調して表示） */}
          <div
            className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5"
            data-testid="support-relief"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-emerald-800">
                支援による負担軽減の参考額
              </p>
              <p className="text-3xl font-bold tracking-tight text-emerald-700">
                {formatYen(comparison.grossCostYen - comparison.afterAllYen)}
              </p>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-emerald-700">
              総額に対する軽減割合：約
              {comparison.grossCostYen > 0
                ? `${(
                    ((comparison.grossCostYen - comparison.afterAllYen) /
                      comparison.grossCostYen) *
                    100
                  ).toFixed(1)}%`
                : "—"}
              （確定支援 {formatYen(supportTotals.confirmedYen)} ＋ 推定支援{" "}
              {formatYen(supportTotals.estimatedYen)}。同じ支援を重ねて計上することはありません）
            </p>
          </div>

          {/* 確定支援のみで差がない場合は、その事実を簡潔に表示 */}
          {comparison.grossCostYen - comparison.afterConfirmedYen === 0 && (
            <p
              className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-600"
              data-testid="confirmed-no-diff"
            >
              確定支援のみでは費用に差がありません（反映できる確定支援額が{" "}
              {formatYen(supportTotals.confirmedYen)} のため）。
            </p>
          )}

          {/* 計算方法・推定額の内訳（長い説明は折りたたみ） */}
          <CollapsibleSection
            title="計算方法と支援見込額の内訳"
            testId="comparison-details"
          >
            <p className="text-xs leading-5 text-slate-500">
              負担軽減の参考額＝「支援なしの場合の費用総額 −
              確定支援と推定支援を反映した場合の参考費用」です。
              うち推定支援 {formatYen(supportTotals.estimatedYen)}{" "}
              は未確認の試算を含みます。支援額は未確認の試算であり、
              支給が確定したことや、実際の負担額が保証されることを意味しません。
            </p>
            <ul className="mt-3 space-y-1">
              {result.fundingMeta.supportAllocationNotes.map((n) => (
                <li key={n} className="text-[11px] leading-4 text-slate-600">
                  ・{n}
                </li>
              ))}
            </ul>
            {result.fundingMeta.unallocatedSupports.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.fundingMeta.unallocatedSupports.map((u) => (
                  <li
                    key={u.programId}
                    className="rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] leading-4 text-slate-600"
                  >
                    <span className="font-semibold">{u.programName}</span>
                    （{u.category === "loan" ? "貸付" : "現金給付等"}）
                    {u.amountYen !== null && ` 見込額 ${formatYen(u.amountYen)}：`}
                    {u.reason}
                    {u.includedInTotal && "（世帯の支援見込額の合計には含まれます）"}
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        </section>


        {/* 目標とする養育資金額のカバー状況（確度を区別して表示） */}
        {goal !== null ? (
          <section
            className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8"
            data-testid="goal-coverage"
          >
            <h2 className="text-sm font-bold text-slate-900">
              目標とする養育資金額のカバー状況
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              目標とする養育資金額 {formatYen(goal.targetYen)} に対するカバー状況
            </p>
            {/* 貯蓄（確定）／確認済みの支援／仮定額の支援参考値を区別した横棒 */}
            <div
              className="mt-3 h-5 w-full overflow-hidden rounded-full bg-slate-100"
              role="img"
              aria-label={`目標 ${formatYen(goal.targetYen)} に対するカバー状況`}
            >
              <div className="flex h-full">
                <div
                  className="h-full bg-sky-500"
                  style={{
                    width: `${Math.min(
                      (goal.savingsYen / Math.max(goal.targetYen, 1)) * 100,
                      100,
                    )}%`,
                  }}
                />
                <div
                  className="h-full bg-emerald-500"
                  style={{
                    width: `${Math.min(
                      (goal.supportConfirmedYen / Math.max(goal.targetYen, 1)) * 100,
                      100,
                    )}%`,
                  }}
                />
                <div
                  className="h-full bg-emerald-300"
                  style={{
                    width: `${Math.min(
                      (goal.supportEstimatedYen / Math.max(goal.targetYen, 1)) * 100,
                      100,
                    )}%`,
                  }}
                />
              </div>
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
              <li className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-sm bg-sky-500"
                  aria-hidden="true"
                />
                現在の貯蓄
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500"
                  aria-hidden="true"
                />
                確認済みの支援
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-sm bg-emerald-300"
                  aria-hidden="true"
                />
                仮定額による支援参考値
              </li>
            </ul>
            {/* 金額と簡単な説明（初期表示）。詳しい前提は折りたたみ */}
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">現在の貯蓄（確定）</dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(goal.savingsYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  確認済みの支援
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                    確認済み
                  </span>
                </dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(goal.supportConfirmedYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  仮定額による支援参考値
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    推定・要確認
                  </span>
                </dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(goal.supportEstimatedYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  {goal.gapYen > 0 ? "目標までの不足額" : "目標を上回る金額"}
                </dt>
                <dd
                  className={`font-bold ${goal.gapYen > 0 ? "text-rose-500" : "text-emerald-600"}`}
                >
                  {formatYen(Math.abs(goal.gapYen))}
                </dd>
              </div>
            </dl>
            {/* 長い説明は折りたたみ（確度の違いの明示を含む） */}
            <CollapsibleSection
              title="この計算の前提と要確認事項"
              testId="goal-details"
            >
              <p className="text-xs leading-5 text-slate-500">
                現在の貯蓄は確定している金額です。確認済みの支援{" "}
                {formatYen(goal.supportConfirmedYen)} と、仮定額による支援参考値{" "}
                {formatYen(goal.supportEstimatedYen)} は確度が異なります。
                仮定額による支援参考値は、利用できない場合があります（要確認）。
                この金額は入力された「目標とする養育資金額」との比較による参考表示です。
                自分で用意できる資金の計算前提は、教育段階別セクションの
                「資金配分の前提（自分で用意できる資金）」をご確認ください。
              </p>
            </CollapsibleSection>
          </section>
        ) : (
          <p
            className="h-fit rounded-2xl border border-slate-100 px-4 py-3 text-xs leading-5 text-slate-500"
            data-testid="target-unset-note"
          >
            目標とする養育資金額が未入力のため、目標の達成状況は表示していません。
            入力画面で目標額を設定すると、貯蓄と支援見込で目標に届くか確認できます。
          </p>
        )}
        </div>

        {/* ③ 教育段階別の費用と支援（全幅） */}
        <section className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900">
              教育段階別の費用と支援
            </h2>
            <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[10px] font-bold text-indigo-600">
              教育段階別
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            妊娠・出産から大学・専門学校まで、教育段階ごとの費用を横棒グラフで比較できます。
            自分で用意する資金・支援でまかなう金額・不足額を色分けし、支援のON/OFFで不足額の変化を確認できます。
            各段階を選ぶと、費用の内訳・対象年数・公立/私立などの計算条件を確認できます。
          </p>
          <div className="mt-5">
            <StageDetail
              childResults={result.children}
              householdStages={result.householdStages}
            />
          </div>

          {/* 資金配分の前提（長い説明は折りたたみ。支援の内訳は「計算方法と支援見込額の内訳」に記載） */}
          {result.fundingMeta.selfFundingNotes.length > 0 && (
            <CollapsibleSection
              title="資金配分の前提（自分で用意できる資金）"
              testId="stage-funding-notes"
            >
              <ul className="mt-1 space-y-1">
                {result.fundingMeta.selfFundingNotes.map((n) => (
                  <li key={n} className="text-[11px] leading-4 text-slate-600">
                    ・{n}
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          )}
        </section>

        {/* ⑤ 将来の家計予測（折りたたみ） */}
        <section className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <CollapsibleSection title="将来の家計予測を詳しく見る" testId="yearly-details">
            <h3 className="text-sm font-bold text-slate-900">将来の貯蓄残高の推移</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              現在の貯蓄 {formatYen(input.savings)} を初期残高として、
              月の手取り収入×12から生活費と子ども費用を差し引き、
              確定支援のみを反映した残高の推移です（推定支援は含めていません）。
            </p>
            {result.savingsSeries.length === 0 ? (
              <p className="mt-4 text-xs text-slate-400">
                対象期間がないため、推移の表示はありません（子ども0人）。
              </p>
            ) : (
              <SavingsChart rows={result.savingsSeries} />
            )}

            <h3 className="mt-6 text-sm font-bold text-slate-900">
              年ごとの収入・支出・収支・貯蓄残高
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              収入は月の手取り収入×12（世帯年収は使用していません）。
              支出は世帯の生活費（住居費を含む前提）と子ども費用の合計です。
            </p>
            {result.yearly.length === 0 ? (
              <p className="mt-4 text-xs text-slate-400">
                対象期間がないため、年ごとの表示はありません（子ども0人）。
              </p>
            ) : (
              <YearlyTable rows={result.yearly} />
            )}
          </CollapsibleSection>
        </section>

        {/* ⑥ 計算に使用した前提条件・仮定値/未確認値の明示（折りたたみ） */}
        <section className="mt-6 rounded-3xl border border-amber-100 bg-white p-6 shadow-sm sm:p-8">
          <CollapsibleSection title="計算に使用した前提条件" testId="assumptions">
            <p className="text-xs leading-5 text-slate-500">
              金額の確度（確認済み／仮定値・要確認／未確認）を区別して表示しています。
            </p>
            <AssumptionList items={result.assumptions} />

            {/* 未入力を0円等で扱った場合の影響 */}
            {result.unenteredNotices.length > 0 && (
              <div className="mt-5">
                <h3 className="text-xs font-bold text-slate-700">
                  未入力の項目と、その扱い
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {result.unenteredNotices.map((notice) => (
                    <li
                      key={notice}
                      className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-800"
                    >
                      {notice}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.incomeChangeNote && (
              <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-600">
                {result.incomeChangeNote}
              </p>
            )}
          </CollapsibleSection>
        </section>

        {/* ⑦ 利用できる可能性のある支援制度（全幅・PC ではカード2列） */}
        <section className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-sm font-bold text-slate-900">利用できる可能性のある支援制度</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            入力内容と制度情報から、利用できる可能性のある制度を表示しています。
            制度ごとに情報の確認状況が異なるため、各カードのバッジと詳細をご確認ください。
          </p>
          <div className="mt-4">
            <SupportList
              effectById={effectById}
              usedProgramIds={supportTotals.usedProgramIds}
              onConsult={onConsult}
              initialPrograms={programs}
            />
          </div>
        </section>

        {/* ⑧ 支援制度の相談 */}
        <section className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-sm font-bold text-slate-900">支援制度の相談</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            制度を指定しても、指定せずにでも相談できます。各制度カードの
            「この制度について相談する」からも開始できます。
          </p>
          {/* 自由な相談の入口（制度を指定せず質問できる） */}
          <button
            type="button"
            onClick={() => onConsult(null)}
            data-testid="consult-free-button"
            className="mt-3 w-full rounded-full border border-blue-500 px-5 py-3 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-50"
          >
            支援制度の相談（制度を指定せず）
          </button>
        </section>
      </div>

      {/* アクション */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={onEdit}
          className="flex-1 rounded-full border border-slate-300 px-6 py-4 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-50"
        >
          入力内容を修正する
        </button>
        <button
          type="button"
          onClick={onReset}
          data-testid="reset-button"
          className="flex-1 rounded-full bg-blue-500 px-6 py-4 text-sm font-bold text-white shadow-lg shadow-blue-500/25 transition-colors hover:bg-blue-600"
        >
          最初からやり直す
        </button>
      </div>
    </div>
  );
}
