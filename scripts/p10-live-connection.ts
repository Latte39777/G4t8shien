/**
 * P10 フェーズ2: INIAD AI-MOP API 接続テスト（実 API へ 1 回だけ送信）
 *
 * 実行: npx tsx scripts/p10-live-connection.ts
 *
 * - .env の INIAD_API_KEY / CONSULT_MODEL 等を読み込む（キーの値は一切表示しない）
 * - 個人情報も KB も含まない短文「Reply with exactly: INIAD_API_CONNECTION_OK」を
 *   1 回だけ送り、キー読込・到達・認証・モデル・応答を確認する
 * - 表示するのは判定結果・モデル名・エラー種別（kind）と HTTP ステータスのみ。
 *   上流エラー本文・認証ヘッダー・キーは出力しない
 * - 失敗時は無制限にリトライしない（1 回で停止して結果を報告）
 */
import {
  createDefaultIniadClient,
  DEFAULT_INIAD_BASE_URL,
  DEFAULT_INIAD_MODEL,
  mapUpstreamError,
  withTimeout,
} from '../lib/consult/iniadAdvisor'

// .env を読み込む（Node 標準。値は出力しない）
try {
  process.loadEnvFile('.env')
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

function main(): void {
  const apiKey = process.env.INIAD_API_KEY ?? ''
  console.log(
    `APIキーの読み込み: ${apiKey.length > 0 ? `成功（非空・長さ ${apiKey.length}）` : '失敗（未設定）'}`,
  )
  if (apiKey.length === 0) {
    console.log('接続結果: 未実施（キー不足。推測で補わず終了）')
    process.exit(1)
  }
  const baseURL = process.env.CONSULT_API_BASE_URL ?? DEFAULT_INIAD_BASE_URL
  const model = process.env.CONSULT_MODEL ?? DEFAULT_INIAD_MODEL
  console.log(`接続先 Base URL: ${baseURL}`)
  console.log(`モデル名: ${model}`)

  const client = createDefaultIniadClient(process.env)
  void withTimeout(
    client.create({
      model,
      messages: [
        { role: 'user', content: 'Reply with exactly: INIAD_API_CONNECTION_OK' },
      ],
    }),
    30_000,
  )
    .then((result) => {
      const content = result.content ?? ''
      console.log(`応答: 受信成功（${content.length} 文字）`)
      console.log(
        `期待トークン「INIAD_API_CONNECTION_OK」の一致: ${
          content.includes('INIAD_API_CONNECTION_OK') ? 'あり' : 'なし'
        }`,
      )
      console.log(`応答本文（先頭300文字）: ${content.slice(0, 300)}`)
      console.log('接続結果: 成功（キー読込・到達・認証・モデル応答すべて確認）')
      process.exit(0)
    })
    .catch((error: unknown) => {
      // 秘密情報を含み得るため、上流エラー本文・message は表示しない
      const kind = mapUpstreamError(error)
      const status = (error as { status?: number } | null)?.status
      console.log(
        `接続結果: 失敗（エラー種別: ${kind.kind}${typeof status === 'number' ? ` / HTTP ${status}` : ''}）`,
      )
      process.exit(1)
    })
}

void main()
