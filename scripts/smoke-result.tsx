/**
 * 結果画面スモークテスト（M4 / レイアウト再設計）
 *
 * 実行: npx tsx scripts/smoke-result.tsx
 * Result.tsx / SupportCard / ScopeSummary をサーバレンダリングし、
 * 結果サマリー・費用比較（数値中心）・教育段階別・支援制度カード・前提条件の
 * 主要表示と、計算結果の金額（ハードコードなし）が正しく描画されること、
 * さらに全幅レイアウト（max-w-[1520px]・2列グリッド）が適用されることを確認する。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Result from "../components/Result";
import { SupportCard } from "../components/SupportList";
import { ScopeSummary } from "../components/StageDetail";
import {
  SAMPLE_INPUT,
  formatYen,
  type SimulationInput,
} from "../lib/simulation";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
import { getSupportPrograms } from "../lib/supports/registry";
import { buildSimulationResult } from "../lib/result";

function main(): void {
  let failed = 0;
  const require = (html: string, texts: string[], label: string) => {
    for (const text of texts) {
      const ok = html.includes(text);
      console.log(`  ${ok ? "✔" : "✘"} [${label}] ${text}`);
      if (!ok) failed += 1;
    }
  };

  // 計算と画面（Result）で同一のデータソース（レジストリ）を使い、数値回帰を確認する
  const sampleResult = buildSimulationResult(SAMPLE_INPUT, getSupportPrograms());

  // ── 結果画面（SAMPLE_INPUT: 子ども2人） ──
  const resultHtml = renderToString(
    createElement(Result, {
      input: SAMPLE_INPUT,
      onEdit: () => {},
      onReset: () => {},
      onConsult: () => {},
    }),
  );
  require(resultHtml, [
    "シミュレーション結果",
    "【要確認】",
    "結果のサマリー",
    "子育て費用の総額見込み",
    "利用できる可能性のある支援額",
    // 費用比較（横棒グラフなし・数値中心）
    "支援を反映した場合の費用比較",
    "支援なしの場合の費用総額",
    "確定支援のみを反映した場合の参考費用",
    "確定支援と推定支援を反映した場合の参考費用",
    "支援による負担軽減の見込額",
    "総額に対する軽減割合",
    // 目標とする養育資金額のカバー状況
    "目標とする養育資金額のカバー状況",
    // 教育段階別の費用と支援（全幅・常時表示）
    "教育段階別の費用と支援",
    "教育段階別",
    "妊娠・出産",
    "乳幼児",
    "小学校",
    "中学校",
    "高校",
    "大学・専門学校",
    "世帯全体",
    "世帯全体の合計",
    "各子どもの費用の合計",
    "第1子",
    "第2子",
    // 支援制度（全幅・サイドバー解除）
    "利用できる可能性のある支援制度",
    // 最下段（折りたたみ）
    "将来の貯蓄残高の推移",
    "年ごとの収入・支出・収支・貯蓄残高",
    "計算に使用した前提条件",
    "詳細を見る",
    // 仮定値・未確認の明示
    "仮定値・要確認",
    "未確認",
    "二重計上",
    "手取り収入",
    "世帯年収は支援の対象条件",
    // 確定支援のみで差がない場合の明示（SAMPLE_INPUT は確定支援 0 円）
    "確定支援のみでは費用に差がありません",
    "confirmed-no-diff",
  ], "result");

  // ── 計算結果の金額がそのまま描画されていること（ハードコードなし・回帰） ──
  require(
    resultHtml,
    [
      formatYen(sampleResult.costTotals.totalYen),
      formatYen(sampleResult.costTotals.referenceYen),
      formatYen(sampleResult.costTotals.assumedYen),
      formatYen(
        sampleResult.supportTotals.confirmedYen +
          sampleResult.supportTotals.estimatedYen,
      ),
      formatYen(sampleResult.comparison.grossCostYen),
      formatYen(sampleResult.comparison.afterConfirmedYen),
      formatYen(sampleResult.comparison.afterAllYen),
      // 支援による負担軽減の見込額
      formatYen(
        sampleResult.comparison.grossCostYen - sampleResult.comparison.afterAllYen,
      ),
    ],
    "result/values",
  );

  // ── レイアウト（PC 全幅化・2列グリッド） ──
  require(
    resultHtml,
    ["max-w-[1520px]", "grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-2"],
    "result/layout",
  );

  // ── 子ども0人の場合 ──
  const emptyInput: SimulationInput = {
    ...SAMPLE_INPUT,
    childCount: 0,
    children: [],
    household: {
      ...SAMPLE_INPUT.household,
      monthlyTakeHomeYen: null,
      monthlyLivingExpenseYen: null,
      monthlyHousingCostYen: null,
    },
  };
  const emptyResult = buildSimulationResult(emptyInput, getSupportPrograms());
  const emptyHtml = renderToString(
    createElement(Result, {
      input: emptyInput,
      onEdit: () => {},
      onReset: () => {},
      onConsult: () => {},
    }),
  );
  require(emptyHtml, [
    "子どもが0人のため",
    "対象期間がないため",
    "月の手取り収入が未入力",
    "世帯の生活費は 0 円",
    // 支援見込額が 0 円の場合も、負担軽減の見込額が 0 円と自然に表示される
    "支援による負担軽減の見込額",
    formatYen(
      emptyResult.comparison.grossCostYen - emptyResult.comparison.afterAllYen,
    ),
  ], "result/0-child");

  // ── ScopeSummary（子どもスコープ：金額・教育方針・支援見込額） ──
  const firstChild = sampleResult.children[0];
  const childScopeHtml = renderToString(
    createElement(ScopeSummary, {
      activeChild: firstChild,
      householdTotalYen: sampleResult.costTotals.totalYen,
      childCount: sampleResult.children.length,
    }),
  );
  require(childScopeHtml, [
    firstChild.label,
    "教育方針：",
    "費用の合計（0〜22歳のうち未経過分）",
    formatYen(firstChild.totalYen),
    "うち確認済み出典／仮定値",
    "支援の見込額（確定／推定）",
    formatYen(firstChild.supportConfirmedYen),
    formatYen(firstChild.supportEstimatedYen),
  ], "scope-summary/child");

  // ── ScopeSummary（計算対象外の子：注意書きの維持） ──
  const excludedHtml = renderToString(
    createElement(ScopeSummary, {
      activeChild: { ...firstChild, excludedFromCalc: true },
      householdTotalYen: sampleResult.costTotals.totalYen,
      childCount: sampleResult.children.length,
    }),
  );
  require(excludedHtml, [
    "計算対象外",
    "出産予定時期が未定のため、この子は計算対象外です",
  ], "scope-summary/excluded");

  // ── ScopeSummary（世帯スコープ・子ども0人） ──
  const householdScopeHtml = renderToString(
    createElement(ScopeSummary, {
      activeChild: null,
      householdTotalYen: sampleResult.costTotals.totalYen,
      childCount: 0,
    }),
  );
  require(householdScopeHtml, [
    "世帯全体の合計",
    "子どもが0人のため",
  ], "scope-summary/household-0");

  // ── 制度カード（モックデータ） ──
  const cardHtml = renderToString(
    createElement(SupportCard, {
      program: MOCK_SUPPORT_PROGRAMS[0],
      effect: sampleResult.supports.effects[0],
      isUsed: true,
      onConsult: () => {},
    }),
  );
  require(cardHtml, [
    "児童手当（モック）",
    "モック・未確認",
    "利用中",
    "この世帯の見込額",
    "金額",
    "対象期間",
    "対象条件の確認状況",
    "根拠法令",
    "要確認",
    "申請期限・申請時期",
    "申請先",
    "URL未確認（公式リンクとして扱いません）",
    "情報の確認日",
    "この制度について相談する",
    "正式な受給資格の決定ではありません",
  ], "support-card");

  console.log(`\nsmoke-result: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();