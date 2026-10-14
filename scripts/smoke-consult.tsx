/**
 * 相談画面スモークテスト（M5 / M6）
 *
 * 実行: npx tsx scripts/smoke-consult.tsx
 * Consult.tsx をサーバレンダリングし、相談画面の主要な表示
 * （自由相談/制度引き継ぎ・モック明示・履歴消滅の告知・質問例・入力欄・
 *   状態表示・リセット・公式情報への導線・M6: AI 応答バッジ／再試行ボタン／
 *   URL の非リンク化）を確認する。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Consult from "../components/Consult";
import { buildInitialMessages, toConsultContextProgram } from "../lib/consult/conversation";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";

function main(): void {
  let failed = 0;
  const require = (html: string, texts: string[], label: string) => {
    for (const text of texts) {
      const ok = html.includes(text);
      console.log(`  ${ok ? "✔" : "✘"} [${label}] ${text}`);
      if (!ok) failed += 1;
    }
  };

  // ── 自由な相談（制度を指定しない） ──
  const freeHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: [],
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  require(freeHtml, [
    "支援制度の相談",
    "制度を指定しない自由な相談です",
    "開発用のモックサンプル",
    "公式サイトの検索を行った結果ではありません",
    "会話履歴はこのブラウザのメモリ上にのみ保持されます",
    "ページをリロードすると会話履歴は消えます",
    "質問例",
    "子育てでもらえるお金には、どんなものがある？",
    "自分の状況で対象になりそうな支援は？",
    "申請はどこですればいい？",
    "ほかに利用できる制度はある？",
    "質問を入力",
    "送信する",
    "会話をリセット",
    "結果画面に戻る",
    "関連する支援制度・公式情報の確認",
    "結果画面の支援制度一覧を見る",
    "必ずご確認ください",
  ], "consult/free");

  // ── 制度カードからの相談（引き継ぎ表示・会話表示・状態表示） ──
  const program = toConsultContextProgram(MOCK_SUPPORT_PROGRAMS[0]);
  const messages = buildInitialMessages({ program, userContext: null });
  const programHtml = renderToString(
    createElement(Consult, {
      program,
      userContext: {
        childCount: 2,
        hasAnnualIncome: true,
        usedProgramIds: ["mock-child-allowance"],
      },
      messages,
      sending: true,
      error: "質問を入力してください。",
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  require(programHtml, [
    "児童手当（モック）",
    "についての相談から開始しています",
    "この制度以外の支援制度についても自由に質問できます",
    "概要（要確認）",
    "金額（要確認）",
    "申請先（要確認）",
    "相談に必要な範囲",
    "収入・貯蓄などの金額は相談機能に渡していません",
    "開発用モックサンプル",
    "未確認情報を含む",
    "回答を準備しています",
    "質問を入力してください。",
    "送信中…",
  ], "consult/program");
  // ── M6: AI 応答バッジ・再試行ボタン・URL の非リンク化 ──
  const aiMessages = [
    ...buildInitialMessages({ program: null, userContext: null }),
    {
      id: "m-ai",
      role: "assistant" as const,
      text: "参考: https://example.invalid は未検証です（未確認）。",
      isMock: false,
      hasUnverified: true,
      relatedPrograms: [],
      sourceType: "ai" as const,
    },
  ];
  const aiHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: aiMessages,
      sending: false,
      error: "通信エラーが発生しました。時間をおいて再度お試しください。",
      onSend: () => {},
      onReset: () => {},
      onRetry: () => {},
      retryable: true,
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  require(aiHtml, [
    "AI回答（Web検索なし・未確認の可能性があります）",
    "未確認情報を含む",
    "通信エラーが発生しました。時間をおいて再度お試しください。",
    "再試行する",
  ], "consult/ai");
  if (aiHtml.includes("<a ")) {
    console.log("  ✘ [consult/ai] URL をアンカー化していないこと");
    failed += 1;
  } else {
    console.log("  ✔ [consult/ai] URL をアンカー化していない（出典として扱わない）");
  }
  if (aiHtml.includes("公式確認済み")) {
    console.log("  ✘ [consult/ai] 「公式確認済み」バッジを出さないこと");
    failed += 1;
  } else {
    console.log("  ✔ [consult/ai] 「公式確認済み」バッジを出さない");
  }

  // 再試行不可のエラーでは再試行ボタンを出さない
  const noRetryHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: aiMessages,
      sending: false,
      error: "質問の形式に問題があります。内容を確認して再度お試しください。",
      onSend: () => {},
      onReset: () => {},
      onRetry: () => {},
      retryable: false,
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  if (noRetryHtml.includes("再試行する")) {
    console.log("  ✘ [consult/ai] 再試行不可エラーでは再試行ボタンを出さない");
    failed += 1;
  } else {
    console.log("  ✔ [consult/ai] 再試行不可エラーでは再試行ボタンを出さない");
  }

  console.log(`\nsmoke-consult: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();