/**
 * 相談画面スモークテスト（M5 / M6 / P3 / M7-M）
 *
 * 実行: npx tsx scripts/smoke-consult.tsx
 * Consult.tsx をサーバレンダリングし、相談画面の主要な表示
 * （自由相談/制度引き継ぎ・モック明示・履歴消滅の告知・質問例・入力欄・
 *   状態表示・リセット・公式情報への導線・M6: AI 応答バッジ／再試行ボタン／
 *   URL の非リンク化・P3: 出典の表示／リンク条件／確認状態／制度区分／
 *   応答正規化での KB 情報の受け渡し・M7-M: 実AI/モック説明の排他表示／
 *   個人情報注意の常時表示と折りたたみ／質問例チップ／重複リンクの解消）を確認する。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Consult from "../components/Consult";
import {
  appendAssistantReply,
  buildInitialMessages,
  toConsultContextProgram,
} from "../lib/consult/conversation";
import { normalizeReplyBody } from "../lib/consult/clientTransport";
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
    "公式サイトをリアルタイム検索する機能ではありません",
    "会話履歴はこのブラウザのメモリ上にのみ保持されます",
    "ページをリロードすると会話履歴は消えます",
    "質問文と会話履歴は外部AIサービス",
    "自動マスキングは完全ではありません",
    "入力フォームで入力した金額（収入・貯蓄など）は相談機能に渡していません",
    "個人情報の取り扱いの詳細",
    "質問例",
    "子育てでもらえるお金には、どんなものがある？",
    "自分の状況で対象になりそうな支援は？",
    "申請はどこですればいい？",
    "ほかに利用できる制度はある？",
    "質問を入力",
    "送信する",
    "会話をリセット",
    "結果画面に戻る",
    "制度一覧・公式情報へのリンク",
    "結果画面で支援制度一覧を見る",
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
    "について相談中",
    "この制度をきっかけに、ほかの支援制度についても質問できます",
    "モック・未確認",
    "制度の詳細（概要・金額・申請先・確認状態）",
    "概要（要確認）",
    "金額（要確認）",
    "申請先（要確認）",
    "相談に必要な範囲",
    "入力フォームで入力した金額（収入・貯蓄など）は相談機能に渡していません",
    "開発用モックサンプル",
    "未確認情報を含む",
    "回答を準備しています",
    "質問を入力してください。",
    "送信中…",
  ], "consult/program");

  // ── M7-M: 実AI/モック説明の排他表示・重複リンクの解消・質問例チップ ──
  const mockModeHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: [
        {
          id: "m-mock",
          role: "assistant" as const,
          text: "モックの回答です。",
          isMock: true,
          hasUnverified: true,
          relatedPrograms: [],
          sourceType: "mock" as const,
        },
      ],
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
      liveAiEnabled: false,
    }),
  );
  require(mockModeHtml, [
    "現在は開発用のモックサンプルです",
    "実際の制度相談や申請判断には使用できません",
    "現在は外部の AI へ送信していません",
    "開発用モックサンプル",
  ], "consult/mode-mock");
  for (const liveOnly of ["質問に回答します", "AI回答（Web検索なし"]) {
    if (mockModeHtml.includes(liveOnly)) {
      console.log(`  ✘ [consult/mode-mock] 実AIの説明を混在させない: ${liveOnly}`);
      failed += 1;
    } else {
      console.log("  ✔ [consult/mode-mock] 実AIの説明を混在させない");
    }
  }
  if (mockModeHtml.includes("consult-ai-badge")) {
    console.log("  ✘ [consult/mode-mock] モック回答に AI バッジを出さない");
    failed += 1;
  } else {
    console.log("  ✔ [consult/mode-mock] モック回答に AI バッジを出さない");
  }

  const liveModeHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: [
        {
          id: "m-ai2",
          role: "assistant" as const,
          text: "AI の回答です。",
          isMock: false,
          hasUnverified: true,
          relatedPrograms: [],
          sourceType: "ai" as const,
        },
      ],
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
      liveAiEnabled: true,
    }),
  );
  require(liveModeHtml, [
    "外部AI（INIAD AI-MOP API）が質問に回答します",
    "質問文と会話履歴は外部AIサービス（INIAD AI-MOP API）へ送信されます",
    "AI回答（Web検索なし・未確認の可能性があります）",
  ], "consult/mode-live");
  for (const mockOnly of [
    "開発用のモックサンプル",
    "開発用モックサンプル",
    "送信していません",
  ]) {
    if (liveModeHtml.includes(mockOnly)) {
      console.log(`  ✘ [consult/mode-live] モックの説明を混在させない: ${mockOnly}`);
      failed += 1;
    } else {
      console.log("  ✔ [consult/mode-live] モックの説明を混在させない");
    }
  }

  // 「結果画面に戻る」は上部1つだけ（下部の重複リンクを廃止）
  const backCount = (freeHtml.match(/結果画面に戻る/g) ?? []).length;
  if (backCount !== 1) {
    console.log(`  ✘ [consult/links] 「結果画面に戻る」は1つだけ（実際 ${backCount} 個）`);
    failed += 1;
  } else {
    console.log("  ✔ [consult/links] 「結果画面に戻る」は1つだけ（重複なし）");
  }
  // 質問例はクリック可能なチップ（button）で4件
  const exampleCount = (freeHtml.match(/data-testid="consult-example"/g) ?? []).length;
  if (exampleCount !== 4) {
    console.log(`  ✘ [consult/examples] 質問例チップは4件（実際 ${exampleCount} 件）`);
    failed += 1;
  } else {
    console.log("  ✔ [consult/examples] 質問例チップは4件（クリックで送信）");
  }
  // 個人情報の詳細は折りたたみ（常時表示の短い注意と併存）
  if (
    !freeHtml.includes("consult-privacy-details") ||
    !freeHtml.includes("consult-privacy-notice")
  ) {
    console.log("  ✘ [consult/privacy] 個人情報注意の常時表示＋詳細折りたたみ");
    failed += 1;
  } else {
    console.log("  ✔ [consult/privacy] 個人情報注意の常時表示＋詳細折りたたみ");
  }
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

  // ── P3: 出典の表示・リンク条件・確認状態・制度区分 ──
  const kbMessages = appendAssistantReply(
    buildInitialMessages({ program: null, userContext: null }),
    {
      text: "児童手当など子育てに関する支援制度があります。参考: https://ai.example/fake は本文中の URL です（出典ではありません）。",
      isMock: true,
      hasUnverified: true,
      unsupported: false,
      relatedPrograms: [
        {
          id: "kb-child-allowance",
          name: "児童手当",
          sourceType: "verified",
          note: "",
          category: "cash_benefit",
          verification: "partial",
          checkedAt: "2026-02-01",
          sources: [
            {
              title: "児童手当の支給",
              organization: "こども家庭庁",
              url: "https://example.go.jp/child",
              urlVerified: true,
              checkedAt: "2026-02-01",
            },
          ],
        },
        {
          id: "kb-education-loan",
          name: "教育支援貸付",
          sourceType: "verified",
          note: "",
          category: "loan",
          verification: "unverified",
          checkedAt: null,
          sources: [
            {
              title: "貸付の案内",
              organization: "某自治体",
              url: "https://example.go.jp/loan",
              urlVerified: false,
              checkedAt: null,
              reviewOutdated: true,
            },
          ],
        },
        {
          id: "kb-fee-reduction",
          name: "保育料の減免",
          sourceType: "verified",
          note: "",
          category: "fee_reduction",
          verification: "official-verified",
          checkedAt: "2026-01-15",
        },
      ],
      citations: [
        {
          title: "児童手当の支給",
          organization: "こども家庭庁",
          url: "https://example.go.jp/child",
          urlVerified: true,
          checkedAt: "2026-02-01",
        },
        {
          title: "未検証のページ",
          organization: "某自治体",
          url: "https://example.go.jp/unverified",
          urlVerified: false,
          checkedAt: null,
        },
        {
          title: "確認が古い情報",
          organization: "某自治体",
          url: "https://example.go.jp/outdated",
          urlVerified: true,
          checkedAt: "2024-01-01",
          reviewOutdated: true,
        },
        {
          title: "URL のない資料",
          organization: "某窓口",
          url: null,
          urlVerified: false,
          checkedAt: "2026-01-01",
        },
        {
          title: "非 HTTPS のページ",
          organization: "某団体",
          url: "http://example.go.jp/insecure",
          urlVerified: true,
          checkedAt: "2026-01-20",
        },
      ],
    },
  );
  const kbHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: kbMessages,
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  require(kbHtml, [
    "参考にした公式ページ",
    "児童手当の支給",
    "こども家庭庁",
    "確認日：2026-02-01",
    'href="https://example.go.jp/child"',
    'target="_blank"',
    'rel="noopener noreferrer"',
    "URL 未確認",
    "情報の再確認が必要です",
    "URL の登録なし",
    "HTTPS の URL ではないためリンクを掲載できません",
    "リンクは掲載していません",
    "給付金（返還不要）",
    "減免・助成（返還不要）",
    "貸与・貸付（返済が必要）",
    "公式情報で確認済み",
    "一部未確認",
    "受給資格（利用資格）は未確認です",
  ], "consult/kb-citations");
  // リンクは「urlVerified=true かつ reviewOutdated でない HTTPS」の1件だけ
  const hrefCount = (kbHtml.match(/href=/g) ?? []).length;
  if (hrefCount !== 1) {
    console.log(`  ✘ [consult/kb-citations] リンクは検証済み HTTPS の1件のみ（実際 ${hrefCount} 件）`);
    failed += 1;
  } else {
    console.log("  ✔ [consult/kb-citations] リンクは検証済み HTTPS の1件のみ");
  }
  for (const unlinked of [
    "https://example.go.jp/unverified",
    "https://example.go.jp/outdated",
    "http://example.go.jp/insecure",
    "https://ai.example/fake",
  ]) {
    if (kbHtml.includes(`href="${unlinked}"`)) {
      console.log(`  ✘ [consult/kb-citations] 未検証/古い/非HTTPS/本文中の URL をリンクにしない: ${unlinked}`);
      failed += 1;
    } else {
      console.log(`  ✔ [consult/kb-citations] リンクにしない: ${unlinked}`);
    }
  }
  // 本文中の URL・機関名を出典として追加しない（出典は citations のみ）
  const citationCount = (kbHtml.match(/data-testid="consult-citation"/g) ?? []).length;
  if (citationCount !== 5 || kbHtml.includes("ai.example/fake</a>")) {
    console.log(`  ✘ [consult/kb-citations] 本文中の URL・機関名を出典に追加しない（出典件数 ${citationCount}）`);
    failed += 1;
  } else {
    console.log("  ✔ [consult/kb-citations] 本文中の URL・機関名を出典に追加しない（出典は citations の5件のみ）");
  }

  // 出典なし（citations 空）でも壊れない・出典セクションを出さない
  const noCitationHtml = renderToString(
    createElement(Consult, {
      program: null,
      userContext: null,
      messages: appendAssistantReply(
        buildInitialMessages({ program: null, userContext: null }),
        {
          text: "出典のない応答です。",
          isMock: true,
          hasUnverified: true,
          unsupported: false,
          relatedPrograms: [],
          citations: [],
        },
      ),
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
    }),
  );
  if (
    noCitationHtml.includes("consult-citations") ||
    noCitationHtml.includes("出典（") ||
    noCitationHtml.includes("<a ")
  ) {
    console.log("  ✘ [consult/kb-none] 出典なしでは出典セクション・リンクを出さない");
    failed += 1;
  } else {
    console.log("  ✔ [consult/kb-none] 出典なしでは出典セクション・リンクを出さない（画面は表示される）");
  }

  // ── P3: API 応答の正規化で KB 由来の出典・確認状態を欠落させない ──
  const normalized = normalizeReplyBody({
    text: "回答",
    isMock: true,
    hasUnverified: true,
    relatedPrograms: [
      {
        id: "p1",
        name: "制度A",
        sourceType: "verified",
        note: "",
        category: "loan",
        verification: "partial",
        checkedAt: null,
        sources: [
          {
            title: "資料",
            organization: "機関",
            url: "https://example.go.jp/x",
            urlVerified: true,
            checkedAt: "2026-02-01",
          },
        ],
      },
      {
        id: "p2",
        name: "制度B",
        sourceType: "verified",
        note: "",
        category: "unknown-category",
        verification: "super-verified",
      },
    ],
    citations: [
      {
        title: "資料",
        organization: "機関",
        url: "https://example.go.jp/x",
        urlVerified: true,
        checkedAt: "2026-02-01",
      },
      { title: "壊れた出典", organization: null },
      "not-a-record",
    ],
  });
  const p1 = normalized.relatedPrograms[0];
  const p2 = normalized.relatedPrograms[1];
  const normOk =
    normalized.citations?.length === 1 &&
    normalized.citations[0]?.urlVerified === true &&
    normalized.citations[0]?.url === "https://example.go.jp/x" &&
    p1.category === "loan" &&
    p1.verification === "partial" &&
    p1.checkedAt === null &&
    p1.sources?.length === 1 &&
    p2.category === undefined &&
    p2.verification === undefined;
  if (!normOk) {
    console.log("  ✘ [consult/normalize] 正規化で KB 由来の出典・区分・確認状態を欠落させない");
    failed += 1;
  } else {
    console.log("  ✔ [consult/normalize] 正規化で KB 由来の出典・区分・確認状態を欠落させない（未知値・壊れた項目は採用しない）");
  }
  const normalizedEmpty = normalizeReplyBody({ text: "回答" });
  if (
    !Array.isArray(normalizedEmpty.citations) ||
    normalizedEmpty.citations.length !== 0
  ) {
    console.log("  ✘ [consult/normalize] 出典なし応答は空の citations になる（UI は非表示のまま安全）");
    failed += 1;
  } else {
    console.log("  ✔ [consult/normalize] 出典なし応答は空の citations になる（UI は非表示のまま安全）");
  }

  console.log(`\nsmoke-consult: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();