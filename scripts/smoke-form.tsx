/**
 * フォーム描画スモークテスト（M3）
 *
 * 実行: npx tsx scripts/smoke-form.tsx
 * Form.tsx をサーバレンダリングし、M3 で追加した主要な入力要素が
 * 描画されることを確認する（操作系の自動テストはM4以降で検討）。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Form from "../components/Form";

function main(): void {
  const html = renderToString(
    createElement(Form, { onSubmit: () => {}, onBack: () => {} }),
  );
  const required = [
    "シミュレーションに必要な情報を入力",
    "現在の状況",
    "すでに子どもがいる",
    "これから子どもを持つ予定",
    "現在いるお子さま",
    "これから生まれる予定のお子さま",
    "予定のお子さまを追加",
    "希望する子どもの人数",
    "第一子の出産予定時期",
    "世帯年収の目安",
    "月の手取り収入",
    "現在の貯蓄額",
    "月々の生活費",
    "家賃・住宅ローン",
    "居住地・自治体",
    "世帯構成",
    "教育方針（幼稚園〜高校）",
    "大学の区分",
    "出産後の働き方・収入変化",
    "現在利用している支援制度",
    "目標とする養育資金額",
    "サンプルデータで自動入力",
    "結果を見る",
  ];
  let failed = 0;
  for (const text of required) {
    const ok = html.includes(text);
    console.log(`  ${ok ? "✔" : "✘"} ${text}`);
    if (!ok) failed += 1;
  }
  console.log(`\nsmoke-form: ${required.length - failed}/${required.length} passed`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();