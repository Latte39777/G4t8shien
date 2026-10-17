/**
 * P9-1（レート制限の信頼性改善）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-p9-1.ts
 *
 * 確認項目:
 *   1. 期限切れの分単位エントリーが削除される
 *   2. 期限切れの日単位エントリーが削除される
 *   3. 有効な制限記録は掃除後も保持される（境界条件・時刻の巻き戻しを含む）
 *   4. 多キー（TRUST_PROXY=1 時の IP バケット）でもメモリが増え続けない
 *   5. レート制限拒否の Retry-After に判定結果の秒数が反映される
 *   6. レート制限以外のエラー挙動・レスポンス形式は変わらない
 *   7. 外部通信 0 回（globalThis.fetch をガードして 0 回であることを確認）
 *
 * 時間はすべて now 注入で進め、待機・実ネットワークアクセスは行わない。
 */
import {
  MemoryRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
} from '../lib/consult/rateLimit'
import { handleConsultRequest } from '../lib/consult/api'
import { ConsultSendError, userMessageForKind } from '../lib/consult/errors'
import type { ConsultProvider, ConsultReply } from '../lib/consult/types'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(
    `  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`,
  )
  if (!cond) failed += 1
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

/** 掃除結果を観測するための内部 Map アクセス（挙動は変えず結果のみ確認する） */
type LimiterInternals = {
  minuteBuckets: Map<string, number[]>
  dayBuckets: Map<string, number[]>
}
function internals(limiter: MemoryRateLimiter): LimiterInternals {
  return limiter as unknown as LimiterInternals
}

const okReply: ConsultReply = {
  text: 'テスト応答',
  isMock: false,
  hasUnverified: true,
  unsupported: true,
  relatedPrograms: [],
}

const liveProvider: ConsultProvider = {
  id: 'test-live',
  label: 'テスト用 Live',
  isMock: false,
  respond: () => Promise.resolve(okReply),
}

const mockProvider: ConsultProvider = {
  id: 'test-mock',
  label: 'テスト用モック',
  isMock: true,
  respond: () => Promise.resolve(okReply),
}

