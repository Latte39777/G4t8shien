/**
 * 回答モードの表示判定（P9-4）
 *
 * - 応答の既存フィールド（isMock / sourceType）だけから表示モードを判定する。
 *   回答本文の表現・文面からモードを推測しない
 * - 判定結果の使い分け:
 *   - 'mock': 通常のモック回答（開発用サンプルであることを表示する）
 *   - 'mock-fallback': ライブ AI 障害時にモックへ切り替えた回答
 *     （ライブ AI が正常に回答したかのような表示をしない）
 *   - 'ai': ライブ AI による生成回答（AI 生成であることと、誤り・未確認が
 *     あり得ることを伝える表示にする）
 * - 本モジュールは表示判定のみ。ライブ AI の有効化・送信制御には使わない
 */
import type { ChatMessage } from './types'

export type ReplyDisplayMode = 'mock' | 'mock-fallback' | 'ai'

/**
 * 応答メッセージの表示モードを判定する（assistant 応答にのみ適用する）。
 * - フィールドが矛盾する場合は安全側（AI 生成と表示しない）に倒す:
 *   isMock 応答を 'ai' と表示することはない
 * - sourceType 未設定（M5 以前のメッセージ）は isMock だけで判定する
 */
export function replyDisplayMode(
  message: Pick<ChatMessage, 'isMock' | 'sourceType'>,
): ReplyDisplayMode {
  if (message.sourceType === 'mock-fallback') return 'mock-fallback'
  if (message.isMock || message.sourceType === 'mock') return 'mock'
  // 'ai' / 'kb' / 'web'（AI 生成。kb/web は出典表示を併用）および
  // sourceType 未設定かつ isMock=false の場合は AI 生成の応答として扱う
  return 'ai'
}
