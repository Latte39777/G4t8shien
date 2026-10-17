# M6-F 設計：公式情報の取得・検証とナレッジベースの構築

M6-A〜M6-E の実装（モック表示・公式調査記録・出典検証・INIAD 接続準備）を引き継ぎ、
公式情報の「取得」から「検証済みナレッジベース」までを整備する。

【スコープの明確化】今回の実装は「公式情報の取得とナレッジベースの整備」まで。
ライブ AI API への実リクエスト・API キーの設定・ライブ AI の有効化は行わない。
外部通信を発生する処理は `scripts/retrieve-official-sources.ts` の手動実行のみで、
通常のアプリ実行・テストは一切外部通信しない。

## 1. モジュール構成（責務分離）

| モジュール | 責務 | 外部通信 |
| --- | --- | --- |
| `lib/supports/sourceFetch.ts` | 公式ページの限定取得エンジン（許可リスト・SSRF 対策・robots・キャッシュ・取得記録） | transport 注入型（実通信は注入時のみ） |
| `lib/supports/sourceLedger.ts` | URL 台帳（登録・到達・公式確認・取得・照合の状態管理と provenance。純関数） | なし |
| `lib/supports/sourceStore.ts` | 台帳・取得ログの永続化（serialize/parse/restore の純関数。ファイル I/O はスクリプト側） | なし |
| `lib/supports/kb.ts` | ナレッジベース（制度情報の構造化・確度・出典対応・provenance・更新履歴・AI 供給整形） | なし |
| `lib/consult/officialSource.ts` | AI 相談側の接続点（`createKbOfficialSourceClient`。KB のみ参照） | なし |
| `scripts/retrieve-official-sources.ts` | 手動取得・人手照合記録ランナー（`--dry-run` / `--register` / `--url` / `--record-review`）。URL 候補の台帳登録（明示許可済みのみ）、取得結果を `data/source-retrievals.json`、台帳状態を `data/source-ledger.json` に保存・復元 | あり（明示実行時のみ） |
| `scripts/verify-m6f.tsx` | 検証（偽 transport 注入・固定レスポンス。外部通信ゼロ） | なし |

既存の安全策（モック表示の維持・未確認データの扱い・API キー秘匿・レート制限）は
変更しない。Web 全体の自動巡回クローラーは作らない（URL 台帳に登録されたページのみ
対象で、実行タイミングは手動取得ランナーの実行時のみ）。

## 2. 公式情報の取得フロー

```
URL 候補を台帳に登録（registerUrlCandidate）
→ 取得許可判定（HTTPS・許可ホスト・内部ネットワーク禁止）
→ robots.txt 確認（不可なら中止）
→ ページ本文の取得（リダイレクト手動追跡・再検証・タイムアウト/サイズ/形式制限）
→ HTML から制度情報の抽出に使える本文を整理（script 等は除去のみ・実行しない）
→ 取得記録（URL・タイトル・取得日時・結果/失敗理由）を記録
→ 台帳に反映（markUrlReachable / markContentRetrieved。内容は「要確認」のまま）
→ 台帳スナップショットに保存（data/source-ledger.json。次回起動時に復元）
→ 人手で制度内容を照合（--record-review = recordManualContentReview）して初めて「確認済み」
→ ナレッジベース登録（buildKnowledgeBase。provenance 付きで転記と実績を区別）
→ 検証済み情報を AI へ提供（buildKbAiContext）
→ AI が根拠付きで説明（将来）／支援額計算は既存プログラム
```

- 失敗時は理由（timeout / not-allowlisted / robots-disallowed / too-large /
  unsupported-content-type / invalid-content / http-error 等）を記録し、
  未確認状態を維持する。AI の知識で不足情報を補完しない。
- **PDF の取得・本文抽出は未対応**（PDF 抽出ライブラリがプロジェクトに無く、
  安全に扱える既存実装もないため）。`application/pdf` は
  `unsupported-content-type` として失敗記録し、無理に対応したことにしない。
  将来対応する場合はサンドボックス付き抽出ライブラリの導入評価が必要。

## 3. 取得先の安全性（SSRF・悪意ある応答対策）

- HTTPS 必須（http は拒否）。URL 内のユーザー情報（user:pass@）は拒否。
- 許可ホストは「実際に公式性を確認した URL」（M6-C 調査ログ）から導出する
  ホスト名の完全一致リスト。サブドメインの推測許可・未確認ドメインの推測登録はしない。
