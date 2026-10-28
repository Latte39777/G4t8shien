# M7-D: 支援制度候補の発見・構造化パイプライン

作成日: 2026-10-27 ／ 範囲: 候補の発見・抽出・保存まで（未検証候補の公開・確定制度データへの登録は行わない）

## 0. 目的と位置づけ

- 子育て世帯が自力では見つけにくい給付金・手当・費用減免・利用料補助などを、
  国・東京都・東京都23区の公式情報から自動的に発見し、構造化して保存する。
- 今回実装するのは「制度候補の発見・抽出・保存」まで。
  **未検証の候補をユーザー向けの確定情報として公開しない。**
  `data/programs/programs.json`（確定制度データ）・制度一覧・給付額集計・条件判定・
  相談AI には一切混入させない（混入経路自体を持たない）。
  確定制度データへの登録（承認フロー）は M7-E。

## 1. ファイルと役割

| ファイル | 役割 |
| --- | --- |
| `lib/discovery/discoveryStore.ts` | 保存物 3 種（候補URL台帳・ページ本文・制度候補）の型・zod スキーマ・検証・serialize/parse・重複排除（sha256 ID）。純関数のみ |
| `lib/discovery/linkScan.ts` | HTML からのリンク抽出・相対 URL 正規化・取得可否の分類（`sourceFetch.evaluateFetchTarget` を再利用）。純関数のみ |
| `lib/discovery/aiExtract.ts` | AI 抽出のプロンプト組み立て・出力検証（zod）・根拠なし値の降格・候補化。INIAD API クライアントは `lib/consult/iniadAdvisor.ts` の `createDefaultIniadClient` を再利用 |
| `lib/discovery/pipeline.ts` | シード収集（調査計画＋RESEARCH_LOG）・候補件数集計・調査計画更新・レポート生成。純関数のみ |
| `lib/discovery/cli.ts` | CLI 本体（status/scan/fetch/extract/report/validate）。ファイル I/O・transport・AI クライアントは注入式（テスト可能） |
| `scripts/discovery.ts` | 実行エントリ（node:fs のアトミック書き込み・実 transport・実 AI クライアントの注入のみ） |
| `scripts/verify-m7d.ts` | 外部通信なしの検証（下記 5 章） |
| `data/discovery/url-candidates.json` | 候補URL台帳（発見した追加調査候補の URL。URL 単位で重複排除） |
| `data/discovery/pages.json` | 取得済みページ本文・ハッシュ・抽出状態 |
| `data/discovery/candidates.json` | 未検証の制度候補（SupportProgram とは別のスキーマ） |

既存からの再利用: `lib/supports/sourceFetch.ts`（HTTPS 必須・SSRF 対策・robots.txt・
サイズ/形式制限・リダイレクト検証・キャッシュ）、`lib/supports/sourceLedger.ts`
（許可ホストの導出）、`lib/supports/sourceStore.ts`（台帳スナップショット復元）、
`lib/survey/surveyPlanStore.ts`（調査計画更新）、`lib/consult/replySchema.ts`
（JSON 抜き出し）、`lib/consult/iniadAdvisor.ts`（確認済み chat.completions クライアント）。
`lib/supports/sourceFetch.ts` への変更は `FetchedPage.hrefs`（リンク href の収集）と
`decodeHtmlEntities` の export 追加のみ（既存の取得結果・検証ロジックは無変更）。

## 2. 公式URLから候補保存までのデータフロー

1. **シード収集**（pipeline.collectSeedUrls）
   `data/survey-plan.json` の `portalUrls` ＋ `RESEARCH_LOG` で根拠を確認できる公式 URL。
   URL 未登録の地域・分野はシードが無く「調査不能」（推測 URL は作らない）。
2. **取得**（scan / fetch、sourceFetch 経由）
   許可ホスト（情報源台帳の official-confirmed）のみ。robots.txt・HTTPS 必須・
   内部ネットワーク禁止・サイズ/形式制限・未許可ホストへのリダイレクト拒否を維持。
   PDF は `unsupported-content-type` として失敗記録（解析済み扱いにしない）。
3. **URL 発見**（linkScan）
   取得ページの `<a href>` を正規化（相対 URL 解決・フラグメント除去）し、
   取得ポリシーを通った URL だけを候補URL台帳に登録（URL 単位で重複排除）。
   未許可ホストのリンクは取得・登録ともしない（件数のみレポート）。
