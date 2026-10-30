/**
 * 会話ログの操作（M5・純関数）
 *
 * - 会話履歴はブラウザのメモリ上（React の state）のみで保持する
 * - localStorage / sessionStorage / IndexedDB / DB には一切保存しない
 * - ページをリロードすると会話履歴は消える（仕様どおり）
 *
 * UI（components/Consult.tsx / useConsultChat）はこのモジュール経由で
 * 会話ログを組み立てる。検証しやすいよう状態操作を純関数にしている。
 */
import type {
  ChatMessage,
  ConsultContextProgram,
  ConsultReply,
  ConsultUserContext,
} from './types'

/** 相談セッション（開始時の引き継ぎ情報） */
export type ConsultSession = {
  program: ConsultContextProgram | null
  userContext: ConsultUserContext | null
}

let messageSeq = 0

function nextId(): string {
  messageSeq += 1
  return `msg-${messageSeq}`
}

/** 制度カードの制度情報を相談用に変換（必要な情報のみ引き継ぐ） */
export function toConsultContextProgram(program: {
  id: string
  name: string
  summary: string
  amount: { description: string }
  application: { where: string | null; deadlineNote: string | null }
  missingInformation: string[]
  mock: boolean
}): ConsultContextProgram {
  return {
    id: program.id,
    name: program.name,
    summary: program.summary,
    amountDescription: program.amount.description,
    where: program.application.where,
    deadlineNote: program.application.deadlineNote,
    missingInformation: program.missingInformation,
    mock: program.mock,
  }
}

/**
 * 開始時の案内メッセージ（自由相談 / 制度指定の2種類）（M7-K に続く M7-M で短縮）
 *
 * - メッセージ本文は「どの制度について相談中か」「ほかの制度も質問できるか」だけに絞る
 * - 制度の概要・金額・申請先・確認状態は相談画面の折りたたみ（制度の詳細）に集約する
 * - 回答モード（実AI/モック）の説明は画面のモード別パネルに一本化して重複させない
 */
export function buildKickoffMessage(session: ConsultSession): ChatMessage {
  const lines: string[] = []
  if (session.program) {
    lines.push(
      `「${session.program.name}」について相談中です。`,
      'この制度をきっかけに、ほかの支援制度についても質問できます。',
    )
  } else {
    lines.push(
      '支援制度の相談を開始しました（制度を指定しない自由な相談）。',
      '気になることがあれば自由に質問してください。',
    )
  }
  return {
    id: nextId(),
    role: 'assistant',
    text: lines.join('\n'),
    isMock: true,
    hasUnverified: Boolean(session.program?.mock),
    relatedPrograms: session.program
      ? [
          {
            id: session.program.id,
            name: session.program.name,
            sourceType: session.program.mock ? 'mock' : 'verified',
            note: session.program.mock
              ? 'モックデータ（未確認）。確定情報ではありません'
              : '検証済みの情報',
          },
        ]
      : [],
  }
}

/** セッション開始（または会話リセット）時の会話ログ */
export function buildInitialMessages(session: ConsultSession): ChatMessage[] {
  return [buildKickoffMessage(session)]
}

/** ユーザーの質問を追加したログを返す（元のログは変更しない） */
export function appendUserMessage(
  messages: ChatMessage[],
  text: string,
): ChatMessage[] {
  return [
    ...messages,
    {
      id: nextId(),
      role: 'user',
      text,
      isMock: false,
      hasUnverified: false,
      relatedPrograms: [],
    },
  ]
}

/** 応答を追加したログを返す（元のログは変更しない） */
export function appendAssistantReply(
  messages: ChatMessage[],
  reply: ConsultReply,
): ChatMessage[] {
  return [
    ...messages,
    {
      id: nextId(),
      role: 'assistant',
      text: reply.text,
      isMock: reply.isMock,
      hasUnverified: reply.hasUnverified,
      relatedPrograms: reply.relatedPrograms,
      sourceType: reply.sourceType,
      // 出典（KB由来）は UI 表示用にそのまま引き継ぐ（本文から拾い直さない）
      citations: reply.citations,
    },
  ]
}