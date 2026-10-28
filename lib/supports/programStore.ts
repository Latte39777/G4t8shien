/**
 * 制度データ保存基盤（M7-B）— data/programs/ からの制度データ読み込み・検証
 *
 * 責務:
 * - 支援制度データを JSON（data/programs/programs.json）で保存し、
 *   supportProgramSchema で検証した上で SupportProgram[] として提供する
 * - 不正な JSON・スキーマ不一致・ID 重複を検出し、「どのファイルの何が問題か」を
 *   明示するエラー（ProgramStoreError）を出す
 * - 制度の追加・更新は JSON の編集のみで完結する（TypeScript ファイルの編集に依存しない）
 *
 * 【クライアント/サーバー境界】
 * このモジュールは components/（クライアントコンポーネント）からも参照されるため、
 * node:fs などのサーバー専用モジュールは使用しない。データはビルド時にバンドル
 * される静的 JSON インポートで読み込む。ファイルシステムから読む必要がある
 * スクリプト（Node 上で動く検証ツール等）は parseProgramStoreJson() に
 * テキストを渡すことで同じ検証・エラー報告を利用できる。
 *
 * 【制度データと情報源台帳の分離】
 * このファイルは「制度本体」だけを保持する。公式URLや取得履歴（情報源台帳）は
 * lib/supports/sourceLedger.ts / data/source-ledger.json / data/source-retrievals.json
 * が担当し、別のデータとして管理する。制度側の sources[].sourceRecordId が
 * 台帳側の記録との紐付け口（M7-D で本格的に運用）。
 *
 * 【テスト用データと本番データの分離】
 * 本番データは data/programs/programs.json のみ。parseProgramStore() /
 * parseProgramStoreJson() は純関数で任意の入力を検証できるため、テストは
 * ストアを汚さずフィクスチャを直接渡せる。フィクスチャ（lib/supports/
 * mockPrograms.ts / officialPrograms.ts）はテスト・相談AI知識（M7-G で移行予定）
 * からのみ参照し、このモジュールからは参照しない。
 */
import { z } from 'zod'
import { supportProgramSchema, type SupportProgram } from '../types/support'
import rawProgramStore from '../../data/programs/programs.json'

/** 制度データ保存形式のバージョン（不整合時は読み込みを拒否する） */
export const PROGRAM_STORE_FORMAT_VERSION = 1

/** 本番の制度データファイル（レポジトリルートからのパス） */
export const PROGRAM_STORE_FILE = 'data/programs/programs.json'

/**
 * 制度データの不正を表すエラー。
 * file と issues（どの要素のどのフィールドが何の問題か）を保持する。
 */
export class ProgramStoreError extends Error {
  readonly file: string
  readonly issues: readonly string[]

  constructor(file: string, issues: readonly string[]) {
    super(
      `${file} の制度データに問題があります:\n${issues
        .map((issue) => `- ${issue}`)
        .join('\n')}`,
    )
    this.name = 'ProgramStoreError'
    this.file = file
    this.issues = issues
  }
}

/** 制度データの保存形式（envelope）。programs の各要素は SupportProgram。 */
const programStoreSchema = z.object({
  formatVersion: z.literal(PROGRAM_STORE_FORMAT_VERSION),
  programs: z.array(supportProgramSchema),
})

/** zod の issue を「programs[i]（id: "x"）.field.path: メッセージ」形式に整形する */
function formatIssue(issue: z.ZodIssue, rawPrograms: unknown[]): string {
  const path = issue.path.map(String)
  const first = issue.path[0]
  const second = issue.path[1]
  if (first === 'programs' && typeof second === 'number') {
    const rest = path.slice(2).join('.')
    const raw = rawPrograms[second]
    const rawId =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { id?: unknown }).id === 'string'
        ? `（id: "${(raw as { id: string }).id}"）`
        : ''
    return `programs[${second}]${rawId}${rest ? `.${rest}` : ''}: ${issue.message}`
  }
  return `${path.join('.') || '(top)'}: ${issue.message}`
}

