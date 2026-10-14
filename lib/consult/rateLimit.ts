/**
 * /api/consult のレート制限（M6）
 *
 * 【実行環境の制約（重要）】
 * - Next.js の Route Handler が受け取る Request は Web Request API 準拠で、
 *   TCP 接続元 IP は取得できない（NextRequest の `ip` / `geo` は
 *   v15.0.0 で削除済み。公式ドキュメントの Version History 参照）。
 * - X-Forwarded-For 等のヘッダはクライアントが偽装できるため、
 *   信頼できるプロキシ配下であることが確認できる構成でのみ使用する。
 * - したがって既定（CONSULT_TRUST_PROXY != '1'）ではヘッダを信用せず、
 *   全リクエストを共有バケットにまとめて制限する（IP 単位の制限はしない）。
 *   これは安全側の設計：個別の誤検知は起きるが、API コストの暴発を防ぐ。
 * - メモリ実装のため開発・単一インスタンス専用。マルチインスタンス/
 *   本番公開前に永続化ストア（Redis 等）への差し替えが必須（未解決事項）。
 */
import {
  ConsultSendError,
} from './errors'

export type RateLimitDecision = {
  allowed: boolean
  /** 拒否時の待機秒数 */
  retryAfterSec: number
}

/** レートリミッタのインターフェース（実装差し替え可能） */
export type RateLimiter = {
  check(key: string, now: number): RateLimitDecision
}

export type ClientKeyResolution = {
  key: string
  basis: 'forwarded-trusted' | 'shared'
}

export type RateLimitConfig = {
  perMinute: number
  perDay: number
  globalPerMinute: number
}

/** 暫定値（大学 API のレート上限確認後に要調整） */
export function parseRateLimitConfig(
  env: Record<string, string | undefined>,
): RateLimitConfig {
  const num = (value: string | undefined, fallback: number): number => {
    const n = Number.parseInt(value ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    perMinute: num(env.CONSULT_RATE_LIMIT_RPM, 10),
    perDay: num(env.CONSULT_RATE_LIMIT_PER_DAY, 100),
    globalPerMinute: num(env.CONSULT_RATE_LIMIT_GLOBAL_PER_MIN, 30),
  }
}

const IP_LIKE = /^[0-9A-Fa-f:.]{2,45}$/

/**
 * クライアント識別キーの解決。
 *
 * - CONSULT_TRUST_PROXY=1 のときだけ X-Forwarded-For を使用する。
 *   これは「全トラフィックが信頼できるプロキシを経由する」ことを
 *   運用で保証できる構成に限定してよい（直接接続が混ざる場合は
 *   ヘッダ偽装で別バケットに分散できてしまう）。
 * - それ以外・判定不能時は 'shared'（共有バケット）。
 */
export function resolveClientKey(
  headers: Headers,
  env: Record<string, string | undefined>,
): ClientKeyResolution {
  if (env.CONSULT_TRUST_PROXY === '1') {
    const hops = Number.parseInt(env.CONSULT_TRUSTED_PROXY_HOPS ?? '1', 10)
    const n = Number.isFinite(hops) && hops >= 1 ? hops : 1
    const xff = headers.get('x-forwarded-for')
    if (xff) {
      const parts = xff
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      // 右から n 番目 = 信頼プロキシが付与した接続元アドレス
      const candidate = parts[parts.length - n]
      if (candidate && IP_LIKE.test(candidate)) {
        return { key: `ip:${candidate}`, basis: 'forwarded-trusted' }
      }
    }
  }
  return { key: 'shared', basis: 'shared' }
}

/** クライアント識別子の解決結果に応じたレート制限エラー */
export function rateLimitError(): ConsultSendError {
  return new ConsultSendError('rate_limit')
}

/**
 * メモリ内スライディングウィンドウ実装（開発・単一インスタンス専用）。
 * - キー単位: perMinute / perDay
 * - 全体セーフシーリング: globalPerMinute（共有バケット誤爆時の全体暴発防止）
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly minuteBuckets = new Map<string, number[]>()
  private readonly dayBuckets = new Map<string, number[]>()
  private readonly globalMinute: number[] = []

  constructor(
    private readonly config: RateLimitConfig = {
      perMinute: 10,
      perDay: 100,
      globalPerMinute: 30,
    },
  ) {}

  check(key: string, now: number): RateLimitDecision {
    const MINUTE_MS = 60_000
    const DAY_MS = 86_400_000

    const minute = this.prune(this.minuteBuckets.get(key) ?? [], now - MINUTE_MS)
    const day = this.prune(this.dayBuckets.get(key) ?? [], now - DAY_MS)
    this.pruneGlobal(now - MINUTE_MS)

    const deny = (retryAfterSec: number): RateLimitDecision => ({
      allowed: false,
      retryAfterSec,
    })

    if (minute.length >= this.config.perMinute) {
      const oldest = minute[0]
      return deny(Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000)))
    }
    if (day.length >= this.config.perDay) {
      const oldest = day[0]
      return deny(Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000)))
    }
    if (this.globalMinute.length >= this.config.globalPerMinute) {
      const oldest = this.globalMinute[0]
      return deny(Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000)))
    }

    minute.push(now)
    day.push(now)
    this.globalMinute.push(now)
    this.minuteBuckets.set(key, minute)
    this.dayBuckets.set(key, day)
    return { allowed: true, retryAfterSec: 0 }
  }

  private prune(list: number[], cutoff: number): number[] {
    const kept = list.filter((t) => t > cutoff)
    return kept
  }

  private pruneGlobal(cutoff: number): void {
    while (this.globalMinute.length > 0 && this.globalMinute[0] <= cutoff) {
      this.globalMinute.shift()
    }
  }
}

let defaultLimiter: MemoryRateLimiter | null = null

/** 既定リミッタ（プロセス内で共有。env は初回呼び出し時の値で確定） */
export function getDefaultRateLimiter(
  env: Record<string, string | undefined> = process.env,
): RateLimiter {
  if (defaultLimiter === null) {
    defaultLimiter = new MemoryRateLimiter(parseRateLimitConfig(env))
  }
  return defaultLimiter
}