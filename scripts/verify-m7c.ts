/**
 * M7-C 調査計画・カバレッジ管理の検証
 *
 * 実行: npx tsx scripts/verify-m7c.ts
 *
 * - 初期データの検証（25地域・12分野・全組み合わせ300タスク・未調査開始）
 * - 調査状態・日付・URL の検証と、不正データ時のエラー品質
 *   （ファイル名・要素番号・ID・フィールドパス）
 * - 進捗集計（調査済み領域の割合＝網羅率ではないことの確認）
 * - 更新処理（applySurveyPlanUpdate / CLI）の安全性（全体再検証・既存データ非破壊）
 * - 既存機能との互換性（制度データ・レジストリ・計算・取得台帳の非変更）
 * - 外部通信なし（fetch 未使用）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SURVEY_PLAN_FILE,
  SurveyPlanError,
  applySurveyPlanUpdate,
  parseSurveyPlan,
  parseSurveyPlanJson,
  serializeSurveyPlan,
} from '../lib/survey/surveyPlanStore'
import { summarizeSurveyPlan } from '../lib/survey/surveyPlanReport'
import {
  SURVEY_STATUSES,
  type SurveyPlan,
  type SurveyTask,
} from '../lib/types/surveyPlan'
import { getSupportPrograms, registryDisclaimer } from '../lib/supports/registry'
import { verifiedOfficialUrls } from '../lib/supports/officialPrograms'
import { buildKnowledgeBase } from '../lib/supports/kb'

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
    const ka = Object.keys(a as object).sort()
    const kb = Object.keys(b as object).sort()
    return (
      deepEqual(ka, kb) &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    )
  }
  return false
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function makeTask(
  taskId: string,
  regionId: string,
  fieldId: string,
  over: Partial<SurveyTask> = {},
): SurveyTask {
  return {
    taskId,
    regionId,
    fieldId,
    status: 'not_started',
    lastSurveyedAt: null,
    nextScheduledDate: null,
    portalUrls: [],
    candidateCount: 0,
    notes: '',
    openIssues: [],
    ...over,
  }
}

/** 検証用の小さな調査計画（2地域 × 2分野 = 4タスク） */
function makeMiniPlan(): SurveyPlan {
  return {
    formatVersion: 1,
    regions: [
      { id: 'nation', name: '国', kind: 'nation' },
      { id: 'tokyo', name: '東京都', kind: 'prefecture' },
    ],
    fields: [
      { id: 'pregnancy-birth', name: '妊娠・出産' },
      { id: 'medical-health', name: '医療費・健康' },
    ],
    tasks: [
      makeTask('nation/pregnancy-birth', 'nation', 'pregnancy-birth'),
      makeTask('nation/medical-health', 'nation', 'medical-health'),
      makeTask('tokyo/pregnancy-birth', 'tokyo', 'pregnancy-birth'),
      makeTask('tokyo/medical-health', 'tokyo', 'medical-health'),
    ],
  }
}

function expectPlanError(
  name: string,
  fn: () => unknown,
  substrings: string[],
): void {
  try {
    fn()
    check(name, false, 'エラーが発生しませんでした')
  } catch (error) {
    if (error instanceof SurveyPlanError) {
      const all = [error.message, ...error.issues].join('\n')
      const missing = substrings.filter((s) => !all.includes(s))
      check(
        name,
        missing.length === 0,
        missing.length > 0 ? `不足: ${missing.join(' / ')} — 実際: ${all}` : undefined,
      )
    } else {
      check(name, false, `SurveyPlanError ではありません: ${String(error)}`)
    }
  }
}


// ── 1. 初期データの検証 ─────────────────────────────────────────
console.log('\n[1] 初期データ（data/survey-plan.json）')
const planText = readFileSync(SURVEY_PLAN_FILE, 'utf8')
const plan = parseSurveyPlanJson(planText, SURVEY_PLAN_FILE)