4. **保存**（discoveryStore）
   候補URL台帳（url-candidates.json）とページ本文＋sha256 ハッシュ（pages.json）。
   取得失敗・アクセス拒否・非対応形式は URL 候補の `lastFetch` に理由を残す。
5. **AI 抽出**（extract、aiExtract）
   取得済み本文だけを根拠に制度候補を JSON で抽出 → プログラム側で zod 検証。
6. **正規化**（normalizeExtractedCandidate）
   根拠抜粋（evidenceQuotes）のない金額・所得・年齢・世帯・期限・対象地域・
   適用年度・有効期間は null に降格し、unconfirmedItems に理由を記録。
7. **候補保存**（candidates.json）
   候補ID（重複キーから導出）・調査タスクID・地域/分野・抽出情報・情報源URL・
   情報源台帳ID・取得日時・本文ハッシュ・根拠抜粋・発見方法（ai-extraction）・
   抽出モデル・抽出状態（unverified）・未確認項目・重複キー・再調査理由を記録。
   重複キー = 地域＋実施主体＋制度名＋適用年度＋根拠URL（年度違い・別制度は別候補）。
8. **調査計画更新**
   該当タスクの `candidateCount` のみ更新（`applySurveyPlanUpdate`）。
   **status は変更しない（候補が見つかっただけで surveyed にしない）。**
9. **確認**（status / report / validate）
   取得件数・候補件数・失敗件数・未調査（URL 未登録）領域を表示。
   「調査の実施（取得）」「候補の発見（未検証）」「公式根拠の確認済み（常に 0）」
   「公開可能と判断（常に 0）」を区別して表示する。

## 3. AI が実行する処理とコードが実行する処理

| AI（INIAD API）が行う | コードが行う |
| --- | --- |
| 取得済みページ本文から制度名・概要・実施主体・条件・金額などの記載を読み取り、根拠抜粋とともに JSON で返す | 取得・robots 遵守・リンク正規化・許可判定・重複排除・保存 |
| 記載が無い項目を null / unknownItems にする（指示） | 出力のスキーマ検証（通らない出力は保存しない） |
| | 根拠抜粋のない値の降格と未確認項目の記録 |
| | 候補 ID・重複キー・調査計画更新・件数集計 |

- AI に Web 検索・URL 取得はさせない（Web 検索機能は未確認のため使用しない）。
  AI の一般知識による補完・推測は採用しない。
- 候補の公式 URL は取得元ページ URL をコードが設定する（AI の創作 URL は採用しない）。

## 4. CLI の利用方法

```
npx tsx scripts/discovery.ts status                 # 設定・候補数・未解決事項
npx tsx scripts/discovery.ts scan [--task <taskId>] [--limit <n>] [--live]
npx tsx scripts/discovery.ts fetch [--limit <n>] [--force] [--live]
npx tsx scripts/discovery.ts extract [--task <taskId>] [--retry] [--live]
npx tsx scripts/discovery.ts report                 # 地域・分野別の件数と失敗
npx tsx scripts/discovery.ts validate               # 保存済みデータの検証
```

- **通常実行は dry-run（外部通信なし・保存なし）**。実行するのは表示のみ。
- 外部通信（ページ取得・AI 呼び出し）は `--live` **かつ** 専用環境変数
  `DISCOVERY_LIVE=1` の両方がそろったときのみ。AI 抽出には `INIAD_API_KEY`
  （サーバー側 env のみ。ログには出力しない）がさらに必要。
- 既存の相談機能（`CONSULT_LIVE_AI`）とは独立で、相互に連動しない。
- 上限: `--limit`（既定 scan 10 / fetch 20 / extract 10）。1 ページから登録する
  URL 候補は最大 100 件。リンク探索の深さは 1 ホップ（シードページのリンクのみ）。
- `--data-dir`（既定 `data/discovery`）/ `--plan`（既定 `data/survey-plan.json`）で
  対象を差し替え可能。保存は一時ファイル経由のアトミック書き込み。
- Next.js の画面表示・API アクセス時に外部サイトへアクセスすることはない
  （外部通信の入口はこの CLI の手動実行のみ）。

## 5. 外部通信なしでの検証

`npx tsx scripts/verify-m7d.ts`（ALL CHECKS PASSED / fetch ガードで 0 通信を保証）:

