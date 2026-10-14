"use client";

/**
 * シミュレーション結果画面（M4）
 *
 * - 子育て費用の総額見込み / 利用できる可能性のある支援額（確定・推定を分離）/
 *   支援を反映した場合の費用比較 / 貯蓄残高の推移 / 年ごとの収支表
 * - 「詳細を見る」で教育段階別の費用を横棒グラフ比較し、内訳・対象年数・
 *   公立/私立などの計算条件を確認できる（大学は国立・公立・私立を区別）
 * - 支援制度一覧（/api/supports のモックデータ）と制度カード・相談ボタン
 * - 計算に使用した前提条件と、仮定値・未確認値を必ず明示する
 *   （未確認の費用総額を確定値のように表示しない）
 * - 複数の子どもがいる場合は、世帯全体の合計と子ども別の詳細を区別する
 */
import type { SimulationInput } from "@/lib/simulation";
import { formatYen } from "@/lib/simulation";
import { MOCK_SUPPORT_PROGRAMS } from "@/lib/supports/mockPrograms";
import type { SupportProgram } from "@/lib/types/support";
import {
  buildSimulationResult,
  type AssumptionItem,
  type ChildResult,
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

/** 子ども1人分のサマリー（世帯合計と区別して表示する） */
function ChildSummaryCard({ child }: { child: ChildResult }) {
  return (
    <li
      className="rounded-2xl border border-slate-100 bg-white p-4"
      data-testid={`child-summary-${child.childId}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-600">
          {child.label}
        </span>
        <p className="text-xs text-slate-500">{child.statusText}</p>
        {child.excludedFromCalc && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
            計算対象外
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        教育方針：{child.courseLabel}／大学：{child.universityLabel}
      </p>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-slate-500">費用の合計（0〜22歳のうち未経過分）</dt>
          <dd className="font-bold text-slate-900" data-testid={`child-total-${child.childId}`}>
            {formatYen(child.totalYen)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">
            うち確認済み出典／仮定値
          </dt>
          <dd className="text-slate-600">
            {formatYen(child.referenceYen)}／{formatYen(child.assumedYen)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">支援の見込額（確定／推定）</dt>
          <dd className="text-slate-600">
            {formatYen(child.supportConfirmedYen)}／
            {formatYen(child.supportEstimatedYen)}
          </dd>
        </div>
      </dl>
    </li>
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

export default function Result({
  input,
  onEdit,
  onReset,
  onConsult,
}: ResultProps) {
  const result: SimulationResult = buildSimulationResult(
    input,
    MOCK_SUPPORT_PROGRAMS,
  );
  const { costTotals, supportTotals, comparison } = result;
  const effectById = new Map(
    result.supports.effects.map((e) => [e.program.id, e]),
  );
  const target = input.targetAmount;
  const covered =
    input.savings + supportTotals.confirmedYen + supportTotals.estimatedYen;

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
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

      {/* ① 結果サマリー */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-bold text-slate-900">結果のサマリー</h2>

        {/* 子育て費用の総額見込み */}
        <div className="mt-4 rounded-2xl bg-indigo-50 p-4" data-testid="cost-total">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-indigo-800">
              子育て費用の総額見込み（世帯合計）
            </p>
            <FlagBadge flag={costTotals.hasUnverified ? "assumed" : "reference"} />
          </div>
          <p className="mt-1 text-2xl font-bold text-indigo-900">
            {formatYen(costTotals.totalYen)}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-indigo-700">
            うち確認済み出典の金額 {formatYen(costTotals.referenceYen)}／
            仮定値（要確認） {formatYen(costTotals.assumedYen)}
            （0〜22歳のうち、これからかかる分の合計）
          </p>
        </div>

        {/* 利用できる可能性のある支援額 */}
        <div className="mt-3 rounded-2xl bg-rose-50 p-4" data-testid="support-total">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-rose-800">
              利用できる可能性のある支援額
            </p>
            <FlagBadge flag="unverified" />
          </div>
          <p className="mt-1 text-2xl font-bold text-rose-900">
            {formatYen(supportTotals.confirmedYen + supportTotals.estimatedYen)}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-rose-700">
            確定 {formatYen(supportTotals.confirmedYen)}／
            推定（要確認） {formatYen(supportTotals.estimatedYen)}
            。モックデータに基づく試算であり、支給が確定したものではありません。
          </p>
        </div>

        {/* 支援を反映した場合の費用比較 */}
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-100">
          <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5">
            <p className="text-xs text-slate-500">支援なしの場合</p>
            <p className="text-sm font-bold text-slate-900">
              {formatYen(comparison.grossCostYen)}
            </p>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5">
            <p className="text-xs text-slate-500">
              支援を反映した場合（確定支援のみ）
            </p>
            <p className="text-sm font-bold text-slate-900">
              {formatYen(comparison.afterConfirmedYen)}
            </p>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5">
            <p className="text-xs text-slate-500">
              支援を反映した場合（確定＋推定・要確認）
            </p>
            <p className="text-sm font-bold text-slate-900">
              {formatYen(comparison.afterAllYen)}
            </p>
          </div>
        </div>

        {/* 目標額に対するカバー状況 */}
        {target > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-100 p-4">
            <p className="text-xs font-semibold text-slate-700">
              目標とする養育資金額 {formatYen(target)} に対するカバー状況
            </p>
            <p className="mt-1 text-xs text-slate-500">
              現在の貯蓄 {formatYen(input.savings)} ＋ 支援見込{" "}
              {formatYen(supportTotals.confirmedYen + supportTotals.estimatedYen)} ＝{" "}
              <span className="font-bold text-slate-800">{formatYen(covered)}</span>
              {covered < target
                ? `（目標まで ${formatYen(target - covered)} 不足）`
                : "（目標を上回ります）"}
            </p>
          </div>
        )}
      </div>

      {/* ② 世帯合計と子ども別の詳細 */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-bold text-slate-900">
          子ども別の費用と世帯全体の合計
        </h2>
        <div className="mt-3 flex items-center justify-between rounded-2xl bg-indigo-50 px-4 py-3">
          <p className="text-xs font-semibold text-indigo-800">世帯全体の合計</p>
          <p className="text-base font-bold text-indigo-900" data-testid="household-total">
            {formatYen(costTotals.totalYen)}
          </p>
        </div>
        {result.children.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            子どもが0人のため、子ども費用の計算対象はありません。
            費用の試算には、子どもの情報を入力してください。
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {result.children.map((child) => (
              <ChildSummaryCard key={child.childId} child={child} />
            ))}
          </ul>
        )}
        {result.children.length > 0 && (
          <p className="mt-3 text-[11px] leading-4 text-slate-400">
            各子どもの費用の合計＝世帯全体の合計（{formatYen(costTotals.totalYen)}）です。
            費用は 0〜22歳のうち、これからかかる分を含みます。
          </p>
        )}
      </div>

      {/* ③ 将来の貯蓄残高の推移 */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-bold text-slate-900">将来の貯蓄残高の推移</h2>
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
      </div>

      {/* ④ 年ごとの収入・支出・収支・貯蓄残高 */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-bold text-slate-900">
          年ごとの収入・支出・収支・貯蓄残高
        </h2>
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
      </div>

      {/* ⑤ 詳細を見る（教育段階別の費用比較・内訳） */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-slate-900">詳細を見る</h2>
          <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[10px] font-bold text-indigo-600">
            教育段階別
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          妊娠・出産から大学・専門学校まで、教育段階ごとの費用を横棒グラフで比較できます。
          各段階を選ぶと、費用の内訳・対象年数・公立/私立などの計算条件を確認できます。
        </p>
        <div className="mt-5">
          <StageDetail
            childResults={result.children}
            householdStages={result.householdStages}
          />
        </div>
      </div>

      {/* ⑥ 支援制度一覧 */}
      <div className="mt-6 rounded-3xl border border-slate-100 bg-white p-6 shadow-sm sm:p-8">
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
          className="mt-3 w-full rounded-full border border-blue-500 px-5 py-3 text-sm font-bold text-blue-600 transition-colors hover:bg-blue-50 sm:w-auto"
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
      </div>

      {/* ⑦ 計算に使用した前提条件・仮定値/未確認値の明示 */}
      <div className="mt-6 rounded-3xl border border-amber-100 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-bold text-slate-900">
          計算に使用した前提条件
        </h2>
        <p className="mt-1 text-xs leading-5 text-slate-500">
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