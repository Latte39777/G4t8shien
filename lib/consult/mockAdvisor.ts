/**
 * モック応答プロバイダ（M5）
 *
 * 【重要】これは開発用のモック実装である。
 * - 実際のAI検索や公式サイトの検索は行わない（行ったかのような表示もしない）
 * - 質問内容・選択中の制度に応じた「確認用のサンプル回答」を決定論的に返す
 * - 実在する制度の受給資格・金額・申請期限・必要書類などを、
 *   未確認のまま確定情報として回答しない（必ず「要確認」「未確認」を明示する）
 * - 未対応の質問に対して、根拠のない制度情報を生成しない
 * - 関連制度を案内する場合は、検証済み情報とモックデータを区別する
 *
 * M6（別途承認後）に OpenAI 等のプロバイダへ差し替えられるよう、
 * ConsultProvider インターフェースを実装している（lib/consult/types.ts）。
 *
 * 【M6-D】制度データの取得元は lib/supports/registry.ts（結果画面・制度一覧・
 * API と共通）。公式確認済みの制度と未確認のモック制度が混在するため、
 * 回答では必ず確認状況を区別し、未確認の情報を事実として断定しない。
 */
import { formatYen } from '../simulation'
import type { SupportCategory, SupportProgram } from '../types/support'
import { getSupportPrograms } from '../supports/registry'
import type {
  ConsultProvider,
  ConsultRelatedProgram,
  ConsultReply,
  ConsultRequest,
} from './types'

/** 応答の先頭に必ず付けるモック明示 */
const MOCK_HEADER =
  '【開発用モック応答】この回答は開発用のサンプルです。公式サイトの検索結果ではなく、制度情報には公式確認済みの情報と未確認のモックデータが混在しています（確認状況は各制度の記載をご確認ください）。'

/** 制度区分の表示ラベル（給付・減免・貸与の混同を防ぐため明示する） */
/** 制度区分のラベル（返還不要/返済が必要の区別を明示。相談 UI のチップ表示でも再利用する） */
export function categoryLabel(category: SupportCategory): string {
  switch (category) {
    case 'cash_benefit':
      return '給付金（返還不要）'
    case 'fee_reduction':
      return '減免・助成（返還不要）'
    case 'loan':
      return '貸与・貸付（返済が必要）'
    case 'tax':
      return '税制上の優遇'
  }
}

export const MOCK_CONSULT_EXAMPLES = [
  '子育てでもらえるお金には、どんなものがある？',
  '自分の状況で対象になりそうな支援は？',
  '申請はどこですればいい？',
  'ほかに利用できる制度はある？',
] as const

/** 制度データの取得元（結果画面・制度一覧・API と共通のレジストリ） */
const PROGRAMS: readonly SupportProgram[] = getSupportPrograms()

/** 制度名（「（モック）」等の注記を除いた中核名）を質問文から探す */
function findProgramInMessage(message: string): SupportProgram | null {
  for (const program of PROGRAMS) {
    const coreName = program.name.replace(/（[^）]*）/g, '')
    if (coreName.length >= 3 && message.includes(coreName)) return program
  }
  return null
}

/** 登録制度を関連制度案内用に変換（検証済み/未確認を区別） */
function toRelated(
  programs: readonly SupportProgram[],
): ConsultRelatedProgram[] {
  return programs.map((p) => ({
    id: p.id,
    name: p.name,
    sourceType: p.mock ? ('mock' as const) : ('verified' as const),
    note: p.mock
      ? 'モックデータ（未確認）。確定情報ではありません'
      : '公式情報で確認済み（未確認の項目あり。窓口確認を推奨）',
  }))
}

/** 相談文脈の制度をレジストリから特定（引き継ぎ情報の ID で照合） */
function resolveContextProgram(request: ConsultRequest): SupportProgram | null {
  if (!request.program) return null
  return PROGRAMS.find((p) => p.id === request.program?.id) ?? null
}

/** 質問の分類（決定論的。優先度順に評価する） */
type Intent =
  | 'greeting'
  | 'application'
  | 'eligibility'
  | 'other_programs'
  | 'overview'
  | 'detail'
  | 'unsupported'

function classify(message: string): Intent {
  if (/^(こんにちは|こんばんは|おはよう|はじめまして|ありがとう|よろしく)/.test(message)) {
    return 'greeting'
  }
  if (/申請|窓口|どこで|提出|期限|必要書類|申込|申し込み|もらい方|受け取り方/.test(message)) {
    return 'application'
  }
  if (/対象|受給|もらえるか|もらえますか|対象外|条件|所得|収入|制限/.test(message)) {
    return 'eligibility'
  }
  if (/(ほか|他)の制度|ほかに|他に|追加|見落と|漏れ|まだある|全て|すべて/.test(message)) {
    return 'other_programs'
  }
  // 制度名に「手当」等を含む質問を概要に落とさないよう、詳細を先に判定する
  if (/詳しく|金額|いくら|どれだけ|内容|概要|期間/.test(message)) {
    return 'detail'
  }
  if (/どんな|何がある|制度|手当|助成|支援|給付|一覧|種類/.test(message)) {
    return 'overview'
  }
  return 'unsupported'
}