const expectedRegions: [string, string, string][] = [
  ['nation', '国', 'nation'],
  ['tokyo', '東京都', 'prefecture'],
  ['chiyoda-ku', '千代田区', 'ward'],
  ['chuo-ku', '中央区', 'ward'],
  ['minato-ku', '港区', 'ward'],
  ['shinjuku-ku', '新宿区', 'ward'],
  ['bunkyo-ku', '文京区', 'ward'],
  ['taito-ku', '台東区', 'ward'],
  ['sumida-ku', '墨田区', 'ward'],
  ['koto-ku', '江東区', 'ward'],
  ['shinagawa-ku', '品川区', 'ward'],
  ['meguro-ku', '目黒区', 'ward'],
  ['ota-ku', '大田区', 'ward'],
  ['setagaya-ku', '世田谷区', 'ward'],
  ['shibuya-ku', '渋谷区', 'ward'],
  ['nakano-ku', '中野区', 'ward'],
  ['suginami-ku', '杉並区', 'ward'],
  ['toshima-ku', '豊島区', 'ward'],
  ['kita-ku', '北区', 'ward'],
  ['arakawa-ku', '荒川区', 'ward'],
  ['itabashi-ku', '板橋区', 'ward'],
  ['nerima-ku', '練馬区', 'ward'],
  ['adachi-ku', '足立区', 'ward'],
  ['katsushika-ku', '葛飾区', 'ward'],
  ['edogawa-ku', '江戸川区', 'ward'],
]
const expectedFields: [string, string][] = [
  ['pregnancy-birth', '妊娠・出産'],
  ['child-allowance-cash', '子ども手当・現金給付'],
  ['childcare-early-education', '保育・幼児教育'],
  ['medical-health', '医療費・健康'],
  ['elementary-junior-school', '小学校・中学校'],
  ['higher-education', '高校・大学・高等教育'],
  ['single-parent-support', 'ひとり親世帯への支援'],
  ['low-income-support', '低所得世帯への支援'],
  ['multi-child-support', '多子世帯への支援'],
  ['disability-support', '障害のある子ども・世帯への支援'],
  ['housing-living-costs', '住宅・生活費などの負担軽減'],
  ['other-childcare-support', 'その他の子育て関連支援'],
]

check('25地域（国・東京都・23区）が存在する', plan.regions.length === 25, `実際: ${plan.regions.length}`)
check(
  '調査状態は not_started / in_progress / surveyed / needs_recheck の4種類',
  deepEqual([...SURVEY_STATUSES], ['not_started', 'in_progress', 'surveyed', 'needs_recheck']),
)
check(
  '地域ID・地域名・地域区分が期待値と一致する',
  deepEqual(
    plan.regions.map((r) => [r.id, r.name, r.kind]),
    expectedRegions,
  ),
)
check('支援分野12が存在する', plan.fields.length === 12, `実際: ${plan.fields.length}`)
check(
  '分野ID・分野名が期待値と一致する',
  deepEqual(
    plan.fields.map((f) => [f.id, f.name]),
    expectedFields,
  ),
)
check(
  '全組み合わせ（25地域 × 12分野 = 300タスク）が管理されている',
  plan.tasks.length === 300,
  `実際: ${plan.tasks.length}`,
)

const fieldIds = new Set(expectedFields.map(([id]) => id))
const coverageOk = plan.regions.every((region) => {
  const fields = plan.tasks.filter((t) => t.regionId === region.id).map((t) => t.fieldId)
  return fields.length === 12 && fieldIds.size === new Set(fields).size
})
check('すべての地域で指定12分野が管理されている（parseSurveyPlan でも網羅性を保証）', coverageOk)