/**
 * 制度データ（パース済みの生 JSON）を検証して SupportProgram[] として返す（純関数）。
 *
 * 検出する問題:
 * - 保存形式（formatVersion）が未対応
 * - programs が配列でない
 * - 各制度が supportProgramSchema に合わない
 * - 制度 ID の重複
 *
 * 問題がある場合は ProgramStoreError を投げ、ファイル名・要素番号・ID・
 * フィールドパスを含むメッセージを出す。
 */
export function parseProgramStore(raw: unknown, file: string): SupportProgram[] {
  const issues: string[] = []

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProgramStoreError(file, [
      'トップレベルは object（formatVersion と programs を持つ）である必要があります',
    ])
  }
  const envelope = raw as { formatVersion?: unknown; programs?: unknown }

  if (envelope.formatVersion !== PROGRAM_STORE_FORMAT_VERSION) {
    issues.push(
      `formatVersion: ${JSON.stringify(envelope.formatVersion)} は未対応の形式です（対応: ${PROGRAM_STORE_FORMAT_VERSION}）`,
    )
  }
  if (!Array.isArray(envelope.programs)) {
    issues.push('programs: 配列である必要があります')
    throw new ProgramStoreError(file, issues)
  }

  const rawPrograms: unknown[] = envelope.programs
  const parsedEntries: { program: SupportProgram; index: number }[] = []
  rawPrograms.forEach((rawProgram, index) => {
    const parsed = supportProgramSchema.safeParse(rawProgram)
    if (parsed.success) {
      parsedEntries.push({ program: parsed.data, index })
    } else {
      for (const issue of parsed.error.issues) {
        issues.push(
          formatIssue(
            { ...issue, path: ['programs', index, ...issue.path] },
            rawPrograms,
          ),
        )
      }
    }
  })

  // ID 重複の検出（スキーマを通った要素のみ ID が使える。報告の index は
  // ファイル内の実際の位置を指す）
  const firstIndexById = new Map<string, number>()
  for (const { program, index } of parsedEntries) {
    const first = firstIndexById.get(program.id)
    if (first !== undefined) {
      issues.push(
        `programs[${index}]（id: "${program.id}"）: id が重複しています（programs[${first}] と同一）`,
      )
    } else {
      firstIndexById.set(program.id, index)
    }
  }

  if (issues.length > 0) {
    throw new ProgramStoreError(file, issues)
  }

  // 全件を保存形式のスキーマで再検証してから返す
  return programStoreSchema.parse({
    formatVersion: PROGRAM_STORE_FORMAT_VERSION,
    programs: rawPrograms,
  }).programs
}

/**
 * 制度データの JSON テキストを検証して SupportProgram[] として返す（純関数）。
 * JSON 構文エラーもファイル名付きの ProgramStoreError にする。
 * Node 上のスクリプトがファイル読み込み（node:fs）と組み合わせて使う想定。
 */
export function parseProgramStoreJson(text: string, file: string): SupportProgram[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProgramStoreError(file, [`JSON として解析できません（${message}）`])
  }
  return parseProgramStore(raw, file)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

let cachedStore: readonly SupportProgram[] | null = null

/**
 * 本番の制度データ（data/programs/programs.json）を読み込んで返す。
 * ビルド時にバンドルされた静的 JSON を使い、初回呼び出し時に検証する
 * （結果はキャッシュ。返り値は凍結済みのため変更できない）。
 * データが不正な場合は ProgramStoreError を投げる。
 */
export function getProgramStore(): readonly SupportProgram[] {
  if (cachedStore === null) {
    cachedStore = deepFreeze(parseProgramStore(rawProgramStore, PROGRAM_STORE_FILE))
  }
  return cachedStore
}

/** テスト用: キャッシュを捨てて次回 getProgramStore() で再読み込みさせる */
export function resetProgramStoreCache(): void {
  cachedStore = null
}