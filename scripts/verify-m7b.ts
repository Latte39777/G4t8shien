/**
 * M7-B 制度データ保存基盤の検証
 *
 * 実行: npx tsx scripts/verify-m7b.ts
 *
 * - 移行前のレジストリ出力（scripts/fixtures/m7b-pre-migration.json）と
 *   getSupportPrograms() の完全一致（件数・ID・名称・分類・給付額・検証状態・
 *   未確認項目）。検証状態の格上げや値の変更が無いことを記録・比較する
 * - 制度データ保存形式（data/programs/programs.json）の検証と、
 *   不正データ時のエラー品質（ファイル名・要素番号・ID・フィールドパス）
 * - 既存機能との互換性（レジストリ API・相談AI 知識生成・シミュレーション計算）
 * - フィクスチャ（lib/supports/mockPrograms.ts / officialPrograms.ts）と
 *   本番ストアの同期（M7-G で kb.ts をストア参照に移行するまでの制約の検出）
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  REGISTRY_DISCLAIMER,
  getSupportPrograms,
  registryDisclaimer,
  remainingMockProgramIds,
} from '../lib/supports/registry'
import {
  PROGRAM_STORE_FILE,
  PROGRAM_STORE_FORMAT_VERSION,
  ProgramStoreError,
  getProgramStore,
  parseProgramStore,
  parseProgramStoreJson,
} from '../lib/supports/programStore'
import { MOCK_DISCLAIMER, MOCK_SUPPORT_PROGRAMS } from '../lib/supports/mockPrograms'
import { buildOfficialPrograms } from '../lib/supports/officialPrograms'
import { buildKnowledgeBase } from '../lib/supports/kb'
import { buildSimulationResult } from '../lib/result'
import { verificationBadgeText } from '../lib/supports/display'
import { supportProgramSchema, type SupportProgram } from '../lib/types/support'
import type { ChildRow, SimulationInput } from '../lib/simulation'

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

/** undefined とキー欠如を同一視する構造比較（順序は配列のみ厳密） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) {
    return (a ?? null) === (b ?? null)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([
      ...Object.keys(a as object),
      ...Object.keys(b as object),
    ])
    for (const key of keys) {
      const av = (a as Record<string, unknown>)[key]
      const bv = (b as Record<string, unknown>)[key]
      if (av === undefined && bv === undefined) continue
      if (!deepEqual(av, bv)) return false
    }
    return true
  }
  return false
}

/** ProgramStoreError が想定した文言を含むことを確認する */
function expectStoreError(
  name: string,
  run: () => unknown,
  expectedFragments: string[],
) {
  try {
    run()
    failed += 1
    console.error(`NG: ${name} — ProgramStoreError が発生しませんでした`)
  } catch (error) {
    if (error instanceof ProgramStoreError) {
      const missing = expectedFragments.filter((f) => !error.message.includes(f))
      check(
        name,
        missing.length === 0,
        missing.length > 0
          ? `メッセージに不足: ${missing.join(' / ')} — 実際: ${error.message}`
          : undefined,
      )
    } else {
      failed += 1
      console.error(`NG: ${name} — 想定外のエラー: ${String(error)}`)
    }
  }
}

// ── 1. 移行前スナップショットとの完全一致（件数・ID・すべての値）─────
const snapshotText = readFileSync('scripts/fixtures/m7b-pre-migration.json', 'utf8')
const snapshotPrograms: SupportProgram[] = JSON.parse(snapshotText)
const storePrograms = getSupportPrograms()

console.log('== 移行前スナップショットとの照合 ==')
// M7-F: 本番データには実調査で公開した制度が追加されている。既存（移行前）
// 6 件が無変更で先頭に残り、追加分はその後ろに付け足されていることを確認する
check(
  `移行前 ${snapshotPrograms.length} 件がすべて残っている（追加分は後ろに追加）`,
  storePrograms.length >= snapshotPrograms.length,
  `${storePrograms.length}件`,
)
check(
  'ID と並び順が移行前の先頭部分と一致',
  deepEqual(
    storePrograms.slice(0, snapshotPrograms.length).map((p) => p.id),
    snapshotPrograms.map((p) => p.id),
  ),
  storePrograms.map((p) => p.id).join(','),
)
check(
  '移行前の6件は全項目が無変更（値・検証状態・未確認項目の変更なし）',
  deepEqual(storePrograms.slice(0, snapshotPrograms.length), snapshotPrograms),
)
check(
  '追加分（M7-F で公開した制度）は ID・検証状態が妥当（未検証データの混入なし）',
  storePrograms
    .slice(snapshotPrograms.length)
    .every(
      (p) =>
        typeof p.id === 'string' &&
        p.id.startsWith('disc-') &&
        p.verification?.status === 'partial' &&
        (p.sources ?? []).length > 0 &&
        p.sources.every((s) => s.urlVerified === true),
    ),
  storePrograms
    .slice(snapshotPrograms.length)
    .map((p) => `${p.id}:${p.verification?.status ?? '-'}`)
    .join(','),
)

