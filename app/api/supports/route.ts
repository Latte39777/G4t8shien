/**
 * GET /api/supports — 公的支援制度のモックデータを返す（M2）
 *
 * - M5 まではモックのみ。外部API・APIキーは一切使用しない。
 * - Live AI（M6）は別途承認まで実装・有効化しない。
 * - レスポンスは必ず zod（supportProgramSchema）で検証してから返す。
 */
import { z } from 'zod'
import { supportProgramSchema } from '../../../lib/types/support'
import {
  MOCK_DISCLAIMER,
  MOCK_SUPPORT_PROGRAMS,
} from '../../../lib/supports/mockPrograms'

export async function GET() {
  const parsed = z.array(supportProgramSchema).safeParse(MOCK_SUPPORT_PROGRAMS)
  if (!parsed.success) {
    return Response.json(
      {
        mock: true,
        error: 'mock support data failed schema validation',
        issues: parsed.error.issues,
      },
      { status: 500 },
    )
  }
  return Response.json({
    mock: true,
    disclaimer: MOCK_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    programs: parsed.data,
  })
}