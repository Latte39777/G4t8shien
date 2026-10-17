/**
 * 支援制度レジストリ（M6-C）— モックと公式確認済みデータの段階的な統合
 *
 * 責務:
 * - 公式情報を確認できた制度から順に、確認済みデータでモックを更新する
 *   （同一 ID で置き換え。一度にモックを全削除しない）
 * - 未確認の制度は既存のモックデータ（mockPrograms.ts）のまま提供する
 *   （安全なモック表示を維持）
 * - 確認済み制度と未確認モック制度は、program.mock / program.verification で
 *   常に区別できる（画面上でもバッジで区別する）
 *
 * 【外部通信なし】fetch や AI API は行わない（公式照合の結果は
 * lib/supports/officialPrograms.ts の調査ログとして保持する）。
 */
import { z } from 'zod'
import { supportProgramSchema, type SupportProgram } from '../types/support'
import {
  MOCK_SUPPORT_PROGRAMS,
  MOCK_DISCLAIMER,
} from './mockPrograms'
import { buildOfficialPrograms } from './officialPrograms'

/**
 * レジストリ全体の免責（確認済み・未確認が混在することを明示する）。
 * API は既存契約の維持のため disclaimer に MOCK_DISCLAIMER を返し、
 * この混在用の注記は verificationNote として返す。
 */
export const REGISTRY_DISCLAIMER =
  'この制度情報には、公式ページと照合済みの情報（確認日を明記）と、未確認のモック・仮データが含まれます。確認済み・未確認の区別は各制度カードのバッジと要確認項目をご確認ください。金額・受給資格は確定情報ではなく、実際の申請は自治体・公式窓口で確認してください。'

/**
 * 確認済みデータと未確認モックを統合した制度一覧を返す（純関数）。
 *
 * - 公式調査データがある ID の制度は、確認済みデータで更新する
 *   （未確認の項目は公式側の「未確認」表現のまま残す＝推測で補完しない）
 * - 公式調査データが無い ID のモックはそのまま残す
 * - 新規の確認済み制度（モックに対応しない ID）は末尾に追加する
 * - 全件を supportProgramSchema で検証してから返す
 */
export function getSupportPrograms(): SupportProgram[] {
  const officialPrograms = buildOfficialPrograms()
  const officialById = new Map(officialPrograms.map((p) => [p.id, p]))
  const merged: SupportProgram[] = []
  const consumedIds = new Set<string>()
  for (const mock of MOCK_SUPPORT_PROGRAMS) {
    const updated = officialById.get(mock.id)
    if (updated !== undefined) {
      merged.push(updated)
      consumedIds.add(mock.id)
    } else {
      merged.push(mock)
    }
  }
  for (const program of officialPrograms) {
    if (!consumedIds.has(program.id)) merged.push(program)
  }
  const parsed = z.array(supportProgramSchema).safeParse(merged)
  if (!parsed.success) {
    throw new Error(
      `支援制度レジストリの検証に失敗しました: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(' / ')}`,
    )
  }
  return parsed.data
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
