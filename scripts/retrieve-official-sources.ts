#!/usr/bin/env tsx
/**
 * 公式情報の手動取得ランナー（M6-F / 安定化・永続化対応）
 *
 * 【使い方】
 *   npx tsx scripts/retrieve-official-sources.ts --dry-run
 *     → 外部通信なし。URL 台帳・許可ホスト・再取得要否・provenance の確認のみ
 *       （デフォルト動作。保存物を書き換えない）。
 *   npx tsx scripts/retrieve-official-sources.ts --register <URL> \
 *     --title <タイトル> --organization <運営機関> --program-ids <制度ID,...> [--note "メモ"]
 *     → 明示的な許可を得た URL 候補を台帳に登録する（状態1・外部通信なし）。
 *       登録だけを行い、実取得は --url で別途実行する（未許可の URL を登録しない）。
 *   npx tsx scripts/retrieve-official-sources.ts --url <URL> [--force]
 *     → 台帳に登録済みの URL だけを取得（未登録 URL は拒否）。
 *       取得対象の検証（HTTPS 必須・内部ネットワーク禁止・robots.txt・
 *       サイズ/形式制限・リダイレクト検証）は sourceFetch が強制する。
 *       台帳への登録は「その URL への明示的な許可」なので、登録済み URL の
 *       取得に限りその URL のホストへのアクセスを許可する（新規ホストの
 *       初回取得＝状態2の記録が可能になる。台帳に無い URL は対象外のまま）。
 *       取得結果（URL・タイトル・取得日時・結果/失敗理由）を
 *       data/source-retrievals.json（取得ログ）に記録し、台帳の状態を
 *       data/source-ledger.json（台帳スナップショット）に保存する。
 *   npx tsx scripts/retrieve-official-sources.ts --confirm-official <URL> \
 *     --note "確認メモ" [--reviewed-at YYYY-MM-DD]
 *     → 到達記録のある URL を公式情報源と人手確認した記録（状態3）を台帳に
 *       保存する（外部通信なし）。この状態になって初めて許可ホストに加わり、
 *       発見パイプライン（scan / fetch）の取得対象になる。
 *   npx tsx scripts/retrieve-official-sources.ts --record-review <URL> \
 *     --fields <項目パス,...> [--note "メモ"] [--reviewed-at YYYY-MM-DD]
 *     → 制度内容の人手照合結果（状態6）を台帳に記録して保存する（外部通信なし）。
 *
 * 【方針】
 * - Web 全体の自動巡回はしない。台帳（lib/supports/sourceLedger.ts）に登録された
 *   URL のみ取得対象。実行タイミングはこのスクリプトの手動実行のみ。
 * - robots.txt・HTTPS・内部ネットワーク禁止・サイズ/形式制限は
 *   lib/supports/sourceFetch.ts が強制する。
 * - 本スクリプトの --url は「取得（状態4）」まで。制度内容の人手照合（状態6）は
 *   --record-review（recordManualContentReview）で記録する
 *   （AI の自己申告では照合済みにしない）。
 * - 台帳スナップショット（data/source-ledger.json）は次回起動時に復元する
 *   （識別情報はコード側の最新定義、状態は保存記録を優先）。
 *   読み込んだ JSON が壊れている場合は上書きせず中断する。
 * - ライブ AI API・INIAD API は一切呼ばない。API キーも不要。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createSourceFetcher,
  fetchTransport,
  type RetrievalRecord,
} from '../lib/supports/sourceFetch'
import {
  buildInitialLedger,
  createLedgerStore,
  markContentRetrieved,
  markOfficialConfirmed,
  markUrlReachable,
  needsContentRecheck,
  recordManualContentReview,
  type LedgerEntry,
} from '../lib/supports/sourceLedger'
import {
  RETRIEVAL_LOG_VERSION,
  appendRetrievalRecord,
  parseLedgerSnapshot,
  parseRetrievalLog,
  restoreLedgerEntries,
  serializeLedgerSnapshot,
  serializeRetrievalLog,
  type RetrievalLog,
} from '../lib/supports/sourceStore'

const args = process.argv.slice(2)
const force = args.includes('--force')

function argValue(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const registerUrl = argValue('--register')
const registerTitle = argValue('--title')
const registerOrganization = argValue('--organization')
const programIdsCsv = argValue('--program-ids')
const targetUrl = argValue('--url')
const confirmUrl = argValue('--confirm-official')
const reviewUrl = argValue('--record-review')
const fieldsCsv = argValue('--fields')
const reviewNote = argValue('--note') ?? ''
const reviewedAt = argValue('--reviewed-at') ?? new Date().toISOString().slice(0, 10)
const dryRun =
  targetUrl === undefined &&
  reviewUrl === undefined &&
  registerUrl === undefined &&
  confirmUrl === undefined

const RETRIEVAL_LOG_PATH = resolve(process.cwd(), 'data/source-retrievals.json')
const LEDGER_SNAPSHOT_PATH = resolve(process.cwd(), 'data/source-ledger.json')

/** 台帳スナップショットの復元（無ければ初期台帳。壊れている場合は上書きせず中断） */
function loadLedgerEntries(): LedgerEntry[] {
  if (!existsSync(LEDGER_SNAPSHOT_PATH)) return buildInitialLedger()
  const parsed = parseLedgerSnapshot(readFileSync(LEDGER_SNAPSHOT_PATH, 'utf8'))
  if (!parsed.ok) {
    throw new Error(
      `${LEDGER_SNAPSHOT_PATH} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
    )
  }
  console.log(`台帳スナップショットを復元しました（保存日時: ${parsed.value.savedAt}）`)
  return restoreLedgerEntries(parsed.value)
}

/** 台帳スナップショットの保存（プロセス終了後も保持するため） */
function saveLedgerEntries(entries: readonly LedgerEntry[]): void {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
  writeFileSync(
    LEDGER_SNAPSHOT_PATH,
    serializeLedgerSnapshot(entries, new Date().toISOString()),
    'utf8',
  )
  console.log(`台帳スナップショットを保存しました: ${LEDGER_SNAPSHOT_PATH}`)
}

/** 取得ログへの追記（壊れた JSON は既存ログを上書きせず中断） */
function appendRetrievalLog(record: RetrievalRecord): void {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true })
  let log: RetrievalLog = { version: RETRIEVAL_LOG_VERSION, savedAt: '', records: [] }
  if (existsSync(RETRIEVAL_LOG_PATH)) {
    const parsed = parseRetrievalLog(readFileSync(RETRIEVAL_LOG_PATH, 'utf8'))
    if (!parsed.ok) {
      throw new Error(
        `${RETRIEVAL_LOG_PATH} を解析できないため追記を中止します（既存のログは上書きしません）: ${parsed.error}`,
      )
    }
    log = parsed.value
  }
  writeFileSync(
    RETRIEVAL_LOG_PATH,
    serializeRetrievalLog(appendRetrievalRecord(log, record, new Date().toISOString())),
    'utf8',
  )
}

async function main(): Promise<void> {
  const store = createLedgerStore(loadLedgerEntries())
  const allowedHosts = store.allowedHosts()

  // URL 候補の登録（外部通信なし。明示的な許可を得た URL のみ登録する）
  if (registerUrl !== undefined) {
    if (
      registerTitle === undefined ||
      registerOrganization === undefined ||
      programIdsCsv === undefined
    ) {
      console.error('--register には --title / --organization / --program-ids を指定してください')
      process.exitCode = 1
      return
    }
    const programIds = programIdsCsv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const existing = store.getByUrl(registerUrl)
    if (existing !== null) {
      console.log(`台帳に登録済みの URL です（既存エントリを維持）: ${registerUrl}`)
      return
    }
    const entry = store.registerUrlCandidate({
      url: registerUrl,
      title: registerTitle,
      organization: registerOrganization,
      programIds,
      registeredAt: new Date().toISOString().slice(0, 10),
      ...(reviewNote !== '' ? { note: reviewNote } : {}),
    })
    saveLedgerEntries(store.list())
    console.log(
      [
        `URL 候補を台帳に登録しました: ${registerUrl}`,
        `  タイトル: ${entry.title} / 組織: ${entry.organization}`,
        `  関連制度: ${entry.programIds.join(', ') || '（なし）'}`,
        `  URL状態: ${entry.urlState}（公式性は未確認。取得は --url で実行してください）`,
      ].join('\n'),
    )
    return
  }

  // 公式情報源の確認（状態3・外部通信なし。到達記録のある URL のみ）
  if (confirmUrl !== undefined) {
    const entry = store.getByUrl(confirmUrl)
    if (entry === null) {
      console.error(`台帳に未登録の URL は公式確認の対象外です: ${confirmUrl}`)
      process.exitCode = 1
      return
    }
    if (reviewNote === '') {
      console.error('--confirm-official には --note で確認内容を指定してください')
      process.exitCode = 1
      return
    }
    store.update(entry.urlId, (e) =>
      markOfficialConfirmed(e, { confirmedAt: reviewedAt, note: reviewNote }),
    )
    saveLedgerEntries(store.list())
    const updated = store.get(entry.urlId)
    console.log(
      [
        `公式情報源と確認しました: ${confirmUrl}`,
        `  URL状態: ${updated?.urlState} / 確認日: ${updated?.officialConfirmedAt ?? ''}`,
        `  確認メモ: ${updated?.officialConfirmNote ?? ''}`,
        `  許可ホスト: ${store.allowedHosts().join(', ')}`,
      ].join('\n'),
    )
    return
  }

  // 人手照合の記録（外部通信なし。台帳スナップショットに保存する）
  if (reviewUrl !== undefined) {
    const entry = store.getByUrl(reviewUrl)
    if (entry === null) {
      console.error(`台帳に未登録の URL は照合記録の対象外です: ${reviewUrl}`)
      process.exitCode = 1
      return
    }
    const fields = (fieldsCsv ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '')
    if (fields.length === 0) {
      console.error('--fields に照合できた項目パス（カンマ区切り）を指定してください')
      process.exitCode = 1
      return
    }
    store.update(entry.urlId, (e) =>
      recordManualContentReview(e, {
        reviewedAt,
        fields,
        note: reviewNote,
        reviewer: 'manual',
      }),
    )
    saveLedgerEntries(store.list())
    const updated = store.get(entry.urlId)
    console.log(
      [
        `人手照合を記録しました: ${reviewUrl}`,
        `  照合済み項目: ${updated?.review.reviewedFields.join(', ') || '（なし）'}`,
        `  照合日: ${updated?.review.reviewedAt ?? ''} / 照合provenance: ${updated?.provenance.review ?? ''}`,
      ].join('\n'),
    )
    return
  }

  // transport を明示的に注入（グローバル fetch を暗黙に使わない）
  // ※ 取得対象の検証（HTTPS・内部ネットワーク禁止・robots.txt 等）は
  //   createSourceFetcher 側が強制する。台帳に登録済み（明示的に許可を得た）
  //   URL の取得に限り、その URL のホストへのアクセスを許可する。
  //   未登録 URL・未確認ホストのリンク探索は引き続き拒否される。

  if (dryRun) {
    console.log('=== 公式情報 URL 台帳（外部通信なし・dry-run） ===')
    for (const entry of store.list()) {
      console.log(
        [
          `- ${entry.url}`,
          `    組織: ${entry.organization}`,
          `    URL状態: ${entry.urlState} / 内容状態: ${entry.contentState}`,
          `    取得日時: ${entry.contentRetrievedAt ?? '（未取得）'}`,
          `    人手照合日: ${entry.review.reviewedAt ?? '（未照合）'} 照合項目: ${entry.review.reviewedFields.join(', ') || '（なし）'}`,
          `    provenance: 登録=${entry.provenance.registered} / 取得=${entry.provenance.retrieval ?? '（未取得）'} / 照合=${entry.provenance.review ?? '（未照合）'}`,
          `    再確認: ${needsContentRecheck(entry) ? '要' : '不要'}`,
        ].join('\n'),
      )
    }
    console.log(`\n許可ホスト（公式確認済みのみ）: ${allowedHosts.join(', ') || '（なし）'}`)
    console.log(
      'URL 候補の登録は --register <URL> --title <タイトル> --organization <運営機関> --program-ids <制度ID,...>、実取得は --url <URL>、公式情報源の確認は --confirm-official <URL> --note <確認メモ>、人手照合の記録は --record-review <URL> --fields <項目,...> を指定してください。',
    )
    return
  }

  if (targetUrl === undefined || targetUrl === '') {
    console.error('--url の値が指定されていません')
    process.exitCode = 1
    return
  }
  const entry = store.getByUrl(targetUrl)
  if (entry === null) {
    console.error(`台帳に未登録の URL は取得対象外です: ${targetUrl}`)
    process.exitCode = 1
    return
  }
  const fetcher = createSourceFetcher({
    transport: fetchTransport(globalThis.fetch),
    allowedHosts: new Set([
      ...allowedHosts,
      new URL(entry.url).hostname.toLowerCase(),
    ]),
  })

  console.log(`取得を実行します（${force ? '強制再取得' : 'キャッシュ優先'}）: ${targetUrl}`)
  const result = await fetcher.fetchUrl(targetUrl, { force })
  appendRetrievalLog(result.record)
  console.log(JSON.stringify(result.record, null, 2))
  if (!result.ok) {
    console.log(
      `取得に失敗しました（${result.record.result}）。未確認状態を維持し、以前の確認済みデータは上書きしません。`,
    )
  } else {
    console.log(`本文抜粋: ${result.page.excerpt}`)
    console.log(
      '※ これは取得（状態4）までです。制度内容の照合（状態6）は人手で行い、--record-review で記録してください。',
    )
  }
  // 台帳の取得記録を更新（成功時は到達・取得を記録。内容の照合状態は
  // 成功時のみ needs-review に。照合済みは上書きしない）
  store.update(entry.urlId, (e) => {
    const reached =
      result.ok && e.urlState === 'candidate-registered'
        ? markUrlReachable(e, result.record.retrievedAt)
        : e
    return markContentRetrieved(reached, {
      retrievedAt: result.record.retrievedAt,
      result: result.record.result,
      failureReason: result.record.failureReason,
      ...(result.ok ? { excerpt: result.page.excerpt } : {}),
    })
  })
  saveLedgerEntries(store.list())
  const updated = store.get(entry.urlId)
  console.log(
    `台帳更新後の状態: URL=${updated?.urlState} / 内容=${updated?.contentState} / 照合済み項目=${updated?.review.reviewedFields.join(', ') || '（なし）'} / 取得provenance=${updated?.provenance.retrieval ?? '（未取得）'}`,
  )
}

main().catch((err: unknown) => {
  console.error('実行に失敗しました:', err)
  process.exitCode = 1
})
