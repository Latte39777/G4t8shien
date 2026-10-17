/**
 * P10 フェーズ3・4: 相談 API 通常経路（UI と同じ POST /api/consult）での実 API 確認
 *
 * 実行: npx tsx scripts/p10-live-http.ts
 *
 * - next dev をループバックで起動し、合成データのみの質問を 2 通送る:
 *   1) 児童手当についての一般的な質問（フェーズ3）
 *   2) 合成した利用者状況での支援制度提案リクエスト（フェーズ4）
 * - 合計の実 API 呼び出しは 2 回（接続テスト 1 回と合わせて 3 回）。無制限リトライなし
 * - 表示するのは API 応答（本文・フラグ・出典・チップ）と判定のみ。API キー・
 *   認証ヘッダー・環境変数の値は出力しない
 */
import { spawn, type ChildProcess } from 'node:child_process'

// .env を読み込む（値は出力しない）。子プロセス（next dev）へは env 継承で渡す
try {
  process.loadEnvFile('.env')
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

const PORT = 3123
const BASE = `http://localhost:${PORT}`

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchJson(path: string, init?: RequestInit, timeoutMs = 180_000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal })
    return { status: res.status, body: await res.json() }
  } finally {
    clearTimeout(timer)
  }
}

type Chip = {
  id: string
  name: string
  sourceType: string
  category?: string
  verification?: string
  checkedAt?: string | null
  note: string
  sources?: Array<{ title: string; organization: string; url: string | null; urlVerified: boolean }>
}

type ReplyBody = {
  text: string
  isMock: boolean
  hasUnverified: boolean
  unsupported: boolean
  sourceType: string
  relatedPrograms: Chip[]
  citations?: Array<{ title: string; organization: string; url: string | null; urlVerified: boolean; checkedAt: string | null }>
  clarificationQuestions?: string[]
}

function printReply(label: string, body: ReplyBody): void {
  console.log(`\n===== ${label} =====`)
  console.log(`sourceType=${body.sourceType} / isMock=${body.isMock} / hasUnverified=${body.hasUnverified} / unsupported=${body.unsupported}`)
  console.log('--- 回答本文 ---')
  console.log(body.text)
  console.log(`--- 確認質問（${(body.clarificationQuestions ?? []).length} 件） ---`)
  for (const q of body.clarificationQuestions ?? []) console.log(`・${q}`)
  console.log(`--- 出典 citations（${(body.citations ?? []).length} 件） ---`)
  for (const c of body.citations ?? []) {
    console.log(`・${c.title}（${c.organization}） url=${c.url === null ? 'なし' : 'あり'} urlVerified=${c.urlVerified} checkedAt=${c.checkedAt ?? '未確認'}`)
  }
  console.log(`--- 関連制度チップ（${body.relatedPrograms.length} 件） ---`)
  for (const p of body.relatedPrograms) {
    console.log(`・[${p.id}] ${p.name} / 区分=${p.category ?? '未確認'} / 確認状態=${p.verification ?? '未確認'} / 確認日=${p.checkedAt ?? '未確認'} / sourceType=${p.sourceType} / 出典${(p.sources ?? []).length}件`)
  }
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
  const apiKey = process.env.INIAD_API_KEY ?? ''
  console.log(`APIキーの読み込み: ${apiKey.length > 0 ? '成功（値は非表示）' : '失敗'}`)
  console.log(`CONSULT_LIVE_AI: ${process.env.CONSULT_LIVE_AI === '1' ? '1（ライブ有効）' : 'その他'}`)
  if (apiKey.length === 0 || process.env.CONSULT_LIVE_AI !== '1') {
    console.log('未実施（設定不足）')
    process.exit(1)
  }

  const child = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
    cwd: process.cwd(),
    env: { ...process.env, CONSULT_LIVE_AI: '1' },
    stdio: 'ignore',
  })
  const kill = (): void => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.on('exit', kill)

  const ready = await waitReady(child)
  if (!ready) {
    console.log('サーバ起動に失敗（実 API 呼び出し 0 回）')
    kill()
    process.exit(1)
  }
  console.log(`next dev 起動確認（loopback :${PORT}）`)

  // 合成ユーザ状況（実在人物の情報なし）
  const userContext = {
    childCount: 2,
    hasAnnualIncome: true,
    usedProgramIds: [] as string[],
  }

  // ── フェーズ3: 相談の通常経路（実 API 1 回） ──
  const q1 = {
    message:
      '児童手当について、どんな制度なのかと、申請時に確認すべきことを簡潔に教えてください。確実に分からない情報は推測しないでください。',
    history: [],
    program: null,
    userContext,
  }
  const r1 = await fetchJson('/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(q1),
  })
  printReply(`フェーズ3: 相談応答（HTTP ${r1.status}）`, r1.body as ReplyBody)

  // ── フェーズ4: 支援制度提案の通常経路（実 API 1 回） ──
  const q2 = {
    message:
      '子どもが2人（3歳と5歳）います。相談者に役立つ可能性のある支援制度の候補を挙げてください。関連する制度がなければ、確認できる候補がないと答えてください。',
    history: [],
    program: null,
    userContext,
  }
  const r2 = await fetchJson('/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(q2),
  })
  printReply(`フェーズ4: 支援制度提案（HTTP ${r2.status}）`, r2.body as ReplyBody)

  kill()
  console.log('\n実 API 呼び出し: 2 回（フェーズ3・4 各 1 回）')
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.log('予期しないエラー（本文は表示しない）:', (error as { name?: string }).name ?? 'unknown')
  process.exit(1)
})
