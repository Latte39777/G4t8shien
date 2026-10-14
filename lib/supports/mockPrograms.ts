/**
 * 公的支援制度のモックデータ（M2）
 *
 * 【重要】このデータはモック（仮データ）である。
 * - 金額・対象条件・根拠法令・申請期限は公式根拠を確認していない（＝未確認）。
 * - amount.basis は 'confirmed' を使用しない（'estimated' または 'unknown'）。
 * - 全制度に mock: true、出典は urlVerified: false で「URL要確認」と表示される。
 * M5まではこのモックのみを使用する。Live AI（M6）は別途承認まで実装・有効化しない。
 */
import type { SupportProgram } from '../types/support'

export const MOCK_DISCLAIMER =
  'この制度情報はモックデータです。金額・対象条件・根拠法令・申請期限は公式根拠を確認しておらず、確定情報ではありません。実際の申請は自治体・公式窓口で確認してください。'

const CHECKED_AT = '2026-10-13'

const source = (title: string, organization: string) => ({
  title,
  organization,
  url: null,
  urlVerified: false,
  official: true,
  checkedAt: CHECKED_AT,
})

export const MOCK_SUPPORT_PROGRAMS: SupportProgram[] = [
  {
    id: 'mock-child-allowance',
    name: '児童手当（モック）',
    category: 'cash_benefit',
    level: 'national',
    summary: '0歳〜中学校修了前の児童を養育する世帯に支給される手当（モック）',
    amount: {
      value: 120_000,
      unit: 'yen_per_year',
      basis: 'estimated',
      description:
        '月10,000円×12か月の仮定値（要確認）。令和7年10月改正・2026年度以降の拡大後の最終額は未確認',
    },
    period: { startAgeYears: 0, endAgeYears: 15, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: '所得制限あり（要確認）',
      householdNote: null,
      other: ['中学校修了前（15歳の最初の3月まで）が対象の想定（要確認）'],
    },
    application: {
      where: '市区町村',
      documents: ['支給申請書（要確認）'],
      deadlineNote: '出生等のあった月から15日以内の申請が原則との想定（要確認）',
      steps: ['市区町村窓口で申請（要確認）'],
    },
    eligibility: 'likely',
    eligibilityNote: 'モック判定。正式な受給資格の決定ではない',
    legalBasis: {
      lawName: '子ども・子育て支援法（要確認）',
      ordinanceName: null,
      note: '根拠法令は未確認',
    },
    sources: [source('こども家庭庁「児童手当」（要確認）', 'こども家庭庁')],
    checkedAt: CHECKED_AT,
    missingInformation: ['改正後の金額', '所得制限の基準額'],
    mock: true,
  },
  {
    id: 'mock-high-school-scholarship',
    name: '高校生等奨学給付金（モック）',
    category: 'cash_benefit',
    level: 'national',
    summary:
      '高校等に通う低所得世帯の生徒に給付される奨学金（授業料等の負担軽減）のモック',
    amount: {
      value: 118_800,
      unit: 'yen_per_year',
      basis: 'estimated',
      description:
        '私立高校等に通う就学支援金受給世帯の給付額の仮定値（要確認）。国公立・私立、課程により異なる',
    },
    period: { startAgeYears: 15, endAgeYears: 17, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: '住民税所得割の基準あり（要確認）',
      householdNote: null,
      other: ['就学支援金の受給が前提の想定（要確認）'],
    },
    application: {
      where: '学校経由（都道府県）',
      documents: ['申請書・マイナンバー関係書類（要確認）'],
      deadlineNote: '学校から案内される時期に申請（要確認）',
      steps: ['学校から配布される申請書類を提出（要確認）'],
    },
    eligibility: 'possible',
    eligibilityNote: '収入未入力のため判定保留（モック）',
    legalBasis: {
      lawName: '教育関係給付金の支給等に関する法律（要確認）',
      ordinanceName: null,
      note: '根拠法令は未確認',
    },
    sources: [source('文部科学省「高校生等奨学給付金」（要確認）', '文部科学省')],
    checkedAt: CHECKED_AT,
    missingInformation: ['世帯収入', '国公立/私立・課程', '給付額の最新基準'],
    mock: true,
  },
  {
    id: 'mock-child-medical-aid',
    name: 'こども医療費助成（モック・自治体による）',
    category: 'fee_reduction',
    level: 'municipal',
    summary:
      '子どもの医療費の自己負担を助成する制度（対象年齢・助成内容は自治体により異なる）のモック',
    amount: {
      value: null,
      unit: 'other',
      basis: 'unknown',
      description: '自治体により助成内容・対象年齢・自己負担額が異なるため未確認',
    },
    period: { startAgeYears: 0, endAgeYears: 17, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: '自治体により所得制限あり（要確認）',
      householdNote: '居住地の自治体の条例による（要確認）',
      other: [],
    },
    application: {
      where: '居住地の市区町村',
      documents: ['認定申請書（要確認）'],
      deadlineNote: '申請日から支給開始となる自治体が多い想定（要確認）',
      steps: ['市区町村窓口で申請（要確認）'],
    },
    eligibility: 'unconfirmed',
    eligibilityNote: '自治体情報が必要（モック。東京都23区で一律ではない）',
    legalBasis: {
      lawName: null,
      ordinanceName: '各自治体の条例（要確認）',
      note: '根拠条例は未確認',
    },
    sources: [source('各自治体「こども医療費助成」（要確認）', '各自治体')],
    checkedAt: CHECKED_AT,
    missingInformation: ['居住地の詳細', '対象年齢', '自己負担の有無'],
    mock: true,
  },
  {
    id: 'mock-education-loan',
    name: '教育一般貸付（モック）',
    category: 'loan',
    level: 'national',
    summary:
      '日本政策金融公庫による学生等のための貸付制度（貸付＝返済義務あり）のモック',
    amount: {
      value: null,
      unit: 'other',
      basis: 'unknown',
      description: '貸付限度額・金利は世帯状況・融資条件により異なるため未確認',
    },
    period: { startAgeYears: 0, endAgeYears: 22, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: null,
      householdNote: null,
      other: ['貸付制度のため給付と異なり返済義務がある'],
    },
    application: {
      where: '日本政策金融公庫',
      documents: ['借用書・収入証明等（要確認）'],
      deadlineNote: '資金需要時期の前に申込が必要（要確認）',
      steps: ['窓口・Webで申込（要確認）'],
    },
    eligibility: 'unconfirmed',
    eligibilityNote: '融資審査による（モック）',
    legalBasis: {
      lawName: '日本政策金融公庫法（要確認）',
      ordinanceName: null,
      note: '根拠法令は未確認',
    },
    sources: [source('日本政策金融公庫「教育一般貸付」（要確認）', '日本政策金融公庫')],
    checkedAt: CHECKED_AT,
    missingInformation: ['貸付条件', '金利', '返済期間'],
    mock: true,
  },
]
