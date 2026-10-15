/**
 * フォーム状態モデル・地域マスタの回帰テスト
 *
 * 実行: npx tsx scripts/verify-form.ts
 * - 未入力時の挙動（任意項目は通過・目標養育資金額は任意）
 * - バリデーション（貯蓄必須・子どもの年齢必須・任意金額の書式）
 * - 子どもの人数と年齢の要約・保持（折りたたみ中でも全行送信）
 * - 地域の正規化（都道府県＋市区町村・東京23区・実在しない自治体の拒否）
 */
import {
  answeredDetailLabels,
  initialFormState,
  remainingRecommendedItems,
  summarizeChildren,
  toSimulationInput,
  validateForm,
  type FormState,
} from "../lib/form/model";
import {
  buildRegion,
  listMunicipalities,
  listPrefectures,
  municipalityKind,
} from "../lib/regions";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}`);
  }
}

function make(overrides: Partial<FormState>): FormState {
  return { ...initialFormState, savings: "1000000", ...overrides };
}

const TOKYO_23_WARDS = [
  "千代田区", "中央区", "港区", "新宿区", "文京区", "台東区", "墨田区", "江東区",
  "品川区", "目黒区", "大田区", "世田谷区", "渋谷区", "中野区", "杉並区", "豊島区",
  "北区", "荒川区", "板橋区", "練馬区", "足立区", "葛飾区", "江戸川区",
];

function main(): void {
  console.log("verify-form: 段階的アンケートの入力モデル");

  // ── 1. 未入力・バリデーション ──
  console.log("\n[1] 未入力時の挙動とバリデーション");
  const noSavings = validateForm(make({ savings: "" }));
  check("貯蓄未入力はエラー", "savings" in noSavings);
  check("目標養育資金額の未入力はエラーにならない（任意化）", !("targetAmount" in noSavings));
  check("貯蓄入力済みなら任意項目はすべて通過", Object.keys(validateForm(make({}))).length === 0);
  check("目標額に不正値があればエラー", "targetAmount" in validateForm(make({ targetAmount: "-1" })));
  check("任意金額の書式エラーを検出", "livingExpense" in validateForm(make({ livingExpense: "abc" })));
  check("希望人数の範囲外を検出", "desiredChildCount" in validateForm(make({ desiredChildCount: "99" })));

  // ── 2. 子どもの人数と年齢 ──
  console.log("\n[2] 子どもの人数と年齢");
  const missingAge = [
    { id: "e1", kind: "existing" as const, ageYears: null, birthInYears: null },
    { id: "e2", kind: "existing" as const, ageYears: 3, birthInYears: null },
  ];
  const ageErrors = validateForm(make({ existing: missingAge }));
  check("年齢未選択の行だけエラー", "child.e1" in ageErrors && !("child.e2" in ageErrors));
  check(
    "要約「2人（年齢未入力・3歳）」",
    summarizeChildren(missingAge) === "2人（年齢未入力・3歳）",
  );
  check(
    "要約「2人（8歳・3歳）」",
    summarizeChildren([
      { id: "a", kind: "existing", ageYears: 8, birthInYears: null },
      { id: "b", kind: "existing", ageYears: 3, birthInYears: null },
    ]) === "2人（8歳・3歳）",
  );
  check(
    "予定の子は出産予定時期で要約",
    summarizeChildren([
      { id: "c", kind: "planned", ageYears: null, birthInYears: 2 },
      { id: "d", kind: "planned", ageYears: null, birthInYears: null },
    ]) === "2人（あと2年後・時期未定）",
  );
  check("子ども0人なら要約なし", summarizeChildren([]) === null);

  // ── 3. 送信データ（折りたたみ状態に依存しない） ──
  console.log("\n[3] 送信データへの変換");
  const form = make({
    planStatus: "have",
    existing: [
      { id: "e1", kind: "existing", ageYears: 8, birthInYears: null },
      { id: "e2", kind: "existing", ageYears: 3, birthInYears: null },
    ],
    planned: [{ id: "p1", kind: "planned", ageYears: null, birthInYears: 2 }],
    targetAmount: "",
    prefectureCode: "13",
    municipalityName: "世田谷区",
    disabilityInHousehold: "present",
  });
  const input = toSimulationInput(form);
  check("子どもは全行・順序どおり送られる", input.children.length === 3 && input.childCount === 3);
  check("目標額未入力は null", input.targetAmount === null);
  check("地域が正規化される", input.household.region?.label === "東京都世田谷区");
  check("互換用 municipality にもラベルが入る", input.household.municipality === "東京都世田谷区");
  check("都道府県コード・市区町村が保存される", input.household.region?.prefectureCode === "13" && input.household.region?.municipalityName === "世田谷区");
  check("障害の回答が保存される", input.household.disabilityInHousehold === "present");
  check(
    "目標額入力時は数値で保存",
    toSimulationInput(make({ targetAmount: "20000000" })).targetAmount === 20_000_000,
  );
  const noRegion = toSimulationInput(make({}));
  check("地域未選択でも変換できる", noRegion.household.region === null && noRegion.household.municipality === null);

  // ── 4. 「あと何項目」の目安 ──
  console.log("\n[4] 入力の目安");
  const rem1 = remainingRecommendedItems(make({ savings: "" }));
  check(
    "初期状態は「現在の状況」「現在の貯蓄額」の2項目",
    rem1.length === 2 && rem1.includes("現在の状況") && rem1.includes("現在の貯蓄額"),
  );
  const rem2 = remainingRecommendedItems(
    make({ planStatus: "have", existing: missingAge }),
  );
  check("年齢未入力行は「第1子の年齢」と数える", rem2.length === 1 && rem2[0] === "第1子の年齢");
  check(
    "任意項目（目標額・地域など）は数えない",
    remainingRecommendedItems(make({ planStatus: "planning", targetAmount: "", prefectureCode: "" })).length === 0,
  );

  // ── 5. 任意項目の入力済みラベル ──
  console.log("\n[5] 詳しい家計・世帯情報の要約");
  const answered = answeredDetailLabels(
    make({ householdType: "couple", disabilityInHousehold: "none" }),
  );
  check(
    "入力済みの任意項目だけラベル化",
    answered.length === 2 && answered.includes("世帯構成") && answered.includes("障害の有無"),
  );

  // ── 6. 地域マスタ ──
  console.log("\n[6] 地域データ（都道府県・市区町村）");
  check("都道府県は47件", listPrefectures().length === 47);
  const tokyo = listMunicipalities("13");
  check("東京23区を個別に選べる", TOKYO_23_WARDS.every((w) => tokyo.includes(w)));
  check("東京の市町村も選べる", tokyo.includes("八王子市") && tokyo.includes("西多摩郡") === false && tokyo.includes("瑞穂町"));
  check("政令市の区を含む自治体もある", listMunicipalities("01").includes("札幌市"));
  check(
    "実在する自治体のみ（架空名を含まない）",
    listMunicipalities("27").includes("大阪市") && !listMunicipalities("27").includes("大阪都市"),
  );
  check("マスタに無い市区町村は null", buildRegion("13", "存在しない市") === null);
  check("都道府県のみ選択も正規化できる", buildRegion("01", null)?.label === "北海道");
  check("都道府県未選択は null", buildRegion("", "世田谷区") === null);
  check(
    "種別の推定（23区=ward / 市=city）",
    municipalityKind("千代田区", "13") === "ward" && municipalityKind("札幌市", "01") === "city",
  );

  console.log(`\nverify-form: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`);
    process.exitCode = 1;
  }
}

main();