// ── 2. 重要値の固定比較（移行前の記録。根拠なく変更しないこと）─────────
type ExpectedKey = {
  id: string
  name: string
  category: string
  level: string
  mock: boolean
  amount: { value: number | null; unit: string; basis: string }
  verificationStatus: string | null // null = verification なし（モックのまま）
  verifiedAt: string | null
  unconfirmedFields: string[]
  missingCount: number
}
const EXPECTED_KEYS: ExpectedKey[] = [
  {
    id: 'mock-child-allowance',
    name: '児童手当',
    category: 'cash_benefit',
    level: 'national',
    mock: false,
    amount: { value: 120000, unit: 'yen_per_year', basis: 'estimated' },
    verificationStatus: 'partial',
    verifiedAt: '2026-10-17',
    unconfirmedFields: [
      'amount.basis',
      'amount.value',
      'amount.fiscalYear',
      'conditions.incomeLimit',
      'legalBasis.ordinanceName',
      'eligibility',
    ],
    missingCount: 3,
  },
  {
    id: 'mock-high-school-scholarship',
    name: '高校生等奨学給付金',
    category: 'cash_benefit',
    level: 'national',
    mock: false,
    amount: { value: 118800, unit: 'yen_per_year', basis: 'estimated' },
    verificationStatus: 'partial',
    verifiedAt: '2026-10-15',
    unconfirmedFields: [
      'amount.basis',
      'amount.value',
      'amount.fiscalYear',
      'conditions.incomeLimit',
      'legalBasis.lawName',
      'eligibility',
    ],
    missingCount: 5,
  },
  {
    id: 'mock-child-medical-aid',
    name: 'こども医療費助成（モック・自治体による）',
    category: 'fee_reduction',
    level: 'municipal',
    mock: true,
    amount: { value: null, unit: 'other', basis: 'unknown' },
    verificationStatus: null,
    verifiedAt: null,
    unconfirmedFields: [],
    missingCount: 3,
  },
  {
    id: 'mock-education-loan',
    name: '教育一般貸付（正式名称は要確認）',
    category: 'loan',
    level: 'national',
    mock: false,
    amount: { value: null, unit: 'other', basis: 'unknown' },
    verificationStatus: 'partial',
    verifiedAt: '2026-10-15',
    unconfirmedFields: [
      'amount.value',
      'period',
      'name',
      'amount.value',
      'period',
      'legalBasis.lawName',
      'eligibility',
    ],
    missingCount: 6,
  },
  {
    id: 'official-jasso-kyufu-shogakukin',
    name: '日本学生支援機構 給付奨学金',
    category: 'cash_benefit',
    level: 'national',
    mock: false,
    amount: { value: null, unit: 'other', basis: 'unknown' },
    verificationStatus: 'partial',
    verifiedAt: '2026-10-17',
    unconfirmedFields: [
      'amount.value',
      'period',
      'amount.value',
      'period',
      'eligibility',
    ],
    missingCount: 4,
  },
  {
    id: 'official-jasso-taiyo-shogakukin',
    name: '日本学生支援機構 貸与奨学金',
    category: 'loan',
    level: 'national',
    mock: false,
    amount: { value: null, unit: 'other', basis: 'unknown' },
    verificationStatus: 'partial',
    verifiedAt: '2026-10-17',
    unconfirmedFields: [
      'amount.value',
      'period',
      'amount.value',
      'conditions.incomeLimit',
      'period',
      'eligibility',
    ],
    missingCount: 6,
  },
]

