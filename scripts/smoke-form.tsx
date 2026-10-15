/**
 * フォーム描画スモークテスト（M3・段階的アンケート対応）
 *
 * 実行: npx tsx scripts/smoke-form.tsx
 * Form.tsx をサーバレンダリングし、以下を確認する。
 * - 常に表示される基本項目（状況・地域・貯蓄・目標・送信）
 * - 「現在の状況」ごとに表示される子供欄（折りたたみの開閉を含む）
 * - 折りたたみのラベルに中身が書かれていること（押す前から分かる）
 * - 入力済みの子供情報は折りたたみ中でも要約が表示されること
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Form from "../components/Form";
import type { FormState } from "../lib/form/model";

function render(initial?: Partial<FormState>): string {
  return renderToString(
    createElement(Form, { onSubmit: () => {}, onBack: () => {}, initial }),
  );
}

function main(): void {
  let failed = 0;
  const require = (html: string, texts: string[], label: string) => {
    for (const text of texts) {
      const ok = html.includes(text);
      console.log(`  ${ok ? "✔" : "✘"} [${label}] ${text}`);
      if (!ok) failed += 1;
    }
  };
  const forbid = (html: string, texts: string[], label: string) => {
    for (const text of texts) {
      const absent = !html.includes(text);
      console.log(`  ${absent ? "✔" : "✘"} [${label}] 非表示: ${text}`);
      if (!absent) failed += 1;
    }
  };

  // ── 初期状態（現在の状況は未選択＝必要最低限だけ表示） ──
  const baseHtml = render();
  require(
    baseHtml,
    [
      "シミュレーションに必要な情報を入力",
      "入力の目安",
      "現在の状況",
      "すでに子どもがいる",
      "これから子どもを持つ予定",
      "未定",
      "子どもの情報を追加する",
      "都道府県",
      "区市町村",
      "現在の貯蓄額",
      "目標とする養育資金額",
      "詳しい家計・世帯情報（任意）",
      "世帯年収・月の手取り収入・月々の生活費",
      "障害のある方の有無",
      "サンプルデータで自動入力",
      "結果を見る",
    ],
    "base",
  );
  // 折りたたみの中身は初期状態では描画されない
  forbid(baseHtml, ["満年齢（0〜22歳）を選択してください", "世帯年収の目安"], "base/折りたたみ");

  // ── have: 現在の子（人数・年齢）を表示し、出産予定は折りたたむ ──
  const haveHtml = render({ planStatus: "have" });
  require(
    haveHtml,
    ["現在いるお子さま（人数・年齢）", "現在いるお子さま", "年齢", "今後の出産予定（任意）"],
    "have",
  );
  forbid(haveHtml, ["希望する子どもの人数"], "have/希望欄は非表示");

  // ── planning: 希望人数・出産予定時期を表示し、現在の子は追加欄 ──
  const planningHtml = render({ planStatus: "planning" });
  require(
    planningHtml,
    [
      "希望する子どもの人数",
      "第一子の出産予定時期",
      "現在いるお子さま（人数・年齢）",
      "今後の出産予定（任意）",
    ],
    "planning",
  );

  // ── undecided: 子ども詳細は「子どもの情報を追加する」で折りたたむ ──
  const undecidedHtml = render({ planStatus: "undecided" });
  require(undecidedHtml, ["子どもの情報を追加する"], "undecided");
  forbid(undecidedHtml, ["満年齢（0〜22歳）を選択してください"], "undecided/折りたたみ");

  // ── 入力済みの子供情報は折りたたみ中でも要約と編集ボタンを表示 ──
  const filledHtml = render({
    planStatus: "planning",
    existing: [
      { id: "e1", kind: "existing", ageYears: 8, birthInYears: null },
      { id: "e2", kind: "existing", ageYears: 3, birthInYears: null },
    ],
  });
  require(filledHtml, ["入力済み：2人（8歳・3歳）", "編集"], "summary");

  console.log(
    `\nsmoke-form: ${failed === 0 ? "ALL PASSED" : `${failed} 件失敗`}`,
  );
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();