check(
  '原則として未調査（not_started）から開始している',
  plan.tasks.every((t) => t.status === 'not_started'),
)
check(
  '最終調査日時・次回調査予定日は初期状態で未設定（null）',
  plan.tasks.every((t) => t.lastSurveyedAt === null && t.nextScheduledDate === null),
)
check(
  '発見候補数は候補ストアと一致する（過大・過小計上なし。0件のタスクも多数残る）',
  (() => {
    const store = JSON.parse(
      readFileSync('data/discovery/candidates.json', 'utf8'),
    ) as { candidates: Array<{ taskId: string; status: string }> }
    const expected = new Map<string, number>()
    for (const c of store.candidates) {
      if (c.status === 'discarded') continue
      expected.set(c.taskId, (expected.get(c.taskId) ?? 0) + 1)
    }
    return plan.tasks.every(
      (t) => t.candidateCount === (expected.get(t.taskId) ?? 0),
    )
  })(),
)
check(
  '全タスクに taskId = regionId + "/" + fieldId の一意な ID がある',
  plan.tasks.every((t) => t.taskId === `${t.regionId}/${t.fieldId}`) &&
    new Set(plan.tasks.map((t) => t.taskId)).size === 300,
)

// ── 2. 公式ポータルURLの根拠 ────────────────────────────────────
console.log('\n[2] 公式ポータルURL（推測で作らない）')
const verifiedUrls = verifiedOfficialUrls()
// M7-F: 情報源台帳で公式確認済み（登録→実取得→公式確認）の URL も根拠とする
{
  const ledger = JSON.parse(
    readFileSync('data/source-ledger.json', 'utf8'),
  ) as { entries: Array<{ url: string; urlState: string }> }
  for (const e of ledger.entries) {
    if (e.urlState === 'official-confirmed') verifiedUrls.add(e.url)
  }
}
check(
  '登録URLはすべて RESEARCH_LOG または情報源台帳で公式確認済みのURL（根拠のあるURLのみ）',
  plan.tasks.every((t) => t.portalUrls.every((u) => verifiedUrls.has(u))),
  plan.tasks
    .flatMap((t) => t.portalUrls)
    .filter((u) => !verifiedUrls.has(u))
    .join(', '),
)
const urlTasks = plan.tasks.filter((t) => t.portalUrls.length > 0)
check(
  'URL登録タスクは根拠のあるURLのみ（M7-C の2タスクから M7-F で拡大。推測URLなし）',
  urlTasks.length >= 2 &&
    urlTasks.every((t) => t.portalUrls.every((u) => verifiedUrls.has(u))),
  `実際: ${urlTasks.length}タスク`,
)
const cashTask = plan.tasks.find((t) => t.taskId === 'nation/child-allowance-cash')
check(
  '国 × 子ども手当・現金給付の参照URL（こども家庭庁 児童手当）が期待値と一致',
  deepEqual(cashTask?.portalUrls, [
    'https://www.cfa.go.jp/policies/kokoseido/jidouteate',
    'https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai',
  ]),
)
const higherTask = plan.tasks.find((t) => t.taskId === 'nation/higher-education')
check(
  '国 × 高校・大学・高等教育の参照URL（JASSO・文科省・日本政策金融公庫）が期待値と一致',
  deepEqual(higherTask?.portalUrls, [
    'https://www.jasso.go.jp/shogakukin/',
    'https://www.mext.go.jp/a_menu/shotou/mushouka/index.htm',
    'https://www.jfc.go.jp/',
  ]),
)
check(
  '東京都・23区の登録URLもすべて根拠のあるURL（M7-F で実在確認済みURLを登録。推測URLを作らない）',
  plan.tasks
    .filter((t) => t.regionId !== 'nation')
    .every((t) => t.portalUrls.every((u) => verifiedUrls.has(u))),
)

// ── 3. 保存形式の安定性 ─────────────────────────────────────────
console.log('\n[3] 保存形式の安定性')
const planAgain = parseSurveyPlanJson(planText, SURVEY_PLAN_FILE)
check('読み込み結果が決定的（再パースで一致）', deepEqual(plan, planAgain))
check(
  'ファイルは正規の直列化形式（serializeSurveyPlan の出力と一致）',
  serializeSurveyPlan(planAgain) === planText,
)
const mini = parseSurveyPlan(makeMiniPlan(), 'mini')
check(
  '直列化 → 再パースの往復一致',
  deepEqual(parseSurveyPlanJson(serializeSurveyPlan(mini), 'mini'), mini),
)