// ── 意図ごとのモック回答（すべて決定論的） ──

function reply(
  body: string,
  relatedPrograms: ConsultRelatedProgram[],
  options?: { unsupported?: boolean; hasUnverified?: boolean },
): ConsultReply {
  const unsupported = options?.unsupported ?? false
  return {
    text: `${MOCK_HEADER}\n\n${body}`,
    isMock: true,
    hasUnverified: options?.hasUnverified ?? true,
    relatedPrograms,
    unsupported,
  }
}

function greetingReply(): ConsultReply {
  return reply(
    [
      'こんにちは。支援制度の相談アシスタント（モック）です。',
      '以下のような質問を試せます。',
      ...MOCK_CONSULT_EXAMPLES.map((e) => `・${e}`),
      '制度を特定せずに自由に質問してください。',
    ].join('\n'),
    [],
    { hasUnverified: false },
  )
}

function overviewReply(program: SupportProgram | null): ConsultReply {
  const lines = PROGRAMS.map((p) => {
    const amount =
      p.amount.value !== null
        ? `${formatYen(p.amount.value)}（${p.amount.unit === 'yen_per_year' ? '年額' : '月額'}・${p.amount.basis === 'estimated' ? '推定・要確認' : '未確認'}）`
        : '金額は未確認'
    const status = p.mock ? '未確認（モック）' : '公式確認済み（一部要確認）'
    return `・${p.name}【${categoryLabel(p.category)}】【${status}】：${p.summary}／${amount}`
  })
  return reply(
    [
      '子育てでもらえる主な支援には、次のものがあります（確認状況を付記しています）。',
      ...lines,
      program
        ? `いま相談中の「${program.name}」についても、対象条件・申請方法などを質問できます。`
        : 'どの制度についても、制度名を含めて質問できます。',
      '※ここに挙げたのは一部の制度で、実際の利用可能な制度の一覧ではありません。未確認の金額・条件は確定情報ではありません。',
      'お住まいの市区町村はどちらですか？（自治体独自の給付や医療費助成もご案内できるため）',
    ].join('\n'),
    toRelated(PROGRAMS),
  )
}

function eligibilityReply(
  request: ConsultRequest,
  program: SupportProgram | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  const contextLines: string[] = []
  if (request.userContext) {
    contextLines.push(
      `（相談に必要な範囲の入力情報のみ利用：お子さま ${request.userContext.childCount} 人・世帯年収の入力 ${request.userContext.hasAnnualIncome ? 'あり' : 'なし'}・利用中の制度 ${request.userContext.usedProgramIds.length} 件。収入・貯蓄の金額は相談機能に渡していません。）`,
    )
  }
  const targetLines = target
    ? [
        `「${target.name}」の対象条件について：`,
        `・対象条件の目安（${target.mock ? '未確認（モック・要確認）' : '公式確認済みの記載・一部要確認'}）：${target.conditions.other.join('／') || '確認できていません'}`,
        `・所得制限：${target.conditions.incomeLimitNote ?? '確認できていません（要確認）'}`,
        `・判定に不足している情報：${target.missingInformation.join('、') || 'なし'}`,
      ]
    : [
        'どの制度の対象条件かを、制度名を含めて質問していただくと、確認できている範囲でお答えできます。',
      ]
  return reply(
    [
      '受給資格の判定は、このモック段階では確定できません。正式な受給資格の決定ではありません。',
      ...contextLines,
      ...targetLines,
      '対象条件・所得制限の基準は未確認のため、該当するかどうかの結論は、お住まいの自治体の窓口・公式窓口での確認が必要です。',
    ].join('\n'),
    target ? toRelated([target]) : toRelated(PROGRAMS),
  )
}

