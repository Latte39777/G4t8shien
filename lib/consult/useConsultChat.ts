'use client'

/**
 * 相談の会話状態フック（M6）
 *
 * - 会話履歴はメモリ上（React の state）のみで保持する
 *   （localStorage / sessionStorage / DB には保存しない。リロードで消える）
 * - 応答は POST /api/consult 経由で取得する（既定: clientTransport）。
 *   テスト等では respond を注入して差し替えられる
 * - 通信障害はエラー表示＋再試行（再試行は直前の質問を再送する）
 */
import { useCallback, useRef, useState } from 'react'
import {
  fetchConsultReply,
  type ConsultResponder,
} from './clientTransport'
import {
  appendAssistantReply,
  appendUserMessage,
  buildInitialMessages,
  type ConsultSession,
} from './conversation'
import {
  ConsultSendError,
  isRetryableKind,
  userMessageForKind,
} from './errors'
import type { ChatMessage, ConsultRequest } from './types'

export type UseConsultChatOptions = {
  /** 応答取得関数（既定: /api/consult へ POST） */
  respond?: ConsultResponder
}

export type UseConsultChat = {
  messages: ChatMessage[]
  sending: boolean
  error: string | null
  /** 再試行が可能か（通信系エラーのときのみ true） */
  retryable: boolean
  /** 相談セッションの開始（制度カードから開始した場合は制度情報を引き継ぐ） */
  startSession: (session: ConsultSession) => void
  /** 質問を送信して応答を会話に追加する */
  send: (text: string) => Promise<void>
  /** 失敗した直前の質問を再送する */
  retry: () => Promise<void>
  /** 会話をリセット（開始時の案内メッセージに戻す） */
  reset: () => void
  /** 会話履歴を完全に破棄（シミュレーションのやり直しなど） */
  clear: () => void
  clearError: () => void
}

export function useConsultChat(
  options?: UseConsultChatOptions,
): UseConsultChat {
  const respond: ConsultResponder = options?.respond ?? fetchConsultReply
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryable, setRetryable] = useState(false)
  const sessionRef = useRef<ConsultSession>({ program: null, userContext: null })
  /** 現在の会話ログ（送信時のリクエスト履歴用に state と同期しておく） */
  const messagesRef = useRef<ChatMessage[]>([])
  /** 連続送信防止（送信中フラグと合わせて二重送信を抑止） */
  const sendingRef = useRef(false)
  /** 再試行対象のリクエスト（失敗時のみ保持） */
  const lastFailedRequestRef = useRef<ConsultRequest | null>(null)

  const commit = useCallback(
    (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      messagesRef.current = updater(messagesRef.current)
      setMessages(messagesRef.current)
    },
    [],
  )

  const startSession = useCallback(
    (session: ConsultSession) => {
      sessionRef.current = session
      commit((prev) => [...prev, ...buildInitialMessages(session)])
      setError(null)
      setRetryable(false)
    },
    [commit],
  )

  /** 応答の取得と会話への追加（再試行時もここを使う） */
  const performRequest = useCallback(
    async (request: ConsultRequest) => {
      try {
        const reply = await respond(request)
        commit((prev) => appendAssistantReply(prev, reply))
        lastFailedRequestRef.current = null
        setError(null)
        setRetryable(false)
      } catch (e) {
        const kind = e instanceof ConsultSendError ? e.kind : null
        setError(
          kind !== null ? userMessageForKind(kind) : '回答の取得に失敗しました。時間をおいて再度お試しください。',
        )
        setRetryable(kind === null || isRetryableKind(kind))
        lastFailedRequestRef.current = request
      } finally {
        sendingRef.current = false
        setSending(false)
      }
    },
    [commit, respond],
  )

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        setError('質問を入力してください。')
        return
      }
      if (sendingRef.current) {
        setError('ただいま回答を準備しています。少しお待ちください。')
        return
      }
      sendingRef.current = true
      setSending(true)
      setError(null)
      setRetryable(false)
      const request: ConsultRequest = {
        message: trimmed,
        history: messagesRef.current,
        program: sessionRef.current.program,
        userContext: sessionRef.current.userContext,
      }
      commit((prev) => appendUserMessage(prev, trimmed))
      await performRequest(request)
    },
    [commit, performRequest],
  )

  const retry = useCallback(async () => {
    const request = lastFailedRequestRef.current
    if (request === null || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    setRetryable(false)
    await performRequest(request)
  }, [performRequest])

  const reset = useCallback(() => {
    commit(() => buildInitialMessages(sessionRef.current))
    setError(null)
    setRetryable(false)
    lastFailedRequestRef.current = null
  }, [commit])

  const clear = useCallback(() => {
    sessionRef.current = { program: null, userContext: null }
    commit(() => [])
    setError(null)
    setRetryable(false)
    lastFailedRequestRef.current = null
  }, [commit])

  const clearError = useCallback(() => {
    setError(null)
    setRetryable(false)
  }, [])

  return {
    messages,
    sending,
    error,
    retryable,
    startSession,
    send,
    retry,
    reset,
    clear,
    clearError,
  }
}