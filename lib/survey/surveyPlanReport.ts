/**
 * 調査計画の進捗集計（M7-C）
 *
 * 【重要】調査済み領域の割合（surveyedTaskRatio）は「調査を実施した領域
 * （地域×分野）の割合」であり、支援制度の網羅率ではない。表示する際は
 * 両者を混同しない注意書きを付ける（scripts/survey-plan.ts の progress）。
 */
import {
  SURVEY_STATUSES,
  type SurveyPlan,
  type SurveyRegionKind,
  type SurveyStatus,
} from '../types/surveyPlan'

export type StatusCounts = { [K in SurveyStatus]: number }

export type SurveyTaskRef = {
  taskId: string
  regionId: string
  regionName: string
  fieldId: string
  fieldName: string
  status: SurveyStatus
  lastSurveyedAt: string | null
  nextScheduledDate: string | null
  candidateCount: number
  portalUrlCount: number
}

export type RegionSummary = {
  regionId: string
  regionName: string
  regionKind: SurveyRegionKind
  statusCounts: StatusCounts
  candidateCount: number
  /** 公式ポータルURLが未登録のタスク数 */
  tasksMissingUrl: number
}

export type FieldSummary = {
  fieldId: string
  fieldName: string
  statusCounts: StatusCounts
  candidateCount: number
}

export type SurveyPlanReport = {
  totalTasks: number
  statusCounts: StatusCounts
  /** 調査済み（surveyed）の領域の割合。制度の網羅率ではない */
  surveyedTaskRatio: number
  byRegion: RegionSummary[]
  byField: FieldSummary[]
  notStartedTasks: SurveyTaskRef[]
  inProgressTasks: SurveyTaskRef[]
  needsRecheckTasks: SurveyTaskRef[]
  /** 公式ポータルURLが未登録のタスク */
  tasksMissingPortalUrl: SurveyTaskRef[]
  /** 発見した候補数の合計（M7-D から更新される） */
  candidateTotal: number
  /** 値の整合性の注意（不正ではない。例: needs_recheck だが最終調査日時が無い） */
  consistencyWarnings: string[]
}

function emptyCounts(): StatusCounts {
  return {
    not_started: 0,
    in_progress: 0,
    surveyed: 0,
    needs_recheck: 0,
  }
}

function countUp(counts: StatusCounts, status: SurveyStatus): void {
  counts[status] += 1
}

/** 調査計画を集計する（純関数） */
export function summarizeSurveyPlan(plan: SurveyPlan): SurveyPlanReport {
  const regionById = new Map(plan.regions.map((r) => [r.id, r]))
  const fieldById = new Map(plan.fields.map((f) => [f.id, f]))

  const statusCounts = emptyCounts()
  const byRegion = new Map<string, RegionSummary>()
  const byField = new Map<string, FieldSummary>()
  for (const region of plan.regions) {
    byRegion.set(region.id, {
      regionId: region.id,
      regionName: region.name,
      regionKind: region.kind,
      statusCounts: emptyCounts(),
      candidateCount: 0,
      tasksMissingUrl: 0,
    })
  }
  for (const field of plan.fields) {
    byField.set(field.id, {
      fieldId: field.id,
      fieldName: field.name,
      statusCounts: emptyCounts(),
      candidateCount: 0,
    })
  }

  const notStartedTasks: SurveyTaskRef[] = []
  const inProgressTasks: SurveyTaskRef[] = []
  const needsRecheckTasks: SurveyTaskRef[] = []
  const tasksMissingPortalUrl: SurveyTaskRef[] = []
  const consistencyWarnings: string[] = []
  let candidateTotal = 0

  for (const task of plan.tasks) {
    const region = regionById.get(task.regionId)
    const field = fieldById.get(task.fieldId)
    const ref: SurveyTaskRef = {
      taskId: task.taskId,
      regionId: task.regionId,
      regionName: region?.name ?? task.regionId,
      fieldId: task.fieldId,
      fieldName: field?.name ?? task.fieldId,
      status: task.status,
      lastSurveyedAt: task.lastSurveyedAt,
      nextScheduledDate: task.nextScheduledDate,
      candidateCount: task.candidateCount,
      portalUrlCount: task.portalUrls.length,
    }

    countUp(statusCounts, task.status)
    const regionSummary = byRegion.get(task.regionId)
    const fieldSummary = byField.get(task.fieldId)
    if (regionSummary !== undefined) {
      countUp(regionSummary.statusCounts, task.status)
      regionSummary.candidateCount += task.candidateCount
      if (task.portalUrls.length === 0) regionSummary.tasksMissingUrl += 1
    }
    if (fieldSummary !== undefined) {
      countUp(fieldSummary.statusCounts, task.status)
      fieldSummary.candidateCount += task.candidateCount
    }
    candidateTotal += task.candidateCount

    if (task.status === 'not_started') notStartedTasks.push(ref)
    else if (task.status === 'in_progress') inProgressTasks.push(ref)
    else if (task.status === 'needs_recheck') needsRecheckTasks.push(ref)
    if (task.portalUrls.length === 0) tasksMissingPortalUrl.push(ref)

    // 整合性の注意（データの不正ではない。人手確認のきっかけとして表示する）
    if (
      (task.status === 'surveyed' || task.status === 'needs_recheck') &&
      task.lastSurveyedAt === null
    ) {
      consistencyWarnings.push(
        `${task.taskId}: 状態は ${task.status} ですが最終調査日時が未記録です`,
      )
    }
    if (task.status === 'not_started' && task.candidateCount > 0) {
      consistencyWarnings.push(
        `${task.taskId}: 未調査ですが候補数が ${task.candidateCount} 件記録されています`,
      )
    }
    if (task.nextScheduledDate !== null && task.status === 'surveyed') {
      consistencyWarnings.push(
        `${task.taskId}: 調査済みですが次回調査予定日（${task.nextScheduledDate}）が設定されています`,
      )
    }
  }

  const totalTasks = plan.tasks.length
  return {
    totalTasks,
    statusCounts,
    surveyedTaskRatio: totalTasks === 0 ? 0 : statusCounts.surveyed / totalTasks,
    byRegion: [...byRegion.values()],
    byField: [...byField.values()],
    notStartedTasks,
    inProgressTasks,
    needsRecheckTasks,
    tasksMissingPortalUrl,
    candidateTotal,
    consistencyWarnings,
  }
}

/** 調査状態の日本語ラベル */
export const SURVEY_STATUS_LABELS: { [K in SurveyStatus]: string } = {
  not_started: '未調査',
  in_progress: '調査中',
  surveyed: '調査済み',
  needs_recheck: '再調査が必要',
}

/** 全状態の並び（表示用） */
export const SURVEY_STATUS_ORDER: readonly SurveyStatus[] = SURVEY_STATUSES
