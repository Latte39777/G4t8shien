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
 */
import { formatYen } from '../simulation'
import { MOCK_SUPPORT_PROGRAMS } from '../supports/mockPrograms'
import type {
  ConsultProvider,
  ConsultRelatedProgram,
  ConsultReply,
  ConsultRequest,
} from './types'

/** 応答の先頭に必ず付けるモック明示 */
const MOCK_HEADER =
  '【開発用モック応答】この回答は開発用のサンプルです。公式サイトの検索結果ではなく、制度情報はモックデータ（未確認）に基づきます。'

/** 未確認情報を含む回答の共通フッタ */
const VERIFY_FOOTER =
  '実際の受給資格・金額・申請期限・必要書類は未確認です。お住まいの自治体・公式窓口で必ずご確認ください。'

export const MOCK_CONSULT_EXAMPLES = [
  '子育てでもらえるお金には、どんなものがある？',
  '自分の状況で対象になりそうな支援は？',
  '申請はどこですればいい？',
  'ほかに利用できる制度はある？',
] as const

/** 制度名（「（モック）」等の注記を除いた中核名）を質問文から探す */
function findProgramInMessage(
  message: string,
): (typeof MOCK_SUPPORT_PROGRAMS)[number] | null {
  for (const program of MOCK_SUPPORT_PROGRAMS) {
    const coreName = program.name.replace(/（[^）]*）/g, '')
    if (coreName.length >= 3 && message.includes(coreName)) return program
  }
  return null
}

/** モック制度を関連制度案内用に変換（検証済み/モックを区別） */
function toRelated(
  programs: readonly (typeof MOCK_SUPPORT_PROGRAMS)[number][],
): ConsultRelatedProgram[] {
  return programs.map((p) => ({
    id: p.id,
    name: p.name,
    sourceType: p.mock ? ('mock' as const) : ('verified' as const),
    note: p.mock
      ? 'モックデータ（未確認）。確定情報ではありません'
      : '検証済みの情報',
  }))
}

/** 相談文脈の制度をモック一覧から特定（引き継ぎ情報は名前照合） */
function resolveContextProgram(
  request: ConsultRequest,
): (typeof MOCK_SUPPORT_PROGRAMS)[number] | null {
  if (!request.program) return null
  return (
    MOCK_SUPPORT_PROGRAMS.find((p) => p.id === request.program?.id) ?? null
  )
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
      'このアシスタントの回答はすべて開発用のサンプルであり、制度情報は未確認のモックデータに基づきます。',
      '以下のような質問を試せます。',
      ...MOCK_CONSULT_EXAMPLES.map((e) => `・${e}`),
      '制度を特定せずに自由に質問してください。',
    ].join('\n'),
    [],
    { hasUnverified: false },
  )
}

function overviewReply(
  program: (typeof MOCK_SUPPORT_PROGRAMS)[number] | null,
): ConsultReply {
  const lines = MOCK_SUPPORT_PROGRAMS.map((p) => {
    const amount =
      p.amount.value !== null
        ? `${formatYen(p.amount.value)}（${p.amount.unit === 'yen_per_year' ? '年額' : '月額'}・${p.amount.basis === 'estimated' ? '推定・要確認' : '未確認'}）`
        : '金額は未確認'
    return `・${p.name}：${p.summary}／${amount}`
  })
  return reply(
    [
      '子育て関連の支援として、モックデータには次の制度が登録されています（すべてモック・未確認）。',
      ...lines,
      program
        ? `いま相談中の「${program.name}」についても、対象条件・申請方法などを質問できます。`
        : '気になる制度があれば、制度名を含めて質問してください。',
      '※モックデータにない制度（自治体独自の制度など）も存在するため、実際の制度の一覧ではありません。',
      VERIFY_FOOTER,
    ].join('\n'),
    toRelated(MOCK_SUPPORT_PROGRAMS),
  )
}

function eligibilityReply(
  request: ConsultRequest,
  program: (typeof MOCK_SUPPORT_PROGRAMS)[number] | null,
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
        `・対象条件の目安（モック・要確認）：${target.conditions.other.join('／') || '記載なし'}`,
        `・所得制限：${target.conditions.incomeLimitNote ?? '記載なし（要確認）'}`,
        `・判定に不足している情報：${target.missingInformation.join('、') || 'なし'}`,
      ]
    : [
        'どの制度の対象条件かを、制度名を含めて質問していただくと、モックデータの範囲でお答えできます。',
      ]
  return reply(
    [
      '受給資格の判定は、このモック段階では確定できません。正式な受給資格の決定ではありません。',
      ...contextLines,
      ...targetLines,
      '対象条件・所得制限の基準は未確認のため、該当するかどうかの結論は公式窓口での確認が必要です。',
      VERIFY_FOOTER,
    ].join('\n'),
    target ? toRelated([target]) : toRelated(MOCK_SUPPORT_PROGRAMS),
  )
}