function runCli(args: string[]): { out: string; status: number } {
  try {
    const out = execFileSync('npx', ['tsx', 'scripts/survey-plan.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, status: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number }
    return {
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      status: e.status ?? 1,
    }
  }
}

// ── 4. 不正データとエラー品質 ───────────────────────────────────
console.log('\n[4] 不正データとエラー品質（原因が分かるエラー）')
const miniJson = () => JSON.stringify(makeMiniPlan())
function mutated(fn: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(miniJson()) as {
    regions: unknown[]
    fields: unknown[]
    tasks: Record<string, unknown>[]
  }
  fn(raw as unknown as Record<string, unknown>)
  return JSON.stringify(raw)
}

expectPlanError(
  'JSON 構文エラーはファイル名と原因を報告',
  () => parseSurveyPlanJson('{ broken', 'data/survey-plan.json'),
  ['data/survey-plan.json', 'JSON として解析できません'],
)
expectPlanError(
  '未対応の formatVersion は報告',
  () =>
    parseSurveyPlan(
      { formatVersion: 2, regions: [], fields: [], tasks: [] },
      'data/survey-plan.json',
    ),
  ['formatVersion', '未対応'],
)
expectPlanError(
  'トップレベルが object でない場合は報告',
  () => parseSurveyPlan('nope', 'data/survey-plan.json'),
  ['トップレベル'],
)
expectPlanError(
  '調査状態の不正値は要素番号・ID・フィールドパス付きで報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].status = 'done'
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'taskId: "nation/pregnancy-birth"', 'status'],
)
expectPlanError(
  '最終調査日時の形式不正は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[2].lastSurveyedAt = '2026/10/27'
      }),
      'data/survey-plan.json',
    ),
  ['tasks[2]', 'lastSurveyedAt', 'ISO 8601'],
)
expectPlanError(
  '次回調査予定日の形式不正は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[1].nextScheduledDate = '10-27-2026'
      }),
      'data/survey-plan.json',
    ),
  ['tasks[1]', 'nextScheduledDate', 'YYYY-MM-DD'],
)
expectPlanError(
  '不正な URL は報告（http/https のみ）',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].portalUrls = ['ftp://example.com']
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'portalUrls.0', 'http/https'],
)
expectPlanError(
  '候補数の負値は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].candidateCount = -1
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'candidateCount'],
)
expectPlanError(
  'taskId の重複は実際の位置で報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        const tasks = raw.tasks as Record<string, unknown>[]
        tasks[2].taskId = tasks[0].taskId
      }),
      'data/survey-plan.json',
    ),
  ['tasks[2]', 'taskId が重複しています', 'tasks[0]'],
)
expectPlanError(
  'regionId の未定義参照は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].regionId = 'suginami-ku-x'
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'regionId', 'suginami-ku-x', 'regions に存在しません'],
)
expectPlanError(
  'fieldId の未定義参照は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].fieldId = 'unknown-field'
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'fieldId', 'fields に存在しません'],
)
expectPlanError(
  '地域ID の重複は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.regions as Record<string, unknown>[])[1].id = 'nation'
      }),
      'data/survey-plan.json',
    ),
  ['regions[1]', 'id が重複しています', 'regions[0]'],
)
expectPlanError(
  '組み合わせの欠落は報告（全組み合わせが必要）',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        raw.tasks = (raw.tasks as Record<string, unknown>[]).slice(0, 3)
      }),
      'data/survey-plan.json',
    ),
  ['組み合わせが不足しています'],
)
expectPlanError(
  '組み合わせの重複は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        const tasks = raw.tasks as Record<string, unknown>[]
        tasks.push({ ...tasks[3], taskId: 'tokyo/medical-health-copy' })
      }),
      'data/survey-plan.json',
    ),
  ['組み合わせ', '重複しています'],
)
expectPlanError(
  '同一タスク内の URL 重複は報告',
  () =>
    parseSurveyPlanJson(
      mutated((raw) => {
        ;(raw.tasks as Record<string, unknown>[])[0].portalUrls = [
          'https://www.cfa.go.jp/laws',
          'https://www.cfa.go.jp/laws',
        ]
      }),
      'data/survey-plan.json',
    ),
  ['tasks[0]', 'portalUrls[1]', '重複しています'],
)

