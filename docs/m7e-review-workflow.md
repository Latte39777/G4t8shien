# M7-E: AI発見制度の検証・承認・公開ワークフロー

## 1. 目的

M7-B〜M7-D で実装した制度データ保存（`data/programs/programs.json`）、調査計画
（`data/survey-plan.json`）、制度候補の発見・抽出（`data/discovery/`）を利用し、
**AI が発見した制度候補を、根拠を人間が確認してから承認・公開する**仕組みを提供する。

- AI の発見結果を、根拠を確認しないまま利用可能な制度として公開しない
- 候補の確認・修正・承認・却下を CLI で安全に行えるようにする
- 未検証・検証中の候補を、既存アプリの制度一覧・計算・相談AI に混入させない

## 2. ファイルと役割

| ファイル | 役割 |
| --- | --- |
| `lib/discovery/reviewStore.ts` | 状態遷移・項目単位の根拠確認・監査履歴の純関数（外部通信なし・I/Oなし） |
| `lib/discovery/publish.ts` | 候補→`SupportProgram` 変換・公開ゲート・既存制度マージの純関数 |
| `lib/discovery/reviewCli.ts` | 検証・承認・公開 CLI の実装本体（`DiscoveryFileOps` 経由で保存） |
| `lib/discovery/cli.ts` | コマンド振り分け（M7-D の status/scan/fetch/extract/report/validate に追加） |
| `lib/discovery/discoveryStore.ts` | 候補スキーマに `approved` 状態・`fieldVerifications`・`publication` を追加 |
| `data/discovery/audit-log.json` | 監査履歴（追記型。いつ・誰が・何を・なぜ・変更前後） |
| `scripts/verify-m7e.ts` | 本機能の検証（固定データ・モック・外部通信ゼロ） |

## 3. 候補の状態遷移

既存スキーマとの互換性を優先し、状態名は M7-D の表記を継承する
（仕様の `needs_recheck` は `needs-recheck` として保持。CLI の `--status` では
`needs_recheck` 表記も受け付ける）。

| 状態 | 意味 | 許可される遷移先 |
| --- | --- | --- |
| `unverified` | 未検証（AI 抽出直後） | `needs-recheck` / `approved` / `discarded` |
| `needs-recheck` | 根拠の再確認が必要 | `unverified`（再確認で解消）/ `approved` / `discarded` |
| `approved` | 公開承認済み（人間が根拠確認済み） | `needs-recheck`（検証失効）/ `discarded`（取消） |
| `discarded` | 制度候補として却下 | `unverified`（restore のみ） |

遷移条件と原則:

- **AI 抽出に成功しただけでは `approved` にしない。** 承認には重要項目すべての
  人手根拠確認（`verify-field`）が必要。
- **公式サイトであることを確認しただけでも、金額・期限・適用条件を確認済みに
  しない。** 項目単位の照合記録がなければ承認できない。
- **却下済み（`discarded`）から直接 `approved` には遷移できない。**
  `restore` で `unverified` に戻し、根拠を再確認してから承認する（再承認条件）。
- 同一状態への再遷移（重複承認など）は拒否する。
- 状態変更には候補 ID の厳密一致・操作者（`--by`）・変更理由（`--reason`）が
  必須で、操作日時・変更前後の状態を監査に記録する。
- **本文ハッシュが抽出時と異なる場合**、過去の確認結果は引き継がず、
  `verify` コマンドが `needs-recheck` へ移行する（監査に `recheck-detected` を記録）。

## 4. 根拠の確認（項目単位）

`candidates <candidateId>` の詳細表示で以下を確認できる: 制度名・実施主体・
対象地域・支援種別・根拠となる公式 URL・取得日時・本文ハッシュ（抽出時/現在と
一致/不一致）・根拠抜粋（本文実在の有無つき）・抽出された金額/年齢/世帯/所得/
期限/年度/有効期間・未確認項目・項目ごとの確認記録（失効の区別つき）・現在の
検証状態・要再確認の警告。

`verify-field` による項目単位の確認ルール:

- 確認対象は重要項目 8 ファミリ（`amount` / `eligibility.age` /
  `eligibility.household` / `eligibility.income` / `application.deadline` /
  `regionScope` / `fiscalYear` / `validPeriod`）。
- **根拠抜粋（`--quote`）がページ本文に実在しない場合は確認済みとして扱わない。**
- **本文と抽出値が一致しない場合は確認済みとして扱わない**（確認値は抽出値と
  一致し、数値は根拠抜粋に現れることが必要）。
- ページに記載が無いことを確認する場合は `--value '（記載なし）'`（値が無い
  場合のみ可）。
- 確認記録は `reviewedBy: 'manual'` 固定（AI の自己申告を確認記録にしない）。
- 確認記録は記録時点の本文ハッシュを保持し、ハッシュが変わった記録は失効
  （引き継がない）。失効分は詳細表示で警告する。

## 5. CLI の利用方法

リポジトリルートで実行（いずれも外部通信なし）。

