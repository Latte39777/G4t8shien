# M7-B 制度データ保存基盤（Program Store）

支援制度（国/東京都/23区）のデータを JSON で保存・検証・提供する土台。
AI による制度発見（M7-D 以降）は本基盤に候補を保存するが、本作業では
発見・外部通信・自動登録は実装しない。

## 1. 構成

| ファイル | 役割 |
| --- | --- |
| `data/programs/programs.json` | **本番の制度データ**（唯一の供給元） |
| `lib/supports/programStore.ts` | 読み込み・検証・エラー報告（純関数 + キャッシュ） |
| `lib/supports/registry.ts` | `getSupportPrograms()` がストアから `SupportProgram[]` を提供 |
| `scripts/fixtures/m7b-pre-migration.json` | 移行前データの**テスト用スナップショット**（変更検知の基準） |
| `scripts/verify-m7b.ts` | 移行一致・重要値・エラー品質・互換性の検証 |

`lib/supports/mockPrograms.ts` / `officialPrograms.ts`（TypeScript フィクスチャ）は
移行前のデータ源。現在はテスト・`sourceLedger.ts` の RESEARCH_LOG・
`kb.ts`（相談AI 知識、M7-G でストア参照へ移行予定）からのみ参照し、
レジストリの供給元ではない。

## 2. 保存形式

`data/programs/programs.json`（エンベロープ形式）:

```json
{
  "formatVersion": 1,
  "programs": [ { "id": "...", "name": "...", ... } ]
}
```

- `programs` の各要素は `supportProgramSchema`（`lib/types/support.ts`）の
  型 `SupportProgram` そのまま。フィールド説明は同ファイルの JSDoc を参照。
- `formatVersion` は保存形式のバージョン。未対応の値は読み込みを拒否する。
- 制度の根拠（`sources[]`）は制度レコード内に `SupportSource` として保持する。
  `sources[].sourceRecordId` が情報源台帳側の記録との**紐付け口**（M7-D で運用）。
  ただし台帳（`data/source-ledger.json` 等）と制度本体は常に別のデータであり、
  台帳のエントリをそのまま制度として登録してはならない。

## 3. 制度の追加・更新方法

1. `data/programs/programs.json` の `programs` 配列にオブジェクトを追加、
   または既存オブジェクトを編集する（**JSON の編集のみ。TypeScript の編集は不要**）。
2. 検証を実行する: `npx tsx scripts/verify-m7b.ts`
3. 意図した変更の場合は、テスト用スナップショット
   `scripts/fixtures/m7b-pre-migration.json` も同じ内容に更新する
   （意図しない値の変更・検証状態の格上げを防ぐガード。更新を忘れると検証が失敗する）。
4. **現時点の制約**: 相談AI 知識（`lib/supports/kb.ts`）はまだフィクスチャ
   （`mockPrograms.ts` / `officialPrograms.ts`）から生成される。制度データを
   変更した場合はフィクスチャ側も同じ値に同期すること（同期のずれは
   verify-m7b の「フィクスチャとストアの同期」で検出される）。この制約は
   M7-G（KB をストア参照へ移行）で解消する。
5. `npx tsc --noEmit` と `npm run build` を実行する。

## 4. 不正データの検出とエラー報告

`parseProgramStore()` / `parseProgramStoreJson()`（純関数）が検証し、
問題があれば `ProgramStoreError` を投げる。メッセージには
**ファイル名・要素番号・制度 ID・フィールドパス**が含まれる:

```
data/programs/programs.json の制度データに問題があります:
- programs[0]（id: "mock-child-allowance"）.amount.value: Invalid input: expected number, received string
- programs[1]（id: "x"）: id が重複しています（programs[0] と同一）
```

検出する問題: JSON 構文エラー / 未対応の formatVersion / programs が配列でない /
`supportProgramSchema` 不一致 / 制度 ID の重複。
アプリ実行時は `getProgramStore()` の初回呼び出しで検証され、不正なら
上記エラーで失敗する（無視して古い値を表示することはない）。

## 5. 既存機能との互換性（検証済み）

- `getSupportPrograms()` の契約（戻り値 `SupportProgram[]`・6件・ID と並び順）は
  移行前と完全一致。`components/Form.tsx`（利用中制度の選択）・
  `components/Result.tsx`・`components/SupportList.tsx` は変更なしで動作する。
- `lib/finance/supports.ts` の計算結果は移行前と完全一致
  （verify-m7b のシミュレーション結果比較で確認）。
- `/api/supports`・`registryDisclaimer()`・`remainingMockProgramIds()` は変更なし。
- 相談AI 知識（`buildKnowledgeBase()`）は 6 件を生成し ID 集合はストアと一致。

## 6. 実装上の制約

- **クライアント/サーバー境界**: `app/page.tsx` と全コンポーネントは
  クライアントコンポーネントのため、`getSupportPrograms()` はバンドル内
  データを同期的に返す必要がある。`programStore.ts` は `node:fs` を使わず、
  ビルド時にバンドルされる静的 JSON インポートで読む（Next.js の
  サーバー/クライアント境界に反しない）。ファイルから読むスクリプトは
  `parseProgramStoreJson(text, file)` に渡す。
- **テストと本番の分離**: 本番データは `data/programs/programs.json` のみ。
  テストは `parseProgramStore()` に任意のフィクスチャを渡せる
  （ストアを汚さない）。検証用スナップショットは `scripts/fixtures/` 配下。
- **検証状態は勝手に変更しない**: `mock` / `verification` / `unconfirmedItems`
  / `missingInformation` は保存データのまま提供する。未確認項目を確認済みに
  格上げする更新は、根拠（情報源台帳への記録）と人手の確認を伴う別作業とする。
- **ID ルール**: 制度 ID は一意で不変。既存 6 件の ID は変更しない（重複は
  エラー）。ID は UI・計算・KB の参照キー。

## 7. M7-D への引き継ぎ事項

- 発見候補の保存領域（例: `data/programs/candidates/`）と、候補 → 公開可能
  （publishable）へのライフサイクル管理（`lifecycleState`）は M7-D/E の対象。
  本基盤の `parseProgramStore(raw, fileLabel)` はファイル単位のエラー報告に
  対応済みで、候補ファイル 1 件ずつの検証にそのまま再利用できる。
- 制度と情報源台帳の正式な紐付け（`sources[].sourceRecordId` の運用、
  台帳からの根拠更新）は M7-D で実装する。
- 制度数が増えた場合のファイル分割（1 制度 1 ファイル + ビルド時集約）も
  同じ `parseProgramStore` ベースで拡張可能。現状は 1 ファイル集約で十分
  （追加・更新が TypeScript に依存しない要件は満たす）。
