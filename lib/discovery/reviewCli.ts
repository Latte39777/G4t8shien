/**
 * 制度候補の検証・承認・公開 CLI（M7-E）実装本体
 *
 * 【コマンド】（実行エントリは scripts/discovery.ts。ここはテスト可能な実装）
 * - candidates [--status <s>] [candidateId]  … 候補一覧 / 詳細表示
 * - recheck                                 … 再取得・再抽出・再確認が必要な候補の識別
 * - verify-field <id> --field --value --quote --by  … 項目単位の根拠確認の記録
 * - request-recheck <id> --by --reason       … 要再確認への遷移（再確認の要求）
 * - discard <id> --by --reason               … 候補の却下
 * - restore <id> --by --reason               … 却下済み候補の復帰（再承認の条件）
 * - approve <id> --by --reason               … 公開承認（根拠確認が揃った候補のみ）
 * - publish <id> --by --reason [--update <programId>] [--supersedes <programId>]
 *                                            … 承認済み候補の公開用データへの変換と反映
 * - audit [candidateId]                      … 監査履歴の表示
 * - verify                                   … 状態・出典・根拠の検証（ハッシュ変更の反映）
 *
 * 【安全原則】
 * - 状態変更は候補 ID の厳密照合・理由・操作者・操作日時・変更前後を監査に残す。
 * - 存在しない候補 ID・不正な状態遷移・壊れた保存物は受け付けない。
 * - 公開（programs.json への反映）は approve と分離した明示的操作のみ。
 *   バックアップを取ってから書き込み、失敗時は既存データを保全する。
 * - 秘密情報・API キーはログに出力しない。この CLI は外部通信を一切行わない。
 */
import { resolve } from 'node:path'
import type { DiscoveryCliDeps, DiscoveryFileOps, ParsedArgs } from './cli'
import {
  CANDIDATE_STORE_FILE,
  PAGE_STORE_FILE,
  parseCandidateStore,
  parsePageStore,
  serializeCandidateStore,
  type CandidateStore,
  type DiscoveryCandidate,
  type DiscoveryCandidateStatus,
  type PageRecord,
  type PageStore,
} from './discoveryStore'
import {
  CANDIDATE_STATUS_LABELS,
  appendAuditEntries,
  applyStatusChange,
  currentFieldVerifications,
  detectRecheckNeeds,
  emptyReviewAuditStore,
  evaluateEvidenceGate,
  makeAuditEntry,
  normalizeStatusName,
  parseReviewAuditStore,
  recordFieldVerification,
  serializeReviewAuditStore,
  type AuditEntry,
  type ReviewAuditStore,
} from './reviewStore'
import {
  buildPublishedPrograms,
  evaluatePublishGate,
  serializeProgramsFile,
} from './publish'
import {
  ProgramStoreError,
  parseProgramStoreJson,
} from '../supports/programStore'
import type { SupportProgram } from '../types/support'

type Load<T> = { ok: true; value: T } | { ok: false; error: string }

function storePaths(deps: DiscoveryCliDeps, args: ParsedArgs) {
  return {
    candPath: resolve(deps.cwd, args.dataDir, CANDIDATE_STORE_FILE.replace('data/discovery/', '')),
    pagePath: resolve(deps.cwd, args.dataDir, PAGE_STORE_FILE.replace('data/discovery/', '')),
    auditPath: resolve(deps.cwd, args.dataDir, 'audit-log.json'),
    programsPath: resolve(deps.cwd, args.programs),
  }
}

function loadCandidates(files: DiscoveryFileOps, path: string): Load<CandidateStore> {
  if (!files.exists(path)) {
    return {
      ok: true,
      value: { formatVersion: 1, savedAt: '', candidates: [] },
    }
  }
  const parsed = parseCandidateStore(files.read(path))
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${path} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
    }
  }
  return parsed
}

function loadPages(files: DiscoveryFileOps, path: string): Load<PageStore> {
  if (!files.exists(path)) {
    return { ok: true, value: { formatVersion: 1, savedAt: '', pages: [] } }
  }
  const parsed = parsePageStore(files.read(path))
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${path} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
    }
  }
  return parsed
}