function fixedLimiter(decision: RateLimitDecision): RateLimiter {
  return { check: () => decision }
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = { message: 'テスト質問です', program: null, history: [] }


async function main(): Promise<void> {
  // ── 外部通信ガード（検証中の外部通信が 0 回であることを最後に確認する） ──
  const fetchCalls: string[] = []
  globalThis.fetch = ((input: unknown) => {
    fetchCalls.push(String(input))
    return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
  }) as typeof fetch

  const silentLogger: Pick<Console, 'warn' | 'error'> = {
    warn: () => undefined,
    error: () => undefined,
  }

  // ── 1. 期限切れの分単位エントリーの削除 ──
  section('1. 分単位ウィンドウの期限切れエントリー削除')
  const t0 = 1_000_000
  const l1 = new MemoryRateLimiter({
    perMinute: 5,
    perDay: 20,
    globalPerMinute: 1000,
  })
  l1.check('ip:old-a', t0)
  l1.check('ip:old-b', t0)
  l1.check('ip:keep', t0 + 30_000) // 掃除間隔未満のため掃除は走らない
  check(
    '掃除間隔内では記録が残る（3 キー）',
    internals(l1).minuteBuckets.size === 3,
    String(internals(l1).minuteBuckets.size),
  )
  l1.check('ip:other', t0 + 61_000) // 掃除間隔経過で sweep 実行
  const m1 = internals(l1).minuteBuckets
  check(
    '期限切れの分単位エントリーは削除される',
    !m1.has('ip:old-a') && !m1.has('ip:old-b'),
  )
  check(
    '有効な分単位記録は掃除後も保持される',
    (m1.get('ip:keep') ?? []).length === 1,
    JSON.stringify(m1.get('ip:keep') ?? null),
  )

  // ── 2. 期限切れの日単位エントリーの削除 ──
  section('2. 日単位ウィンドウの期限切れエントリー削除')
  check(
    '日次ウィンドウ内の記録は分単位が切れても保持される',
    internals(l1).dayBuckets.has('ip:old-a') &&
      (internals(l1).dayBuckets.get('ip:old-a') ?? []).length === 1,
  )
  l1.check('ip:z', t0 + DAY_MS + 61_000) // 日次も期限切れになった時点の sweep
  const d1 = internals(l1).dayBuckets
  check(
    '期限切れの日単位エントリーは削除される',
    !d1.has('ip:old-a') && !d1.has('ip:old-b') && !d1.has('ip:keep'),
  )

  // ── 3. 掃除の境界条件 ──
  section('3. 掃除の境界条件')
  const u0 = 5_000_000
  const l2 = new MemoryRateLimiter({
    perMinute: 5,
    perDay: 20,
    globalPerMinute: 1000,
  })
  l2.check('edge', u0) // 初回 sweep（空）
  l2.check('edge', u0 + 1)
  l2.check('other', u0 + MINUTE_MS) // sweep: cutoff = u0
  const m2 = internals(l2).minuteBuckets
  check(
    'ちょうど期限切れ（t == cutoff）は削除、その直後は保持',
    (m2.get('edge') ?? []).length === 1 && (m2.get('edge') ?? [])[0] === u0 + 1,
    JSON.stringify(m2.get('edge') ?? null),
  )
  l2.check('other', u0 - 10 * MINUTE_MS) // 時刻の巻き戻し（sweep はスキップされる）
  check(
    '時刻の巻き戻し時も有効な記録は保持される',
    (internals(l2).minuteBuckets.get('edge') ?? []).length === 1,
    JSON.stringify(internals(l2).minuteBuckets.get('edge') ?? null),
  )

  // ── 4. 多キー時のメモリ抑制（TRUST_PROXY=1 時の IP バケット想定） ──
  section('4. 多キー時の Map 抑制')
  const l3 = new MemoryRateLimiter({
    perMinute: 1000,
    perDay: 10_000,
    globalPerMinute: 10_000,
  })
  for (let i = 0; i < 50; i += 1) {
    l3.check(`ip:10.0.0.${i}`, t0)
  }
  check('50 キーが記録される', internals(l3).minuteBuckets.size === 50)
  l3.check('ip:new', t0 + 61_000) // sweep で期限切れ 50 キーを削除
  check(
    '参照されなくなったキーも次回 sweep で削除される',
    internals(l3).minuteBuckets.size === 1 &&
      internals(l3).minuteBuckets.has('ip:new'),
    String(internals(l3).minuteBuckets.size),
  )

  // ── 5. Retry-After ヘッダーの整合性 ──
  section('5. Retry-After ヘッダーの整合性')
  const callApi = (
    rateLimiter: RateLimiter,
    provider: ConsultProvider = liveProvider,
    now: number = t0,
  ): Promise<Response> =>
    handleConsultRequest(jsonRequest(validBody), {
      resolveProvider: () => provider,
      env: {},
      rateLimiter,
      now: () => now,
      logger: silentLogger,
    })
  const denied = (retryAfterSec: number): RateLimiter =>
    fixedLimiter({ allowed: false, retryAfterSec })

  const res7 = await callApi(denied(7))
  check(
    '拒否時の Retry-After に判定秒数がそのまま反映される（7 秒）',
    res7.status === 429 && res7.headers.get('retry-after') === '7',
    `${res7.status} / ${res7.headers.get('retry-after') ?? 'null'}`,
  )
  const resRound = await callApi(denied(2.5))
  check(
    '秒数は切り上げで正の整数になる（2.5 秒 → 3 秒）',
    resRound.headers.get('retry-after') === '3',
    resRound.headers.get('retry-after') ?? 'null',
  )
  const resSmall = await callApi(denied(0.4))
  check(
    '1 秒未満でも正の整数になる（0.4 秒 → 1 秒）',
    resSmall.headers.get('retry-after') === '1',
    resSmall.headers.get('retry-after') ?? 'null',
  )
  const resBad = await callApi(denied(Number.NaN))
  check(
    '不正値の場合は既定の 30 秒へフォールバック',
    resBad.headers.get('retry-after') === '30',
    resBad.headers.get('retry-after') ?? 'null',
  )
  const resMissing = await callApi(
    fixedLimiter({
      allowed: false,
      retryAfterSec: undefined as unknown as number,
    }),
  )
  check(
    '判定値が無い場合も既定の 30 秒',
    resMissing.headers.get('retry-after') === '30',
    resMissing.headers.get('retry-after') ?? 'null',
  )
  // 実 MemoryRateLimiter の判定秒数がヘッダに反映される（固定値でない証明）
  const realLimiter = new MemoryRateLimiter({
    perMinute: 1,
    perDay: 100,
    globalPerMinute: 100,
  })
  const realNow = 9_000_000
  const resFirst = await callApi(realLimiter, liveProvider, realNow)
  const resSecond = await callApi(realLimiter, liveProvider, realNow + 10_000)
  // 分窓の残り = ceil((realNow + 60000 - (realNow + 10000)) / 1000) = 50 秒
  check(
    '実リミッタの判定秒数が Retry-After に反映される（50 秒）',
    resFirst.status === 200 &&
      resSecond.status === 429 &&
      resSecond.headers.get('retry-after') === '50',
    `${resFirst.status}/${resSecond.status} / ${resSecond.headers.get('retry-after') ?? 'null'}`,
  )
  const body429 = (await res7.json()) as {
    error?: { kind?: string; message?: string }
  }
  check(
    '429 のレスポンス形式は不変（error.kind / error.message のみ）',
    body429.error?.kind === 'rate_limit' &&
      body429.error?.message === userMessageForKind('rate_limit'),
    JSON.stringify(body429),
  )

  // ── 6. レート制限以外の挙動は不変 ──
  section('6. レート制限以外の挙動は不変')
  const timeoutProvider: ConsultProvider = {
    id: 'test-timeout',
    label: 'テスト用タイムアウト',
    isMock: false,
    respond: () => Promise.reject(new ConsultSendError('timeout')),
  }
  const resTimeout = await callApi(
    fixedLimiter({ allowed: true, retryAfterSec: 0 }),
    timeoutProvider,
  )
  check(
    'タイムアウト（504）に Retry-After は付かない',
    resTimeout.status === 504 && resTimeout.headers.get('retry-after') === null,
  )
  const resValidation = await handleConsultRequest(
    new Request('http://localhost/api/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    }),
    {
      resolveProvider: () => liveProvider,
      env: {},
      rateLimiter: fixedLimiter({ allowed: true, retryAfterSec: 0 }),
      now: () => t0,
      logger: silentLogger,
    },
  )
  check(
    '入力不正（400）に Retry-After は付かない',
    resValidation.status === 400 &&
      resValidation.headers.get('retry-after') === null,
  )
  const resAllowed = await callApi(
    fixedLimiter({ allowed: true, retryAfterSec: 0 }),
  )
  check(
    '許可時は 200・Retry-After なしで応答形式は不変',
    resAllowed.status === 200 && resAllowed.headers.get('retry-after') === null,
  )
  const resMock = await callApi(denied(5), mockProvider)
  check(
    'モック時はレート制限を適用しない（既存挙動の維持）',
    resMock.status === 200 && resMock.headers.get('retry-after') === null,
  )

  // ── 7. 外部通信ゼロ ──
  section('7. 外部通信の監視')
  check(
    '検証中の外部通信は 0 回（fetch 未使用）',
    fetchCalls.length === 0,
    fetchCalls.join(', '),
  )

  console.log(
    `\nP9-1 検証: ${failed === 0 ? 'すべてのチェックに合格しました' : `${failed} 件失敗`}`,
  )
  if (failed > 0) {
    process.exitCode = 1
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
