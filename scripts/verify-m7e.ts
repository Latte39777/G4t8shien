/**
 * M7-E AI発見制度の検証・承認・公開ワークフローの検証
 *
 * 実行: npx tsx scripts/verify-m7e.ts
 *
 * - 正常な候補の詳細表示 / 不正な候補データの拒否
 * - 根拠が不足する候補・金額/期限に根拠がない候補の承認拒否
 * - ハッシュ変更後の再確認要求（過去の確認を引き継がない）
 * - 不正な状態遷移の拒否・却下済み候補の再承認条件
 * - 制度 ID の重複拒否・既存制度の更新時の競合検出
 * - 公開データへの変換と SupportProgram スキーマ検証
 * - 書き込み失敗時の既存データ保全・監査履歴の記録
 * - 未承認候補が既存レジストリ（programs.json / getSupportPrograms）へ混入しないこと
 * すべて固定データとモックのみ。外部通信なしで実行する。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ChatCompletionsLike } from '../lib/consult/iniadAdvisor'
import {
  DISCOVERY_STORE_FORMAT_VERSION,
  VERIFICATION_ABSENT_VALUE,
  serializeCandidateStore,
  serializePageStore,
  type DiscoveryCandidate,
  type PageRecord,
} from '../lib/discovery/discoveryStore'
import {
  CANDIDATE_STATUS_TRANSITIONS,
  canTransition,
  normalizeStatusName,
  parseReviewAuditStore,
} from '../lib/discovery/reviewStore'
import {
  buildPublishedPrograms,
  candidateProgramId,
  convertCandidateToProgram,
  evaluatePublishGate,
  mergeProgramUpdate,
  serializeProgramsFile,
} from '../lib/discovery/publish'
import {
  runDiscoveryCli,
  type DiscoveryCliDeps,
  type DiscoveryFileOps,
} from '../lib/discovery/cli'
import { parseProgramStoreJson } from '../lib/supports/programStore'
import { supportProgramSchema } from '../lib/types/support'
import { getSupportPrograms, registryDisclaimer } from '../lib/supports/registry'

// ── 外部通信ガード（この検証では一切の外部通信を行わない）────────────
const originalFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (async (...args: unknown[]) => {
  fetchCalls += 1
  throw new Error(`外部通信を検出しました: ${String(args[0])}`)
}) as typeof fetch

let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok: ${name}`)
  } else {
    failed += 1
    console.error(`NG: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const FIXED_TIME = '2026-10-27T10:00:00+09:00'
const fixedNow = () => new Date(FIXED_TIME)

// ── 仮想ファイルシステム（テスト用。実ファイルを汚さない）────────────

type MemFiles = Map<string, string>

function memOps(map: MemFiles, failWrite?: (path: string) => boolean): DiscoveryFileOps {
  return {
    exists: (path) => map.has(path),
    read: (path) => map.get(path) ?? '',
    write: (path, text) => {
      if (failWrite?.(path) === true) {
        throw new Error(`書き込みエラー（テスト）: ${path}`)
      }
      map.set(path, text)
    },
  }
}

async function runCli(
  argv: string[],
  map: MemFiles,
  failWrite?: (path: string) => boolean,
): Promise<{ code: number; out: string }> {
  const lines: string[] = []
  const deps: DiscoveryCliDeps = {
    env: {},
    cwd: '/virtual',
    files: memOps(map, failWrite),
    now: fixedNow,
    log: (line) => lines.push(line),
  }
  const code = await runDiscoveryCli(argv, deps)
  return { code, out: lines.join('\n') }
}

// ── フィクスチャ（固定データ）──────────────────────────────────

const PAGE_TEXT = [
  '育児支援給付のご案内',
  '本制度は、千代田区内在住の0歳から中学校修了前の児童を養育する世帯に、月額10,000円を支給します。',
  '所得制限は世帯収入の目安として記載しています。',
  '申請期限は2027年3月31日です。',
  '対象地域は千代田区全域です。',
  '適用年度は2026年度です。',
  '申請方法は区役所窓口への持参です。',
].join('\n')

const PAGE_URL = 'https://www.city.chiyoda.lg.jp/ikuji-test'
const CAND_ID = 'cand-testhash000001'
const CONTENT_HASH = 'hash-original-content'

const baseCandidate: DiscoveryCandidate = {
  candidateId: CAND_ID,
  taskId: 'chiyoda-ku/child-allowance-cash',
  regionId: 'chiyoda-ku',
  fieldId: 'child-allowance-cash',
  name: '育児支援給付',
  summary: '児童を養育する世帯への現金給付',
  implementer: '千代田区',
  regionScope: '千代田区全域',
  kind: 'cash_benefit',
  eligibility: {
    ageNote: '0歳から中学校修了前',
    householdNote: null,
    incomeNote: '所得制限あり',
    other: [],
  },
  amount: { value: 10000, unit: 'yen_per_month', description: '月額10,000円' },
  application: {
    how: '区役所窓口への持参',
    deadlineNote: '2027年3月31日',
    documents: ['マイナンバーカード'],
  },
  fiscalYear: '2026年度',
  validPeriod: null,
  sourceUrl: PAGE_URL,
  sourceRecordId: null,
  retrievedAt: '2026-10-26T09:00:00+09:00',
  contentHash: CONTENT_HASH,
  evidenceQuotes: [
    { field: 'amount', quote: '月額10,000円を支給します' },
    { field: 'eligibility.age', quote: '0歳から中学校修了前の児童を養育する世帯' },
    { field: 'eligibility.income', quote: '所得制限は世帯収入の目安として記載しています' },
    { field: 'application.deadline', quote: '申請期限は2027年3月31日です' },
    { field: 'regionScope', quote: '対象地域は千代田区全域です' },
    { field: 'fiscalYear', quote: '適用年度は2026年度です' },
  ],
  unknownItems: [],
  unconfirmedItems: [
    { field: 'eligibility.household', reason: '本文の根拠抜粋がないため確定扱いにしません（要検証）' },
    { field: 'validPeriod', reason: '本文の根拠抜粋がないため確定扱いにしません（要検証）' },
  ],
  discoveryMethod: 'ai-extraction',
  extractionModel: 'iniad:test-model',
  firstExtractedAt: FIXED_TIME,
  extractedAt: FIXED_TIME,
  status: 'unverified',
  dedupeKey: 'chiyoda-ku|千代田区|育児支援給付|2026年度|https://www.city.chiyoda.lg.jp/ikuji-test',
  recheckReason: null,
}

const basePage: PageRecord = {
  url: PAGE_URL,
  finalUrl: PAGE_URL,
  title: '育児支援給付のご案内',
  text: PAGE_TEXT,
  textTruncated: false,
  retrievedAt: '2026-10-26T09:00:00+09:00',
  contentHash: CONTENT_HASH,
  extractState: 'extracted',
  extractedAt: FIXED_TIME,
  extractionError: null,
  extractedCandidateCount: 1,
}

const CAND_PATH = '/virtual/data/discovery/candidates.json'
const PAGE_PATH = '/virtual/data/discovery/pages.json'
const AUDIT_PATH = '/virtual/data/discovery/audit-log.json'
const PROGRAMS_PATH = '/virtual/data/programs/programs.json'

function seedStores(map: MemFiles, candidates: DiscoveryCandidate[] = [baseCandidate]): void {
  map.set(
    CAND_PATH,
    serializeCandidateStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: FIXED_TIME,
      candidates,
    }),
  )
  map.set(
    PAGE_PATH,
    serializePageStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: FIXED_TIME,
      pages: [basePage],
    }),
  )
}

/** 重要項目 8 つすべての根拠確認を記録する（正常系の準備） */
async function verifyAllFields(map: MemFiles, candidateId: string): Promise<void> {
  const cases: [string, string, string][] = [
    ['amount.value', '10000', '月額10,000円を支給します'],
    ['eligibility.age', '0歳から中学校修了前', '0歳から中学校修了前の児童を養育する世帯'],
    ['eligibility.household', VERIFICATION_ABSENT_VALUE, '所得制限は世帯収入の目安として記載しています'],
    ['eligibility.income', '所得制限あり', '所得制限は世帯収入の目安として記載しています'],
    ['application.deadline', '2027年3月31日', '申請期限は2027年3月31日です'],
    ['regionScope', '千代田区全域', '対象地域は千代田区全域です'],
    ['fiscalYear', '2026年度', '適用年度は2026年度です'],
    ['validPeriod', VERIFICATION_ABSENT_VALUE, '申請方法は区役所窓口への持参です'],
  ]
  for (const [field, value, quote] of cases) {
    const r = await runCli(
      ['verify-field', candidateId, '--field', field, '--value', value, '--quote', quote, '--by', '田中確認者'],
      map,
    )
    if (r.code !== 0) {
      throw new Error(`verify-field ${field} が失敗しました: ${r.out}`)
    }
  }
}

