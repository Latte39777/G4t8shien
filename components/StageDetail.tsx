"use client";

/**
 * 教育段階別の費用比較（横棒グラフ）と、段階ごとの内訳詳細（M4）
 *
 * - 段階を選択すると、費用の内訳・対象年数・公立/私立などの計算条件を確認できる
 * - 大学は国立・公立・私立を区別して表示する
 * - 子ども別の費用と世帯全体の合計をタブで切り替えて表示する
 */
import { useState } from "react";
import type {
  ChildResult,
  CostLineItem,
  DisplayStageKey,
  StageCostDetail,
} from "@/lib/result";
import { DISPLAY_STAGES } from "@/lib/result";
import { formatYen } from "@/lib/simulation";

type StageDetailProps = {
  childResults: ChildResult[];
  householdStages: StageCostDetail[];
};

function BasisBadge({ basis }: { basis: "reference" | "assumed" }) {
  return basis === "reference" ? (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
      確認済み出典
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
      仮定値・要確認
    </span>
  );
}

function ItemRow({ item }: { item: CostLineItem }) {
  return (
    <li className="border-t border-slate-100 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-xs font-semibold text-slate-800">{item.label}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            年額 {formatYen(item.annualYen)} × 対象 {item.years}年
            {item.category === "entrance" && "（一時金・1回）"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-slate-900">
            {formatYen(item.subtotalYen)}
          </p>
          <div className="mt-1">
            <BasisBadge basis={item.basis} />
          </div>
        </div>
      </div>
      {item.sourceTitle && (
        <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
          出典: {item.sourceTitle}（{item.sourceOrganization}）
          {item.sourceUrl !== null && item.sourceUrlVerified ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-blue-500 underline"
            >
              公式情報
            </a>
          ) : (
            <span className="ml-1 font-semibold text-amber-600">
              URL要確認（公式リンクとして未確認）
            </span>
          )}
        </p>
      )}
      {item.note && (
        <p className="mt-1 text-[11px] leading-4 text-slate-400">{item.note}</p>
      )}
    </li>
  );
}

export default function StageDetail({
  childResults,
  householdStages,
}: StageDetailProps) {
  const [scope, setScope] = useState<string>("household");
  const [selected, setSelected] = useState<DisplayStageKey | null>(null);

  const stages =
    scope === "household"
      ? householdStages
      : (childResults.find((c) => c.childId === scope)?.stages ?? householdStages);
  const maxTotal = Math.max(...stages.map((s) => s.totalYen), 1);
  const selectedStage = stages.find((s) => s.key === selected) ?? null;

  return (
    <div>
      {/* 表示対象の切り替え（世帯全体 / 子ども別） */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setScope("household")}
          data-testid="stage-scope-household"
          className={`rounded-full px-4 py-2 text-xs font-bold transition-colors ${
            scope === "household"
              ? "bg-blue-500 text-white"
              : "border border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
        >
          世帯全体
        </button>
        {childResults.map((c) => (
          <button
            key={c.childId}
            type="button"
            onClick={() => setScope(c.childId)}
            data-testid={`stage-scope-${c.childId}`}
            className={`rounded-full px-4 py-2 text-xs font-bold transition-colors ${
              scope === c.childId
                ? "bg-blue-500 text-white"
                : "border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {c.label}
            {c.excludedFromCalc && "（計算対象外）"}
          </button>
        ))}
      </div>

      {/* 教育段階別の横棒グラフ */}
      <ul className="mt-5 space-y-2.5" data-testid="stage-chart">
        {DISPLAY_STAGES.map((def) => {
          const stage = stages.find((s) => s.key === def.key);
          const total = stage?.totalYen ?? 0;
          const width = total > 0 ? Math.max((total / maxTotal) * 100, 1.5) : 0;
          const isSelected = selected === def.key;
          return (
            <li key={def.key}>
              <button
                type="button"
                onClick={() => setSelected(isSelected ? null : def.key)}
                data-testid={`stage-bar-${def.key}`}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  isSelected
                    ? "border-blue-300 bg-blue-50"
                    : "border-slate-100 bg-white hover:bg-slate-50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-xs font-bold text-slate-800">
                    {def.label}
                    <span className="ml-1.5 font-normal text-slate-400">
                      {def.ageLabel}
                    </span>
                  </p>
                  <p className="text-sm font-bold text-slate-900">
                    {formatYen(total)}
                  </p>
                </div>
                <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full ${def.dataMissing ? "bg-slate-300" : "bg-indigo-400"}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-slate-400">
                  {def.dataMissing
                    ? "費用データ未整備（要確認）・0円扱い"
                    : `対象 ${stage?.years ?? 0}年（${def.ageLabel}）`}
                  ／ 選択すると内訳を表示
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      {/* 選択した段階の内訳・計算条件 */}
      {selectedStage && (
        <div
          className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
          data-testid={`stage-detail-${selectedStage.key}`}
        >
          <h4 className="text-sm font-bold text-slate-900">
            {selectedStage.label} の内訳
            <span className="ml-2 text-xs font-normal text-slate-500">
              {selectedStage.ageLabel}
            </span>
          </h4>
          <p className="mt-1 text-xs text-slate-500">
            対象年数：{selectedStage.years}年（このシミュレーションに含まれる年数。
            {selectedStage.label}全体では{selectedStage.fullYears}年）
          </p>
          {selectedStage.note && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              {selectedStage.note}
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            合計 {formatYen(selectedStage.totalYen)}（確認済み出典{" "}
            {formatYen(selectedStage.referenceYen)}／仮定値{" "}
            {formatYen(selectedStage.assumedYen)}）
          </p>

          {selectedStage.items.length === 0 ? (
            <p className="mt-3 text-xs text-slate-400">
              この段階の費用データは未整備のため、内訳はありません（0円扱い・要確認）。
            </p>
          ) : (
            <ul className="mt-3">
              {selectedStage.items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          )}

          {/* 大学は国立・公立・私立を区別して表示 */}
          {selectedStage.universityOptions && (
            <div className="mt-4">
              <h5 className="text-xs font-bold text-slate-700">
                大学の区分別の金額（国立・公立・私立）
              </h5>
              <table className="mt-2 w-full text-left text-[11px]">
                <thead>
                  <tr className="text-slate-400">
                    <th className="py-1 font-medium">区分</th>
                    <th className="py-1 font-medium">学費（年額）</th>
                    <th className="py-1 font-medium">入学料</th>
                    <th className="py-1 font-medium">確度</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedStage.universityOptions.map((opt) => (
                    <tr key={opt.course} className="border-t border-slate-100">
                      <td className="py-1.5 font-semibold text-slate-700">
                        {opt.label}
                      </td>
                      <td className="py-1.5 text-slate-700">
                        {formatYen(opt.annualYen)}
                      </td>
                      <td className="py-1.5 text-slate-700">
                        {formatYen(opt.entranceYen)}
                      </td>
                      <td className="py-1.5">
                        <BasisBadge basis={opt.basis} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-slate-400">
                上記の内訳は、入力された大学の区分に基づいて計算しています。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}