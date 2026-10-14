/**
 * 相談プロバイダの取得（M6）
 *
 * 【2 重スイッチ】Live AI は CONSULT_LIVE_AI=1 かつ INIAD_API_KEY 設定の
 * 両方そろったときのみ有効。それ以外は M5 のモック固定のまま。
 * （G2 承認前は両方とも設定しないこと）
 *
 * - 未設定時: モック応答（M5 と同一）
 * - 両方設定時: INIAD API ライブ応答（lib/consult/iniadAdvisor.ts）
 *   実クライアントはこのとき初めて遅延構築される
 */
import { createIniadConsultProvider } from './iniadAdvisor'
import { mockConsultProvider } from './mockAdvisor'
import type { ConsultProvider } from './types'

/** Live AI が有効か（2 重スイッチ。テストでは env を差し替えられる） */
export function isLiveConsultEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CONSULT_LIVE_AI === '1' && Boolean(env.INIAD_API_KEY)
}

let liveProvider: ConsultProvider | null = null

export function getConsultProvider(): ConsultProvider {
  if (!isLiveConsultEnabled()) return mockConsultProvider
  if (liveProvider === null) {
    liveProvider = createIniadConsultProvider()
  }
  return liveProvider
}