console.log('== 重要値の固定比較 ==')
check(
  `重要値レコードの件数が一致（${EXPECTED_KEYS.length}件）`,
  EXPECTED_KEYS.length === snapshotPrograms.length,
)
for (const expected of EXPECTED_KEYS) {
  const p = storePrograms.find((x) => x.id === expected.id)
  if (p === undefined) {
    failed += 1
    console.error(`NG: ${expected.id} がレジストリにありません`)
    continue
  }
  check(
    `${expected.id}: 名称・分類・レベル・mock`,
    p.name === expected.name &&
      p.category === expected.category &&
      p.level === expected.level &&
      p.mock === expected.mock,
    `${p.name} / ${p.category} / ${p.level} / mock=${String(p.mock)}`,
  )
  check(
    `${expected.id}: 給付額・減免額（value/unit/basis）`,
    p.amount.value === expected.amount.value &&
      p.amount.unit === expected.amount.unit &&
      p.amount.basis === expected.amount.basis,
    `value=${String(p.amount.value)} unit=${p.amount.unit} basis=${p.amount.basis}`,
  )
  check(
    `${expected.id}: 検証状態（格上げなし）`,
    (p.verification?.status ?? null) === expected.verificationStatus &&
      (p.verification?.verifiedAt ?? null) === expected.verifiedAt,
    `status=${p.verification?.status ?? '(なし)'} verifiedAt=${p.verification?.verifiedAt ?? '(なし)'}`,
  )
  check(
    `${expected.id}: 未確認項目`,
    deepEqual(
      (p.unconfirmedItems ?? []).map((u) => u.field),
      expected.unconfirmedFields,
    ),
    (p.unconfirmedItems ?? []).map((u) => u.field).join(','),
  )
  check(
    `${expected.id}: 要確認事項 ${expected.missingCount}件`,
    p.missingInformation.length === expected.missingCount,
    `${p.missingInformation.length}件`,
  )
}

// ── 3. 制度データ保存形式の検証（本番ファイル・スキーマ）─────────────
console.log('== 制度データ保存形式 ==')
const storeFileText = readFileSync(PROGRAM_STORE_FILE, 'utf8')
const storeFromText = parseProgramStoreJson(storeFileText, PROGRAM_STORE_FILE)
check(
  '本番ファイル（parseProgramStoreJson）と getProgramStore() が一致',
  deepEqual(storeFromText, [...getProgramStore()]),
)
check(
  '全件が supportProgramSchema を満たす',
  z.array(supportProgramSchema).safeParse(storePrograms).success,
)
check(
  '制度 ID の重複なし',
  new Set(storePrograms.map((p) => p.id)).size === storePrograms.length,
)
check(
  'getProgramStore() は凍結済み（キャッシュ汚染の防止）',
  Object.isFrozen(getProgramStore()),
)
{
  const first = getSupportPrograms()
  first.sort((a, b) => b.id.localeCompare(a.id))
  check(
    'getSupportPrograms() は呼び出し元が並べ替えてもキャッシュを壊さない',
    getSupportPrograms()[0].id === 'mock-child-allowance',
    getSupportPrograms()[0].id,
  )
}
check(
  `formatVersion は ${PROGRAM_STORE_FORMAT_VERSION}`,
  JSON.parse(storeFileText).formatVersion === PROGRAM_STORE_FORMAT_VERSION,
)

// ── 4. 不正データの検出とエラー報告の品質 ─────────────────────────
console.log('== 不正データの検出とエラー報告 ==')
const base = JSON.parse(storeFileText) as {
  formatVersion: number
  programs: Record<string, unknown>[]
}
const corruptAmount = JSON.parse(JSON.stringify(base.programs[0])) as {
  id: string
  amount: { value: unknown }
}
corruptAmount.amount.value = '金額'
expectStoreError(
  'JSON 構文エラー: ファイル名と理由が分かる',
  () => parseProgramStoreJson('{ "formatVersion": 1,', 'test/broken.json'),
  ['test/broken.json', 'JSON として解析できません'],
)
expectStoreError(
  '未対応の formatVersion を検出',
  () => parseProgramStore({ formatVersion: 99, programs: [] }, 'test/v.json'),
  ['test/v.json', 'formatVersion'],
)
expectStoreError(
  'programs が配列でないことを検出',
  () => parseProgramStore({ formatVersion: 1, programs: {} }, 'test/notarray.json'),
  ['test/notarray.json', 'programs: 配列である必要があります'],
)
expectStoreError(
  'スキーマ不一致: ファイル名・要素番号・ID・フィールドパスが分かる',
  () =>
    parseProgramStore(
      { formatVersion: 1, programs: [corruptAmount] },
      'test/schema.json',
    ),
  ['test/schema.json', 'programs[0]', 'id: "mock-child-allowance"', 'amount.value'],
)
expectStoreError(
  'ID 重複: 両方の要素番号と ID が分かる',
  () =>
    parseProgramStore(
      { formatVersion: 1, programs: [base.programs[0], base.programs[0]] },
      'test/dup.json',
    ),
  ['test/dup.json', 'programs[1]', 'programs[0]', 'id が重複'],
)
expectStoreError(
  'ID 重複: 不正要素が混じっても実際のファイル位置を報告する',
  () =>
    parseProgramStore(
      {
        formatVersion: 1,
        programs: [corruptAmount, base.programs[0], base.programs[0]],
      },
      'test/dup2.json',
    ),
  ['test/dup2.json', 'programs[2]', 'programs[1]', 'id が重複'],
)
expectStoreError(
  'トップレベルが object でないことを検出',
  () => parseProgramStore([], 'test/array.json'),
  ['test/array.json', 'トップレベル'],
)

