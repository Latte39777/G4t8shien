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

/** 開始時の案内メッセージ（自由相談 / 制度指定の2種類） */
export function buildKickoffMessage(session: ConsultSession): ChatMessage {
  const lines: string[] = []
  if (session.program) {
    lines.push(
      `「${session.program.name}」についての相談を開始しました。`,
      `制度の概要（${session.program.mock ? 'モック・未確認' : '確認済み'}）：${session.program.summary}`,
      '※この制度は相談のきっかけです。この制度以外の支援制度についても自由に質問できます。',
    )
  } else {
    lines.push(
      '支援制度の相談を開始しました（制度を指定しない自由な相談）。',
      '気になることがあれば自由に質問してください。',
    )
  }
  lines.push(
    'このアシスタントの回答はすべて開発用のモックサンプルです。制度情報は未確認のモックデータに基づき、公式サイトの検索結果ではありません。',
  )
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
    },
  ]
}