- localhost・プライベート IP（10/8・172.16/12・192.168/16・169.254/16 等）・
  IPv6 リテラル・`.local`/`.internal` 等の内部ネットワーク宛を禁止。
- リダイレクトは `redirect: 'manual'` で手動追跡し、遷移先ごとに再検証
  （上限 3 回。超過・許可外先は中止）。
- 接続タイムアウト（既定 10 秒）・本文サイズ上限（既定 500KB）・
  許可コンテンツ形式（text/html・application/xhtml+xml のみ）。
- JavaScript・埋め込みコードは実行しない（script/style/iframe 等は除去のみ）。
- robots.txt を必ず確認し、Disallow 対象は取得しない。robots.txt が確認できない
  場合は安全側に倒して取得中止。サイトの利用条件は台帳の `terms` に人手確認欄を設け、
  未確認のままで自動取得を常時実行しない（手動実行・間隔管理）。
- 取得対象・実行タイミングは台帳の `retrievalPolicy`（再取得目安日数・手動実行のみ）で管理。

## 4. URL の確認と制度内容の確認の分離（状態モデル）

台帳（`lib/supports/sourceLedger.ts`）で以下を別々に管理する。

| # | 状態 | フィールド | 更新できる処理 |
| --- | --- | --- | --- |
| 1 | URL 候補として登録済み | `registeredAt`（urlState: candidate-registered） | registerUrlCandidate |
| 2 | URL にアクセスできた | `reachableAt`（urlState: reachable） | markUrlReachable（取得処理） |
| 3 | 公式の情報源と確認済み | `officialConfirmedAt`（urlState: official-confirmed） | markOfficialConfirmed（人手確認のみ） |
| 4 | ページ本文を取得済み | `contentRetrievedAt`（機械的な取得日時） | markContentRetrieved（成功時） |
| 5 | 制度内容の確認が必要 | `contentState: 'needs-review'` | markContentRetrieved（成功時。照合済みにしない） |
| 6 | 人手で制度内容を照合済み | `contentState: 'reviewed'` + `review.reviewedAt/reviewedFields` | recordManualContentReview（reviewer は 'manual' 固定） |

- URL にアクセスできたこと（2・4）だけで、金額・法令名を確認済み（6）にしない。
  確認済み項目は `review.reviewedFields` に照合できた項目のみ列挙する。
- AI の自己申告で確認済みにする処理は存在しない（recordManualContentReview は
  reviewer が 'manual' 以外をエラーとする）。
- 取得日時（contentRetrievedAt）と人手確認日時（review.reviewedAt）は別に保持。
  ページ再取得後は照合済み項目を残しつつ `isReviewOutdated` で「要再確認」と判定する
  （再取得しただけで金額・条件が再確認済みにならない）。
  reviewedAt は日付粒度（YYYY-MM-DD）のため、照合はその日（+09:00 の一日）の終端までに
  実施されたものとして扱い、同日中の「取得→人手照合」を要再確認にしない。照合日より
  後の日付の再取得で要再確認になる（同日中に照合より後に再取得があった場合は日付粒度
  では判別できないため、運用は取得→照合の順で記録する）。
- 各状態には **provenance（実績の由来）** を保持する。`research-log-transcribed`
  （M6-C 調査ログからの転記）と `fetch-run` / `user-registered` / `manual-review`
  （実運用での取得・登録・人手照合の実績）を区別し、転記を実績として扱わない。

## 5. ナレッジベースの保存形式

過剰なインフラ（DB 等）は導入しない。既存レジストリ（`lib/supports/registry.ts`）と
整合するローカルの構造化データとして、`lib/supports/kb.ts` の zod スキーマで型・
整合性を検証するコード内データ（取得記録は `data/source-retrievals.json`、
台帳状態は `data/source-ledger.json`）。

### 5.1 永続化と復元（data/source-ledger.json）

- 台帳の状態（到達・取得・照合・provenance）は取得ランナーが
  `data/source-ledger.json`（台帳スナップショット）に保存し、次回起動時に
  `lib/supports/sourceStore.ts` で復元する（プロセス終了後も保持）。
