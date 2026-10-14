/**
 * AI相談機能の型定義（M5）
 *
 * - 相談UI（components/Consult.tsx）と応答生成（プロバイダ）をこの型で分離する
 * - M5 はモック応答のみ。M6（別途承認後）に OpenAI 等のプロバイダへ
 *   差し替えられるよう ConsultProvider インターフェースを用意する
 * - 会話履歴はブラウザのメモリ上（React の state）のみで保持し、
 *   localStorage / sessionStorage / DB には保存しない
 */

export type ChatRole = 'user' | 'assistant'

/**
 * 応答の出所。
 * - 'mock': 開発用モックサンプル
 * - 'mock-fallback': Live AI 障害時にモックへ切り替えた応答（明示ラベル付き）
 * - 'ai': AI 応答（M6 フェーズ1: Web検索なし・未確認の可能性あり）
 * - 'kb' / 'web': 検証済みナレッジベース / Web検索（未整備。M6-B 以降）
 */
export type ConsultReplySource =
  | 'mock'
  | 'mock-fallback'
  | 'ai'
  | 'kb'
  | 'web'

/** 会話メッセージ1件 */
export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  /** 応答がモック（開発用サンプル）であることを示す */
  isMock: boolean
  /** 未確認情報を含む応答であることを示す */
  hasUnverified: boolean
  /** 応答で案内した関連制度（モック/確認済みを区別） */
  relatedPrograms: ConsultRelatedProgram[]
  /** 応答の出所（M6 で追加。M5 以前のメッセージは未設定でもよい） */
  sourceType?: ConsultReplySource
}

/** 応答で案内する関連制度 */
export type ConsultRelatedProgram = {
  id: string
  name: string
  /**
   * 情報の区分。
   * - 'mock': モックデータ（未確認）。確定情報として扱わない
   * - 'verified': 実際に検証済みの情報
   */
  sourceType: 'mock' | 'verified'
  note: string
}

/**
 * 相談画面に引き継ぐ制度情報（制度カードから開始された場合）。
 * 制度は相談のきっかけにすぎず、他の制度についても自由に質問できる。
 */
export type ConsultContextProgram = {
  id: string
  name: string
  summary: string
  /** 金額の説明（未確認の場合はその旨を含む） */
  amountDescription: string
  /** 申請先（未確認は null） */
  where: string | null
  /** 申請期限・時期（未確認は null） */
  deadlineNote: string | null
  /** 判定に不足している情報 */
  missingInformation: string[]
  /** モックデータかどうか */
  mock: boolean
}

/**
 * 相談に必要な最小限の入力情報。
 * 収入・貯蓄などの金額は渡さない（必要最小限のみ）。
 */
export type ConsultUserContext = {
  childCount: number
  /** 世帯年収が入力されているか（金額自体は渡さない） */
  hasAnnualIncome: boolean
  /** 現在利用中の支援制度 ID */
  usedProgramIds: string[]
}

export type ConsultRequest = {
  message: string
  history: ChatMessage[]
  /** 制度カードから開始された場合の制度（自由相談は null） */
  program: ConsultContextProgram | null
  userContext: ConsultUserContext | null
}

export type ConsultReply = {
  text: string
  /** 応答がモック（開発用サンプル）であることを示す */
  isMock: boolean
  /** 未確認情報を含む */
  hasUnverified: boolean
  relatedPrograms: ConsultRelatedProgram[]
  /** 未対応の質問だった（根拠のない情報は生成しない） */
  unsupported: boolean
  /** 応答の出所（M6 で追加。未設定は 'mock' 扱い） */
  sourceType?: ConsultReplySource
  /** AI が尋ねた確認質問（M6 で追加。本文末尾にも展開して表示する） */
  clarificationQuestions?: string[]
  /**
   * 検証日（kb/web 出所のときのみ）。M6 フェーズ1では常に null
   * （検証済みナレッジベース未整備のため）
   */
  checkedAt?: string | null
}

/**
 * 応答プロバイダのインターフェース。
 * M5: モック実装（lib/consult/mockAdvisor.ts）のみ使用。
 * M6: OpenAI 等の実装に差し替え（別途承認まで実装・有効化しない）。
 */
export type ConsultProvider = {
  readonly id: string
  /** 表示用ラベル（モックであることが分かる名称にする） */
  readonly label: string
  readonly isMock: boolean
  respond(request: ConsultRequest): Promise<ConsultReply>
}
