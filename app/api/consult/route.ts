/**
 * POST /api/consult — AI 相談（M6 フェーズ1）
 * GET  /api/consult — 設定状態（P10-1。送信前注意表示用の真偽値のみ）
 *
 * - 処理本体は lib/consult/api.ts（テストで依存を注入できるように分離）
 * - ここでは実クライアント・実リミッタの構築のみを配線する。
 *   外部 API 呼び出しは lib/consult/iniadAdvisor.ts の注入可能な
 *   client 経由でのみ発生し、Live 無効時は一切発生しない
 * - Live 有効化は CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定の両方と
 *   もそろったときのみ（G2 承認前はどちらも設定しないこと）
 * - GET は { liveAiEnabled } のみを返す（API キーなどの秘密情報・
 *   環境変数の値はクライアントへ公開しない）
 */
import {
  handleConsultRequest,
  handleConsultStatusRequest,
} from '@/lib/consult/api'
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

export async function GET(): Promise<Response> {
  return handleConsultStatusRequest({ env: process.env })
}