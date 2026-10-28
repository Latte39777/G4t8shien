/**
 * 発見パイプラインの段階処理（M7-D）
 *
 * 【責務】調査計画からのシード収集・件数集計・調査計画更新・レポート生成という、
 * 取得・AI 抽出そのものから切り離した処理を純関数で提供する。
 * - 段階の分離: URL 発見（linkScan）／ページ取得（sourceFetch 経由の CLI）／
 *   AI 抽出（aiExtract）／保存（discoveryStore）を独立して実行できるようにする。
 * - 調査計画の更新は「候補件数（candidateCount）」のみ。候補が見つかっただけで
 *   その領域を surveyed（調査済み）や網羅済みにはしない。
 *   調査の実施・候補の発見・公式根拠の確認・公開可能判断は別の指標として扱う。
 *
 * 【外部通信なし】純関数のみ（取得・AI 呼び出しは行わない）。
 */
import { RESEARCH_LOG } from '../supports/officialPrograms'
import { applySurveyPlanUpdate, type SurveyPlanUpdate } from '../survey/surveyPlanStore'
import type { SurveyPlan, SurveyTask } from '../types/surveyPlan'
import type {
  DiscoveryCandidate,
  DiscoveryMethod,
  PageRecord,
  UrlCandidate,
} from './discoveryStore'

/** URL 発見の出発点（シード） */
export type SeedUrl = {
  url: string
  /** このシードが属する調査タスク（タスクに紐付かない場合は null） */
  taskId: string | null
  regionId: string | null
  fieldId: string | null
  method: DiscoveryMethod
}

/**
 * URL 発見のシードを収集する（純関数）。
 * - data/survey-plan.json に登録済みの公式ポータル URL（portalUrls）
 * - RESEARCH_LOG で根拠を確認できる公式 URL（調査計画に未登録のものも対象）
 * - URL 未登録の地域・分野はシードが無く、調査不能（推測 URL は作らない）
 */
export function collectSeedUrls(plan: SurveyPlan): SeedUrl[] {
  const seeds: SeedUrl[] = []
  const seen = new Set<string>()
  for (const task of plan.tasks) {
    for (const url of task.portalUrls) {
      if (seen.has(url)) continue
      seen.add(url)
      seeds.push({
        url,
        taskId: task.taskId,
        regionId: task.regionId,
        fieldId: task.fieldId,
        method: 'survey-plan-portal',
      })
    }
  }
  for (const log of RESEARCH_LOG) {
    if (!log.verified) continue
    if (seen.has(log.url)) continue
    seen.add(log.url)
    seeds.push({
      url: log.url,
      taskId: null,
      regionId: null,
      fieldId: null,
      method: 'research-log',
    })
  }
  return seeds
}

/** 候補から調査タスクごとの候補件数を集計する（discarded は数えない） */
export function computeCandidateCountsByTask(
  candidates: readonly DiscoveryCandidate[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const c of candidates) {
    if (c.status === 'discarded') continue
    counts.set(c.taskId, (counts.get(c.taskId) ?? 0) + 1)
  }
  return counts
}

/**
 * 候補件数の集計結果から調査計画の更新（set-candidate-count）を作る（純関数）。
 * - 既に同じ件数なら更新しない
 * - 存在しない taskId は更新に含めない（エラーにせず警告用に返す）
 * - status（not_started / in_progress / surveyed / needs_recheck）は変更しない
 */
export function planUpdatesForCandidateCounts(
  plan: SurveyPlan,
  counts: ReadonlyMap<string, number>,
): { updates: SurveyPlanUpdate[]; unknownTaskIds: string[] } {
  const updates: SurveyPlanUpdate[] = []
  const unknownTaskIds: string[] = []
  for (const [taskId, count] of counts) {
    const task = plan.tasks.find((t) => t.taskId === taskId)
    if (task === undefined) {
      unknownTaskIds.push(taskId)
      continue
    }
    if (task.candidateCount !== count) {
      updates.push({ type: 'set-candidate-count', taskId, candidateCount: count })
    }
  }
  return { updates, unknownTaskIds }
}

/** 調査計画に候補件数の更新をまとめて適用する（純関数。元の plan は変更しない） */
export function applyCandidateCountUpdates(
  plan: SurveyPlan,
  updates: readonly SurveyPlanUpdate[],
): SurveyPlan {
  let next = plan
  for (const update of updates) {
    next = applySurveyPlanUpdate(next, update)
  }
  return next
}

// ── レポート（取得件数・候補件数・失敗件数・未調査領域） ─────────────