// ═══ 検証開始 ═══════════════════════════════════════════════════

async function main(): Promise<void> {
const protectedHashes: Record<string, string> = {
  'data/programs/programs.json': hashFile('data/programs/programs.json'),
  'data/discovery/candidates.json': hashFile('data/discovery/candidates.json'),
  'data/survey-plan.json': hashFile('data/survey-plan.json'),
  'data/source-ledger.json': hashFile('data/source-ledger.json'),
}
const registryBefore = JSON.stringify(getSupportPrograms())
const disclaimerBefore = registryDisclaimer()

console.log('\n[1] 正常な候補の詳細表示')
{
  const map: MemFiles = new Map()
  seedStores(map)
  const detail = await runCli(['candidates', CAND_ID], map)
  check('詳細表示: 成功（exit 0）', detail.code === 0, detail.out)
  check('詳細表示: 制度名・実施主体・対象地域を表示', detail.out.includes('育児支援給付') && detail.out.includes('千代田区') && detail.out.includes('千代田区全域'))
  check('詳細表示: 支援種別を表示', detail.out.includes('cash_benefit'))
  check('詳細表示: 根拠となる公式URLを表示', detail.out.includes(PAGE_URL))
  check('詳細表示: 取得日時・本文ハッシュを表示', detail.out.includes('2026-10-26T09:00:00+09:00') && detail.out.includes(CONTENT_HASH))
  check('詳細表示: 根拠となる本文抜粋を表示', detail.out.includes('月額10,000円を支給します'))
  check('詳細表示: 抽出された金額・期限・条件を表示', detail.out.includes('10000') && detail.out.includes('2027年3月31日') && detail.out.includes('所得制限あり'))
  check('詳細表示: 未確認項目を表示', detail.out.includes('eligibility.household') && detail.out.includes('validPeriod'))
  check('詳細表示: 現在の検証状態を表示', detail.out.includes('未検証（unverified）'))
  check('詳細表示: 警告・確認不足を表示', detail.out.includes('重要項目の確認状況'))
  check('詳細表示: 未検証である旨を明示', detail.out.includes('確定制度データではありません'))
  const list = await runCli(['candidates'], map)
  check('一覧表示: 成功し候補を含む', list.code === 0 && list.out.includes(CAND_ID))
  const unverified = await runCli(['candidates', '--status', 'needs_recheck'], map)
  check('一覧表示: needs_recheck 表記も受け付ける', unverified.code === 0 && unverified.out.includes('要再確認'))
}

console.log('\n[2] 不正な候補データの拒否')
{
  const map: MemFiles = new Map()
  seedStores(map)
  map.set(CAND_PATH, '{ 壊れた JSON')
  const beforeHash = hashText(map.get(CAND_PATH) ?? '')
  for (const argv of [
    ['discard', CAND_ID, '--by', 'X', '--reason', 'Y'],
    ['approve', CAND_ID, '--by', 'X', '--reason', 'Y'],
    ['publish', CAND_ID, '--by', 'X', '--reason', 'Y'],
  ]) {
    const r = await runCli(argv, map)
    check(`不正データ拒否: ${argv[0]} が中断される`, r.code === 1 && r.out.includes('復元できないため中断'), r.out)
  }
  check('不正データ拒否: 保存物を上書きしない', hashText(map.get(CAND_PATH) ?? '') === beforeHash)
  // スキーマ違反（不正な状態値）も拒否
  const map2: MemFiles = new Map()
  seedStores(map2)
  const broken = JSON.parse(map2.get(CAND_PATH) ?? '{}')
  broken.candidates[0].status = 'approved-lol'
  map2.set(CAND_PATH, JSON.stringify(broken))
  const r2 = await runCli(['candidates', CAND_ID], map2)
  check('不正データ拒否: スキーマ違反の状態値も拒否', r2.code === 1 && r2.out.includes('復元できないため中断'), r2.out)
}

console.log('\n[3] 根拠が不足する候補の承認拒否')
{
  const map: MemFiles = new Map()
  seedStores(map)
  const r = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '内容を確認した'], map)
  check('承認拒否: 確認記録なしでは承認できない', r.code === 1 && r.out.includes('公開承認を拒否します'), r.out)
  check('承認拒否: 不足項目を具体的に報告', r.out.includes('金額（amount）') && r.out.includes('申請期限（application.deadline）'), r.out)
  const cand = JSON.parse(map.get(CAND_PATH) ?? '{}')
  check('承認拒否: 状態は unverified のまま', cand.candidates[0].status === 'unverified')
  check('承認拒否: 監査に承認記録を残さない', !map.has(AUDIT_PATH) || !(map.get(AUDIT_PATH) ?? '').includes('"action": "approved"'))
}

