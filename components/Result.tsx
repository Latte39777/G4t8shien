"use client";

/**
 * シミュレーション結果画面（M4 / レイアウト再設計）
 *
 * - PC では最大幅約 1520px を使い、次の順で全幅レイアウトに並べる：
 *   ① 結果サマリー（費用総額・支援額の2カード横並び）
 *   ② 2列（左：支援を反映した場合の費用比較＝数値中心／右：目標のカバー状況）
 *   ③ 教育段階別の費用と支援（世帯全体/子ども別の切り替え・横棒グラフ・支援ON/OFF）
 *   ④ 利用できる可能性のある支援制度（カード2列。サイドバーには固定しない）
 *   ⑤ 将来の家計予測（折りたたみ）／⑥ 前提条件（折りたたみ）／アクション
 * - 費用比較は横棒グラフを使わず数値で表示し、支援による負担軽減の見込額を
 *   緑で強調する（金額はすべて buildSimulationResult の計算結果から取得し、
 *   ハードコードしない）
 * - 子ども別の金額・教育方針・計算対象外の注意は教育段階別セクションの
 *   スコープ切り替え（ScopeSummary）に統合し、重複セクションは持たない
 * - 支援制度一覧（/api/supports のモックデータ）と制度カード・相談ボタン
 * - 計算に使用した前提条件と、仮定値・未確認値を必ず明示する
 *   （未確認の費用総額を確定値のように表示しない）
 * - 複数の子どもがいる場合は、世帯全体の合計と子ども別の詳細を区別する
 */
import { useState, type ReactNode } from "react";
import type { SimulationInput } from "@/lib/simulation";
import { formatYen } from "@/lib/simulation";
import { getSupportPrograms } from "@/lib/supports/registry";
import type { SupportProgram } from "@/lib/types/support";
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
}: ResultProps) {
  const result: SimulationResult = buildSimulationResult(
    input,
    getSupportPrograms(),
  );
  const { costTotals, supportTotals, comparison } = result;
  const effectById = new Map(
    result.supports.effects.map((e) => [e.program.id, e]),
  );
  const goal = result.goalCoverage;

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

      {/* 仮定値・未確認値を含むことの明示（確定値のように扱わせない） */}
      <p
        className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"
        data-testid="unverified-banner"
      >
        <span className="font-bold">【要確認】</span>
        この結果には仮定値・未確認のデータが含まれます。費用総額は確定値ではなく、
        公式資料での確認前に金額が変更される可能性があります。
        金額の確度（確認済み／仮定値・要確認／未確認）を各項目に表示しています。
      </p>

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

          {/* 利用できる可能性のある支援額（大きな数値2） */}
          <div className="rounded-2xl bg-rose-50 p-4 sm:p-5" data-testid="support-total">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-rose-800">
                利用できる可能性のある支援額
              </p>
              <FlagBadge flag="unverified" />
            </div>
            <p className="mt-1 text-4xl font-bold tracking-tight text-rose-900">
              {formatYen(supportTotals.confirmedYen + supportTotals.estimatedYen)}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-rose-700">
              確定 {formatYen(supportTotals.confirmedYen)}／
              推定（要確認） {formatYen(supportTotals.estimatedYen)}
              。未確認の試算であり、支給が確定したものではありません。併用可否が未確認の制度を含むため、合計は単純合算の試算です（要確認）。
            </p>
          </div>
          </div>
        </section>

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
              </dt>
              <dd
                className="text-sm font-bold text-slate-900"
                data-testid="compare-after-all"
              >
                {formatYen(comparison.afterAllYen)}
              </dd>
            </div>
          </dl>

          {/* 支援による負担軽減の見込額（緑で強調して表示） */}
          <div
            className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5"
            data-testid="support-relief"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-emerald-800">
                支援による負担軽減の見込額
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
          <p className="mt-3 text-[11px] leading-4 text-slate-500">
            負担軽減の見込額は「支援なしの場合の費用総額 −
            確定支援と推定支援を反映した場合の参考費用」です。
            うち推定支援 {formatYen(supportTotals.estimatedYen)}{" "}
            は未確認の試算を含みます。支援額は未確認の試算であり、
            支給が確定したことや、実際の負担額が保証されることを意味しません。
          </p>
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
            {/* 貯蓄（確定）／確定支援／推定支援を区別した横棒 */}
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
                現在の貯蓄（確定）
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500"
                  aria-hidden="true"
                />
                確定支援
              </li>
              <li className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-sm bg-emerald-300"
                  aria-hidden="true"
                />
                支援見込（推定・要確認）
              </li>
            </ul>
            <p className="mt-3 text-xs text-slate-500">
              現在の貯蓄 {formatYen(goal.savingsYen)} ＋ 支援見込{" "}
              {formatYen(goal.supportTotalYen)} ＝{" "}
              <span className="font-bold text-slate-800">
                {formatYen(goal.savingsYen + goal.supportTotalYen)}
              </span>
              {goal.gapYen > 0
                ? `（目標まで ${formatYen(goal.gapYen)} 不足）`
                : "（目標を上回ります）"}
            </p>
            <p className="mt-2 text-[11px] leading-4 text-slate-400">
              現在の貯蓄は確定している金額です。確定支援{" "}
              {formatYen(goal.supportConfirmedYen)} と、支援見込（推定・要確認）{" "}
              {formatYen(goal.supportEstimatedYen)} は確度が異なります。
              推定を含む支援見込は、利用できない場合があります（要確認）。
            </p>
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

          {/* 資金配分の前提・未配分の支援（推定と未確認を混同させない） */}
          {(result.fundingMeta.selfFundingNotes.length > 0 ||
            result.fundingMeta.supportAllocationNotes.length > 0 ||
            result.fundingMeta.unallocatedSupports.length > 0) && (
            <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <h3 className="text-xs font-bold text-slate-700">
                資金配分の前提と要確認事項
              </h3>
              <ul className="mt-2 space-y-1">
                {result.fundingMeta.selfFundingNotes.map((n) => (
                  <li key={n} className="text-[11px] leading-4 text-slate-600">
                    ・{n}
                  </li>
                ))}
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
                      className="rounded-lg bg-white px-2 py-1.5 text-[11px] leading-4 text-slate-600"
                    >
                      <span className="font-semibold">{u.programName}</span>
                      （{u.category === "loan" ? "貸付" : "現金給付等"}）
                      {u.amountYen !== null && ` 見込額 ${formatYen(u.amountYen)}`}：
                      {u.reason}
                      {u.includedInTotal && "（世帯の支援見込額の合計には含まれます）"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {/* ④ 利用できる可能性のある支援制度（全幅・PC ではカード2列） */}
        <section className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
          <h2 className="text-sm font-bold text-slate-900">利用できる可能性のある支援制度</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            金額・対象条件・根拠法令・申請期限はモックデータに基づく未確認の情報です。
            確認済みの事実として表示していないため、必ず公式窓口でご確認ください。
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
          <div className="mt-4">
            <SupportList
              effectById={effectById}
              usedProgramIds={supportTotals.usedProgramIds}
              onConsult={onConsult}
            />
          </div>
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