- 復元マージ規則: **識別情報（URL・名称・組織・対象制度・登録メモ・取得ポリシー）は
  コード側の最新定義を優先、状態（実績）はディスク側の記録を優先**。
  コード側に無い URL（実行時登録）は保存分をそのまま追加する。
- 読み込んだ JSON が壊れている・バージョン不一致の場合は上書きせず中断する
  （例外ではなく StoreResult で失敗を返し、保存物を保全する）。
- 人手照合記録は `--record-review <URL> --fields <項目,...>`
  （recordManualContentReview・reviewer は 'manual' 固定）で記録し、同スナップショットに
  保存する。AI の自己申告で照合済みにする経路は持たない。
- **管理方針（確定）**: `data/source-ledger.json` と `data/source-retrievals.json` は
  いずれも Git 管理（コミット対象）とする。台帳には人手照合の成果が唯一の形で保存される
  ため紛失させず、取得ログは実取得の監査証跡として履歴を残す。機微情報・個人情報は
  含まない（確認済み）。追記ノイズが大きくなった時点で取得ログのみ ignore への移行を
  検討する。

### 5.2 provenance（実績の由来。転記と実績の混同防止）

- 台帳（`LedgerProvenance`）: `registered`（research-log-transcribed /
  user-registered）・`retrieval`（research-log-transcribed / fetch-run / null）・
  `review`（research-log-transcribed / manual-review / null）。
- KB（`KbSourceView.provenance`）は台帳の provenance を引き継ぎ、
  `KbField.provenance` は項目の確度の根拠（照合）の由来
  （research-log-transcribed / manual-review / mixed / none）を示す。
- `buildKbAiContext` は出典に「調査ログ転記の取得・照合」か
  「実取得・人手照合」かを明示し、更新履歴（revisions.by）も provenance 由来とする。

各制度（`KbProgramEntry`）:

- `programId`（既存レジストリの制度 ID と一致）・`name`・`category`・`level`
- `jurisdiction`（実施主体・対象地域。不明は推測しない）
- `fields[]`: フィールドパス・ラベル・値（未確認は null）・金額単位・適用年度・
  確度（confirmed / estimated / unconfirmed）・出典 sourceIds・引用 excerpt・注記
- `sources[]`: タイトル・URL・組織・urlState（URL 検証）と contentState（内容確認）・
  取得日時 retrievedAt・確認日時 reviewedAt・照合済み項目・取得結果・引用
- `unconfirmedItems[]`: 未確認項目と理由
- `wardBinding`: 対象区が確認できたデータだけを当該区に紐づける（現時点は空。
  こども医療費助成は「東京都全体で共通の制度」として扱わない）
- `revisions[]`: 更新履歴（registration / retrieval / review / update の前後追跡）

情報源の本文の丸ごと保存はしない。制度の判断根拠に必要な構造化データ・出典情報・
必要最小限の引用（excerpt）のみを保持する。

## 6. 最初に扱う制度と、取得できた情報／未確認の情報

M6-C 調査ログと URL 台帳の 5 公式 URL を起点に整理（自動巡回なし）。

| 制度 | 情報源 | 確認済み（confirmed） | 未確認（unconfirmed / estimated） |
| --- | --- | --- | --- |
| 児童手当 | こども家庭庁 2 ページ | 制度名・概要・対象年齢/期間・金額内訳（3歳未満15,000円/月・3歳〜小3修了前10,000円/月・第3子以降30,000円/月・中学生10,000円/月）・申請先・申請期限文・添付書類・手続き・対象地域 | 計算用の単一金額・適用年度・所得制限・根拠法令・受給資格 |
| 高校生等奨学給付金 | 文部科学省 | 制度名・概要（返還不要・授業料以外）・申請先・条件注記・対象地域 | 金額・適用年度・所得基準の具体額・根拠法令・受給資格（対象年齢は estimated） |
| 教育一般貸付（国の教育ローン） | 日本政策金融公庫 | 概要・申請先 | 正式名称・金額・適用期間・根拠法令・受給資格 |
| JASSO 給付奨学金・貸与奨学金 | 日本学生支援機構 | 制度名・概要・条件注記（家計区分・返還要否） | 金額・所得基準・期間・申請経路の詳細・受給資格 |
| こども医療費助成 | （公式 URL 未取得） | なし（全項目未確認） | 全項目。モック表示を維持。対象区が確認できたデータのみ当該区に紐づける（現在は該当なし） |

