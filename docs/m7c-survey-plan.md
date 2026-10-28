# M7-C 調査計画・カバレッジ管理

国・東京都・東京都23区の支援制度について「どの地域・分野を調査したか／未調査か」を
管理する仕組み。M7-D の公式サイト調査パイプラインの調査対象・進捗管理の土台。

## 1. データ保存形式（`data/survey-plan.json`）

```jsonc
{
  "formatVersion": 1,
  "regions": [ { "id": "nation", "name": "国", "kind": "nation" }, ... ],
  "fields":  [ { "id": "pregnancy-birth", "name": "妊娠・出産" }, ... ],
  "tasks": [
    {
      "taskId": "nation/pregnancy-birth",   // = regionId + "/" + fieldId（一意）
      "regionId": "nation",
      "fieldId": "pregnancy-birth",
      "status": "not_started",
      "lastSurveyedAt": null,                // 最終調査日時（ISO 8601 または null）
      "nextScheduledDate": null,             // 次回調査予定日（YYYY-MM-DD または null）
      "portalUrls": [],                      // 参照する公式ポータルURL（根拠のあるURLのみ）
      "candidateCount": 0,                   // 発見した候補数（M7-D から更新）
      "notes": "",                           // 補足情報
      "openIssues": []                       // 未解決事項
    },
    ...
  ]
}
```

- **地域は25区分**（国・東京都・23区）、**分野は12区分**。タスクは地域×分野の
  全組み合わせ（25×12＝300件）を1件ずつ持つ。欠落・重複は `parseSurveyPlan` が
  エラーとして検出する。
- 調査状態（`status`）:
  - `not_started`：未調査
  - `in_progress`：調査中
  - `surveyed`：調査を実施済み（**制度を網羅できたという意味ではない**。
    調査件数0件でも制度が存在しないと断定しない）
  - `needs_recheck`：再調査が必要
- 地域×分野は原則として未調査から開始する。
- 公式ポータルURLは**根拠を確認できた URL だけ**を登録する。推測で URL を作らない
  （未登録のまま `portalUrls: []` とする）。

## 2. 実装ファイル

| ファイル | 責務 |
| --- | --- |
| `lib/types/surveyPlan.ts` | zod スキーマと型（SurveyPlan / SurveyRegion / SurveyField / SurveyTask） |
| `lib/survey/surveyPlanStore.ts` | `parseSurveyPlan` / `parseSurveyPlanJson`（検証）・`serializeSurveyPlan`・`applySurveyPlanUpdate`（更新）。不正データは `SurveyPlanError` で「ファイル名・要素番号・ID・フィールドパス」を報告 |
| `lib/survey/surveyPlanReport.ts` | `summarizeSurveyPlan`（進捗集計。調査済み領域の割合＝網羅率ではない） |
| `data/survey-plan.json` | 調査計画の本体（初期データは全300タスクが `not_started`） |
| `scripts/survey-plan.ts` | 進捗確認 CLI（確認系・更新系） |
| `scripts/verify-m7c.ts` | 検証スクリプト |

`SupportProgram`（`lib/types/support.ts`）には調査進捗の情報を混在させていない
（調査計画は独立データ）。`data/programs/programs.json`・`registry.ts`・
`getSupportPrograms()`・費用計算・画面表示は無変更。

## 3. CLI の使い方

リポジトリルートで実行（外部通信なし）。

```bash
npx tsx scripts/survey-plan.ts                # 全体サマリ
npx tsx scripts/survey-plan.ts region         # 地域別の調査状況
npx tsx scripts/survey-plan.ts field          # 分野別の調査状況
npx tsx scripts/survey-plan.ts todo           # 未調査の地域・分野一覧
npx tsx scripts/survey-plan.ts recheck        # 再調査が必要な領域
npx tsx scripts/survey-plan.ts progress       # 調査済み領域の割合
npx tsx scripts/survey-plan.ts missing-urls   # 公式ポータルURLが未登録の領域
npx tsx scripts/survey-plan.ts candidates     # 発見した候補数
npx tsx scripts/survey-plan.ts validate       # データの検証のみ
```

更新系（`--file <path>` で対象ファイルを差し替え可能。既定は `data/survey-plan.json`）:

```bash
npx tsx scripts/survey-plan.ts set-status <taskId> <status> [lastSurveyedAt]
npx tsx scripts/survey-plan.ts set-next <taskId> <YYYY-MM-DD または ->
npx tsx scripts/survey-plan.ts add-url <taskId> <url>
npx tsx scripts/survey-plan.ts rm-url <taskId> <url>
npx tsx scripts/survey-plan.ts set-count <taskId> <件数>
```

- 更新は必ず全体を再検証してから、一時ファイル経由（アトミック書込）で保存する。
  不正な値は受け入れず、原因が分かるエラーを表示して exit 1 となる。
- 進捗率表示は「調査済み領域の割合」であり、**制度の網羅率ではない**ことを
  常に明示する（progress コマンド）。

## 4. データの追加・変更手順

- URL の追加・状態の更新・候補数の更新は CLI（上記更新系）を使う。
- 地域・分野・タスクの構成（対象の追加や変更）は `data/survey-plan.json` を直接編集し、
  `npx tsx scripts/survey-plan.ts validate` で検証する。**既存の取得台帳
  （`data/source-ledger.json` 等）や制度データは変更しない。**
- 編集後は `npx tsx scripts/verify-m7c.ts` を実行して整合性を確認する。

## 5. 公式ポータルURLの登録ルール

登録済み URL はすべて `lib/supports/officialPrograms.ts` の RESEARCH_LOG で
取得・照合済み（verified）の公式ページ（根拠のある URL のみ）:

| taskId | 参照URL |
| --- | --- |
| `nation/child-allowance-cash` | こども家庭庁 児童手当（トップ・案内） |
| `nation/higher-education` | JASSO 奨学金 / 文部科学省 高校生等奨学給付金 / 日本政策金融公庫 |

東京都・23区は**確認できる公式URLが現時点で存在しないため未登録**。
`scripts/verify-m7c.ts` は「登録URL ⊆ RESEARCH_LOG の照合済みURL」を検証する
（推測URLの混入を防止）。

## 6. M7-D への接続（設計のみ。発見処理は未実装）

M7-D の候補発見パイプラインは、次の情報を `taskId`（`regionId/fieldId`）と
結び付けて管理する想定:

- 調査タスクID（taskId）・地域ID（regionId）・支援分野ID（fieldId）
- 取得元URL・発見した候補ID・調査日時・発見方法

更新は `lib/survey/surveyPlanStore.ts` の `applySurveyPlanUpdate`（純関数。
更新後に全体を再検証）と、CLI の更新系を使う。候補件数は
`set-candidate-count` / `applySurveyPlanUpdate({type:'set-candidate-count'})` で
記録する（`candidateCount`）。AI による制度抽出・外部通信・クローラー・
取得処理の自動化は M7-C の範囲外（実装しない）。

## 7. 検証

`npx tsx scripts/verify-m7c.ts`（外部通信ガード付き）で以下を確認:

- 25地域・12分野・全組み合わせ300タスク・未調査からの開始
- 公式ポータルURLが根拠（RESEARCH_LOG）のある URL のみで、推測URLが無いこと
- 調査状態・日付・URL の検証と、不正データ時のエラー品質
  （ファイル名・要素番号・ID・フィールドパス）
- 進捗集計（調査済み領域の割合＝網羅率ではないこと）
- 更新処理の安全性（純関数・全体再検証・既存データ非破壊）
- 既存機能との互換性（制度データ・レジストリ・計算・取得台帳が無変更）
