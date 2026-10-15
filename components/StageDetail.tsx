"use client";

/**
 * 教育段階別の費用と資金配分（横棒グラフ）と、段階ごとの内訳詳細
 *
 * - 各段階の必要額を「自分で用意する資金（青）」「支援でまかなう金額（緑）」
 *   「不足する金額（赤）」で色分け表示する
 * - 支援ON/OFFで内訳を切り替えられる（OFF=青＋赤、ON=青＋緑＋赤）。
 *   切り替えても最大値・目盛り・計算の対象は変わらない
 * - 全段階で共通の目盛りを使い、最大幅は表示されている費用データから
 *   動的に計算する（固定値を使わない）。支援でまかなっても残る不足は赤のまま
 * - 段階を選ぶと、費用の内訳・対象年数・公立/私立などの計算条件と、
 *   自前資金・支援・不足額の資金配分（前提・要確認事項つき）を確認できる
 * - 大学は国立・公立・私立を区別して表示する
 * - 子ども別の費用と世帯全体の合計をタブで切り替えて表示する
 */
import { useState } from "react";
import type {
  ChildResult,
  CostLineItem,
  DisplayStageKey,
  StageCostDetail,
  StageFunding,
} from "@/lib/result";
import { DISPLAY_STAGES } from "@/lib/result";
import { formatYen } from "@/lib/simulation";

type StageDetailProps = {
  childResults: ChildResult[];
  householdStages: StageCostDetail[];
};

/** 段階データが無い場合のゼロ埋め */
const ZERO_FUNDING: StageFunding = {
  selfFundedYen: 0,
  supportConfirmedYen: 0,
  supportEstimatedYen: 0,
  shortageWithoutSupportYen: 0,
  supportConfirmedAppliedYen: 0,
  supportEstimatedAppliedYen: 0,
  supportAppliedYen: 0,
  shortageWithSupportYen: 0,
  supportSurplusYen: 0,
  supportProgramIds: [],
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

/**
 * 共通目盛り（円）。最大値を4等分した「読みやすい間隔」を選び、
 * 最大費用を必ず最大幅として含める（固定値なし・データ追随）。
 */
function tickValues(maxYen: number): number[] {
  if (maxYen <= 0) return [0];
  const rough = maxYen / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) *
    magnitude;
  const ticks: number[] = [];
  for (let v = 0; v < maxYen - 1; v += step) ticks.push(Math.round(v));
  ticks.push(maxYen);
  return ticks;
}