// ── 5. 更新処理（applySurveyPlanUpdate）─────────────────────────
console.log('\n[5] 更新処理（既存データを壊さない）')
const base = parseSurveyPlan(makeMiniPlan(), 'mini')
const baseJson = JSON.stringify(base)
const updated = applySurveyPlanUpdate(base, {
  type: 'set-status',
  taskId: 'tokyo/medical-health',
  status: 'surveyed',
  lastSurveyedAt: '2026-10-27T10:00:00+09:00',
})
check('元の plan は変更されない（純関数）', JSON.stringify(base) === baseJson)
check(
  'set-status と最終調査日時が反映される',
  updated.tasks[3].status === 'surveyed' &&
    updated.tasks[3].lastSurveyedAt === '2026-10-27T10:00:00+09:00',
)
check(
  '対象外のタスク・地域・分野は変更されない',
  deepEqual(updated.tasks.slice(0, 3), base.tasks.slice(0, 3)) &&
    deepEqual(updated.regions, base.regions) &&
    deepEqual(updated.fields, base.fields),
)
check(
  'lastSurveyedAt の解除ができる',
  applySurveyPlanUpdate(base, {
    type: 'set-status',
    taskId: 'nation/pregnancy-birth',
    status: 'in_progress',
    lastSurveyedAt: null,
  }).tasks[0].lastSurveyedAt === null,
)
check(
  'set-next-date が反映・解除される',
  applySurveyPlanUpdate(
    applySurveyPlanUpdate(base, {
      type: 'set-next-date',
      taskId: 'nation/pregnancy-birth',
      nextScheduledDate: '2026-12-01',
    }),
    { type: 'set-next-date', taskId: 'nation/pregnancy-birth', nextScheduledDate: null },
  ).tasks[0].nextScheduledDate === null,
)
check(
  'add-url / remove-url が反映される',
  (() => {
    const withUrl = applySurveyPlanUpdate(base, {
      type: 'add-url',
      taskId: 'nation/pregnancy-birth',
      url: 'https://www.cfa.go.jp/laws',
    })
    const removed = applySurveyPlanUpdate(withUrl, {
      type: 'remove-url',
      taskId: 'nation/pregnancy-birth',
      url: 'https://www.cfa.go.jp/laws',
    })
    return (
      withUrl.tasks[0].portalUrls.length === 1 &&
      removed.tasks[0].portalUrls.length === 0
    )
  })(),
)
check(
  'set-candidate-count が反映される',
  applySurveyPlanUpdate(base, {
    type: 'set-candidate-count',
    taskId: 'tokyo/pregnancy-birth',
    candidateCount: 7,
  }).tasks[2].candidateCount === 7,
)
expectPlanError(
  '存在しない taskId の更新は明確なエラー',
  () =>
    applySurveyPlanUpdate(base, {
      type: 'set-status',
      taskId: 'tokyo/no-such',
      status: 'surveyed',
    }),
  ['tokyo/no-such', '存在しません'],
)
expectPlanError(
  '不正な日時での更新は拒否（全体再検証）',
  () =>
    applySurveyPlanUpdate(base, {
      type: 'set-status',
      taskId: 'nation/pregnancy-birth',
      status: 'surveyed',
      lastSurveyedAt: '昨日',
    }),
  ['lastSurveyedAt', 'ISO 8601'],
)
expectPlanError(
  '不正な URL の追加は拒否（http/https のみ）',
  () =>
    applySurveyPlanUpdate(base, {
      type: 'add-url',
      taskId: 'nation/pregnancy-birth',
      url: 'javascript:alert(1)',
    }),
  ['portalUrls', 'http/https'],
)
expectPlanError(
  '負の候補数の更新は拒否',
  () =>
    applySurveyPlanUpdate(base, {
      type: 'set-candidate-count',
      taskId: 'nation/pregnancy-birth',
      candidateCount: -3,
    }),
  ['candidateCount'],
)