- HTML からのリンク抽出・相対 URL 正規化・フラグメント/メール等の除去・重複排除
- 未許可ホスト・http・URL 内ユーザー情報・localhost・プライベート IP・
  標準外ポート・サブドメインの拒否（既存取得ポリシーの維持）
- 同一 URL・同一候補の重複排除（年度違い・別制度は統合しない）
- ダミー本文 → AI 抽出入力の流れ（偽クライアント。model / messages のみ送信を確認）
- AI 出力: 正常 JSON / コードフェンス / 空配列 / 不正 JSON / 制度名欠落 / 非 JSON
- 根拠抜粋なしの金額・条件・期限・対象地域・年度を確定扱いにしない
- 未検証候補が本番制度データへ流入しない（`getSupportPrograms()` が移行前
  スナップショットと完全一致・保護ファイルのハッシュ一致）
- 調査計画の候補件数更新（status を変更しない）
- 重複登録・取得失敗・抽出失敗からの復旧（--retry）
- dry-run で外部通信・保存が発生しない（transport/AI 経路の未使用を検証）
- 壊れた保存物を上書きせず中断
- 実 CLI（status / report / validate / scan dry-run）の実行

## 6. 未対応の形式・取得制約

- **PDF は未対応**（抽出ライブラリが無いため。`unsupported-content-type` として
  失敗記録し、解析済みとして扱わない）。HTML（text/html, application/xhtml+xml）のみ。
- JavaScript による動的レンダリングは実行しない（HTML ソースのみが対象）。
- robots.txt が取得できない場合は安全側に倒して取得中止（sourceFetch の既定）。
- 本文は 500KB 上限・保存は 20 万文字まで（超過は切り詰めを明示）。
- リンク探索は 1 ホップ。許可ホスト以外は追わない（同一ドメイン内を優先）。
- 取得 URL 数・回数は `--limit` で制限（無制限の巡回はしない）。

## 7. URL 未登録により探索できない地域・分野

- 現在シード URL があるのは、RESEARCH_LOG で根拠を確認済みの URL の範囲
  （こども家庭庁・文科省・日本政策金融公庫・日本学生支援機構の一部ページ）＝
  国の一部分野のみ。
- **東京都・東京都23区は公式ポータル URL が未登録のため、現状では調査不能**
  （300 タスクのうち 298 が URL 未登録）。23区の制度を網羅できたわけではない。
- URL 未登録の領域は CLI が「調査不能」として明示する。推測 URL は作らない。
  探索範囲の拡大は、URL の根拠を確認して `scripts/survey-plan.ts add-url` で
  調査計画に追加すればよい（シードとして自動的に使われる）。
  リンク探索で見つかった URL も、公式確認済みホストに属するものだけ取得する。

## 8. INIAD API について確認できた仕様と未確認事項

確認済み（docs/consult-m6e-design.md の記録に依拠。本実装はこの範囲のみ使用）:

- Base URL: https://api.openai.iniad.org/api/v1
- 認証: API キー（INIAD_API_KEY。サーバー側 env のみ）
- `chat.completions.create({ model, messages })` が利用可能（model は gpt-5.4 既定）

未確認（使用しない）: web_search / ツール呼び出し / structured outputs /
Responses API / 任意パラメータ / レート上限 / 料金 / データ保持 /
学外サービスでの利用可否。JSON 出力はプロンプトで要求し zod 検証する方式
（相談機能と同じ方針）。**実際の AI API 呼び出しは本タスクでは実行していない。**

## 9. M7-E で必要となる検証・公開フロー

1. 候補（`data/discovery/candidates.json`）の内容を人手で公式資料と照合する
   （根拠抜粋・取得日時・本文ハッシュの変更検知を確認）。
2. 照合できた項目を `sourceLedger` の人手照合記録（recordManualContentReview）や
   `SupportProgram` の `verification.verifiedFields` として記録する。
3. `research.ts` の `normalizeResearchCandidate`＋`evidence.ts` で確定制度データ形式に
   正規化し、`data/programs/programs.json` へ承認フローを経て追加する
   （候補を直接 SupportProgram として扱わない）。
4. 公開可否の判断（unverified → 承認済み）と、制度一覧・計算・相談AI への反映は
   M7-E の承認フローで行い、未検証候補は常に非公開のまま扱う。
5. 候補の needs-recheck / discarded（重複・誤検出）の運用と、再調査理由の記録。