function applicationReply(
  request: ConsultRequest,
  program: (typeof MOCK_SUPPORT_PROGRAMS)[number] | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  if (!target) {
    return reply(
      [
        'どの制度の申請方法か、制度名を含めて質問してください。',
        'モックデータに登録されている制度：',
        ...MOCK_SUPPORT_PROGRAMS.map((p) => `・${p.name}`),
        'なお、申請先・期限・必要書類はすべて未確認です。この回答は公式サイトの検索結果ではありません。',
        VERIFY_FOOTER,
      ].join('\n'),
      toRelated(MOCK_SUPPORT_PROGRAMS),
    )
  }
  const app = target.application
  return reply(
    [
      `「${target.name}」の申請について、モックデータ（未確認）の記載は次のとおりです。`,
      `・申請先：${app.where ?? '未確認'}（要確認）`,
      `・申請期限・時期：${app.deadlineNote ?? '未確認'}（要確認）`,
      `・必要書類：${app.documents.join('、') || '未確認'}（要確認）`,
      `・申請手順：${app.steps.join('→') || '未確認'}（要確認）`,
      '※上記はモックデータのサンプルであり、公式の申請案内ではありません。必要書類の一覧が正式なものである保証もありません。',
      VERIFY_FOOTER,
    ].join('\n'),
    toRelated([target]),
  )
}

function otherProgramsReply(
  request: ConsultRequest,
  program: (typeof MOCK_SUPPORT_PROGRAMS)[number] | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  const rest = MOCK_SUPPORT_PROGRAMS.filter((p) => p.id !== target?.id)
  return reply(
    [
      target
        ? `「${target.name}」以外にも、モックデータには次の制度があります（すべてモック・未確認）。`
        : 'モックデータには次の制度があります（すべてモック・未確認）。',
      ...rest.map((p) => `・${p.name}：${p.summary}`),
      '※モックデータは一部の制度のみを収録したサンプルで、実際の利用可能な制度の一覧ではありません。検証済みの制度情報は現時点で持っていません。',
      'どの制度についても自由に質問できます。制度名を含めて質問してください。',
      VERIFY_FOOTER,
    ].join('\n'),
    toRelated(rest),
  )
}

function detailReply(
  request: ConsultRequest,
  program: (typeof MOCK_SUPPORT_PROGRAMS)[number] | null,
): ConsultReply {
  const target = findProgramInMessage(request.message) ?? program
  if (!target) {
    return reply(
      [
        'どの制度について詳しく知りたいか、制度名を含めて質問してください。',
        ...MOCK_SUPPORT_PROGRAMS.map((p) => `・${p.name}`),
        VERIFY_FOOTER,
      ].join('\n'),
      toRelated(MOCK_SUPPORT_PROGRAMS),
    )
  }
  const amount =
    target.amount.value !== null
      ? `${formatYen(target.amount.value)}（${target.amount.description}）`
      : target.amount.description
  return reply(
    [
      `「${target.name}」について、モックデータ（未確認）の記載は次のとおりです。`,
      `・概要：${target.summary}`,
      `・金額：${amount}【${target.amount.basis === 'estimated' ? '推定・要確認' : '未確認'}】`,
      `・対象期間：${target.period.startAgeYears ?? 0}歳〜${target.period.endAgeYears ?? '上限なし（要確認）'}歳`,
      `・根拠法令：${target.legalBasis.lawName ?? target.legalBasis.ordinanceName ?? '未確認'}（要確認）`,
      '※金額・対象条件は確定情報ではありません。',
      VERIFY_FOOTER,
    ].join('\n'),
    toRelated([target]),
  )
}

function unsupportedReply(): ConsultReply {
  return reply(
    [
      '申し訳ありませんが、その質問には未対応です。',
      'モックデータにない制度情報や、確認していない情報を推測で生成することはしません（公式サイトを検索した結果でもありません）。',
      '次のような質問ならお答えできます。',
      ...MOCK_CONSULT_EXAMPLES.map((e) => `・${e}`),
      '具体的な制度名（例：児童手当）を含む質問にも、モックデータの範囲でお答えできます。',
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