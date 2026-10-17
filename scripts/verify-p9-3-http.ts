/**
 * P9-3 検証: 相談 API の HTTP 境界テスト（ループバック限定・外部通信ゼロ）
 *
 * 実行: npx tsx scripts/verify-p9-3-http.ts
 *
 * 構成:
 * - 子プロセス（npx tsx scripts/verify-p9-3-http.ts --serve）に実 Route Handler
 *   （app/api/consult/route.ts）を載せた HTTP サーバーを 127.0.0.1 の空きポートで
 *   起動し、親プロセスから localhost 経由の実 HTTP で検証する
 * - 子プロセスの環境では CONSULT_LIVE_AI / INIAD_API_KEY / CONSULT_FALLBACK_TO_MOCK
 *   を空文字で明示し、モックプロバイダ選択を READY 行と応答の両方で確認する
 *   （親プロセスの環境変数・.env の内容は表示しない）
 * - 子プロセスでは global fetch を封じて外部通信を禁止（回数を /__fetch-count で計測）
 * - バインドは 127.0.0.1 のみ。公開ネットワークにはバインドしない
 * - テスト成否に関わらず子プロセスを終了し、ポート解放を確認する
 *
 * 検証項目:
 * 1. 正常リクエスト → 想定形式の JSON が HTTP で返る
 * 2. 不正入力 → 適切な HTTP エラー（400）
 * 3. レート制限 → HTTP 429 と Retry-After の整合
 * 4. エラー応答に秘密情報・内部スタックが含まれない
 * 5. モック応答がモックであると識別できる（外部通信 0 回と併せて確認）
 * 6. テスト後サーバープロセス終了・ポート解放
 *
 * 注: レート制限はモックプロバイダでは発動しないため、同一ハンドラ
 * （handleConsultRequest）にライブ相当のスタブプロバイダ（外部通信なし）と
 * 低めのリミッタを注入した /api/consult-rt でも 429 を検証する。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { userMessageForKind } from '../lib/consult/errors'
import type { ConsultReply } from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

const SILENT_LOGGER = { warn: (): void => {}, error: (): void => {} }

// ── 子プロセス（サーバー）モード ──
async function runServer(): Promise<void> {
  // 外部通信ガード（モック経路は fetch しない。万一呼ばれたら拒否して計測）
  let fetchCount = 0
  globalThis.fetch = ((input: unknown) => {
    fetchCount += 1
    void input
    return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
  }) as typeof fetch

  // ライブ AI 無効の明示（空文字で上書き。2 重スイッチ未成立＝モック固定）
  process.env.CONSULT_LIVE_AI = ''
  process.env.INIAD_API_KEY = ''
  process.env.CONSULT_FALLBACK_TO_MOCK = ''

  const { POST: consultPost } = await import('../app/api/consult/route')
  const { handleConsultRequest } = await import('../lib/consult/api')
  const { isLiveConsultEnabled } = await import('../lib/consult/provider')
  const { MemoryRateLimiter } = await import('../lib/consult/rateLimit')

  // レート制限検証用のライブ相当スタブ（外部通信なし・応答は固定）
  const stubReply: ConsultReply = {
    text: '応答',
    isMock: false,
    hasUnverified: true,
    relatedPrograms: [],
    unsupported: false,
    sourceType: 'ai',
  }
  const stubLiveProvider = {
    id: 'stub-live',
    label: 'ライブスタブ（テスト）',
    isMock: false,
    respond: () => Promise.resolve(stubReply),
  }
  const strictLimiter = new MemoryRateLimiter({
    perMinute: 3,
    perDay: 100,
    globalPerMinute: 100,
  })

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const rawBody = Buffer.concat(chunks).toString('utf8')
        if (req.method === 'GET' && req.url === '/__fetch-count') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ fetchCount }))
          return
        }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value
          else if (Array.isArray(value)) headers[key] = value.join(', ')
        }
        const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          body: rawBody,
        })
        let response: Response
        if (req.url === '/api/consult' && req.method === 'POST') {
          // 実 Route Handler（app/api/consult/route.ts）を通す
          response = await consultPost(request)
        } else if (req.url === '/api/consult-rt' && req.method === 'POST') {
          response = await handleConsultRequest(request, {
            resolveProvider: () => stubLiveProvider,
            env: {},
            rateLimiter: strictLimiter,
            logger: SILENT_LOGGER,
          })
        } else {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        const resHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          resHeaders[key] = value
        })
        res.writeHead(response.status, resHeaders)
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch {
        // 内部エラーも自由文は返さない（安全側の固定文のみ）
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('internal error')
      }
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  const address = typeof addr === 'object' && addr !== null ? addr.address : ''
  const live = isLiveConsultEnabled({
    CONSULT_LIVE_AI: process.env.CONSULT_LIVE_AI,
    INIAD_API_KEY: process.env.INIAD_API_KEY,
  })
  // READY 行（ポート・バインド先・ライブ無効の確認用。環境変数の値は出さない）
  console.log(`READY ${JSON.stringify({ port, address, live })}`)

  const shutdown = (): void => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
// ── 親プロセス（テスト）用ユーティリティ ──
type ReadyInfo = { port: number; address: string; live: boolean }

function isLoopback(url: string): boolean {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')
}

/** ループバック限定 fetch（アクセス先を記録し、非ループバックは拒否する） */
function localFetch(
  url: string,
  init: RequestInit | undefined,
  seen: string[],
): Promise<Response> {
  seen.push(url)
  if (!isLoopback(url)) {
    return Promise.reject(new Error('ループバック以外へのアクセスは禁止'))
  }
  return fetch(url, init)
}

