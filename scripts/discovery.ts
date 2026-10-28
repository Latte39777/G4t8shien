#!/usr/bin/env tsx
/**
 * 支援制度候補の発見・構造化パイプライン CLI（M7-D）
 *
 * 【使い方（リポジトリルートで実行）】
 *   npx tsx scripts/discovery.ts status
 *   npx tsx scripts/discovery.ts scan [--task <taskId>] [--limit <n>] [--live]
 *   npx tsx scripts/discovery.ts fetch [--limit <n>] [--force] [--live]
 *   npx tsx scripts/discovery.ts extract [--task <taskId>] [--retry] [--live]
 *   npx tsx scripts/discovery.ts report
 *   npx tsx scripts/discovery.ts validate
 *
 *   候補の検証・承認・公開（M7-E。外部通信なし）:
 *   npx tsx scripts/discovery.ts candidates [--status <s>] [candidateId]
 *   npx tsx scripts/discovery.ts recheck
 *   npx tsx scripts/discovery.ts verify
 *   npx tsx scripts/discovery.ts verify-field <candidateId> --field <項目> --value <値> --quote <本文抜粋> --by <確認者>
 *   npx tsx scripts/discovery.ts request-recheck <candidateId> --by <操作者> --reason <理由>
 *   npx tsx scripts/discovery.ts discard <candidateId> --by <操作者> --reason <理由>
 *   npx tsx scripts/discovery.ts restore <candidateId> --by <操作者> --reason <理由>
 *   npx tsx scripts/discovery.ts approve <candidateId> --by <操作者> --reason <理由>
 *   npx tsx scripts/discovery.ts publish <candidateId> --by <操作者> --reason <理由> [--update <programId>] [--supersedes <programId>] [--programs <file>]
 *   npx tsx scripts/discovery.ts audit [candidateId]
 *
 * 【安全な実行モード】
 * - 通常実行は dry-run（外部通信なし・保存なし）。
 * - 外部通信（ページ取得・AI 呼び出し）は --live かつ DISCOVERY_LIVE=1 の両方が
 *   必要。AI 呼び出しには INIAD_API_KEY（サーバー側 env のみ）がさらに必要。
 *   既存の相談機能（CONSULT_LIVE_AI）とは独立で、相互には連動しない。
 * - API キー・認証情報はログに出力しない（キーの有無は真偽のみ表示）。
 * - Next.js の画面表示・API アクセス時に外部サイトを取得することはない
 *   （この CLI の手動実行のみが外部通信の入口）。
 *
 * 実装は lib/discovery/cli.ts（テスト可能な本体）。このファイルは node:fs と
 * 実 transport / 実 AI クライアントの注入だけを行う。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchTransport } from '../lib/supports/sourceFetch'
import { createDefaultExtractClient } from '../lib/discovery/aiExtract'
import { runDiscoveryCli, type DiscoveryFileOps } from '../lib/discovery/cli'

/** 一時ファイル経由のアトミックな書き込み（途中失敗で保存物を壊さない） */
const fileOps: DiscoveryFileOps = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  },
}

async function main(): Promise<void> {
  const code = await runDiscoveryCli(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    files: fileOps,
    // 外部通信経路は live 実行時のみ構築される（dry-run では呼ばない）
    createTransport: () => fetchTransport(globalThis.fetch),
    createAiClient: () => createDefaultExtractClient(process.env),
    log: (line) => console.log(line),
  })
  process.exitCode = code
}

main().catch((err: unknown) => {
  console.error('実行に失敗しました:', err)
  process.exitCode = 1
})