// ── 5. 既存機能との互換性 ─────────────────────────────────────────
console.log('== 既存機能との互換性 ==')
check(
  'remainingMockProgramIds(): 未確認モックは mock-child-medical-aid のみ',
  deepEqual(remainingMockProgramIds(), ['mock-child-medical-aid']),
  remainingMockProgramIds().join(','),
)
check(
  'registryDisclaimer(): モック免責を併記（表示契約の維持）',
  registryDisclaimer().includes(REGISTRY_DISCLAIMER) &&
    registryDisclaimer().includes(MOCK_DISCLAIMER),
)
{
  const kb = buildKnowledgeBase()
  check(`相談AI 知識: ${EXPECTED_KEYS.length}件を生成`, kb.length === EXPECTED_KEYS.length, `${kb.length}件`)
  // M7-F: 相談AI の知識は M6 の調査ログ由来の制度から生成される（移行前6件）。
  // ストアには M7-F で公開した制度も含まれるため、集合一致ではなく
  // 「知識の ID はすべてストアに存在し、移行前6件を含む」ことを確認する
  const kbIds = new Set(kb.map((e) => e.programId))
  const storeIds = new Set(storePrograms.map((p) => p.id))
  check(
    '相談AI 知識: 制度 ID はすべてストアに存在し移行前6件を含む',
    [...kbIds].every((id) => storeIds.has(id)) &&
      snapshotPrograms.every((p) => kbIds.has(p.id)),
    kb.map((e) => e.programId).join(','),
  )
}
{
  // フィクスチャと本番ストアの同期ガード（kb.ts がフィクスチャ参照の
  // ままのため、制度データ更新時は両方を更新すること）
  const fixturePrograms: SupportProgram[] = [
    ...buildOfficialPrograms(),
    ...MOCK_SUPPORT_PROGRAMS.filter((p) => p.id === 'mock-child-medical-aid'),
  ]
  for (const fixture of fixturePrograms) {
    const stored = storePrograms.find((p) => p.id === fixture.id)
    check(
      `フィクスチャとストアの同期: ${fixture.id}`,
      stored !== undefined && deepEqual(stored, fixture),
      stored === undefined ? 'ストアに存在しない' : undefined,
    )
  }
}
{
  const child: ChildRow = { id: 'a', kind: 'existing', ageYears: 8, birthInYears: null }
  const input: SimulationInput = {
    childCount: 1,
    savings: 1_000_000,
    targetAmount: 10_000_000,
    planStatus: 'have',
    children: [child],
    desiredChildCount: null,
    firstBirthTiming: null,
    household: {
      annualIncomeYen: 6_000_000,
      incomeBand: null,
      monthlyTakeHomeYen: 350_000,
      monthlyLivingExpenseYen: 220_000,
      monthlyHousingCostYen: 90_000,
      municipality: '東京都世田谷区',
      householdType: 'couple',
      schoolCourse: 'public',
      universityCourse: 'national',
      workAfterBirth: 'unchanged',
      usedSupportProgramIds: ['mock-child-allowance'],
    },
  }
  // M7-F: 追加公開分を含めたシミュレーション結果が変化するのは意図どおりのため、
  // 「移行前6件に限定した場合の計算結果が無変更」であることを確認する
  const fromStore = buildSimulationResult(
    input,
    getSupportPrograms().filter((p) =>
      snapshotPrograms.some((s) => (s as { id: string }).id === p.id),
    ),
  )
  const fromSnapshot = buildSimulationResult(input, snapshotPrograms)
  check(
    'シミュレーション計算結果が移行前データと完全一致（既存6件の計算ロジックに変化なし）',
    deepEqual(fromStore, fromSnapshot),
  )
  check(
    '追加分を含む全制度でシミュレーションが正常に動作する（計算は崩壊していない）',
    buildSimulationResult(input, getSupportPrograms()).children.length > 0,
  )
}

