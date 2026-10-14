/**
 * 相談 API のエラー種別とユーザー向け文言（M6）
 *
 * - サーバー（lib/consult/api.ts / iniadAdvisor.ts）とクライアント
 *   （lib/consult/clientTransport.ts）で同じ区分を共有する
 * - 原則: 通信障害は「エラー表示＋再試行」。モック応答への自動切替は
 *   CONSULT_FALLBACK_TO_MOCK=1 のときのみ（既定は 0）
 */

export type ConsultErrorKind =
  /** 入力不正（長すぎる・形式不正など） */
  | 'validation'
  /** 認証・設定エラー（401/403/404 など。再試行しても直らない） */
  | 'auth'
  /** レート制限（429） */
  | 'rate_limit'
  /** タイムアウト */
  | 'timeout'
  /** 通信障害 */
  | 'network'
  /** 上流サーバエラー（5xx など） */
  | 'server'
  /** 応答の解析不能（内容は破棄して限定文のみ返す） */
  | 'invalid_response'

/** 相談 API の通信・処理失敗（クライアント/サーバー両側で使用） */
export class ConsultSendError extends Error {
  readonly kind: ConsultErrorKind

  constructor(kind: ConsultErrorKind, message?: string) {
    super(message ?? kind)
    this.name = 'ConsultSendError'
    this.kind = kind
  }
}

/** 再試行が見込めるエラーか（認証・入力不正は再試行しても直らない） */
export function isRetryableKind(kind: ConsultErrorKind): boolean {
  return kind !== 'validation' && kind !== 'auth'
}

/** 画面に表示するユーザー向け文言（内部エラーの詳細は出さない） */
export function userMessageForKind(kind: ConsultErrorKind): string {
  switch (kind) {
    case 'validation':
      return '質問の形式に問題があります。内容を確認して再度お試しください。'
    case 'auth':
      return 'AI 相談機能が現在ご利用いただけません（設定を確認中です）。'
    case 'rate_limit':
      return 'アクセスが集中しています。時間をおいて再度お試しください。'
    case 'timeout':
      return '回答の取得に時間がかかりすぎました。時間をおいて再度お試しください。'
    case 'network':
      return '通信エラーが発生しました。時間をおいて再度お試しください。'
    case 'server':
      return '回答の取得に失敗しました。時間をおいて再度お試しください。'
    case 'invalid_response':
      return '回答を準備できませんでした。時間をおいて再度お試しください。'
  }
}

/** モックフォールバック時の障害ラベル用（簡潔な原因名） */
export function reasonLabelForKind(kind: ConsultErrorKind): string {
  switch (kind) {
    case 'validation':
      return '入力エラー'
    case 'auth':
      return '認証・設定エラー'
    case 'rate_limit':
      return 'レート制限'
    case 'timeout':
      return 'タイムアウト'
    case 'network':
      return '通信エラー'
    case 'server':
      return 'サーバーエラー'
    case 'invalid_response':
      return '応答解析エラー'
  }
}

/** エラー種別 → HTTP ステータス */
export function statusForKind(kind: ConsultErrorKind): number {
  switch (kind) {
    case 'validation':
      return 400
    case 'auth':
      return 503
    case 'rate_limit':
      return 429
    case 'timeout':
      return 504
    case 'network':
      return 502
    case 'server':
      return 502
    case 'invalid_response':
      return 502
  }
}

/** HTTP ステータス → エラー種別（クライアント側のフォールバック判定用） */
export function kindForStatus(status: number): ConsultErrorKind {
  if (status === 400 || status === 422) return 'validation'
  if (status === 401 || status === 403 || status === 404) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 504) return 'timeout'
  return 'server'
}