export default function StageDetail({
  childResults,
  householdStages,
}: StageDetailProps) {
  const [scope, setScope] = useState<string>("household");
  const [selected, setSelected] = useState<DisplayStageKey | null>(null);
  const [supportOn, setSupportOn] = useState(false);

  const stages =
    scope === "household"
      ? householdStages
      : (childResults.find((c) => c.childId === scope)?.stages ?? householdStages);

  // 共通目盛りの最大幅：世帯全体/子ども別や支援ON/OFFの切り替えでも変わらないよう、
  // 表示対象になりうるすべての費用データから一度だけ動的に計算する（固定値なし）
  const maxTotal = Math.max(
    1,
    ...householdStages.map((s) => s.totalYen),
    ...childResults.flatMap((c) => c.stages.map((s) => s.totalYen)),
  );
  const ticks = tickValues(maxTotal);
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

      {/* 支援のON/OFF（切り替えても最大値・目盛り・計算の対象は変わらない） */}
      <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-700">支援の反映</span>
          <button
            type="button"
            onClick={() => setSupportOn(false)}
            aria-pressed={!supportOn}
            data-testid="support-toggle-off"
            className={`rounded-full px-4 py-2 text-xs font-bold transition-colors ${
              !supportOn
                ? "bg-slate-700 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            支援を反映しない
          </button>
          <button
            type="button"
            onClick={() => setSupportOn(true)}
            aria-pressed={supportOn}
            data-testid="support-toggle-on"
            className={`rounded-full px-4 py-2 text-xs font-bold transition-colors ${
              supportOn
                ? "bg-emerald-600 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            支援を反映する
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-slate-500">
          切り替えても最大値と目盛りは変わりません。
          {supportOn
            ? "支援でまかなう金額（緑）と、支援を反映しても残る不足額（赤）を表示しています（推定・未確認を含みます。支給が確定した金額ではありません）。"
            : "支援を反映しない場合の不足額（赤）を表示しています。支援を反映すると不足額がどう変わるかを確認できます。"}
        </p>
      </div>

      {/* 凡例 */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-slate-500">
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-blue-500"
            aria-hidden="true"
          />
          自分で用意する資金
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500"
            aria-hidden="true"
          />
          支援でまかなう金額（確定）
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-emerald-300"
            aria-hidden="true"
          />
          支援でまかなう金額（推定・要確認）
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-rose-500"
            aria-hidden="true"
          />
          不足する金額
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-4 rounded-sm bg-slate-200"
            aria-hidden="true"
          />
          背景・目盛り（残り）
        </li>
      </ul>

      {/* 共通目盛り（全段階で同じ。最大費用の段階＝最大幅） */}
      <div className="relative mt-4 h-5" data-testid="stage-axis">
        {ticks.map((v, i) => (
          <span
            key={v}
            className={`absolute top-0 text-[9px] text-slate-400 ${
              i === 0
                ? ""
                : i === ticks.length - 1
                  ? "-translate-x-full"
                  : "-translate-x-1/2"
            }`}
            style={{ left: `${(v / maxTotal) * 100}%` }}
          >
            {formatYen(v)}
          </span>
        ))}
        <div className="absolute bottom-0 left-0 h-px w-full bg-slate-200" />
      </div>

      {/* 教育段階別の横棒グラフ（青=自助／緑=支援／赤=不足、グレー=背景） */}
      <ul className="mt-2 space-y-2.5" data-testid="stage-chart">
        {DISPLAY_STAGES.map((def) => {
          const stage = stages.find((s) => s.key === def.key);
          const total = stage?.totalYen ?? 0;
          const f = stage?.funding ?? ZERO_FUNDING;
          const isSelected = selected === def.key;
          const shortYen = supportOn
            ? f.shortageWithSupportYen
            : f.shortageWithoutSupportYen;
          const pct = (yen: number) =>
            maxTotal > 0 ? Math.min((yen / maxTotal) * 100, 100) : 0;
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
                {/* 費用のまかなえ方の棒（背景のグレー＝共通目盛りの残り） */}
                <div
                  className="mt-1.5 h-4 w-full overflow-hidden rounded-full bg-slate-200"
                  role="img"
                  aria-label={`${def.label}の費用 ${formatYen(total)} の内訳（支援${
                    supportOn ? "反映" : "未反映"
                  }）`}
                >
                  <div className="flex h-full">
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${pct(f.selfFundedYen)}%` }}
                    />
                    {supportOn && (
                      <>
                        <div
                          className="h-full bg-emerald-500"
                          style={{
                            width: `${pct(f.supportConfirmedAppliedYen)}%`,
                          }}
                        />
                        <div
                          className="h-full bg-emerald-300"
                          style={{
                            width: `${pct(f.supportEstimatedAppliedYen)}%`,
                          }}
                        />
                      </>
                    )}
                    <div
                      className="h-full bg-rose-500"
                      style={{ width: `${pct(shortYen)}%` }}
                    />
                  </div>
                </div>
                {/* 棒の数値（支援ON/OFFに連動して更新） */}
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] leading-4 text-slate-500">
                  <span>自分で用意 {formatYen(f.selfFundedYen)}</span>
                  {supportOn ? (
                    <>
                      <span>
                        支援でまかなう {formatYen(f.supportAppliedYen)}（確定{" "}
                        {formatYen(f.supportConfirmedAppliedYen)}／推定{" "}
                        {formatYen(f.supportEstimatedAppliedYen)}）
                      </span>
                      <span className="font-semibold text-rose-500">
                        支援を反映しても残る不足額{" "}
                        {formatYen(f.shortageWithSupportYen)}
                      </span>
                      {f.supportSurplusYen > 0 && (
                        <span>
                          必要額を超える支援見込額{" "}
                          {formatYen(f.supportSurplusYen)}
                          （棒には表示していません）
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="font-semibold text-rose-500">
                      支援を反映しない場合の不足額{" "}
                      {formatYen(f.shortageWithoutSupportYen)}
                    </span>
                  )}
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

      {/* 選択した段階の内訳・計算条件・資金配分 */}
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

          {/* この段階の費用のまかなえ方（資金配分） */}
          <div className="mt-4 rounded-xl border border-slate-100 p-3">
            <h5 className="text-xs font-bold text-slate-700">
              この段階の費用のまかなえ方（資金配分）
            </h5>
            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  自分で用意する資金（青）
                </dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(selectedStage.funding.selfFundedYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  支援でまかなう額・確定（緑）
                </dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(selectedStage.funding.supportConfirmedAppliedYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  支援でまかなう額・推定要確認（緑）
                </dt>
                <dd className="font-semibold text-slate-800">
                  {formatYen(selectedStage.funding.supportEstimatedAppliedYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  支援を反映しない場合の不足額（赤）
                </dt>
                <dd className="font-semibold text-rose-500">
                  {formatYen(selectedStage.funding.shortageWithoutSupportYen)}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-slate-500">
                  支援を反映しても残る不足額（赤）
                </dt>
                <dd className="font-semibold text-rose-500">
                  {formatYen(selectedStage.funding.shortageWithSupportYen)}
                </dd>
              </div>
            </dl>
            {selectedStage.funding.supportSurplusYen > 0 && (
              <p className="mt-2 text-[11px] leading-4 text-slate-500">
                必要額を上回る支援見込額{" "}
                {formatYen(selectedStage.funding.supportSurplusYen)}{" "}
                は、この段階の棒には表示していません（必要額を超えるため。要確認）。
              </p>
            )}
            <p className="mt-2 text-[11px] leading-4 text-slate-500">
              {selectedStage.dataMissing
                ? "費用データ未整備（要確認）のため 0円扱いです。実際の費用が発生する可能性があります（要確認）。"
                : selectedStage.funding.supportProgramIds.length > 0
                  ? `この段階に配分された支援制度：${selectedStage.funding.supportProgramIds.length}件。確定と推定は上記のとおり区別しています。`
                  : selectedStage.totalYen > 0
                    ? "この段階に見込額のある支援制度はありません（対象年齢・対象期間が重ならない、または支援対象外のため）。不足情報がある制度は支援制度一覧で要確認です。"
                    : "この段階の費用は0円扱いです。"}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              資金配分は、現在の貯蓄と各年の収支から段階ごとに重複なく配分した目安です。
              推定・未確認の支援を含み、正式な受給額の決定ではありません（要確認）。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}