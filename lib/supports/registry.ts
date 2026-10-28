/**
 * 支援制度レジストリ（M6-C / M7-B）— 制度データ保存基盤からの提供
 *
 * 責務:
 * - 制度データの供給元は data/programs/programs.json（制度データ保存基盤、
 *   M7-B）。lib/supports/programStore.ts 経由で検証済みの SupportProgram[] を
 *   提供する（型・ID・金額・検証状態は保存データそのまま。推測で補完しない）
 * - 確認済み制度と未確認モック制度は、program.mock / program.verification で
 *   常に区別できる（画面上でもバッジで区別する）
 * - 制度の追加・更新は JSON の編集のみで完結する（TypeScript ファイルの編集に
 *   依存しない）。検証状態を勝手に格上げしないこと
 *
 * 【外部通信なし】fetch や AI API は行わない（公式照合の結果は情報源台帳
 * lib/supports/sourceLedger.ts 側が保持し、制度データは sources[].sourceRecordId
 * で紐付け口を持つ）。
 *
 * ※ M6-C までの「モック＋公式確認済みデータのマージ」は M7-B の移行で完了し、
 *   統合結果が data/programs/programs.json に保存されている。移行前のデータは
 *   scripts/fixtures/m7b-pre-migration.json（テスト用スナップショット）に記録。
 */
import type { SupportProgram } from '../types/support'
import { MOCK_DISCLAIMER } from './mockPrograms'
import { getProgramStore } from './programStore'

/**
 * レジストリ全体の免責（確認済み・未確認が混在することを明示する）。
 * API は既存契約の維持のため disclaimer に MOCK_DISCLAIMER を返し、
 * この混在用の注記は verificationNote として返す。
 */
export const REGISTRY_DISCLAIMER =
  'この制度情報には、公式ページと照合済みの情報（確認日を明記）と、未確認のモック・仮データが含まれます。確認済み・未確認の区別は各制度カードのバッジと要確認項目をご確認ください。金額・受給資格は確定情報ではなく、実際の申請は自治体・公式窓口で確認してください。'

/**
 * 制度データ保存基盤（data/programs/programs.json）の制度一覧を返す。
 *
 * - 各制度は supportProgramSchema で検証済み（不正データは ProgramStoreError）
 * - 未確認の項目は「未確認」表現のまま返す（推測で補完しない）
 * - 返り値の配列は呼び出し元が並べ替えてもキャッシュに影響しない
 */
export function getSupportPrograms(): SupportProgram[] {
  return [...getProgramStore()]
}

/** まだモック（未確認）のまま残っている制度 ID（未確認＝確認が済んでいない制度） */
export function remainingMockProgramIds(): string[] {
  return getSupportPrograms()
    .filter((p) => p.mock)
    .map((p) => p.id)
}

/** 免責文言（未確認モックが残っている場合はモックの免責も併記する） */
export function registryDisclaimer(): string {
  const hasMock = getSupportPrograms().some((p) => p.mock)
  return hasMock ? `${REGISTRY_DISCLAIMER}（${MOCK_DISCLAIMER}）` : REGISTRY_DISCLAIMER
}