// ── 5b. M7-G 公開前監査: 確認者の区別とシミュレーション安全性 ────────
{
  const discPrograms = getSupportPrograms().filter((p) => p.id.startsWith('disc-'))
  check(
    'M7-G: 追加公開5件はすべて humanConfirmed:false（人手確認未完了を明示）',
    discPrograms.length === 5 &&
      discPrograms.every((p) => p.verification?.humanConfirmed === false),
    `${discPrograms.length}件`,
  )
  check(
    'M7-G: 追加公開5件の確認者は AIエージェントとして記録（人間確認と区別できる）',
    discPrograms.every((p) => p.verification?.confirmedBy === 'AIエージェント(M7-F)'),
  )
  const discText = JSON.stringify(discPrograms)
  check(
    'M7-G: 人手未確認データに「人間が承認」「人手確認」の誤表記がない',
    !discText.includes('人間が承認') && !discText.includes('に人手確認'),
  )
  check(
    'M7-G: 人手確認未完了の制度はバッジを「AI確認済み・人手確認待ち」に落とす',
    discPrograms.every((p) => verificationBadgeText(p) === 'AI確認済み・人手確認待ち'),
    discPrograms.map((p) => verificationBadgeText(p)).join(' / '),
  )
  const legacy = getSupportPrograms().filter((p) => !p.id.startsWith('disc-'))
  check(
    'M7-G: 既存6件には humanConfirmed を付与せず表示を変更しない',
    legacy.length === 6 &&
      legacy.every((p) => p.verification?.humanConfirmed === undefined),
  )
}
{
  // M7-G: シミュレーション安全性（本番データ11件で確認）
  const input: SimulationInput = {
    childCount: 1,
    savings: 1_000_000,
    targetAmount: 10_000_000,
    planStatus: 'have',
    children: [{ id: 'a', kind: 'existing', ageYears: 8, birthInYears: null }],
    desiredChildCount: null,
    firstBirthTiming: null,
    household: {
      annualIncomeYen: 6_000_000,
      incomeBand: null,
      monthlyTakeHomeYen: 350_000,
      monthlyLivingExpenseYen: 220_000,
      monthlyHousingCostYen: 90_000,
      municipality: '東京都新宿区',
      householdType: 'couple',
      schoolCourse: 'public',
      universityCourse: 'national',
      workAfterBirth: 'unchanged',
      usedSupportProgramIds: [],
    },
  }
  const result = buildSimulationResult(input, getSupportPrograms())
  const uncountedReasons = result.supportTotals.uncounted.map((u) => u.excludedReason ?? '')
  check(
    'M7-G: 金額未確認の制度は合計対象外（理由付き・合計に混入しない）',
    uncountedReasons.some((r) => r.includes('金額が未確認')),
    uncountedReasons.join(' / '),
  )
  check(
    'M7-G: 貸付は給付・助成の合計に含まれない（理由付き）',
    uncountedReasons.filter((r) => r.includes('貸付制度のため合計対象外')).length >= 2,
    uncountedReasons.join(' / '),
  )
  check(
    'M7-G: 対象条件が未確認の追加制度は「利用可能」と断定しない（unconfirmed のまま）',
    result.supports.effects
      .filter((e) => e.program.id.startsWith('disc-'))
      .every((e) => e.eligibility === 'unconfirmed'),
    result.supports.effects
      .filter((e) => e.program.id.startsWith('disc-'))
      .map((e) => `${e.program.id}:${e.eligibility}`)
      .join(' / '),
  )
  const todayStr = new Date().toISOString().slice(0, 10)
  const expiredButCounted = result.supports.effects.filter(
    (e) =>
      e.includedInTotal &&
      e.program.application.deadlineDate !== null &&
      e.program.application.deadlineDate !== undefined &&
      e.program.application.deadlineDate < todayStr,
  )
  check(
    'M7-G: 受付期限が過ぎた制度が合計計上されない（本番データで確認）',
    expiredButCounted.length === 0,
    expiredButCounted.map((e) => e.program.id).join(' / '),
  )
  const combinationUnknown = result.supports.effects.some(
    (e) => e.includedInTotal && e.program.conditions.combinedWith.length === 0,
  )
  const assumption = result.assumptions.find((a) => a.label === '公的支援の額')
  check(
    'M7-G: 併用可否が未確認の制度を含む場合、合計は単純合算の試算と明示（確定額と断定しない）',
    !combinationUnknown ||
      (assumption?.flag === 'unverified' && (assumption.note ?? '').includes('単純合算')),
    JSON.stringify(assumption),
  )
}

// ── 6. 外部通信なし・結果サマリ ───────────────────────────────────
check('外部通信は一切行っていない', fetchCalls === 0, `${fetchCalls}回`)
globalThis.fetch = originalFetch

if (failed > 0) {
  console.error(`\nNG: ${failed} 件のチェックが失敗しました`)
  process.exit(1)
}
console.log('\nPASS: M7-B 制度データ保存基盤の検証はすべて成功しました')