```bash
# 候補一覧 / 詳細 / 状態別一覧
npx tsx scripts/discovery.ts candidates [--status unverified|needs-recheck|approved|discarded]
npx tsx scripts/discovery.ts candidates <candidateId>

# 再取得・再抽出・再確認が必要な候補の識別（read-only）
npx tsx scripts/discovery.ts recheck

# 状態・出典・根拠の検証（ハッシュ変更を要再確認へ反映。監査に記録）
npx tsx scripts/discovery.ts verify

# 項目単位の根拠確認（人手）
npx tsx scripts/discovery.ts verify-field <candidateId> \
  --field <項目> --value <値または'（記載なし）'> --quote <本文抜粋> --by <確認者>

# 状態変更（--by --reason 必須）
npx tsx scripts/discovery.ts request-recheck <candidateId> --by <操作者> --reason <理由>
npx tsx scripts/discovery.ts discard <candidateId> --by <操作者> --reason <理由>
npx tsx scripts/discovery.ts restore <candidateId> --by <操作者> --reason <理由>
npx tsx scripts/discovery.ts approve <candidateId> --by <操作者> --reason <理由>

# 承認済み候補の公開（変換と公開は明示的に分離。approve とは別操作）
npx tsx scripts/discovery.ts publish <candidateId> --by <操作者> --reason <理由> \
  [--update <programId>] [--supersedes <programId>] [--programs <file>]

# 監査履歴
npx tsx scripts/discovery.ts audit [candidateId]
```

- 存在しない候補 ID・不正な状態遷移・壊れた保存物は受け付けない（保存物を
  上書きせず中断）。
- `--programs` で公開先を差し替えられる（既定 `data/programs/programs.json`）。

## 6. 承認から本番制度データへの反映まで

1. `verify-field` で重要項目 8 つを本文と照合（値または「（記載なし）」）。
2. `approve`（状態遷移）。根拠確認が揃っていない候補は拒否し不足項目を報告。
3. `publish`（変換と公開）。公開前に公開ゲートが以下を検証し、不備があれば
   **公開を拒否して不足項目を具体的に報告**する（拒否も監査に記録）。
   - 承認済み・未公開であること（変換しただけで公開しない）
   - `SupportProgram` スキーマに適合する（`normalizeResearchCandidate` で変換）
   - 制度 ID が一意である（既存 ID と衝突したら `--update` の明示を要求）
   - 公式 URL と情報源が記録されている
   - 適用年度が人手確認済みのみ反映される（年度を跨いだ混同を防ぐ）
   - 重要項目に未確認情報が残っていない
   - 給付・減免・貸付・税の区分が明確である
   - 重複制度や年度違いの誤統合がない（同名の既存制度は競合として検出。
     適用年度が異なれば別制度として登録）
   - 未確認項目・検証状態が不適切に格上げされていない
     （受給資格は常に `unconfirmed`、検証状態は `partial`）
4. 公開時の書き込みは **バックアップ → 制度データ → 候補 → 監査** の順。
   書き込み前に保存形式を再検証し、バックアップ失敗・書き込み失敗時は
   中止して既存データを保全する。
5. 既存制度の更新（`--update <programId>`）は `mergeProgramUpdate` が行い、
   **既存の制度 ID・確認済みの根拠（sources / verifiedFields）・適用年度・
   適用期間を無視して上書きしない**（新しい確認は追記・統合）。
6. 旧制度からの切替は `--supersedes <programId>` で追跡情報を残す
   （候補の `publication.supersedesProgramIds` と監査に記録）。

変換（`convertCandidateToProgram`）と公開承認（`approve` + `publish`）は分離され、
AI が作成した候補を変換しただけで公開されることはない。

## 7. 監査履歴の保存

`data/discovery/audit-log.json`（追記型。既存エントリは変更・削除しない）:

- `extracted` — いつ・どの URL から・何を抽出したか（M7-D の extract が記録）
- `field-verified` — どの情報を人間が確認したか（項目・確認値・根拠抜粋・確認者）
- `status-changed` / `approved` / `discarded` / `restored` — 誰が・なぜ・
  変更前後の状態・操作日時
- `published` / `publish-rejected` — いつ公開用データへ反映したか（制度 ID・
  確認済み項目・バックアップ先）／公開拒否の不足項目
- `recheck-detected` — ハッシュ変更等による要再確認の検知

AI 自身の「検証済み」という出力が、人間による確認記録の代わりになる経路は存在しない
（`FieldVerification.reviewedBy` は `'manual'` 固定、監査の actor は操作者名）。

## 8. 作業制限（今回の実装が守ったこと）

- 外部サイトへのアクセス・INIAD API への実リクエストなし（検証は固定データと
  モックのみ。fetch ガードで外部通信ゼロを保証）
- `.env` 変更なし・新規依存パッケージなし
- 既存 UI・費用計算ロジックの変更なし（`getSupportPrograms()` は無変更を検証）
- 既存制度データ（`data/programs/programs.json`）を実験用候補で上書きしない
  （テストは仮想ファイルシステムと `--programs` で分離。実ファイルのハッシュ
  一致を検証）
- 実データの承認・却下は行っていない（実 CLI も読み取りコマンドのみ実行）

## 9. 未対応・制限事項

- **重要項目 8 つすべての確認が承認の必須条件**。ページに記載が無い項目は
  「（記載なし）」の確認が必要（安全側の設計。大量候補の承認には作業量がある）。
- 「（記載なし）」の確認にも本文内の根拠抜粋を要求する（抜粋は「記載が無い
  こと」の直接の引用ではなく、確認対象範囲の特定に使う）。
- `publish` は 1 候補 = 1 制度を想定（1 ページ複数制度は候補が分かれるため対応）。
  既存制度への複数候補の統合更新は `--update` を候補ごとに実行する。
- 候補のフィールド値そのものの編集コマンドは未提供（抽出値の誤りは
  再抽出（`extract` の再実行）または候補の却下で対処）。M7-F 以降で拡張余地。
- 監査の承認拒否は `publish-rejected` のみ記録（`approve` の拒否は画面報告のみ）。
- 東京都・23区の候補は、M7-D の URL ギャップ（シード URL 未登録 298/300 タスク）
  により現状ほとんど発見されない（`scripts/survey-plan.ts add-url` で拡張）。