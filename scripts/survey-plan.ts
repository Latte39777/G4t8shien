/**
 * 調査計画の進捗確認 CLI（M7-C）
 *
 * 実行例（リポジトリルートで実行）:
 *   npx tsx scripts/survey-plan.ts                # 全体サマリ
 *   npx tsx scripts/survey-plan.ts region         # 地域別の調査状況
 *   npx tsx scripts/survey-plan.ts field          # 分野別の調査状況
 *   npx tsx scripts/survey-plan.ts todo           # 未調査の地域・分野一覧
 *   npx tsx scripts/survey-plan.ts recheck        # 再調査が必要な領域
 *   npx tsx scripts/survey-plan.ts progress       # 調査済み領域の割合
 *   npx tsx scripts/survey-plan.ts missing-urls   # 公式ポータルURLが未登録の領域
 *   npx tsx scripts/survey-plan.ts candidates     # 発見した候補数
 *   npx tsx scripts/survey-plan.ts validate       # データの検証のみ
 *
 * 更新系（--file <path> で対象ファイルを差し替え可能。既定は data/survey-plan.json。
 * 更新は全体を再検証してから一時ファイル経由で書き込む）:
 *   npx tsx scripts/survey-plan.ts set-status <taskId> <status> [lastSurveyedAt]
 *   npx tsx scripts/survey-plan.ts set-next <taskId> <YYYY-MM-DD または ->
 *   npx tsx scripts/survey-plan.ts add-url <taskId> <url>
 *   npx tsx scripts/survey-plan.ts rm-url <taskId> <url>
 *   npx tsx scripts/survey-plan.ts set-count <taskId> <件数>
 *
 * 【進捗率の注意】「調査済み領域の割合」は調査を実施した領域（地域×分野）の
 * 割合であり、支援制度の網羅率ではない。両者を混同しないこと。
 * 【外部通信なし】この CLI はローカルファイルのみを扱う。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SURVEY_PLAN_FILE,
  SurveyPlanError,
  applySurveyPlanUpdate,
  parseSurveyPlanJson,
  serializeSurveyPlan,
  type SurveyPlanUpdate,
} from '../lib/survey/surveyPlanStore'
import {
  SURVEY_STATUS_LABELS,
  SURVEY_STATUS_ORDER,
  summarizeSurveyPlan,
  type SurveyTaskRef,
} from '../lib/survey/surveyPlanReport'
import type { SurveyStatus } from '../lib/types/surveyPlan'

const PROGRESS_NOTE =
  '※ 調査済み領域の割合＝調査を実施した領域（地域×分野）の割合です。\n' +
  '  支援制度の網羅率ではありません。調査済みでも制度の網羅を意味せず、\n' +
  '  調査件数が0件でも制度が存在しないとは限りません。'

/** 表示幅（全角を2として数える） */
function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function padEndW(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

function formatTaskRef(ref: SurveyTaskRef): string {
  const urlInfo =
    ref.portalUrlCount > 0 ? `URL登録あり(${ref.portalUrlCount})` : 'URL未登録'
  const surveyed = ref.lastSurveyedAt ? ` 最終調査: ${ref.lastSurveyedAt}` : ''
  const next = ref.nextScheduledDate ? ` 次回予定: ${ref.nextScheduledDate}` : ''
  return `  ${ref.regionName} × ${ref.fieldName} [${ref.taskId}] ${SURVEY_STATUS_LABELS[ref.status]} 候補${ref.candidateCount}件 ${urlInfo}${surveyed}${next}`
}

function printCounts(counts: Record<SurveyStatus, number>): string {
  return SURVEY_STATUS_ORDER.map(
    (s) => `${SURVEY_STATUS_LABELS[s]}=${counts[s]}`,
  ).join(' ')
}

function printHeader(title: string): void {
  console.log(`\n== ${title} ==`)
}

/** 簡易テーブル表示（各行は [列値...]。列幅は表示幅で揃える） */
function printTable(rows: string[][]): void {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell))
    })
  }
  for (const row of rows) {
    console.log('  ' + row.map((cell, i) => padEndW(cell, widths[i])).join('  '))
  }
}