console.log('\n[4] 金額・期限などに根拠がない候補の承認拒否')
{
  const map: MemFiles = new Map()
  seedStores(map)
  // 根拠抜粋が本文に無い → 確認済みとして扱わない
  const r1 = await runCli(
    ['verify-field', CAND_ID, '--field', 'amount.value', '--value', '10000', '--quote', '本文に無い抜粋です', '--by', '確認者B'],
    map,
  )
  check('抜粋不在: 本文に無い抜粋は確認記録にならない', r1.code === 1 && r1.out.includes('抜粋と本文が一致しません'), r1.out)
  // 本文と抽出値が一致しない → 確認済みとして扱わない
  const r2 = await runCli(
    ['verify-field', CAND_ID, '--field', 'amount.value', '--value', '99999', '--quote', '月額10,000円を支給します', '--by', '確認者B'],
    map,
  )
  check('値不一致: 抽出値と一致しない確認値は拒否', r2.code === 1 && r2.out.includes('一致しません'), r2.out)
  // 数値が根拠抜粋に現れない → 拒否
  const r3 = await runCli(
    ['verify-field', CAND_ID, '--field', 'amount.value', '--value', '10000', '--quote', '申請方法は区役所窓口への持参です', '--by', '確認者B'],
    map,
  )
  check('値不在: 数値が抜粋に現れない場合は拒否', r3.code === 1 && r3.out.includes('根拠抜粋に現れません'), r3.out)
  // 「（記載なし）」は値が無い場合のみ
  const r4 = await runCli(
    ['verify-field', CAND_ID, '--field', 'amount.value', '--value', VERIFICATION_ABSENT_VALUE, '--quote', '月額10,000円を支給します', '--by', '確認者B'],
    map,
  )
  check('記載なし誤用: 値がある項目の「（記載なし）」は拒否', r4.code === 1 && r4.out.includes('残っています'), r4.out)
  // 金額・期限が確認できていない状態では承認できない
  const r5 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '確認済みのはず'], map)
  check('承認拒否: 金額・期限に根拠がない候補を拒否', r5.code === 1 && r5.out.includes('公開承認を拒否します'), r5.out)
  const cand = JSON.parse(map.get(CAND_PATH) ?? '{}')
  check('承認拒否: 無効な確認は保存されていない', (cand.candidates[0].fieldVerifications ?? []).length === 0)
}