// ── 6. 進捗集計（調査済み領域の割合と制度の網羅率の分離）─────────
console.log('\n[6] 進捗集計')
const report = summarizeSurveyPlan(plan)
check('総領域数 300（25 × 12）', report.totalTasks === 300, String(report.totalTasks))
check(
  '未調査 300 / 他 0（初期状態）',
  report.statusCounts.not_started === 300 &&
    report.statusCounts.in_progress === 0 &&
    report.statusCounts.surveyed === 0 &&
    report.statusCounts.needs_recheck === 0,
)
check('調査済み領域の割合は 0%', report.surveyedTaskRatio === 0)
check(
  '発見候補数合計は候補ストアの非却下件数と一致',
  report.candidateTotal ===
    (
      JSON.parse(readFileSync('data/discovery/candidates.json', 'utf8')) as {
        candidates: Array<{ status: string }>
      }
    ).candidates.filter((c) => c.status !== 'discarded').length,
  String(report.candidateTotal),
)
check(
  `URL未登録 ${plan.tasks.filter((t) => t.portalUrls.length === 0).length} 領域（調査計画の実データと一致）`,
  report.tasksMissingPortalUrl.length ===
    plan.tasks.filter((t) => t.portalUrls.length === 0).length,
  String(report.tasksMissingPortalUrl.length),
)
check(
  '地域別集計（25地域 × 12分野が未調査）',
  report.byRegion.length === 25 &&
    report.byRegion.every((r) => r.statusCounts.not_started === 12),
)
check(
  '分野別集計（12分野 × 25地域が未調査）',
  report.byField.length === 12 &&
    report.byField.every((f) => f.statusCounts.not_started === 25),
)

const mixed = applySurveyPlanUpdate(
  applySurveyPlanUpdate(
    applySurveyPlanUpdate(parseSurveyPlan(makeMiniPlan(), 'mini'), {
      type: 'set-status',
      taskId: 'tokyo/medical-health',
      status: 'surveyed',
      lastSurveyedAt: '2026-10-27T10:00:00+09:00',
    }),
    { type: 'set-status', taskId: 'nation/pregnancy-birth', status: 'in_progress' },
  ),
  { type: 'set-status', taskId: 'tokyo/pregnancy-birth', status: 'needs_recheck' },
)
const mixedReport = summarizeSurveyPlan(mixed)
check(
  '調査済み領域の割合は surveyed のみを数える（調査中を含めない: 1/4 = 0.25）',
  mixedReport.surveyedTaskRatio === 0.25,
  String(mixedReport.surveyedTaskRatio),
)
check(
  '再調査が必要な領域の一覧化',
  mixedReport.needsRecheckTasks.length === 1 &&
    mixedReport.needsRecheckTasks[0].taskId === 'tokyo/pregnancy-birth',
)
check(
  '調査中・未調査の一覧化',
  mixedReport.inProgressTasks.length === 1 &&
    mixedReport.notStartedTasks.length === 1,
)
check(
  '整合性の注意（再調査だが最終調査日時が未記録）が通知される',
  mixedReport.consistencyWarnings.some((w) =>
    w.includes('tokyo/pregnancy-birth') && w.includes('最終調査日時が未記録'),
  ),
)

// ── 7. CLI の動作（進捗確認・安全な更新）────────────────────────
console.log('\n[7] CLI の動作')
const protectedFiles = [
  SURVEY_PLAN_FILE,
  'data/programs/programs.json',
  'data/source-ledger.json',
  'data/source-retrievals.json',
  'lib/supports/programStore.ts',
  'lib/supports/registry.ts',
  'lib/supports/mockPrograms.ts',
  'lib/supports/officialPrograms.ts',
  'lib/supports/kb.ts',
  'lib/finance/supports.ts',
  'lib/types/support.ts',
  'components/Form.tsx',
  'components/Result.tsx',
]
const hashesBefore = protectedFiles.map((f) => hashFile(f))

const tmpDir = mkdtempSync(join(tmpdir(), 'm7c-'))
const tmpFile = join(tmpDir, 'survey-plan.json')
copyFileSync(SURVEY_PLAN_FILE, tmpFile)

