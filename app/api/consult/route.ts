/**
 * POST /api/consult — AI 相談（M6 フェーズ1）
 *
 * - 処理本体は lib/consult/api.ts（テストで依存を注入できるように分離）
 * - ここでは実クライアント・実リミッタの構築のみを配線する。
 *   外部 API 呼び出しは lib/consult/iniadAdvisor.ts の注入可能な
 *   client 経由でのみ発生し、Live 無効時は一切発生しない
 * - Live 有効化は CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定の両方と
 *   もそろったときのみ（G2 承認前はどちらも設定しないこと）
 */
import { handleConsultRequest } from '@/lib/consult/api'
import { getConsultProvider } from '@/lib/consult/provider'

// OpenAI SDK（Node）を使うため Node.js ランタイム固定
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  return handleConsultRequest(request, {
    resolveProvider: getConsultProvider,
    env: process.env,
    logger: console,
  })
}