現時点で取得できない情報は既存のモック表示・未確認表示を維持する。

【未対応の報告】PDF ページのみの公式資料は取得・本文抽出とも未対応（上記 2 の通り）。

## 7. キャッシュ・更新・障害対応

- 同一 URL はキャッシュ（TTL 既定 24 時間）内で再利用し、`fromCache: true` を返す。
  `record.retrievedAt` は元の取得日時のまま（再取得していないのに更新しない）。
- `needsRefresh(url)` で「未取得・取得失敗・TTL 超過」を再取得対象と判別。
  `--force` で強制再取得。
- タイムアウト・取得失敗・不正応答は失敗コードと理由を記録し、未確認状態を維持。
  更新失敗時に以前の確認済みデータ（照合済み項目・成功取得記録）を上書きしない
  （markContentRetrieved の失敗分岐・getLastSuccess）。

## 8. AI との接続点（今回は実 API 呼び出しなし）

将来のフロー:
公式URL取得 → ページ本文の整理 → 出典と情報の検証 → ナレッジベース登録 →
検証済み情報を AI へ提供 → AI が根拠付きで説明 → プログラムが対象条件・支援額を計算

- `buildKbAiContext` は confirmed の項目のみを出典付きで提供し、未確認項目は
  「確認できる公式情報がありません」「条件の確認が必要です」として分離する。
- AI の学習知識だけで最新の支給額・法令・申請期限を確定しない（amountCalculationPolicy）。
  支援額の計算は `lib/finance/supports.ts` 等の既存プログラムが行い、AI に金額を
  自由生成させて計算結果として採用しない。
- `createKbOfficialSourceClient`（`lib/consult/officialSource.ts`）は KB のみを参照し、
  実行時のネットワークアクセスを行わない。検索（search）と取得（fetchSource）は
  別機能のまま（検索ヒット＝取得済みではない）。

## 9. テストと外部通信

- 取得処理は transport（fetch 相当）を注入でき、テストは偽クライアント・固定
  レスポンスのみ使用（`scripts/verify-m6f.tsx`）。globalThis.fetch をガードし、
  検証中の外部通信が 0 回であることを確認する。
- 検証内容: 許可 URL の取得／未許可ホスト・内部ネットワーク・非 HTTPS の拒否／
  リダイレクト先の再検証／タイムアウト・サイズ超過・不正本文・PDF 偽装の処理／
  robots.txt 遵守（サイズ制限・同長 Allow 優先を含む）／キャッシュと再取得判別／
  URL 検証と内容検証の分離／未確認の金額・法令名が確認済みにならない／
  更新失敗時の上書き防止／KB とレジストリ整合・区単位の分離／AI 供給の分離／
  台帳・取得ログの永続化と復元（ファイル往復・壊れた JSON の保全）／
  provenance の区別（転記・実取得・人手照合）／urlVerified と照合の鮮度
  （reviewOutdated では urlVerified にしない）／項目対応の厳格化と項目の網羅／
  既存機能の回帰。
- 既存 M1〜M6-E のテスト（`scripts/verify-m*.tsx`）・型チェック・Lint・ビルドも実行する。

## 10. ライブ AI 接続前に残る課題

1. PDF 公式資料の取得・本文抽出（ライブラリ選定とサンドボックス設計が必要）
2. 未確認項目の解消（所得制限・適用年度・根拠法令・金額（計算用単一値）・受給資格）
3. こども医療費助成の区別データの収集（対象区ごとの年齢・所得条件・自己負担）と
   区単位の紐づけ（wardBinding）の実データ化
4. サイト利用条件の人手確認（台帳 terms）と、再取得間隔の運用ルール整備
5. ~~取得・照合結果の台帳への永続化フロー~~（対応済み: 台帳スナップショット
   `data/source-ledger.json` に保存・復元し、人手照合記録は `--record-review` で
   記録する。残件は運用開始時の初回の取得・人手照合の実施と手順の周知）
6. INIAD API（互換 Chat Completions）の実通信確認（M6-E の未確認事項:
   モデル名・structured outputs・レート制限の実値・料金・学外公開可否）
7. 検証済み情報のみを AI へ渡す運用（無回答時のフォールバック文言の最終確認）