function applicationReply(
  request: ConsultRequest,
  program: SupportProgram | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  if (!target) {
    return reply(
      [
        'どの制度の申請方法か、制度名を含めて質問してください。',
        '確認できている制度：',
        ...PROGRAMS.map((p) => `・${p.name}`),
        'なお、申請先・期限・必要書類には未確認の内容が含まれます。公式サイトの検索結果ではありません。',
      ].join('\n'),
      toRelated(PROGRAMS),
    )
  }
  const app = target.application
  return reply(
    [
      `「${target.name}」の申請について、確認できている内容は次のとおりです（確認状況: ${target.mock ? '未確認（モック）' : '公式確認済みの項目と未確認の項目が混在'}）。`,
      `・申請先：${app.where ?? '未確認'}（要確認）`,
      `・申請期限・時期：${app.deadlineNote ?? '未確認'}（要確認）`,
      `・必要書類：${app.documents.join('、') || '未確認'}（要確認）`,
      `・申請手順：${app.steps.join('→') || '未確認'}（要確認）`,
      '※これは開発用のサンプル情報であり、公式の申請案内ではありません。実際の申請先・申請期限・必要書類などは、お住まいの自治体の窓口・公式サイトで必ずご確認ください。',
    ].join('\n'),
    toRelated([target]),
  )
}

function otherProgramsReply(
  request: ConsultRequest,
  program: SupportProgram | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  const rest = PROGRAMS.filter((p) => p.id !== target?.id)
  return reply(
    [
      target
        ? `「${target.name}」以外にも、次の支援制度があります（確認状況を付記しています）。`
        : '子育て支援の制度には、ほかにも次のようなものがあります（確認状況を付記しています）。',
      ...rest.map(
        (p) =>
          `・${p.name}【${categoryLabel(p.category)}】【${p.mock ? '未確認（モック）' : '公式確認済み（一部要確認）'}】：${p.summary}`,
      ),
      '※ここに挙げたのは一部の制度で、実際の利用可能な制度の一覧ではありません。確認済みの制度にも未確認の項目が含まれます。',
      'どの制度についても、制度名を含めて質問してください。',
    ].join('\n'),
    toRelated(rest),
  )
}

function detailReply(
  request: ConsultRequest,
  program: SupportProgram | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  if (!target) {
    return reply(
      [
        'どの制度について詳しく知りたいか、制度名を含めて質問してください。',
        ...PROGRAMS.map((p) => `・${p.name}`),
        VERIFY_FOOTER,
      ].join('\n'),
      toRelated(PROGRAMS),
    )
  }
  const amount =
    target.amount.value !== null
      ? `${formatYen(target.amount.value)}（${target.amount.description}）`
      : target.amount.description
  return reply(
    [
      `「${target.name}」について、確認できている内容は次のとおりです（確認状況: ${target.mock ? '未確認（モック）' : '公式確認済みの項目と未確認の項目が混在'}）。`,
      `・概要：${target.summary}`,
      `・金額【${categoryLabel(target.category)}】：${amount}【${target.amount.basis === 'confirmed' ? '公式確認済み' : target.amount.basis === 'estimated' ? '推定・要確認' : '未確認'}】`,
      `・対象期間：${target.period.startAgeYears ?? 0}歳〜${target.period.endAgeYears ?? '上限なし（要確認）'}歳`,
      `・根拠法令：${target.legalBasis.lawName ?? target.legalBasis.ordinanceName ?? '未確認'}（要確認）`,
      '※金額・対象条件は確定情報ではありません。実際の受給資格・金額・申請期限・必要書類は、お住まいの自治体・公式窓口で必ずご確認ください。',
    ].join('\n'),
    toRelated([target]),
  )
}

function unsupportedReply(): ConsultReply {
  return reply(
    [
      '申し訳ありませんが、その質問には未対応です。',
      '確認できていない情報を推測で答えることはしません（公式サイトの検索結果でもありません）。',
      '次のような質問ならお答えできます。',
      ...MOCK_CONSULT_EXAMPLES.map((e) => `・${e}`),
      '具体的な制度名（例：児童手当）を含む質問にも、サンプルデータの範囲でお答えできます。',
    ].join('\n'),
    [],
    { unsupported: true, hasUnverified: false },
  )
}

/** モック応答の生成（決定論的・同期処理） */
export function buildMockReply(request: ConsultRequest): ConsultReply {
  const program = resolveContextProgram(request)
  switch (classify(request.message)) {
    case 'greeting':
      return greetingReply()
    case 'overview':
      return overviewReply(program)
    case 'eligibility':
      return eligibilityReply(request, program)
    case 'application':
      return applicationReply(request, program)
    case 'other_programs':
      return otherProgramsReply(request, program)
    case 'detail':
      return detailReply(request, program)
    default:
      return unsupportedReply()
  }
}

/** モックプロバイダ（M5 の唯一のプロバイダ。M6 で差し替え予定） */
export const mockConsultProvider: ConsultProvider = {
  id: 'mock',
  label: 'モック応答（開発用サンプル）',
  isMock: true,
  respond(request: ConsultRequest): Promise<ConsultReply> {
    return Promise.resolve(buildMockReply(request))
  },
}