function loadAudit(files: DiscoveryFileOps, path: string): Load<ReviewAuditStore> {
  if (!files.exists(path)) return { ok: true, value: emptyReviewAuditStore() }
  const parsed = parseReviewAuditStore(files.read(path))
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${path} を復元できないため中断します（保存物は上書きしません）: ${parsed.error}`,
    }
  }
  return parsed
}

function loadPrograms(files: DiscoveryFileOps, path: string): Load<SupportProgram[]> {
  if (!files.exists(path)) return { ok: true, value: [] }
  try {
    return { ok: true, value: parseProgramStoreJson(files.read(path), path) }
  } catch (error) {
    if (error instanceof ProgramStoreError) {
      return { ok: false, error: `${path} を復元できないため中断します（保存物は上書きしません）: ${error.message}` }
    }
    return { ok: false, error: `公開先データの読み込みに失敗しました: ${(error as Error).message}` }
  }
}

/** 候補 ID の厳密照合（部分一致はしない） */
function findCandidate(
  store: CandidateStore,
  candidateId: string,
): DiscoveryCandidate | null {
  return store.candidates.find((c) => c.candidateId === candidateId) ?? null
}

function pageOf(pages: PageStore, url: string): PageRecord | null {
  return pages.pages.find((p) => p.url === url) ?? null
}

/** ISO 8601 日時（now() から） */
function isoOf(now: Date): string {
  return now.toISOString()
}

/** YYYY-MM-DD（確認日用） */
function dateOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function compactStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** 監査履歴の保存（追記。壊れている場合は中断して保存物を保全する） */
function saveAudit(
  deps: DiscoveryCliDeps,
  path: string,
  store: ReviewAuditStore,
  now: Date,
): void {
  deps.files.write(
    path,
    serializeReviewAuditStore({ ...store, savedAt: isoOf(now) }),
  )
}

/** 監査エントリを追記して保存する */
function appendAndSaveAudit(
  deps: DiscoveryCliDeps,
  path: string,
  store: ReviewAuditStore,
  entries: readonly AuditEntry[],
  now: Date,
): ReviewAuditStore {
  const next = appendAuditEntries(store, entries)
  saveAudit(deps, path, next, now)
  return next
}

// ── candidates: 候補一覧 / 詳細表示 ──────────────────────────────

/** ページ記録を検知判定用の形に変換 */
function toPageView(
  pages: PageStore,
  url: string,
): { extractState: string; contentHash: string | null; text: string } | null {
  const page = pageOf(pages, url)
  if (page === null) return null
  return {
    extractState: page.extractState,
    contentHash: page.contentHash,
    text: page.text,
  }
}

function runCandidates(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const paths = storePaths(deps, args)
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const pageStore = loadPages(deps.files, paths.pagePath)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }

  // 詳細表示（候補 ID 指定）
  const idArg = args.positional[0] ?? null
  if (idArg !== null) {
    const candidate = findCandidate(candStore.value, idArg)
    if (candidate === null) {
      log(`候補 ID「${idArg}」は存在しません（厳密一致のみ受け付けます）`)
      return 1
    }
    logCandidateDetail(log, candidate, pageStore.value)
    return 0
  }

  // 一覧（--status で絞り込み）
  let statusFilter: DiscoveryCandidateStatus | null = null
  if (args.status !== null) {
    const parsed = normalizeStatusName(args.status)
    if (parsed === null) {
      log(`不正な状態です: ${args.status}（unverified / needs-recheck / approved / discarded）`)
      return 1
    }
    statusFilter = parsed
  }
  const candidates = candStore.value.candidates
    .filter((c) => statusFilter === null || c.status === statusFilter)
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  log(
    `=== 制度候補一覧（${statusFilter === null ? '全状態' : CANDIDATE_STATUS_LABELS[statusFilter]}）: ${candidates.length} 件 ===`,
  )
  for (const c of candidates) {
    const recheck = detectRecheckNeeds(c, toPageView(pageStore.value, c.sourceUrl))
    const mark = recheck !== null ? ` [要対応: ${recheck.need}]` : ''
    log(
      `  ${c.candidateId}  ${CANDIDATE_STATUS_LABELS[c.status]}  ${c.name}（${c.regionId}/${c.fieldId}）${mark}`,
    )
  }
  if (candidates.length === 0) {
    log('  （該当する候補はありません）')
  }
  log('詳細: npx tsx scripts/discovery.ts candidates <candidateId>')
  return 0
}

/** 候補の詳細表示（検証に必要な情報をすべて表示する） */
function logCandidateDetail(
  log: (line: string) => void,
  c: DiscoveryCandidate,
  pages: PageStore,
): void {
  const page = pageOf(pages, c.sourceUrl)
  log(`=== 制度候補 ${c.candidateId} ===`)
  log(`  制度名      : ${c.name}`)
  log(`  実施主体    : ${c.implementer ?? '（未確認）'}`)
  log(`  対象地域    : ${c.regionScope ?? '（未確認）'}（調査タスク地域: ${c.regionId}）`)
  log(`  支援種別    : ${c.kind ?? '（未確認。給付・減免・貸付・税のいずれかが必要）'}`)
  log(`  概要        : ${c.summary ?? '（未確認）'}`)
  log('  [出典・根拠]')
  log(`    公式URL   : ${c.sourceUrl}`)
  log(`    情報源台帳: ${c.sourceRecordId ?? '（紐付く台帳記録なし）'}`)
  log(`    取得日時  : ${c.retrievedAt}`)
  log(`    本文ハッシュ(抽出時): ${c.contentHash}`)
  log(
    `    本文ハッシュ(現在)  : ${page?.contentHash ?? '（ページ記録なし）'}${page !== null && page.contentHash === c.contentHash ? '（一致）' : '（不一致→要再確認）'}`,
  )
  log(`    抽出      : ${c.extractionModel} / ${c.extractedAt}（発見: ${c.firstExtractedAt}）`)
  log(`    抽出状態  : ${page?.extractState ?? '（ページ記録なし）'}`)
  log('  [根拠となる本文抜粋]')
  if (c.evidenceQuotes.length === 0) {
    log('    （抜粋なし。根拠が不足しています）')
  }
  for (const q of c.evidenceQuotes) {
    const inPage = page !== null && q.quote.trim() !== '' && page.text.includes(q.quote.trim())
    log(`    - ${q.field}: ${q.quote}${inPage ? '' : '（現本文に見つからない→要再確認）'}`)
  }
  log('  [抽出された値]')
  log(`    金額      : ${c.amount.value ?? '（未確認）'} ${c.amount.unit ?? ''} ${c.amount.description ?? ''}`)
  log(`    対象年齢  : ${c.eligibility.ageNote ?? '（未確認）'}`)
  log(`    世帯要件  : ${c.eligibility.householdNote ?? '（未確認）'}`)
  log(`    所得要件  : ${c.eligibility.incomeNote ?? '（未確認）'}`)
  log(`    申請期限  : ${c.application.deadlineNote ?? '（未確認）'}`)
  log(`    適用年度  : ${c.fiscalYear ?? '（未確認）'}`)
  log(`    有効期間  : ${c.validPeriod ?? '（未確認）'}`)
  log(`    申請方法  : ${c.application.how ?? '（未確認）'}`)
  log(
    `    必要書類  : ${c.application.documents.length > 0 ? c.application.documents.join(' / ') : '（未確認）'}`,
  )
  log('  [未確認項目]')
  const unconfirmed = c.unconfirmedItems.map((i) => `${i.field}: ${i.reason}`)
  for (const u of c.unknownItems) unconfirmed.push(`（AI不明）${u}`)
  if (unconfirmed.length === 0) log('    （なし）')
  for (const u of unconfirmed) log(`    - ${u}`)
  log('  [項目ごとの根拠確認]')
  const valid = page === null ? [] : currentFieldVerifications(c, page.contentHash)
  const staleCount = (c.fieldVerifications ?? []).length - valid.length
  if ((c.fieldVerifications ?? []).length === 0) {
    log('    （確認記録なし。verify-field で項目単位に確認してください）')
  }
  for (const v of c.fieldVerifications ?? []) {
    const effective = v.contentHash === page?.contentHash
    log(
      `    - ${v.field} = ${v.value}（${v.reviewedBy} ${v.reviewedAt}${effective ? '' : ' / 失効: ハッシュ不一致'}）根拠: ${v.evidenceQuote.slice(0, 60)}`,
    )
  }
  if (staleCount > 0) log(`    ※ 失効した確認記録 ${staleCount} 件は引き継がれません`)
  const gate = evaluateEvidenceGate(
    c,
    page === null ? null : { text: page.text, contentHash: page.contentHash },
  )
  log(`    重要項目の確認状況: ${gate.ok ? 'すべて確認済み' : `不足 ${gate.failures.length} 件`}`)
  for (const f of gate.failures) log(`      - ${f}`)
  log('  [検証状態]')
  log(`    状態      : ${CANDIDATE_STATUS_LABELS[c.status]}（${c.status}）`)
  if (c.recheckReason !== null) log(`    要再確認理由: ${c.recheckReason}`)
  if (c.publication !== undefined) {
    log(
      `    公開済み  : ${c.publication.programId}（${c.publication.mode} / ${c.publication.publishedAt}）`,
    )
    if (c.publication.supersedesProgramIds.length > 0) {
      log(`    後継に切替: ${c.publication.supersedesProgramIds.join(', ')}`)
    }
  } else {
    log('    公開      : 未公開（approve → publish まで未実施）')
  }
  log('  [警告・エラー]')
  const need = detectRecheckNeeds(c, toPageView(pages, c.sourceUrl))
  if (need !== null) {
    log(`    - ${need.need}: ${need.reason}`)
  } else {
    log('    （なし）')
  }
  log('  ※ これは未検証/検証中の候補であり、確定制度データではありません')
}

// ── verify-field: 項目単位の根拠確認 ─────────────────────────────

function runVerifyField(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const now = deps.now ? deps.now() : new Date()
  const paths = storePaths(deps, args)
  const candidateId = args.positional[0] ?? null
  if (candidateId === null) {
    log('使い方: verify-field <candidateId> --field <項目> --value <値> --quote <本文抜粋> --by <確認者>')
    return 1
  }
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const pageStore = loadPages(deps.files, paths.pagePath)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }
  const candidate = findCandidate(candStore.value, candidateId)
  if (candidate === null) {
    log(`候補 ID「${candidateId}」は存在しません（厳密一致のみ受け付けます）`)
    return 1
  }
  const page = pageOf(pageStore.value, candidate.sourceUrl)
  if (page === null) {
    log('取得済みページ本文が見つからないため、根拠を照合できません（fetch で再取得してください）')
    return 1
  }
  const result = recordFieldVerification(candidate, {
    field: args.field ?? '',
    value: args.value ?? '',
    evidenceQuote: args.quote ?? '',
    actor: args.by ?? '',
    at: isoOf(now),
    pageText: page.text,
    pageContentHash: page.contentHash,
    note: args.reason,
  })
  if (!result.ok) {
    log(`確認を記録できません: ${result.error}`)
    return 1
  }
  const nextCandidates: CandidateStore = {
    ...candStore.value,
    savedAt: isoOf(now),
    candidates: candStore.value.candidates.map((c) =>
      c.candidateId === candidateId ? result.candidate : c,
    ),
  }
  deps.files.write(paths.candPath, serializeCandidateStore(nextCandidates))
  const auditStore = loadAudit(deps.files, paths.auditPath)
  if (!auditStore.ok) {
    log(auditStore.error)
    return 1
  }
  appendAndSaveAudit(deps, paths.auditPath, auditStore.value, [result.auditEntry], now)
  log(
    `確認を記録しました: ${candidateId} / ${result.auditEntry.fields.join(', ')} = ${args.value}（${args.by} / ${isoOf(now)}）`,
  )
  log(`※ 確認者「${args.by}」による照合記録です（抜粋の本文実在・値一致を機械照合）。AI の自己申告だけでは確認済みになりません`)
  return 0
}

// ── 状態変更（request-recheck / discard / restore / approve）────

function runStatusChange(
  args: ParsedArgs,
  deps: DiscoveryCliDeps,
  to: DiscoveryCandidateStatus,
  commandName: string,
): number {
  const log = deps.log
  const now = deps.now ? deps.now() : new Date()
  const paths = storePaths(deps, args)
  const candidateId = args.positional[0] ?? null
  if (candidateId === null) {
    log(`使い方: ${commandName} <candidateId> --by <操作者> --reason <変更理由>`)
    return 1
  }
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const candidate = findCandidate(candStore.value, candidateId)
  if (candidate === null) {
    log(`候補 ID「${candidateId}」は存在しません（厳密一致のみ受け付けます）`)
    return 1
  }

  // まず状態遷移の妥当性を検証（不正な遷移・却下済みからの直接承認は拒否）
  const changed = applyStatusChange(candidate, {
    to,
    actor: args.by ?? '',
    reason: args.reason ?? '',
    at: isoOf(now),
  })
  if (!changed.ok) {
    log(`状態を変更できません: ${changed.error}`)
    return 1
  }

  // approve は根拠確認ゲート（重要項目の人手確認）が前提
  if (to === 'approved') {
    const pageStore = loadPages(deps.files, paths.pagePath)
    if (!pageStore.ok) {
      log(pageStore.error)
      return 1
    }
    const page = pageOf(pageStore.value, candidate.sourceUrl)
    const gate = evaluateEvidenceGate(
      candidate,
      page === null ? null : { text: page.text, contentHash: page.contentHash },
    )
    if (!gate.ok) {
      log(`公開承認を拒否します（根拠が不足しています）: ${candidateId}`)
      for (const f of gate.failures) log(`  - ${f}`)
      log('verify-field で項目単位に根拠を確認してから再度お試しください')
      return 1
    }
  }
  const nextCandidates: CandidateStore = {
    ...candStore.value,
    savedAt: isoOf(now),
    candidates: candStore.value.candidates.map((c) =>
      c.candidateId === candidateId ? changed.candidate : c,
    ),
  }
  deps.files.write(paths.candPath, serializeCandidateStore(nextCandidates))
  const auditStore = loadAudit(deps.files, paths.auditPath)
  if (!auditStore.ok) {
    log(auditStore.error)
    return 1
  }
  appendAndSaveAudit(deps, paths.auditPath, auditStore.value, [changed.auditEntry], now)
  log(
    `${commandName}: ${candidateId} ${CANDIDATE_STATUS_LABELS[changed.auditEntry.fromStatus ?? candidate.status]} → ${CANDIDATE_STATUS_LABELS[to]}（${args.by} / ${isoOf(now)}）`,
  )
  log(`  理由: ${args.reason}`)
  return 0
}

// ── recheck: 再取得・再抽出・再確認が必要な候補の識別 ─────────────

function runRecheck(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const paths = storePaths(deps, args)
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const pageStore = loadPages(deps.files, paths.pagePath)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }
  log('=== 根拠の再取得・再抽出・再確認が必要な候補（外部通信なし） ===')
  let count = 0
  for (const c of [...candStore.value.candidates].sort((a, b) =>
    a.candidateId.localeCompare(b.candidateId),
  )) {
    const need = detectRecheckNeeds(c, toPageView(pageStore.value, c.sourceUrl))
    if (need === null) continue
    count += 1
    log(`  ${c.candidateId}（${CANDIDATE_STATUS_LABELS[c.status]}）${c.name}`)
    log(`    ${need.need}: ${need.reason}`)
  }
  // ハッシュ不一致でも確認記録の失効状況も併せて報告
  for (const c of candStore.value.candidates) {
    const page = pageOf(pageStore.value, c.sourceUrl)
    if (page === null) continue
    const stale = (c.fieldVerifications ?? []).filter(
      (v) => v.contentHash !== page.contentHash,
    )
    if (stale.length > 0) {
      log(`  ${c.candidateId}: 失効した確認記録 ${stale.length} 件（再確認が必要: ${stale.map((v) => v.field).join(', ')}）`)
    }
  }
  if (count === 0) log('  （該当する候補はありません）')
  return 0
}

// ── verify: 状態・出典・根拠の検証（ハッシュ変更の反映） ─────────

function runVerify(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const now = deps.now ? deps.now() : new Date()
  const paths = storePaths(deps, args)
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const pageStore = loadPages(deps.files, paths.pagePath)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }
  const auditStore = loadAudit(deps.files, paths.auditPath)
  if (!auditStore.ok) {
    log(auditStore.error)
    return 1
  }
  log('=== 候補の検証: 状態・出典・根拠（外部通信なし） ===')
  let problems = 0
  const transitions: DiscoveryCandidate[] = []
  const auditEntries: AuditEntry[] = []
  for (const c of candStore.value.candidates) {
    // 状態: スキーマ検証は読み込み時に済み（壊れたデータはここまで来ない）
    // 出典
    if (c.sourceUrl.trim() === '') {
      problems += 1
      log(`  ${c.candidateId}: 出典エラー — 公式 URL が記録されていません`)
    }
    // 根拠: 抜粋が現本文に実在するか
    const page = pageOf(pageStore.value, c.sourceUrl)
    if (page !== null) {
      for (const q of c.evidenceQuotes) {
        if (q.quote.trim() === '' || !page.text.includes(q.quote.trim())) {
          problems += 1
          log(`  ${c.candidateId}: 根拠エラー — 抜粋（${q.field}）が現本文に見つかりません`)
        }
      }
    }
    // ハッシュ変更 → 要再確認へ（過去の確認は引き継がない）
    const need = detectRecheckNeeds(c, toPageView(pageStore.value, c.sourceUrl))
    if (need !== null && need.need === 're-verify' && c.status !== 'discarded' && c.status !== 'needs-recheck') {
      const changed = applyStatusChange(c, {
        to: 'needs-recheck',
        actor: 'pipeline',
        reason: need.reason,
        at: isoOf(now),
      })
      if (changed.ok) {
        transitions.push(changed.candidate)
        auditEntries.push(
          changed.auditEntry,
          makeAuditEntry({
            at: isoOf(now),
            candidateId: c.candidateId,
            action: 'recheck-detected',
            actor: 'pipeline',
            reason: need.reason,
            fromStatus: c.status,
            toStatus: 'needs-recheck',
            pageUrl: c.sourceUrl,
            fields: [],
            programId: null,
            details: `抽出時ハッシュ ${c.contentHash} → 現在 ${page?.contentHash ?? '（なし）'}`,
          }),
        )
        log(`  ${c.candidateId}: 要再確認へ移行（${need.reason}）`)
      }
    }
  }
  if (transitions.length > 0) {
    const nextCandidates: CandidateStore = {
      ...candStore.value,
      savedAt: isoOf(now),
      candidates: candStore.value.candidates.map(
        (c) => transitions.find((t) => t.candidateId === c.candidateId) ?? c,
      ),
    }
    deps.files.write(paths.candPath, serializeCandidateStore(nextCandidates))
    appendAndSaveAudit(deps, paths.auditPath, auditStore.value, auditEntries, now)
    log(`要再確認へ移行: ${transitions.length} 件（監査に記録しました）`)
  }
  log(`検証結果: 問題 ${problems} 件 / 要再確認への移行 ${transitions.length} 件`)
  // 問題・要再確認への移行がある場合は非 0（対応が必要であることを示す）
  return problems > 0 || transitions.length > 0 ? 1 : 0
}

// ── audit: 監査履歴の表示 ───────────────────────────────────────

function runAudit(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const paths = storePaths(deps, args)
  const auditStore = loadAudit(deps.files, paths.auditPath)
  if (!auditStore.ok) {
    log(auditStore.error)
    return 1
  }
  const candidateId = args.positional[0] ?? null
  const entries = auditStore.value.entries
    .filter((e) => candidateId === null || e.candidateId === candidateId)
    .sort((a, b) => a.at.localeCompare(b.at))
  log(`=== 監査履歴（${candidateId ?? '全候補'}）: ${entries.length} 件 ===`)
  for (const e of entries) {
    const status =
      e.fromStatus !== null || e.toStatus !== null
        ? ` [${e.fromStatus ?? '-'} → ${e.toStatus ?? '-'}]`
        : ''
    log(`  ${e.at} ${e.action}${status} by ${e.actor}`)
    log(`    ${e.candidateId}: ${e.reason}`)
    if (e.pageUrl !== null) log(`    出典: ${e.pageUrl}`)
    if (e.fields.length > 0) log(`    項目: ${e.fields.join(', ')}`)
    if (e.programId !== null) log(`    制度ID: ${e.programId}`)
    if (e.details !== null) log(`    ${e.details}`)
    log(`    監査ID: ${e.auditId}`)
  }
  if (entries.length === 0) log('  （記録はありません）')
  log('※ AI の自己申告は監査記録になりません（人手操作・機械的検知のみ記録）')
  return 0
}

// ── publish: 承認済み候補の公開用データへの変換と反映 ─────────────

function runPublish(args: ParsedArgs, deps: DiscoveryCliDeps): number {
  const log = deps.log
  const now = deps.now ? deps.now() : new Date()
  const paths = storePaths(deps, args)
  const candidateId = args.positional[0] ?? null
  if (candidateId === null) {
    log('使い方: publish <candidateId> --by <操作者> --reason <公開理由> [--update <programId>] [--supersedes <programId>]')
    return 1
  }
  const candStore = loadCandidates(deps.files, paths.candPath)
  if (!candStore.ok) {
    log(candStore.error)
    return 1
  }
  const pageStore = loadPages(deps.files, paths.pagePath)
  if (!pageStore.ok) {
    log(pageStore.error)
    return 1
  }
  const programStore = loadPrograms(deps.files, paths.programsPath)
  if (!programStore.ok) {
    log(programStore.error)
    return 1
  }
  const auditStore = loadAudit(deps.files, paths.auditPath)
  if (!auditStore.ok) {
    log(auditStore.error)
    return 1
  }
  const candidate = findCandidate(candStore.value, candidateId)
  if (candidate === null) {
    log(`候補 ID「${candidateId}」は存在しません（厳密一致のみ受け付けます）`)
    return 1
  }
  const actor = (args.by ?? '').trim()
  const reason = (args.reason ?? '').trim()
  if (actor === '' || reason === '') {
    log('公開には操作者（--by）と公開理由（--reason）が必要です')
    return 1
  }
  const mode: 'new' | 'update' = args.update !== null ? 'update' : 'new'
  const supersedes = args.supersedes !== null ? [args.supersedes] : []
  const page = pageOf(pageStore.value, candidate.sourceUrl)

  const gate = evaluatePublishGate(candidate, {
    page: page === null ? null : { text: page.text, contentHash: page.contentHash },
    existingPrograms: programStore.value,
    mode,
    updateProgramId: args.update,
    supersedesProgramIds: supersedes,
    approvedBy: actor,
    approvedAt: dateOf(now),
  })
  if (!gate.ok || gate.program === null) {
    log(`公開を拒否しました: ${candidateId}（不足項目を報告します）`)
    for (const f of gate.failures) log(`  - ${f}`)
    // 拒否も監査に残す（不足項目つき）
    appendAndSaveAudit(deps, paths.auditPath, auditStore.value, [
      makeAuditEntry({
        at: isoOf(now),
        candidateId,
        action: 'publish-rejected',
        actor,
        reason,
        fromStatus: candidate.status,
        toStatus: null,
        pageUrl: candidate.sourceUrl,
        fields: [],
        programId: null,
        details: gate.failures.join(' / ').slice(0, 500),
      }),
    ], now)
    return 1
  }

  const nextPrograms = buildPublishedPrograms(programStore.value, gate.program, mode)
  const programsText = serializeProgramsFile(nextPrograms)
  // 書き込み前に保存形式を再検証（壊れたデータを書かない）
  try {
    parseProgramStoreJson(programsText, paths.programsPath)
  } catch (error) {
    log(`公開データの検証に失敗しました（書き込みません）: ${(error as Error).message}`)
    return 1
  }

  // バックアップ → 制度データ → 候補 → 監査 の順で書き込む
  let backupPath: string | null = null
  if (deps.files.exists(paths.programsPath)) {
    backupPath = `${paths.programsPath}.backup-${compactStamp(now)}`
    try {
      deps.files.write(backupPath, deps.files.read(paths.programsPath))
    } catch (error) {
      log(`バックアップに失敗したため公開を中止します（既存データは変更していません）: ${(error as Error).message}`)
      return 1
    }
  }
  try {
    deps.files.write(paths.programsPath, programsText)
  } catch (error) {
    log(`公開先への書き込みに失敗しました（既存データは保全されています）: ${(error as Error).message}`)
    return 1
  }
  const publishedCandidate: DiscoveryCandidate = {
    ...candidate,
    publication: {
      programId: gate.program.id,
      publishedAt: isoOf(now),
      mode,
      supersedesProgramIds: supersedes,
    },
  }
  const nextCandidates: CandidateStore = {
    ...candStore.value,
    savedAt: isoOf(now),
    candidates: candStore.value.candidates.map((c) =>
      c.candidateId === candidateId ? publishedCandidate : c,
    ),
  }
  deps.files.write(paths.candPath, serializeCandidateStore(nextCandidates))
  appendAndSaveAudit(deps, paths.auditPath, auditStore.value, [
    makeAuditEntry({
      at: isoOf(now),
      candidateId,
      action: 'published',
      actor,
      reason,
      fromStatus: candidate.status,
      toStatus: candidate.status,
      pageUrl: candidate.sourceUrl,
      fields: gate.verifiedFields,
      programId: gate.program.id,
      details: `mode: ${mode}${supersedes.length > 0 ? ` / 後継に切替: ${supersedes.join(', ')}` : ''}${backupPath !== null ? ` / バックアップ: ${backupPath}` : ''}`,
    }),
  ], now)
  log(`公開しました: ${candidateId} → ${gate.program.id}（${mode} / ${paths.programsPath}）`)
  if (backupPath !== null) log(`  バックアップ: ${backupPath}`)
  if (supersedes.length > 0) log(`  後継制度へ切替（追跡記録）: ${supersedes.join(', ')}`)
  log(`  確認済み項目: ${gate.verifiedFields.join(', ')}`)
  return 0
}

// ── コマンドの振り分け ─────────────────────────────────────────

export function runReviewCommand(
  command: string,
  args: ParsedArgs,
  deps: DiscoveryCliDeps,
): number {
  switch (command) {
    case 'candidates':
      return runCandidates(args, deps)
    case 'recheck':
      return runRecheck(args, deps)
    case 'verify':
      return runVerify(args, deps)
    case 'verify-field':
      return runVerifyField(args, deps)
    case 'request-recheck':
      return runStatusChange(args, deps, 'needs-recheck', 'request-recheck')
    case 'discard':
      return runStatusChange(args, deps, 'discarded', 'discard')
    case 'restore':
      return runStatusChange(args, deps, 'unverified', 'restore')
    case 'approve':
      return runStatusChange(args, deps, 'approved', 'approve')
    case 'publish':
      return runPublish(args, deps)
    case 'audit':
      return runAudit(args, deps)
    default:
      deps.log(`未対応のコマンドです: ${command}`)
      return 1
  }
}