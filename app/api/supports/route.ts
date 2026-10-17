/**
 * GET /api/supports — 公的支援制度データを返す（M2 / M6-C）
 *
 * - M6-C: 公式情報を確認できた制度から段階的に反映したレジストリ
 *   （lib/supports/registry.ts）を返す。未確認のモック制度も残す。
 * - 外部API・APIキーは一切使用しない。Live AI（M6）は別途承認まで実装・有効化しない。
 * - レスポンスは必ず zod（supportProgramSchema）で検証してから返す。
 */
import { z } from 'zod'
import { supportProgramSchema } from '../../../lib/types/support'
import { MOCK_DISCLAIMER } from '../../../lib/supports/mockPrograms'
import {
  getSupportPrograms,
  registryDisclaimer,
} from '../../../lib/supports/registry'

export async function GET() {
  const programs = getSupportPrograms()
  const parsed = z.array(supportProgramSchema).safeParse(programs)
  if (!parsed.success) {
    return Response.json(
      {
        mock: true,
        error: 'support data failed schema validation',
        issues: parsed.error.issues,
      },
      { status: 500 },
    )
  }
  const hasMock = parsed.data.some((p) => p.mock)
  return Response.json({
    /** 未確認のモック・仮データを含む場合は true（確認済みのみなら false） */
    mock: hasMock,
    /** 既存契約の免責文言（未確認モックが残る場合はモックの免責を維持） */
    disclaimer: hasMock ? MOCK_DISCLAIMER : registryDisclaimer(),
    /** 確認済み・未確認が混在することの注記（M6-C） */
    verificationNote: registryDisclaimer(),
    generatedAt: new Date().toISOString(),
    /** 公式出典で確認済みの制度数（確認済み・未確認の区別用） */
    verifiedProgramCount: parsed.data.filter((p) => !p.mock).length,
    programs: parsed.data,
  })
}