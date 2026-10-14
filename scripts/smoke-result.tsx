/**
 * 結果画面スモークテスト（M4）
 *
 * 実行: npx tsx scripts/smoke-result.tsx
 * Result.tsx / SupportCard をサーバレンダリングし、
 * 結果サマリー・教育段階別詳細・支援制度カード・前提条件の主要表示が
 * 描画されることを確認する。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Result from "../components/Result";
import { SupportCard } from "../components/SupportList";
import { SAMPLE_INPUT, type SimulationInput } from "../lib/simulation";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";
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
    "子育て費用の総額見込み",
    "利用できる可能性のある支援額",
    "支援なしの場合",
    "支援を反映した場合（確定支援のみ）",
    "支援を反映した場合（確定＋推定・要確認）",
    "子ども別の費用と世帯全体の合計",
    "世帯全体の合計",
    "第1子",
    "第2子",
    "将来の貯蓄残高の推移",
    "年ごとの収入・支出・収支・貯蓄残高",
    "詳細を見る",
    "教育段階別",
    "妊娠・出産",
    "乳幼児",
    "小学校",
    "中学校",
    "高校",
    "大学・専門学校",
    "世帯全体",
    "利用できる可能性のある支援制度",
    "計算に使用した前提条件",
    "仮定値・要確認",
    "未確認",
    "二重計上",
    "手取り収入",
    "世帯年収は支援の対象条件",
  ], "result");

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
  ], "result/0-child");

  // ── 制度カード（モックデータ） ──
  const sampleEffect = buildSimulationResult(SAMPLE_INPUT, MOCK_SUPPORT_PROGRAMS);
  const cardHtml = renderToString(
    createElement(SupportCard, {
      program: MOCK_SUPPORT_PROGRAMS[0],
      effect: sampleEffect.supports.effects[0],
      isUsed: true,
      onConsult: () => {},
    }),
  );
  require(cardHtml, [
    "児童手当（モック）",
    "モック・未確認",
    "利用中",
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