console.log('\n[5] ハッシュ変更後の再確認要求')
{
  const map: MemFiles = new Map()
  seedStores(map)
  await verifyAllFields(map, CAND_ID)
  const a1 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '全項目を本文と照合済み'], map)
  check('準備: 根拠確認が揃えば承認できる', a1.code === 0, a1.out)
  // ページ本文が変更される（ハッシュ変更）
  map.set(PAGE_PATH, serializePageStore({
    formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
    savedAt: FIXED_TIME,
    pages: [{ ...basePage, text: `${PAGE_TEXT}\n（2026年10月に改定されました）`, contentHash: 'hash-changed-0001' }],
  }))
  const v = await runCli(['verify'], map)
  check('ハッシュ変更: verify が要再確認を検知', v.code === 1 && v.out.includes('要再確認へ移行'), v.out)
  const cand = JSON.parse(map.get(CAND_PATH) ?? '{}')
  check('ハッシュ変更: 状態が needs-recheck に移る', cand.candidates[0].status === 'needs-recheck', cand.candidates[0].status)
  check('ハッシュ変更: 再確認理由を記録', String(cand.candidates[0].recheckReason ?? '').includes('ハッシュ'), cand.candidates[0].recheckReason)
  // 過去の確認結果は引き継がない（失効）
  const a2 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '前回の確認で問題なし'], map)
  check('ハッシュ変更: 失効した確認では再承認できない', a2.code === 1 && a2.out.includes('公開承認を拒否します'), a2.out)
  const auditText = map.get(AUDIT_PATH) ?? ''
  check('ハッシュ変更: 監査に recheck-detected を記録', auditText.includes('"action": "recheck-detected"'), auditText.slice(0, 300))
  const detailAfter = await runCli(['candidates', CAND_ID], map)
  check('ハッシュ変更: 失効した確認記録を詳細で警告', detailAfter.out.includes('失効'), detailAfter.out)
  // 再確認（新しい本文ハッシュに対して確認し直せば承認できる）
  await verifyAllFields(map, CAND_ID)
  const a3 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '改定後の本文と再照合済み'], map)
  check('ハッシュ変更: 再確認後は承認できる', a3.code === 0, a3.out)
}

console.log('\n[6] 不正な状態遷移の拒否')
{
  check('遷移表: unverified → approved は許可', canTransition('unverified', 'approved'))
  check('遷移表: discarded → approved は不許可', !canTransition('discarded', 'approved'))
  check('遷移表: approved → approved（重複承認）は不許可', !canTransition('approved', 'approved'))
  check('遷移表: discarded → unverified（restore）は許可', canTransition('discarded', 'unverified'))
  check('状態名: needs_recheck 表記を正規化', normalizeStatusName('needs_recheck') === 'needs-recheck')
  check('状態名: 不正な状態名は null', normalizeStatusName('hoge') === null)
  check('遷移表: 全状態の遷移先が定義されている', Object.keys(CANDIDATE_STATUS_TRANSITIONS).length === 4)

  const map: MemFiles = new Map()
  seedStores(map, [{ ...baseCandidate, status: 'discarded', recheckReason: '重複候補のため' }])
  const r1 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', 'よさそう'], map)
  check('却下済みから直接承認できない', r1.code === 1 && r1.out.includes('restore'), r1.out)
  const map2: MemFiles = new Map()
  seedStores(map2)
  await verifyAllFields(map2, CAND_ID)
  await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '確認済み'], map2)
  const r2 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', 'もう一度'], map2)
  check('重複承認を拒否', r2.code === 1 && r2.out.includes('すでに'), r2.out)
  const r3 = await runCli(['request-recheck', CAND_ID, '--by', '確認者A'], map2)
  check('理由なしの状態変更を拒否', r3.code === 1 && r3.out.includes('--reason'), r3.out)
  const r4 = await runCli(['discard', 'cand-not-exist', '--by', 'X', '--reason', 'Y'], map2)
  check('存在しない候補 ID を拒否', r4.code === 1 && r4.out.includes('存在しません'), r4.out)
  const r5 = await runCli(['candidates', '--status', 'bogus'], map2)
  check('不正な状態フィルタを拒否', r5.code === 1 && r5.out.includes('不正な状態'), r5.out)
}

console.log('\n[7] 却下済み候補の再承認条件')
{
  const map: MemFiles = new Map()
  seedStores(map)
  const d = await runCli(['discard', CAND_ID, '--by', '承認者A', '--reason', '別サイトで確認できないため'], map)
  check('却下: 成功（exit 0）', d.code === 0, d.out)
  const r1 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', 'やっぱり承認'], map)
  check('再承認拒否: 却下済みは直に承認できない', r1.code === 1 && r1.out.includes('restore'), r1.out)
  const rest = await runCli(['restore', CAND_ID, '--by', '承認者A', '--reason', '公式ページを再発見した'], map)
  check('restore: 却下済みから unverified へ復帰', rest.code === 0, rest.out)
  const r2 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '復帰したので承認'], map)
  check('再承認条件: 復帰後も根拠確認なしでは承認できない', r2.code === 1 && r2.out.includes('公開承認を拒否します'), r2.out)
  await verifyAllFields(map, CAND_ID)
  const r3 = await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '根拠を再確認して承認'], map)
  check('再承認条件: 根拠を再確認すれば承認できる', r3.code === 0, r3.out)
  const auditText = map.get(AUDIT_PATH) ?? ''
  check('監査: discarded → unverified → approved を記録', auditText.includes('"action": "discarded"') && auditText.includes('"action": "restored"') && auditText.includes('"action": "approved"'))
}

