/**
 * 調査計画（data/survey-plan.json）の読み込み・検証・更新（M7-C）
 *
 * 【責務】
 * - parseSurveyPlan / parseSurveyPlanJson: 調査計画データを検証して
 *   SurveyPlan として返す純関数（不正データは ProgramStoreError と同じ形式の
 *   SurveyPlanError で「ファイル名・要素番号・ID・フィールドパス」を報告）
 * - serializeSurveyPlan: 検証済みデータを正規の JSON テキストに変換
 * - applySurveyPlanUpdate: 調査タスクの更新（状態・日付・URL・候補数）の純関数。
 *   更新後に全体を再検証してから返す（既存データを壊さない）
 *
 * 【検出する問題】
 * - JSON 構文エラー / 未対応の formatVersion / 形式不一致（zod スキーマ）
 * - regionId / fieldId / taskId の重複・未定義参照
 * - 地域×分野の組み合わせの重複・欠落（全組み合わせが1件ずつ必要）
 *
 * 【外部通信なし】このモジュールは状態管理と純関数のみ。fetch は行わない。
 * ファイル入出力はスクリプト側（node:fs）で行う。
 */
import {
  surveyPlanSchema,
  type SurveyPlan,
  type SurveyStatus,
  type SurveyTask,
} from '../types/surveyPlan'

/** 本番の調査計画ファイル（リポジトリルートからの相対パス） */
export const SURVEY_PLAN_FILE = 'data/survey-plan.json'

/** 保存形式のバージョン */
export const SURVEY_PLAN_FORMAT_VERSION = 1

/** 調査計画データの不正を表すエラー（ファイル名と問題点の一覧を保持） */
export class SurveyPlanError extends Error {
  readonly file: string
  readonly issues: readonly string[]

  constructor(file: string, issues: readonly string[]) {
    super(`${file} の調査計画データに問題があります:\n- ${issues.join('\n- ')}`)
    this.name = 'SurveyPlanError'
    this.file = file
    this.issues = [...issues]
  }
}

/** zod の issue を「tasks[i]（taskId: "x"）.field: メッセージ」形式に整形する */
function formatIssue(
  issue: { path: PropertyKey[]; message: string },
  raw: { regions: unknown[]; fields: unknown[]; tasks: unknown[] },
): string {
  const path = issue.path.map(String)
  const first = issue.path[0]
  const second = issue.path[1]
  const collection =
    first === 'regions'
      ? raw.regions
      : first === 'fields'
        ? raw.fields
        : first === 'tasks'
          ? raw.tasks
          : null
  if (collection !== null && typeof second === 'number') {
    const rest = path.slice(2).join('.')
    const element = collection[second]
    const idKey = first === 'tasks' ? 'taskId' : 'id'
    const rawId =
      typeof element === 'object' &&
      element !== null &&
      typeof (element as Record<string, unknown>)[idKey] === 'string'
        ? `（${idKey}: "${(element as Record<string, string>)[idKey]}"）`
        : ''
    return `${String(first)}[${second}]${rawId}${rest ? `.${rest}` : ''}: ${issue.message}`
  }
  return `${path.join('.') || '(top)'}: ${issue.message}`
}

/**
 * 調査計画データ（パース済みの生 JSON）を検証して SurveyPlan として返す（純関数）。
 * 問題がある場合は SurveyPlanError を投げる。
 */