const progressOut = runCli(['progress'])
check(
  'progress: 調査済み領域の割合を表示し、制度の網羅率ではない旨を明示',
  progressOut.status === 0 &&
    progressOut.out.includes('0 / 300 領域') &&
    progressOut.out.includes('網羅率ではありません'),
)
check(
  'progress: 調査件数0件でも制度が無いとは限らない旨を明示',
  progressOut.out.includes('制度が存在しないとは限りません'),
)
const validateOut = runCli(['validate', '--file', tmpFile])
check('validate: 検証に成功', validateOut.status === 0 && validateOut.out.includes('検証 OK'))
const summaryOut = runCli(['summary'])
check(
  'summary: 総領域数と URL未登録数を表示',
  summaryOut.status === 0 &&
    summaryOut.out.includes('全300領域') &&
    summaryOut.out.includes(
      `公式ポータルURL未登録: ${plan.tasks.filter((t) => t.portalUrls.length === 0).length}`,
    ),
)
check(
  'todo: 未調査は制度が無い意味ではない旨を明示',
  runCli(['todo']).out.includes('制度が無いという意味ではありません'),
)

const setCountOut = runCli(['set-count', 'tokyo/pregnancy-birth', '5', '--file', tmpFile])
check('set-count: 一時ファイルに反映される', setCountOut.status === 0)
check(
  'set-count: 反映後のファイルも再検証される',
  parseSurveyPlanJson(readFileSync(tmpFile, 'utf8'), tmpFile).tasks.find(
    (t) => t.taskId === 'tokyo/pregnancy-birth',
  )?.candidateCount === 5,
)
const badStatusOut = runCli(['set-status', 'tokyo/pregnancy-birth', 'done', '--file', tmpFile])
check(
  'set-status: 不正な status は exit 1 で拒否',
  badStatusOut.status === 1 && badStatusOut.out.includes('不正'),
)
const badUrlOut = runCli(['add-url', 'tokyo/pregnancy-birth', 'ftp://x', '--file', tmpFile])
check(
  'add-url: 不正な URL は exit 1 で拒否',
  badUrlOut.status === 1 && badUrlOut.out.includes('http/https'),
)
rmSync(tmpDir, { recursive: true, force: true })

// ── 8. 既存機能との互換性・非破壊 ───────────────────────────────
console.log('\n[8] 既存機能との互換性・非破壊')
const hashesAfter = protectedFiles.map((f) => hashFile(f))
check(
  '既存データ・制度データ・台帳・UI・計算モジュールが無変更（ハッシュ一致）',
  deepEqual(hashesBefore, hashesAfter),
)
const snapshotPrograms = JSON.parse(
  readFileSync('scripts/fixtures/m7b-pre-migration.json', 'utf8'),
) as Array<{ id: string }>
const storePrograms = getSupportPrograms()
// M7-F: 本番データには実調査で公開した制度が追加されている。既存6件が
// 無変更で残っていること（＝条件判定・表示の根拠が不変）を確認する
check(
  'getSupportPrograms() は移行前6件を無変更で含む（既存制度・条件判定・表示の根拠が不変。M7-F 公開分は追加）',
  snapshotPrograms.every((s, i) => storePrograms[i]?.id === s.id) &&
    deepEqual(
      storePrograms.slice(0, snapshotPrograms.length),
      snapshotPrograms,
    ),
  `${storePrograms.length}件 vs ${snapshotPrograms.length}件`,
)
check(
  'registryDisclaimer() の表示契約が不変（免責の併記）',
  typeof registryDisclaimer() === 'string' && registryDisclaimer().length > 0,
)
check('相談AI のナレッジベース生成が従来どおり動作', buildKnowledgeBase().length > 0)

// ── 外部通信ガードの解除と総括 ─────────────────────────────────
globalThis.fetch = originalFetch
check('この検証で外部通信は一切行われていない', fetchCalls === 0, `${fetchCalls} 回`)
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECKS FAILED`)
process.exitCode = failed === 0 ? 0 : 1