// ── 引数の解析 ──────────────────────────────────────────────────
const argv = process.argv.slice(2)
const fileFlagIndex = argv.indexOf('--file')
const planFile =
  fileFlagIndex >= 0 && argv[fileFlagIndex + 1] !== undefined
    ? argv[fileFlagIndex + 1]
    : SURVEY_PLAN_FILE
const positional = argv.filter(
  (a, i) => a !== '--file' && !(fileFlagIndex >= 0 && i === fileFlagIndex + 1),
)
const command = positional[0] ?? 'summary'
const args = positional.slice(1)

function loadPlan() {
  return parseSurveyPlanJson(
    readFileSync(resolve(process.cwd(), planFile), 'utf8'),
    planFile,
  )
}

function taskRefOf(
  task: {
    taskId: string
    regionId: string
    fieldId: string
    status: SurveyStatus
    lastSurveyedAt: string | null
    nextScheduledDate: string | null
    candidateCount: number
    portalUrls: string[]
  },
  regionName: string,
  fieldName: string,
): SurveyTaskRef {
  return {
    taskId: task.taskId,
    regionId: task.regionId,
    regionName,
    fieldId: task.fieldId,
    fieldName,
    status: task.status,
    lastSurveyedAt: task.lastSurveyedAt,
    nextScheduledDate: task.nextScheduledDate,
    candidateCount: task.candidateCount,
    portalUrlCount: task.portalUrls.length,
  }
}

/** 更新系コマンドの共通処理（全体再検証 → 一時ファイル経由でアトミックに書込） */
function applyUpdate(update: SurveyPlanUpdate, describe: string): void {
  const plan = loadPlan()
  const names = (taskId: string) => {
    const task = plan.tasks.find((t) => t.taskId === taskId)
    const regionName =
      plan.regions.find((r) => r.id === task?.regionId)?.name ?? task?.regionId ?? ''
    const fieldName =
      plan.fields.find((f) => f.id === task?.fieldId)?.name ?? task?.fieldId ?? ''
    return { task, regionName, fieldName }
  }
  const before = names(update.taskId)
  const next = applySurveyPlanUpdate(plan, update, planFile)
  const after = namesIn(next, update.taskId)
  const target = resolve(process.cwd(), planFile)
  writeFileSync(`${target}.tmp`, serializeSurveyPlan(next), 'utf8')
  renameSync(`${target}.tmp`, target)
  console.log(`${describe}（${planFile} に保存）`)
  if (before.task !== undefined && after.task !== undefined) {
    console.log(
      `  変更前: ${formatTaskRef(taskRefOf(before.task, before.regionName, before.fieldName))}`,
    )
    console.log(
      `  変更後: ${formatTaskRef(taskRefOf(after.task, after.regionName, after.fieldName))}`,
    )
  }
}

function printUsage(): void {
  console.log(`調査計画 進捗確認 CLI

確認系:
  summary         全体サマリ（既定）
  region          地域別の調査状況
  field           分野別の調査状況
  todo            未調査（not_started）の地域・分野一覧
  recheck         再調査が必要（needs_recheck）な領域
  progress        調査済み領域の割合（制度の網羅率ではない）
  missing-urls    公式ポータルURLが未登録の領域
  candidates      発見した候補数（M7-D から更新される）
  validate        データの検証のみ

更新系（--file <path> で対象ファイルを差し替え可能。既定: ${SURVEY_PLAN_FILE}）:
  set-status <taskId> <status> [lastSurveyedAt]
  set-next <taskId> <YYYY-MM-DD または ->
  add-url <taskId> <url>
  rm-url <taskId> <url>
  set-count <taskId> <件数>

status: ${SURVEY_STATUS_ORDER.join(' / ')}`)
}