function postJson(url: string, body: string, seen: string[]): Promise<Response> {
  return localFetch(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    seen,
  )
}

function waitForReady(
  child: ChildProcess,
  readStdout: () => string,
  timeoutMs: number,
): Promise<ReadyInfo | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const match = /^READY (\{.*\})$/m.exec(readStdout())
      if (match) {
        clearInterval(timer)
        resolve(JSON.parse(match[1]) as ReadyInfo)
        return
      }
      if (child.exitCode !== null || Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(null)
      }
    }, 100)
  })
}

/** 子プロセスグループ全体へシグナル（npx→sh→node の多段起動もまとめて終了させる） */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // 既に終了済み
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** 指定ポートが解放されているか（127.0.0.1 で再バインド可能か。解放待ちを少し再試行） */
async function canBind(port: number, retries = 4): Promise<boolean> {
  for (let i = 0; i < retries; i += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createNetServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => {
        srv.close(() => resolve(true))
      })
    })
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

const validBody = JSON.stringify({
  message: '申請はどこですればいい？',
  history: [],
  program: null,
  userContext: null,
})

async function main(): Promise<void> {
  const selfPath = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(process.cwd(), 'scripts/verify-p9-3-http.ts')
  const repoRoot = path.resolve(path.dirname(selfPath), '..')

  // 子プロセスの環境（親の環境変数の値は表示しない。ライブ AI を空で明示）
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CONSULT_LIVE_AI: '',
    INIAD_API_KEY: '',
    CONSULT_FALLBACK_TO_MOCK: '',
  }
  const child = spawn('npx', ['tsx', selfPath, '--serve'], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // npx→sh→node の多段起動を同一プロセスグループにし、まとめて終了できるようにする
    detached: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString('utf8')
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf8')
  })

  const ready = await waitForReady(child, () => stdout, 20000)
  const seen: string[] = []
  if (ready === null) {
    check('子プロセス（HTTP サーバー）が起動できる', false, stderr.slice(0, 500))
    signalTree(child, 'SIGKILL')
    child.stdout?.destroy()
    child.stderr?.destroy()
    console.log(`\nverify-p9-3-http: ${failed} 件失敗`)
    process.exitCode = 1
    return
  }
  check('子プロセス（HTTP サーバー）が起動できる', true)
  check(
    'サーバーは 127.0.0.1 のみにバインド（空きポート自動採用）',
    ready.address === '127.0.0.1' && ready.port > 0,
    `address=${ready.address} port=${ready.port}`,
  )
  check(
    '子プロセスではライブ AI が無効（モックプロバイダ選択）',
    ready.live === false,
  )

  const base = `http://127.0.0.1:${ready.port}`
  const errorTexts: string[] = []

  // ── 1. 正常リクエスト ──
  const r1 = await postJson(`${base}/api/consult`, validBody, seen)
  const b1 = (await r1.json()) as ConsultReply
  check(
    '1. 正常リクエスト: HTTP 200 で想定形式の JSON',
    r1.status === 200 &&
      typeof b1.text === 'string' &&
      Array.isArray(b1.relatedPrograms) &&
      typeof b1.isMock === 'boolean' &&
      typeof b1.hasUnverified === 'boolean',
  )
  check(
    '1. 200 応答に Retry-After は付かない',
    r1.headers.get('retry-after') === null,
  )

  // ── 2. 不正入力 ──
  const r2a = await postJson(`${base}/api/consult`, 'not-json', seen)
  const t2a = await r2a.text()
  errorTexts.push(t2a)
  const b2a = JSON.parse(t2a) as { error?: { kind?: string; message?: string } }
  check(
    '2. 不正 JSON: 400 / validation / 固定文言',
    r2a.status === 400 &&
      b2a.error?.kind === 'validation' &&
      b2a.error?.message === 'リクエストの形式が不正です。',
  )
  const r2b = await postJson(
    `${base}/api/consult`,
    JSON.stringify({ message: '', history: [], program: null, userContext: null }),
    seen,
  )
  const t2b = await r2b.text()
  errorTexts.push(t2b)
  const b2b = JSON.parse(t2b) as { error?: { kind?: string } }
  check('2. 空の質問: 400 / validation', r2b.status === 400 && b2b.error?.kind === 'validation')
  const r2c = await postJson(
    `${base}/api/consult`,
    JSON.stringify({ message: 'あ'.repeat(1001), history: [], program: null, userContext: null }),
    seen,
  )
  const t2c = await r2c.text()
  errorTexts.push(t2c)
  const b2c = JSON.parse(t2c) as { error?: { kind?: string; message?: string } }
  check(
    '2. 長すぎる質問: 400 で上限文言',
    r2c.status === 400 && b2c.error?.message === '質問が長すぎます（上限 1000 文字）。',
    b2c.error?.message ?? '',
  )
  // ── 3. レート制限（429 と Retry-After の整合） ──
  const rtUrl = `${base}/api/consult-rt`
  const rtStatuses: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const r = await postJson(rtUrl, validBody, seen)
    await r.arrayBuffer()
    rtStatuses.push(r.status)
  }
  check('3. レート制限: 上限内（3 回）は 200', rtStatuses.every((s) => s === 200), rtStatuses.join(','))
  const r429a = await postJson(rtUrl, validBody, seen)
  const t429a = await r429a.text()
  errorTexts.push(t429a)
  const b429a = JSON.parse(t429a) as { error?: { kind?: string; message?: string } }
  const ra1 = Number(r429a.headers.get('retry-after'))
  const r429b = await postJson(rtUrl, validBody, seen)
  const t429b = await r429b.text()
  errorTexts.push(t429b)
  const ra2 = Number(r429b.headers.get('retry-after'))
  check('3. レート制限: 4 回目以降は 429', r429a.status === 429 && r429b.status === 429, `${r429a.status},${r429b.status}`)
  check(
    '3. 429 と Retry-After が整合（正整数 1〜60 秒・連続応答で矛盾しない）',
    Number.isInteger(ra1) && ra1 >= 1 && ra1 <= 60 && Math.abs(ra1 - ra2) <= 1,
    `ra1=${ra1} ra2=${ra2}`,
  )
  check(
    '3. 429 の body は固定文言（kind=rate_limit）',
    b429a.error?.kind === 'rate_limit' &&
      b429a.error?.message === userMessageForKind('rate_limit'),
  )

  // ── 4. エラー応答に秘密情報・内部スタックが含まれない ──
  const rSec = await postJson(
    `${base}/api/consult`,
    JSON.stringify({
      message: `sk-FAKE-TEST-KEY-0000DEADBEEF ${'あ'.repeat(1200)}`,
      history: [],
      program: null,
      userContext: null,
    }),
    seen,
  )
  const tSec = await rSec.text()
  errorTexts.push(tSec)
  const allErrors = errorTexts.join('\n')
  check(
    '4. 秘密情報らしき文字列がエラー応答に漏れない',
    rSec.status === 400 &&
      !allErrors.includes('sk-FAKE') &&
      !allErrors.includes('DEADBEEF'),
  )
  check(
    '4. 内部スタック・ファイル情報がエラー応答に含まれない',
    !allErrors.includes('node:') &&
      !allErrors.includes('.ts:') &&
      !allErrors.includes('stack') &&
      !allErrors.includes('    at '),
    allErrors.slice(0, 300),
  )

  // ── 5. モック応答の識別と外部通信ゼロ ──
  const rGuard = await localFetch(`${base}/__fetch-count`, undefined, seen)
  const guard = (await rGuard.json()) as { fetchCount: number }
  check(
    '5. モック応答がモックであると識別できる（isMock / sourceType）',
    b1.isMock === true && b1.sourceType !== 'ai',
    `isMock=${String(b1.isMock)} sourceType=${String(b1.sourceType)}`,
  )
  check('5. 子プロセスでの外部通信（fetch）は 0 回', guard.fetchCount === 0, `fetchCount=${guard.fetchCount}`)
  check(
    '5. テスト中のアクセスはすべてループバック限定',
    seen.length > 0 && seen.every((u) => isLoopback(u)),
    `access=${seen.length}`,
  )

  // ── 6. サーバープロセスの終了とポート解放 ──
  signalTree(child, 'SIGTERM')
  const exited = await waitForExit(child, 5000)
  if (!exited) {
    signalTree(child, 'SIGKILL')
    await waitForExit(child, 2000)
  }
  check('6. テスト後、サーバープロセスが終了する', exited || child.exitCode !== null || child.signalCode !== null)
  const freed = await canBind(ready.port)
  check('6. ポートが解放される（再バインド可能）', freed, `port=${ready.port}`)
  child.stdout?.destroy()
  child.stderr?.destroy()
  if (stderr.length > 0) {
    console.log(`  (子プロセス stderr: ${stderr.slice(0, 300).replace(/\n/g, ' ')})`)
  }

  console.log(`\nverify-p9-3-http: ${failed === 0 ? 'ALL PASSED' : `${failed} 件失敗`}`)
  if (failed > 0) {
    console.error(`NG: ${failed} 件失敗`)
    process.exitCode = 1
  }
}

if (process.argv.includes('--serve')) {
  void runServer()
} else {
  void main()
}