// ── 公開系テストのヘルパ ───────────────────────────────────────

function mkVerif(field: string, value: string, evidenceQuote: string) {
  return {
    field,
    value,
    evidenceQuote,
    reviewedBy: 'manual' as const,
    reviewedAt: FIXED_TIME,
    contentHash: CONTENT_HASH,
  }
}

const allVerifications = [
  mkVerif('amount.value', '10000', '月額10,000円を支給します'),
  mkVerif('eligibility.age', '0歳から中学校修了前', '0歳から中学校修了前の児童を養育する世帯'),
  mkVerif('eligibility.household', VERIFICATION_ABSENT_VALUE, '所得制限は世帯収入の目安として記載しています'),
  mkVerif('eligibility.income', '所得制限あり', '所得制限は世帯収入の目安として記載しています'),
  mkVerif('application.deadline', '2027年3月31日', '申請期限は2027年3月31日です'),
  mkVerif('regionScope', '千代田区全域', '対象地域は千代田区全域です'),
  mkVerif('fiscalYear', '2026年度', '適用年度は2026年度です'),
  mkVerif('validPeriod', VERIFICATION_ABSENT_VALUE, '申請方法は区役所窓口への持参です'),
]

/** 既存制度のフィクスチャ（SupportProgram スキーマ検証込み） */
function fixtureProgram(
  id: string,
  name: string,
  extra: Partial<Record<string, unknown>> = {},
) {
  return supportProgramSchema.parse({
    id,
    name,
    category: 'cash_benefit',
    level: 'ward',
    summary: '既存の制度（テスト）',
    amount: { value: 5000, unit: 'yen_per_month', basis: 'confirmed', description: '月額5,000円', fiscalYear: '2026年度' },
    period: { startAgeYears: null, endAgeYears: null, durationMonths: null },
    conditions: { combinedWith: [], incomeLimitNote: null, householdNote: null, other: [] },
    application: { where: null, documents: [], deadlineNote: null, steps: [] },
    eligibility: 'unconfirmed',
    eligibilityNote: null,
    legalBasis: { lawName: null, ordinanceName: null, note: '根拠法令は未確認', confidence: 'unconfirmed' },
    sources: [
      {
        title: '既存出典',
        organization: '千代田区',
        url: 'https://www.city.chiyoda.lg.jp/legacy',
        urlVerified: true,
        official: true,
        checkedAt: '2026-10-20',
      },
    ],
    checkedAt: '2026-10-20',
    missingInformation: [],
    mock: false,
    effectiveFrom: '2026-04-01',
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-20',
      verifiedFields: ['legacy.field'],
      note: '既存の確認記録',
    },
    ...extra,
  })
}

console.log('\n[8] 制度IDの重複拒否')
{
  const map: MemFiles = new Map()
  seedStores(map)
  const derivedId = candidateProgramId(baseCandidate)
  check('ID 導出: 候補 ID から安定した制度 ID を導く', derivedId === 'disc-testhash000001', derivedId)
  map.set(PROGRAMS_PATH, serializeProgramsFile([fixtureProgram(derivedId, '別名称の既存制度')]))
  await verifyAllFields(map, CAND_ID)
  await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '確認済み'], map)
  const before = map.get(PROGRAMS_PATH) ?? ''
  const r = await runCli(['publish', CAND_ID, '--by', '公開者A', '--reason', '公式確認済み'], map)
  check('ID重複: 同一 ID の制度があると公開を拒否', r.code === 1 && r.out.includes('既に存在します'), r.out)
  check('ID重複: --update の明示を求める', r.out.includes('--update'))
  check('ID重複: 公開先データを変更しない', (map.get(PROGRAMS_PATH) ?? '') === before)
  const cand = JSON.parse(map.get(CAND_PATH) ?? '{}')
  check('ID重複: 公開記録を残さない', cand.candidates[0].publication === undefined)
  const auditText = map.get(AUDIT_PATH) ?? ''
  check('ID重複: 拒否を監査に記録', auditText.includes('"action": "publish-rejected"'))
}

