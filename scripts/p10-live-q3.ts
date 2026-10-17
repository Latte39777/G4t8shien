/**
 * P10 フェーズ5 追加確認: 関連する候補がない質問での安全な応答（実 API 1 回）
 *
 * 実行: npx tsx scripts/p10-live-q3.ts
 * - 合成質問のみ。実 API 呼び出しは 1 回。キー・ヘッダー・env 値は出力しない
 */
import { spawn, type ChildProcess } from 'node:child_process'

try {
  process.loadEnvFile('.env')
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

const PORT = 3124
const BASE = `http://localhost:${PORT}`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitReady(child: ChildProcess): Promise<boolean> {
  for (let i = 0; i < 90; i += 1) {
    if (child.exitCode !== null) return false
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) })
      if (res.status < 500) return true
    } catch {
      // 起動中
    }
    await sleep(2000)
  }
  return false
}

async function main(): Promise<void> {
  const child = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, CONSULT_LIVE_AI: '1' },
    stdio: 'ignore',
  })
  const kill = (): void => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.on('exit', kill)
  if (!(await waitReady(child))) {
    console.log('サーバ起動に失敗（実 API 呼び出し 0 回）')
    kill()
    process.exit(1)
  }

  // 支援制度と無関係な合成質問（セッション情報は渡す＝候補リストは送られる）
  const q = {
    message:
      '私の趣味の園芸について相談です。観葉植物の水やり頻度を教えてください。支援制度の候補があるなら教えてください。',
    history: [],
    program: null,
    userContext: { childCount: 0, hasAnnualIncome: false, usedProgramIds: [] },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  const res = await fetch(`${BASE}/api/consult`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(q),
    signal: controller.signal,
  })
  clearTimeout(timer)
  const body = (await res.json()) as {
    text: string
    isMock: boolean
    sourceType: string
    hasUnverified: boolean
    unsupported: boolean
    relatedPrograms: Array<{ id: string; name: string; verification?: string; note: string }>
  }
  console.log(`HTTP ${res.status} / sourceType=${body.sourceType} / isMock=${body.isMock} / unsupported=${body.unsupported}`)
  console.log('--- 回答本文 ---')
  console.log(body.text)
  console.log(`--- 関連制度チップ（${body.relatedPrograms.length} 件） ---`)
  for (const p of body.relatedPrograms) {
    console.log(`・[${p.id}] ${p.name} / ${p.verification ?? '未確認'}`)
  }
  kill()
  console.log('\n実 API 呼び出し: 1 回')
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.log('予期しないエラー（本文は表示しない）:', (error as { name?: string }).name ?? 'unknown')
  process.exit(1)
})
