/**
 * 相談画面スナップショット生成（M7-M の表示確認用・検証専用）
 *
 * 実行: npx tsx scripts/snapshot-consult.tsx <出力HTMLパス> [state]
 *   state: "conversation"（会話中・既定） / "initial"（会話開始直前）
 *
 * Consult.tsx をサーバレンダリングし、ビルド済み CSS を埋め込んだ単一 HTML を
 * 書き出す。モックモード（liveAiEnabled=false）の会話中状態を基本とし、
 * #expanded を付けると折りたたみ（details）をすべて開いた状態で初期化する。
 * 外部 AI への通信は一切行わない（表示確認のみ）。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Consult from "../components/Consult";
import {
  buildInitialMessages,
  toConsultContextProgram,
} from "../lib/consult/conversation";
import type { ChatMessage } from "../lib/consult/types";
import { MOCK_SUPPORT_PROGRAMS } from "../lib/supports/mockPrograms";

function main(): void {
  const outPath = resolve(
    process.argv[2] ?? "docs/screenshots/consult-snapshot.html",
  );
  const state = process.argv[3] ?? "conversation";
  const program = toConsultContextProgram(MOCK_SUPPORT_PROGRAMS[0]);

  const conversation: ChatMessage[] = [
    ...buildInitialMessages({ program, userContext: null }),
    {
      id: "m-user",
      role: "user",
      text: "申請はどこですればいい？",
      isMock: false,
      hasUnverified: false,
      relatedPrograms: [],
    },
    {
      id: "m-mock",
      role: "assistant",
      text: "【開発用モック応答】児童手当（モック）は、お住まいの市区町村（公務員の場合は勤務先）に申請します（要確認）。",
      isMock: true,
      hasUnverified: true,
      relatedPrograms: [
        {
          id: "mock-child-allowance",
          name: "児童手当（モック）",
          sourceType: "mock",
          note: "モックデータ（未確認）です。制度の内容・金額・申請方法は公式窓口でご確認ください。",
          category: "cash_benefit",
          checkedAt: undefined,
        },
      ],
    },
  ];

  const consultHtml = renderToString(
    createElement(Consult, {
      program,
      userContext: {
        childCount: 2,
        hasAnnualIncome: true,
        usedProgramIds: ["mock-child-allowance"],
      },
      messages:
        state === "initial"
          ? buildInitialMessages({ program, userContext: null })
          : conversation,
      sending: false,
      error: null,
      onSend: () => {},
      onReset: () => {},
      onBack: () => {},
      onOpenSupports: () => {},
      liveAiEnabled: false,
    }),
  );

  // ビルド済み CSS（.next/static/chunks/*.css）を埋め込む
  const chunksDir = resolve(".next/static/chunks");
  const cssFiles = readdirSync(chunksDir).filter((f) => f.endsWith(".css"));
  const css = cssFiles
    .map((f) => readFileSync(join(chunksDir, f), "utf8"))
    .join("\n");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>支援制度の相談（スナップショット）</title>
<style>${css}</style>
</head>
<body class="min-h-dvh bg-gradient-to-b from-slate-50 via-white to-blue-50">
<div class="flex min-h-dvh flex-col">
<main class="flex flex-1 flex-col">
${consultHtml}
</main>
</div>
<script>
(function () {
  if (location.hash === "#expanded") {
    var ds = document.querySelectorAll("details");
    for (var i = 0; i < ds.length; i++) ds[i].open = true;
  }
})();
</script>
</body>
</html>
`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`snapshot written: ${outPath} (state=${state})`);
}

main();