export function parseSurveyPlan(raw: unknown, file: string): SurveyPlan {
  const issues: string[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SurveyPlanError(file, [
      'トップレベルは object（formatVersion・regions・fields・tasks を持つ）である必要があります',
    ])
  }
  const envelope = raw as {
    formatVersion?: unknown
    regions?: unknown
    fields?: unknown
    tasks?: unknown
  }

  if (envelope.formatVersion !== SURVEY_PLAN_FORMAT_VERSION) {
    issues.push(
      `formatVersion: ${JSON.stringify(envelope.formatVersion)} は未対応の形式です（対応: ${SURVEY_PLAN_FORMAT_VERSION}）`,
    )
  }
  for (const key of ['regions', 'fields', 'tasks'] as const) {
    if (!Array.isArray(envelope[key])) {
      issues.push(`${key}: 配列である必要があります`)
    }
  }
  if (issues.length > 0) {
    throw new SurveyPlanError(file, issues)
  }

  const rawCollections = {
    regions: envelope.regions as unknown[],
    fields: envelope.fields as unknown[],
    tasks: envelope.tasks as unknown[],
  }

  // zod スキーマによる検証
  const parsed = surveyPlanSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(formatIssue(issue, rawCollections))
    }
    throw new SurveyPlanError(file, issues)
  }
  const plan = parsed.data

  // ID の重複検出
  const seenRegionIds = new Map<string, number>()
  plan.regions.forEach((region, index) => {
    const first = seenRegionIds.get(region.id)
    if (first !== undefined) {
      issues.push(
        `regions[${index}]（id: "${region.id}"）: id が重複しています（regions[${first}] と同一）`,
      )
    } else {
      seenRegionIds.set(region.id, index)
    }
  })
  const seenFieldIds = new Map<string, number>()
  plan.fields.forEach((field, index) => {
    const first = seenFieldIds.get(field.id)
    if (first !== undefined) {
      issues.push(
        `fields[${index}]（id: "${field.id}"）: id が重複しています（fields[${first}] と同一）`,
      )
    } else {
      seenFieldIds.set(field.id, index)
    }
  })
  const seenTaskIds = new Map<string, number>()
  plan.tasks.forEach((task, index) => {
    const first = seenTaskIds.get(task.taskId)
    if (first !== undefined) {
      issues.push(
        `tasks[${index}]（taskId: "${task.taskId}"）: taskId が重複しています（tasks[${first}] と同一）`,
      )
    } else {
      seenTaskIds.set(task.taskId, index)
    }
  })

  // 参照整合性（regionId / fieldId がマスタに存在するか）と URL の重複
  plan.tasks.forEach((task, index) => {
    if (!seenRegionIds.has(task.regionId)) {
      issues.push(
        `tasks[${index}]（taskId: "${task.taskId}"）.regionId: "${task.regionId}" が regions に存在しません`,
      )
    }
    if (!seenFieldIds.has(task.fieldId)) {
      issues.push(
        `tasks[${index}]（taskId: "${task.taskId}"）.fieldId: "${task.fieldId}" が fields に存在しません`,
      )
    }
    const seenUrls = new Set<string>()
    task.portalUrls.forEach((url, urlIndex) => {
      if (seenUrls.has(url)) {
        issues.push(
          `tasks[${index}]（taskId: "${task.taskId}"）.portalUrls[${urlIndex}]: ${url} が重複しています`,
        )
      } else {
        seenUrls.add(url)
      }
    })
  })

  // 地域×分野の全組み合わせが1件ずつ存在するか
  const comboIndex = new Map<string, number>()
  plan.tasks.forEach((task, index) => {
    const comboKey = `${task.regionId}\u0000${task.fieldId}`
    const first = comboIndex.get(comboKey)
    if (first !== undefined) {
      issues.push(
        `tasks[${index}]（taskId: "${task.taskId}"）: 地域×分野の組み合わせ（${task.regionId} / ${task.fieldId}）が重複しています（tasks[${first}] と同一）`,
      )
    } else {
      comboIndex.set(comboKey, index)
    }
  })
  const missingCombos: string[] = []
  for (const region of plan.regions) {
    for (const field of plan.fields) {
      if (!comboIndex.has(`${region.id}\u0000${field.id}`)) {
        missingCombos.push(`${region.name}（${region.id}）× ${field.name}（${field.id}）`)
      }
    }
  }
  if (missingCombos.length > 0) {
    const shown = missingCombos.slice(0, 20).join(', ')
    const rest = missingCombos.length > 20 ? ` ほか ${missingCombos.length - 20} 件` : ''
    issues.push(`地域×分野の組み合わせが不足しています（全組み合わせが必要）: ${shown}${rest}`)
  }

  if (issues.length > 0) {
    throw new SurveyPlanError(file, issues)
  }
  return plan
}

/** 調査計画の JSON テキストを検証して SurveyPlan として返す（純関数） */
export function parseSurveyPlanJson(text: string, file: string): SurveyPlan {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SurveyPlanError(file, [`JSON として解析できません（${message}）`])
  }
  return parseSurveyPlan(raw, file)
}

/** 検証済みの調査計画を正規の JSON テキストに変換する */
export function serializeSurveyPlan(plan: SurveyPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`
}

/** 調査タスクの更新内容（M7-D の更新もこの形で行う） */
export type SurveyPlanUpdate =
  | {
      type: 'set-status'
      taskId: string
      status: SurveyStatus
      lastSurveyedAt?: string | null
    }
  | { type: 'set-next-date'; taskId: string; nextScheduledDate: string | null }
  | { type: 'add-url'; taskId: string; url: string }
  | { type: 'remove-url'; taskId: string; url: string }
  | { type: 'set-candidate-count'; taskId: string; candidateCount: number }

/**
 * 調査タスクの更新を適用した新しい SurveyPlan を返す（純関数。元の plan は変更しない）。
 *
 * - 更新対象の taskId が無い場合は SurveyPlanError
 * - 値の検証は更新後に全体を再検証することで保証する（不正な値は受け入れない）
 * - タスク・地域・分野の追加や削除は行わない（対象や構成の変更は
 *   data/survey-plan.json の編集手順に従う）
 */
export function applySurveyPlanUpdate(
  plan: SurveyPlan,
  update: SurveyPlanUpdate,
  file: string = SURVEY_PLAN_FILE,
): SurveyPlan {
  const index = plan.tasks.findIndex((t) => t.taskId === update.taskId)
  if (index < 0) {
    throw new SurveyPlanError(file, [
      `tasks: taskId "${update.taskId}" が存在しません`,
    ])
  }
  const tasks: SurveyTask[] = plan.tasks.map((task) => ({ ...task }))
  const task = tasks[index]

  switch (update.type) {
    case 'set-status': {
      task.status = update.status
      if (update.lastSurveyedAt !== undefined) {
        task.lastSurveyedAt = update.lastSurveyedAt
      }
      break
    }
    case 'set-next-date': {
      task.nextScheduledDate = update.nextScheduledDate
      break
    }
    case 'add-url': {
      task.portalUrls = [...task.portalUrls, update.url]
      break
    }
    case 'remove-url': {
      task.portalUrls = task.portalUrls.filter((u) => u !== update.url)
      break
    }
    case 'set-candidate-count': {
      task.candidateCount = update.candidateCount
      break
    }
  }

  // 更新後の全体を再検証してから返す（不正な値は渡さない）
  const next: SurveyPlan = { ...plan, tasks }
  return parseSurveyPlan(next, file)
}