console.log('\n[9] 既存制度の更新時の競合検出')
{
  const map: MemFiles = new Map()
  seedStores(map)
  map.set(PROGRAMS_PATH, serializeProgramsFile([fixtureProgram('prog-existing', '育児支援給付')]))
  await verifyAllFields(map, CAND_ID)
  await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '確認済み'], map)
  const r1 = await runCli(['publish', CAND_ID, '--by', '公開者A', '--reason', '公開する'], map)
  check('競合検出: 同名の既存制度を検出して公開を拒否', r1.code === 1 && r1.out.includes('prog-existing'), r1.out)
  const r2 = await runCli(['publish', CAND_ID, '--by', '公開者A', '--reason', '既存制度を更新する', '--update', 'prog-existing'], map)
  check('明示更新: --update で既存制度を更新できる', r2.code === 0, r2.out)
  const programs = parseProgramStoreJson(map.get(PROGRAMS_PATH) ?? '', PROGRAMS_PATH)
  check('明示更新: 制度 ID を上書きしない', programs.length === 1 && programs[0].id === 'prog-existing')
  check('明示更新: 確認済みの根拠を引き継ぐ', (programs[0].verification?.verifiedFields ?? []).includes('legacy.field') && (programs[0].verification?.verifiedFields ?? []).includes('amount.value'))
  check('明示更新: 適用期間を引き継ぐ', programs[0].effectiveFrom === '2026-04-01')
  check('明示更新: 既存出典と新出典を両方保持', programs[0].sources.length === 2, String(programs[0].sources.length))
  check('明示更新: 適用年度を引き継ぐ', programs[0].amount.fiscalYear === '2026年度')
  const cand = JSON.parse(map.get(CAND_PATH) ?? '{}')
  check('明示更新: 公開記録（update）を候補に保存', cand.candidates[0].publication?.mode === 'update' && cand.candidates[0].publication?.programId === 'prog-existing')
  // 年度違いは別制度（誤統合しない）
  const gateYear = evaluatePublishGate(
    { ...baseCandidate, status: 'approved', fieldVerifications: allVerifications },
    {
      page: { text: PAGE_TEXT, contentHash: CONTENT_HASH },
      existingPrograms: [fixtureProgram('prog-2025', '育児支援給付', { amount: { value: 5000, unit: 'yen_per_month', basis: 'confirmed', description: '月額5,000円', fiscalYear: '2025年度' } })],
      mode: 'new',
      updateProgramId: null,
      supersedesProgramIds: [],
      approvedBy: '承認者A',
      approvedAt: '2026-10-27',
    },
  )
  check('年度違い: 適用年度が異なれば別制度として競合にしない', gateYear.ok, gateYear.failures.join(' / '))
}

console.log('\n[10] 公開データへの変換とスキーマ検証')
{
  const converted = convertCandidateToProgram(baseCandidate, {
    programId: 'disc-testhash000001',
    approvedAt: '2026-10-27',
    approvedBy: '承認者A',
    verifications: allVerifications,
  })
  check('変換: 正常に変換できる', converted.ok, converted.ok ? '' : converted.problems.join(' / '))
  if (converted.ok) {
    const p = converted.program
    check('変換: SupportProgram スキーマに適合', supportProgramSchema.safeParse(p).success)
    check('変換: 受給資格は unconfirmed のまま（格上げしない）', p.eligibility === 'unconfirmed')
    check('変換: 金額は確認済みのため confirmed', p.amount.value === 10000 && p.amount.basis === 'confirmed')
    check('変換: 適用年度を反映', p.amount.fiscalYear === '2026年度')
    check('変換: 対象地域（23区）を反映', p.jurisdiction?.ward === 'chiyoda' && p.jurisdiction?.confidence === 'confirmed')
    check('変換: 検証状態は partial（すべて確認済みとはしない）', p.verification?.status === 'partial')
    check('変換: 確認済み項目を記録', (p.verification?.verifiedFields ?? []).length === 8)
    check('変換: 「（記載なし）」は不足情報として記録', p.missingInformation.some((m) => m.includes('公式ページに記載なし')))
    const criticalLeft = (p.unconfirmedItems ?? []).filter((i) =>
      ['period', 'amount', 'legalBasis', 'application.deadline'].includes(i.field) && i.field !== 'legalBasis',
    )
    check('変換: 確認済みの重要項目は未確認に残さない', criticalLeft.length === 0, JSON.stringify(criticalLeft))
    check('変換: 公式出典（URL確認済み）を記録', p.sources.length === 1 && p.sources[0].url === PAGE_URL && p.sources[0].urlVerified)
  }
  const badKind = convertCandidateToProgram(
    { ...baseCandidate, kind: 'other' },
    { programId: 'x', approvedAt: '2026-10-27', approvedBy: 'A', verifications: allVerifications },
  )
  check('変換拒否: 支援種別が不明確なら変換しない', !badKind.ok && badKind.problems.some((x) => x.includes('支援種別')))
  // シリアライズ → 再検証のラウンドトリップ
  const text = serializeProgramsFile(converted.ok ? [converted.program] : [])
  check('保存形式: 公開先ファイルとして再検証できる', parseProgramStoreJson(text, PROGRAMS_PATH).length === 1)
  // 変換だけでは公開されない（ゲートが未承認を拒否）
  const gateUnapproved = evaluatePublishGate(
    { ...baseCandidate, fieldVerifications: allVerifications },
    {
      page: { text: PAGE_TEXT, contentHash: CONTENT_HASH },
      existingPrograms: [],
      mode: 'new',
      updateProgramId: null,
      supersedesProgramIds: [],
      approvedBy: '承認者A',
      approvedAt: '2026-10-27',
    },
  )
  check('分離: 変換できても未承認では公開ゲートを通らない', !gateUnapproved.ok && gateUnapproved.failures.some((f) => f.includes('公開承認済み')))
  const gateApproved = evaluatePublishGate(
    { ...baseCandidate, status: 'approved', fieldVerifications: allVerifications },
    {
      page: { text: PAGE_TEXT, contentHash: CONTENT_HASH },
      existingPrograms: [],
      mode: 'new',
      updateProgramId: null,
      supersedesProgramIds: [],
      approvedBy: '承認者A',
      approvedAt: '2026-10-27',
    },
  )
  check('公開ゲート: 承認済み・根拠確認済みなら通過', gateApproved.ok, gateApproved.failures.join(' / '))
  // 既存制度の更新は ID・根拠・適用年度を上書きしない
  const existing = fixtureProgram('prog-m', '古い制度', {
    amount: { value: 5000, unit: 'yen_per_month', basis: 'confirmed', description: '月額5,000円', fiscalYear: null },
  })
  const incoming = { ...existing, amount: { ...existing.amount, value: 8000 } }
  const merged = mergeProgramUpdate(existing, incoming)
  check('更新マージ: 制度 ID を維持', merged.id === 'prog-m')
  check('更新マージ: 確認済みの根拠を維持', (merged.verification?.verifiedFields ?? []).includes('legacy.field'))
  check('更新マージ: 適用年度を無視して上書きしない', merged.amount.fiscalYear === null)
  check('更新マージ: 適用開始日を維持', merged.effectiveFrom === '2026-04-01')
  const built = buildPublishedPrograms([existing], incoming, 'update')
  check('更新マージ: 他制度は変更しない', built.length === 1 && built[0].amount.value === 8000)
}

