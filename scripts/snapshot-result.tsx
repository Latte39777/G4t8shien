/**
 * 結果画面スナップショット生成（M7-K の変更前後記録用・検証専用）
 *
 * 実行: npx tsx scripts/snapshot-result.tsx <出力HTMLパス>
 *
 * Result.tsx をサーバレンダリングし、ビルド済み CSS を埋め込んだ単一 HTML を
 * 書き出す。支援制度カードも同一データソース（レジストリ）で描画するため、
 * 本番画面と同じ構造・文言を静的に確認できる。
 * トグル（詳細を見る／閉じる）は素の JS で開閉できるようにし、
 * #expanded を付けると全折りたたみを開いた状態で初期化する。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Result from "../components/Result";
import { SAMPLE_INPUT } from "../lib/simulation";
import { getSupportPrograms } from "../lib/supports/registry";

function main(): void {
  const outPath = resolve(
    process.argv[2] ?? "docs/screenshots/result-snapshot.html",
  );
  const programs = getSupportPrograms();
  const resultHtml = renderToString(
    createElement(Result, {
      input: SAMPLE_INPUT,
      onEdit: () => {},
      onReset: () => {},
      onConsult: () => {},
      programs,
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
<title>シミュレーション結果（スナップショット）</title>
<style>${css}</style>
</head>
<body class="min-h-dvh bg-gradient-to-b from-slate-50 via-white to-blue-50">
<div class="flex min-h-dvh flex-col">
<main class="flex flex-1 flex-col">
${resultHtml}
</main>
</div>
<script>
(function () {
  function labelFor(btn, expanding) {
    var hasControls = btn.getAttribute("aria-controls");
    var spans = btn.querySelectorAll("span");
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent || "";
      if (t.indexOf("詳細") >= 0 || t === "閉じる" || t === "▲ 閉じる") {
        if (hasControls) {
          spans[i].textContent = expanding ? "詳細を閉じる" : "詳細を見る";
        } else {
          spans[i].textContent = expanding ? "閉じる" : "詳細を見る";
        }
      }
    }
  }
  function wire(btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
      var panel = null;
      var id = btn.getAttribute("aria-controls");
      if (id) panel = document.getElementById(id);
      if (!panel) {
        var p = btn.parentElement;
        if (p) {
          var divs = p.children;
          for (var i = 0; i < divs.length; i++) {
            if (divs[i].tagName === "DIV" && (divs[i].classList.contains("hidden") || divs[i].classList.contains("mt-3") || divs[i].classList.contains("mt-4"))) {
              panel = divs[i];
              break;
            }
          }
        }
      }
      if (panel) {
        if (expanded) {
          panel.className = "hidden";
        } else {
          panel.className = btn.getAttribute("aria-controls") ? "mt-4" : "mt-3";
        }
      }
      labelFor(btn, !expanded);
    });
  }
  var buttons = document.querySelectorAll("button[aria-expanded]");
  for (var i = 0; i < buttons.length; i++) wire(buttons[i]);
  if (location.hash === "#expanded") {
    for (var j = 0; j < buttons.length; j++) {
      if (buttons[j].getAttribute("aria-expanded") === "false") buttons[j].click();
    }
  }
})();
</script>
</body>
</html>
`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`snapshot written: ${outPath}`);
}

main();