try {
  const plan = loadPlan()
  const report = summarizeSurveyPlan(plan)

  switch (command) {
    case 'help':
    case '--help':
      printUsage()
      break

    case 'summary': {
      console.log(
        `調査計画（${planFile}）: 全${report.totalTasks}領域（${plan.regions.length}地域 × ${plan.fields.length}分野）`,
      )
      console.log(`  ${printCounts(report.statusCounts)}`)
      console.log(`  調査済み領域の割合: ${(report.surveyedTaskRatio * 100).toFixed(1)}%`)
      console.log(`  発見した候補数: ${report.candidateTotal} 件`)
      console.log(`  公式ポータルURL未登録: ${report.tasksMissingPortalUrl.length} 領域`)
      if (report.consistencyWarnings.length > 0) {
        console.log(`  注意（${report.consistencyWarnings.length}件）:`)
        for (const w of report.consistencyWarnings.slice(0, 5)) console.log(`    - ${w}`)
      }
      console.log(
        `\n詳細: region / field / todo / recheck / progress / missing-urls / candidates`,
      )
      break
    }

    case 'region': {
      printHeader('地域別の調査状況')
      const rows = [
        ['地域', '区分', ...SURVEY_STATUS_ORDER.map((s) => SURVEY_STATUS_LABELS[s]), '候補数', 'URL未登録'],
      ]
      for (const r of report.byRegion) {
        rows.push([
          r.regionName,
          r.regionKind === 'nation' ? '国' : r.regionKind === 'prefecture' ? '都' : '区',
          ...SURVEY_STATUS_ORDER.map((s) => String(r.statusCounts[s])),
          String(r.candidateCount),
          String(r.tasksMissingUrl),
        ])
      }
      printTable(rows)
      break
    }

    case 'field': {
      printHeader('分野別の調査状況')
      const rows = [
        ['分野', ...SURVEY_STATUS_ORDER.map((s) => SURVEY_STATUS_LABELS[s]), '候補数'],
      ]
      for (const f of report.byField) {
        rows.push([
          f.fieldName,
          ...SURVEY_STATUS_ORDER.map((s) => String(f.statusCounts[s])),
          String(f.candidateCount),
        ])
      }
      printTable(rows)
      break
    }

    case 'todo': {
      printHeader(`未調査の地域・分野（${report.notStartedTasks.length}領域）`)
      console.log(
        '※ 未調査は「まだ調査していない」という意味であり、制度が無いという意味ではありません。',
      )
      for (const ref of report.notStartedTasks) console.log(formatTaskRef(ref))
      break
    }

    case 'recheck': {
      printHeader(`再調査が必要な領域（${report.needsRecheckTasks.length}領域）`)
      for (const ref of report.needsRecheckTasks) console.log(formatTaskRef(ref))
      break
    }

    case 'progress': {
      printHeader('調査済み領域の割合')
      console.log(
        `  ${report.statusCounts.surveyed} / ${report.totalTasks} 領域 = ${(report.surveyedTaskRatio * 100).toFixed(1)}%`,
      )
      console.log(PROGRESS_NOTE)
      break
    }

    case 'missing-urls': {
      printHeader(
        `公式ポータルURLが未登録の領域（${report.tasksMissingPortalUrl.length}領域）`,
      )
      console.log(
        '※ 根拠を確認できない URL は登録しません。確認できた公式ページのみ追加してください。',
      )
      for (const ref of report.tasksMissingPortalUrl) console.log(formatTaskRef(ref))
      break
    }

    case 'candidates': {
      printHeader('発見した候補数')
      console.log(
        `  合計: ${report.candidateTotal} 件（M7-D の発見パイプラインから更新される）`,
      )
      console.log('  地域別:')
      for (const r of report.byRegion) {
        console.log(`    ${padEndW(r.regionName, 12)} ${String(r.candidateCount).padStart(4)} 件`)
      }
      console.log('  分野別:')
      for (const f of report.byField) {
        console.log(`    ${padEndW(f.fieldName, 24)} ${String(f.candidateCount).padStart(4)} 件`)
      }
      break
    }

    case 'validate': {
      console.log(
        `${planFile}: 検証 OK（${plan.regions.length}地域 × ${plan.fields.length}分野 = ${plan.tasks.length}タスク）`,
      )
      break
    }

    case 'set-status': {
      const [taskId, statusArg, surveyedAt] = args
      if (taskId === undefined || statusArg === undefined) {
        throw new SurveyPlanError(planFile, [
          '使い方: set-status <taskId> <status> [lastSurveyedAt（ISO 8601）]',
        ])
      }
      if (!SURVEY_STATUS_ORDER.includes(statusArg as SurveyStatus)) {
        throw new SurveyPlanError(planFile, [
          `status: "${statusArg}" は不正です（${SURVEY_STATUS_ORDER.join(' / ')} のいずれか）`,
        ])
      }
      applyUpdate(
        {
          type: 'set-status',
          taskId,
          status: statusArg as SurveyStatus,
          ...(surveyedAt !== undefined ? { lastSurveyedAt: surveyedAt } : {}),
        },
        `${taskId} の調査状態を ${SURVEY_STATUS_LABELS[statusArg as SurveyStatus]} に更新`,
      )
      break
    }

    case 'set-next': {
      const [taskId, dateArg] = args
      if (taskId === undefined || dateArg === undefined) {
        throw new SurveyPlanError(planFile, [
          '使い方: set-next <taskId> <YYYY-MM-DD または ->（- は予定日の解除）',
        ])
      }
      applyUpdate(
        {
          type: 'set-next-date',
          taskId,
          nextScheduledDate: dateArg === '-' ? null : dateArg,
        },
        `${taskId} の次回調査予定日を更新`,
      )
      break
    }

    case 'add-url':
    case 'rm-url': {
      const [taskId, url] = args
      if (taskId === undefined || url === undefined) {
        throw new SurveyPlanError(planFile, [`使い方: ${command} <taskId> <url>`])
      }
      applyUpdate(
        { type: command === 'add-url' ? 'add-url' : 'remove-url', taskId, url },
        `${taskId} の公式ポータルURLを${command === 'add-url' ? '追加' : '削除'}`,
      )
      break
    }

    case 'set-count': {
      const [taskId, countArg] = args
      const count = Number(countArg)
      if (taskId === undefined || countArg === undefined || !Number.isInteger(count)) {
        throw new SurveyPlanError(planFile, [
          '使い方: set-count <taskId> <件数（0以上の整数）>',
        ])
      }
      applyUpdate(
        { type: 'set-candidate-count', taskId, candidateCount: count },
        `${taskId} の発見候補数を ${count} 件に更新`,
      )
      break
    }

    default:
      console.error(`不明なコマンドです: ${command}\n`)
      printUsage()
      process.exitCode = 1
  }
} catch (error) {
  if (error instanceof SurveyPlanError) {
    console.error(error.message)
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}

/** タスクの表示名を解決する（applyUpdate の変更後表示用。関数宣言は巻き上げられる） */
function namesIn(
  plan: {
    tasks: {
      taskId: string
      regionId: string
      fieldId: string
      status: SurveyStatus
      lastSurveyedAt: string | null
      nextScheduledDate: string | null
      candidateCount: number
      portalUrls: string[]
    }[]
    regions: { id: string; name: string }[]
    fields: { id: string; name: string }[]
  },
  taskId: string,
) {
  const task = plan.tasks.find((t) => t.taskId === taskId)
  const regionName = plan.regions.find((r) => r.id === task?.regionId)?.name ?? ''
  const fieldName = plan.fields.find((f) => f.id === task?.fieldId)?.name ?? ''
  return { task, regionName, fieldName }
}