console.log('\n[11] 書き込み失敗時の既存データ保全')
{
  const map: MemFiles = new Map()
  seedStores(map)
  map.set(PROGRAMS_PATH, serializeProgramsFile([fixtureProgram('prog-other', '無関係な制度')]))
  await verifyAllFields(map, CAND_ID)
  await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '確認済み'], map)
  const beforePrograms = map.get(PROGRAMS_PATH) ?? ''
  const beforeCand = map.get(CAND_PATH) ?? ''
  const r = await runCli(
    ['publish', CAND_ID, '--by', '公開者A', '--reason', '公開する'],
    map,
    (path) => path === PROGRAMS_PATH,
  )
  check('書き込み失敗: 公開は中断される', r.code === 1 && r.out.includes('書き込みに失敗しました'), r.out)
  check('書き込み失敗: 既存の制度データは保全される', (map.get(PROGRAMS_PATH) ?? '') === beforePrograms)
  check('書き込み失敗: 候補側も変更されない', (map.get(CAND_PATH) ?? '') === beforeCand)
  check('書き込み失敗: 保全された旨を表示', r.out.includes('保全'))
  // バックアップ取得失敗時も中止して保全
  const r2 = await runCli(
    ['publish', CAND_ID, '--by', '公開者A', '--reason', '公開する'],
    map,
    (path) => path.includes('.backup-'),
  )
  check('バックアップ失敗: 公開を中止する', r2.code === 1 && r2.out.includes('バックアップに失敗'), r2.out)
  check('バックアップ失敗: 既存の制度データは保全される', (map.get(PROGRAMS_PATH) ?? '') === beforePrograms)
}