/** 地域×分野ごとの発見パイプライン状況 */
export type TaskDiscoveryStats = {
  taskId: string
  regionId: string
  fieldId: string
  regionName: string
  fieldName: string
  seedCount: number
  discoveredUrlCount: number
  fetchedOkCount: number
  fetchFailedCount: number
  pageExtractedCount: number
  extractionFailedCount: number
  /** 候補ストアの候補数（未検証。discarded は除く） */
  candidateCount: number
  /** 調査計画の candidateCount（候補件数の記録） */
  planCandidateCount: number
  /** 公式 URL が未登録で発見を開始できない（調査不能） */
  unscannable: boolean
}

/** 確認の区別（混同しないための指標） */
export type DiscoveryDistinction = {
  /** 調査の実施＝取得できたページ数 */
  pagesRetrieved: number
  /** 候補の発見＝AI 抽出で見つかった未検証候補の数 */
  candidatesFound: number
  /** 公式根拠を確認できた件数（人手確認。M7-D では常に 0） */
  evidenceVerified: number
  /** 公開可能と判断した件数（承認フロー。M7-E まで常に 0） */
  publishable: number
}

export type DiscoveryReport = {
  tasks: TaskDiscoveryStats[]
  totals: {
    seedCount: number
    discoveredUrlCount: number
    fetchedOkCount: number
    fetchFailedCount: number
    pageExtractedCount: number
    extractionFailedCount: number
    candidateCount: number
    /** タスクに紐付かない URL・ページ（research-log シード由来など） */
    unassignedUrlCount: number
    unassignedCandidateCount: number
  }
  /** URL 未登録で調査を開始できないタスク */
  unscannableTasks: { taskId: string; regionName: string; fieldName: string }[]
  distinction: DiscoveryDistinction
}

/** 発見パイプライン全体のレポートを組み立てる（純関数） */
export function buildDiscoveryReport(input: {
  plan: SurveyPlan
  seeds: readonly SeedUrl[]
  urls: readonly UrlCandidate[]
  pages: readonly PageRecord[]
  candidates: readonly DiscoveryCandidate[]
}): DiscoveryReport {
  const regionName = new Map(input.plan.regions.map((r) => [r.id, r.name]))
  const fieldName = new Map(input.plan.fields.map((f) => [f.id, f.name]))

  const tasks: TaskDiscoveryStats[] = input.plan.tasks.map((task: SurveyTask) => {
    const seeds = input.seeds.filter((s) => s.taskId === task.taskId)
    const urls = input.urls.filter((u) => u.taskId === task.taskId)
    const urlSet = new Set(urls.map((u) => u.url))
    // タスクのページ＝そのタスクの URL 候補（シード含む）に対応するページ本文
    const pages = input.pages.filter((p) => urlSet.has(p.url))
    const candidates = input.candidates.filter(
      (c) => c.taskId === task.taskId && c.status !== 'discarded',
    )
    return {
      taskId: task.taskId,
      regionId: task.regionId,
      fieldId: task.fieldId,
      regionName: regionName.get(task.regionId) ?? task.regionId,
      fieldName: fieldName.get(task.fieldId) ?? task.fieldId,
      seedCount: seeds.length,
      discoveredUrlCount: urls.length,
      fetchedOkCount: pages.length,
      fetchFailedCount: urls.filter((u) => u.lastFetch?.state === 'failed').length,
      pageExtractedCount: pages.filter((p) => p.extractState === 'extracted').length,
      extractionFailedCount: pages.filter((p) => p.extractState === 'failed').length,
      candidateCount: candidates.length,
      planCandidateCount: task.candidateCount,
      unscannable: task.portalUrls.length === 0,
    }
  })

  const unassignedUrls = input.urls.filter((u) => u.taskId === null)

  const allPagesOk = input.pages.length
  const candidateCount = input.candidates.filter((c) => c.status !== 'discarded').length

  return {
    tasks,
    totals: {
      seedCount: input.seeds.length,
      discoveredUrlCount: input.urls.length,
      fetchedOkCount: allPagesOk,
      fetchFailedCount: input.urls.filter((u) => u.lastFetch?.state === 'failed').length,
      pageExtractedCount: input.pages.filter((p) => p.extractState === 'extracted').length,
      extractionFailedCount: input.pages.filter((p) => p.extractState === 'failed').length,
      candidateCount,
      unassignedUrlCount: unassignedUrls.length,
      unassignedCandidateCount: input.candidates.filter(
        (c) => c.status !== 'discarded' && !input.plan.tasks.some((t) => t.taskId === c.taskId),
      ).length,
    },
    unscannableTasks: tasks
      .filter((t) => t.unscannable)
      .map((t) => ({
        taskId: t.taskId,
        regionName: t.regionName,
        fieldName: t.fieldName,
      })),
    distinction: {
      pagesRetrieved: allPagesOk,
      candidatesFound: candidateCount,
      // 以下 2 件は M7-D では常に 0（確認・承認は人手の M7-E フロー）
      evidenceVerified: 0,
      publishable: 0,
    },
  }
}
