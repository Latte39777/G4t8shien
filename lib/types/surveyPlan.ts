/**
 * 調査計画（M7-C）の構造化データ型と zod スキーマ
 *
 * 【責務】
 * - 国・東京都・東京都23区 × 支援分野 の「どの地域・分野を調査したか／未調査か」を
 *   管理する。M7-D の制度候補発見パイプラインの調査対象・進捗の土台。
 * - 調査計画は制度データ（lib/types/support.ts の SupportProgram）と独立に管理し、
 *   SupportProgram に調査進捗の情報を混在させない。
 *
 * 【調査状態の意味（重要）】
 * - 'surveyed' は「調査を実施した」という意味であり、その地域・分野の制度を
 *   網羅できたという意味ではない。調査件数が 0 件でも、制度が存在しないと
 *   断定しない（進捗率＝調査済み領域の割合であって制度の網羅率ではない）。
 * - 'needs_recheck' は再調査が必要な領域。
 *
 * 【原則】
 * - 地域×分野の組み合わせは最初から調査済みと扱わず、未調査（not_started）から
 *   開始する。
 * - 公式ポータルURLは根拠（RESEARCH_LOG などの確認記録）のある URL だけを登録し、
 *   根拠を確認できない URL は推測で作らず未登録のままにする。
 * - 未確認の値は null。根拠のない値を補完しない。
 *
 * 【M7-D への接続（設計のみ。発見処理は実装しない）】
 * - taskId は調査タスクの一意な ID であり、将来の発見レコード（取得元URL・
 *   発見候補ID・調査日時・発見方法）はこの taskId / regionId / fieldId と
 *   結び付けて管理する。
 */
import { z } from 'zod'

/** 調査状態 */
export const SURVEY_STATUSES = [
  'not_started',
  'in_progress',
  'surveyed',
  'needs_recheck',
] as const
export type SurveyStatus = (typeof SURVEY_STATUSES)[number]

/** 地域区分 */
export const SURVEY_REGION_KINDS = ['nation', 'prefecture', 'ward'] as const
export type SurveyRegionKind = (typeof SURVEY_REGION_KINDS)[number]

/** ID は小文字英数字のケバブケース（regionId / fieldId / taskId に共通の制約） */
const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 日付（YYYY-MM-DD） */
const datePattern = /^\d{4}-\d{2}-\d{2}$/
/** 日時（ISO 8601。タイムゾーン付きまたは Z） */
const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

/** http(s) URL のみ許可する（それ以外は根拠のある URL とみなさない） */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 地域（国・東京都・23区） */
export const surveyRegionSchema = z.object({
  id: z.string().regex(idPattern, 'ID は小文字英数字のケバブケースにしてください'),
  name: z.string().min(1),
  kind: z.enum(SURVEY_REGION_KINDS),
})
export type SurveyRegion = z.infer<typeof surveyRegionSchema>

/** 支援分野 */
export const surveyFieldSchema = z.object({
  id: z.string().regex(idPattern, 'ID は小文字英数字のケバブケースにしてください'),
  name: z.string().min(1),
})
export type SurveyField = z.infer<typeof surveyFieldSchema>

/** 調査タスク（地域×分野の1領域） */
export const surveyTaskSchema = z.object({
  /** 調査タスクの一意な ID（M7-D の発見レコードの結び付け口） */
  taskId: z.string().min(1),
  regionId: z.string().min(1),
  fieldId: z.string().min(1),
  status: z.enum(SURVEY_STATUSES),
  /** 最終調査日時（ISO 8601。未調査なら null） */
  lastSurveyedAt: z
    .string()
    .regex(isoDateTimePattern, 'ISO 8601 の日時（例: 2026-10-27T10:00:00+09:00）で指定してください')
    .nullable(),
  /** 次回調査予定日（YYYY-MM-DD。未定なら null） */
  nextScheduledDate: z
    .string()
    .regex(datePattern, 'YYYY-MM-DD の日付で指定してください')
    .nullable(),
  /** 参照する公式ポータルURL（根拠のある URL のみ。未登録は空配列） */
  portalUrls: z
    .array(
      z
        .string()
        .refine(isHttpUrl, 'URL として解析できません（http/https のみ）'),
    )
    .max(20),
  /** 発見した候補数（M7-D から更新される。初期値は 0） */
  candidateCount: z.number().int().nonnegative(),
  /** 補足情報 */
  notes: z.string(),
  /** 未解決事項 */
  openIssues: z.array(z.string().min(1)),
})
export type SurveyTask = z.infer<typeof surveyTaskSchema>

/**
 * 調査計画の保存形式（envelope）。
 * regions / fields はマスタ、tasks は地域×分野の全組み合わせを1件ずつ持つ
 * （欠落・重複は parseSurveyPlan で検出する）。
 */
export const surveyPlanSchema = z.object({
  formatVersion: z.literal(1),
  regions: z.array(surveyRegionSchema).min(1),
  fields: z.array(surveyFieldSchema).min(1),
  tasks: z.array(surveyTaskSchema),
})
export type SurveyPlan = z.infer<typeof surveyPlanSchema>