console.log('\n[12] 監査履歴の記録')
{
  const map: MemFiles = new Map()
  seedStores(map)
  map.set(PROGRAMS_PATH, serializeProgramsFile([]))
  await verifyAllFields(map, CAND_ID)
  await runCli(['approve', CAND_ID, '--by', '承認者A', '--reason', '全項目を本文と照合済み'], map)
  await runCli(['publish', CAND_ID, '--by', '公開者A', '--reason', '公式ページで確認済み'], map)
  const audit = parseReviewAuditStore(map.get(AUDIT_PATH) ?? '')
  check('監査: 監査履歴をスキーマ検証して復元できる', audit.ok)
  if (audit.ok) {
    const entries = audit.value.entries
    const actions = entries.map((e) => e.action)
    check('監査: 発見以降の操作を記録', actions.includes('field-verified') && actions.includes('approved') && actions.includes('published'))
    const approved = entries.find((e) => e.action === 'approved')
    check('監査: 承認に変更前後の状態を記録', approved?.fromStatus === 'unverified' && approved?.toStatus === 'approved')
    check('監査: 誰が承認したかを記録', approved?.actor === '承認者A')
    check('監査: 変更理由を記録', (approved?.reason ?? '').includes('照合'))
    check('監査: 操作日時を記録', (approved?.at ?? '').startsWith('2026-10-27'))
    const fieldEntries = entries.filter((e) => e.action === 'field-verified')
    check('監査: 項目ごとの確認（8件）を記録', fieldEntries.length === 8, String(fieldEntries.length))
    check('監査: 確認者と項目を記録', fieldEntries.every((e) => e.actor === '田中確認者') && fieldEntries.some((e) => e.fields.includes('amount.value')))
    check('監査: 根拠抜粋を記録', (fieldEntries[0]?.details ?? '').includes('根拠抜粋'))
    const published = entries.find((e) => e.action === 'published')
    check('監査: 公開日時・制度ID・出典を記録', published?.programId === 'disc-testhash000001' && published?.pageUrl === PAGE_URL)
    check('監査: いつ公開されたかを記録', (published?.at ?? '').startsWith('2026-10-27'))
    check('監査: 公開で確認済み項目を記録', (published?.fields ?? []).length === 8)
    // 重複公開は記録されない（すでに公開済みで拒否）
    await runCli(['publish', CAND_ID, '--by', '公開者A', '--reason', '再公開'], map)
    const audit2 = parseReviewAuditStore(map.get(AUDIT_PATH) ?? '')
    check('監査: 重複公開は published を増やさない', audit2.ok && audit2.value.entries.filter((e) => e.action === 'published').length === 1)
  }
  const show = await runCli(['audit', CAND_ID], map)
  check('監査: CLI で履歴を表示できる', show.code === 0 && show.out.includes('approved') && show.out.includes('published'), show.out)

  // AI 抽出（発見）の監査記録（M7-D パイプラインとの接続。偽 AI クライアント）
  const map2: MemFiles = new Map()
  map2.set(
    '/virtual/data/discovery/pages.json',
    serializePageStore({
      formatVersion: DISCOVERY_STORE_FORMAT_VERSION,
      savedAt: FIXED_TIME,
      pages: [{ ...basePage, extractState: 'pending', extractedAt: null, extractionError: null, extractedCandidateCount: null }],
    }),
  )
  map2.set(
    '/virtual/data/discovery/candidates.json',
    serializeCandidateStore({ formatVersion: DISCOVERY_STORE_FORMAT_VERSION, savedAt: FIXED_TIME, candidates: [] }),
  )
  const extractionOutput = JSON.stringify({
    candidates: [
      {
        name: '育児支援給付',
        summary: '児童を養育する世帯への現金給付',
        implementer: '千代田区',
        regionScope: '千代田区全域',
        kind: 'cash_benefit',
        eligibility: { ageNote: '0歳から中学校修了前', householdNote: null, incomeNote: '所得制限あり', other: [] },
        amount: { value: 10000, unit: 'yen_per_month', description: '月額10,000円' },
        application: { how: '区役所窓口への持参', deadlineNote: '2027年3月31日', documents: [] },
        fiscalYear: '2026年度',
        validPeriod: null,
        evidenceQuotes: [
          { field: 'amount', quote: '月額10,000円を支給します' },
          { field: 'eligibility.age', quote: '0歳から中学校修了前の児童を養育する世帯' },
          { field: 'eligibility.income', quote: '所得制限は世帯収入の目安として記載しています' },
          { field: 'application.deadline', quote: '申請期限は2027年3月31日です' },
          { field: 'regionScope', quote: '対象地域は千代田区全域です' },
          { field: 'fiscalYear', quote: '適用年度は2026年度です' },
        ],
        unknownItems: [],
      },
    ],
  })
  const fakeAi: ChatCompletionsLike = {
    create: async () => ({ content: extractionOutput }),
  }
  const extractLines: string[] = []
  const extractCode = await runDiscoveryCli(
    ['extract', '--task', 'chiyoda-ku/child-allowance-cash', '--live'],
    {
      env: { DISCOVERY_LIVE: '1', INIAD_API_KEY: 'test-key-not-real' },
      cwd: '/virtual',
      files: memOps(map2),
      now: fixedNow,
      createAiClient: () => fakeAi,
      log: (line) => extractLines.push(line),
    },
  )
  check('抽出監査: extract --live が成功（偽 AI。実 API なし）', extractCode === 0, extractLines.join('\n'))
  const auditExtract = parseReviewAuditStore(map2.get(AUDIT_PATH) ?? '')
  check('抽出監査: 発見（AI抽出）を監査に記録', auditExtract.ok && auditExtract.value.entries.some((e) => e.action === 'extracted' && e.actor === 'ai-extraction'))
  if (auditExtract.ok) {
    const e = auditExtract.value.entries.find((x) => x.action === 'extracted')
    check('抽出監査: 取得元 URL・抽出情報を記録', e?.pageUrl === PAGE_URL && (e?.details ?? '').includes('根拠抜粋'))
    check('抽出監査: 発見日時を記録', (e?.details ?? '').includes('発見: '))
  }
  const candExtract = JSON.parse(map2.get('/virtual/data/discovery/candidates.json') ?? '{}')
  check('抽出監査: 抽出された候補は unverified（承認扱いにしない）', candExtract.candidates[0]?.status === 'unverified')
}

console.log('\n[13] 未承認候補が既存レジストリへ混入しないこと')
{
  check('非混入: getSupportPrograms() が無変更', JSON.stringify(getSupportPrograms()) === registryBefore)
  check('非混入: レジストリにテスト候補・公開制度が含まれない', !JSON.stringify(getSupportPrograms()).includes('disc-testhash000001') && !JSON.stringify(getSupportPrograms()).includes('育児支援給付'))
  check('非混入: registryDisclaimer() が無変更', registryDisclaimer() === disclaimerBefore)
  for (const [path, before] of Object.entries(protectedHashes)) {
    check(`非破壊: ${path} が無変更（ハッシュ一致）`, hashFile(path) === before)
  }
  check('外部通信ガード: fetch は一度も呼ばれていない', fetchCalls === 0, String(fetchCalls))
}

// ── 結果 ───────────────────────────────────────────────────────
globalThis.fetch = originalFetch
if (failed > 0) {
  console.error(`\n${failed} 件のチェックが失敗しました`)
  process.exitCode = 1
} else {
  console.log('\nALL CHECKS PASSED (0 network calls)')
}
}

main().catch((err: unknown) => {
  globalThis.fetch = originalFetch
  console.error('検証の実行に失敗しました:', err)
  process.exitCode = 1
})