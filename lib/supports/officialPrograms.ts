/**
 * 東京都の公的支援制度の公式情報・調査結果とデータ整備（M6-C）
 *
 * 【責務】
 * - 公式ページ（国の省庁・こども家庭庁・文部科学省・日本政策金融公庫・日本学生支援機構等）
 *   を実際に取得し、本文と照合できた情報だけを確認済みとして整理する
 * - 未確認の項目は null / 未確認ステータス / 理由付きの unconfirmedItems に留め、
 *   一般的な知識や推測で補完しない
 * - 確認済みデータは lib/supports/registry.ts 経由で既存のモックデータと段階的に統合する
 *
 * 【M6-C の検証ルール（このファイルで強制する）】
 * - urlVerified: true は「RESEARCH_LOG に記録し、実際の公式ページ本文と照合できた URL」のみ。
 *   調査メモ・AI 候補の自己申告だけでは true にならない（buildOfficialProgram が
 *   調査ログと突き合わせ、ログに無い URL の urlVerified は強制的に false に落とす）
 * - 金額の適用年度（fiscalYear）は公式資料に明記がある場合のみ設定する
 * - 根拠法令の名称は公式資料に記載がある場合のみ設定する（推測で補完しない）
 * - 受給資格は常に 'unconfirmed'（lib/supports/research.ts の正規化で保証）。
 *   実際に受給できるかの自動判定は行わない
 * - 貸付（返済必要）は給付金と区別する
 * - 対象地域が確認できない制度は推測で地域を設定しない（coverage: 'unknown'）
 *
 * 【外部通信なし】このモジュール自身は fetch や AI API を行わない。
 * 公式ページの照合は M6-C の調査工程（人手の確認）で実施し、その結果を
 * RESEARCH_LOG と OFFICIAL_RESEARCH_RECORDS に記録する。
 *
 * ══════════════════════════════════════════════════════════════════
 * 【調査ログ】2026-10-15 に実際に取得し、本文と照合した公式ページ
 * ══════════════════════════════════════════════════════════════════
 * 1. こども家庭庁「児童手当」 https://www.cfa.go.jp/policies/kokoseido/jidouteate
 *    → 照合済み: 制度の目的・対象（0歳〜18歳に達する日以後の最初の3月31日まで）。
 *      法令名・金額・所得制限の記載なし。
 * 2. こども家庭庁「児童手当制度のご案内」 https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai
 *    → 照合済み: 支給対象・支給額（3歳未満 月15,000円〔第3子以降30,000円〕／
 *      3歳以上〜高校生年代まで 月10,000円〔第3子以降30,000円〕）・支給時期（偶数月に2か月分）・
 *      認定請求の申請先（市区町村）・申請期限（出生日の翌日から15日以内等）・添付書類。
 *      所得制限・法令名・金額の適用年度の明記なし。
 * 3. 文部科学省「高校生等への修学支援」 https://www.mext.go.jp/a_menu/shotou/mushouka/index.htm
 *    → 照合済み: 高校生等奨学給付金＝授業料以外の教育費（教科書費・教材費等）を支援する
 *      返還不要の給付金・申請先は都道府県または学校・手続きは都道府県により異なる。
 *      給付額・所得基準・適用年度はこのページでは確認できないため未確認のままとする。
 * 4. 日本政策金融公庫 https://www.jfc.go.jp/
 *    → 照合済み: 「国の教育ローン」＝お子さまの教育資金を必要とする方をサポートする
 *      日本政策金融公庫の取扱い・教育ローンコールセンターの案内。
 *      貸付限度額・金利・必要書類・正式名称（教育一般貸付）・根拠法令は未確認のままとする
 *      （詳細ページは今回の調査では到達できなかった）。
 * 5. 独立行政法人日本学生支援機構「奨学金」 https://www.jasso.go.jp/shogakukin/
 *    → 照合済み: 学資の「貸与及び給付」を行う旨・貸与（返還あり）と給付の区別・
 *      家計（収入）による支援区分の存在。金額・申込資格の詳細は未確認。
 *
 * 【照合できなかった項目（未確認のまま扱う）】
 * - こども医療費助成（区市町村制度）: 自治体の公式ページに今回の調査では到達できず。
 *   対象年齢・助成内容・所得制限・条例は未確認。既存のモック表示を維持する。
 * - 児童手当の根拠法令名・所得制限の基準額・金額の適用年度
 * - 高校生等奨学給付金の給付額（課程・世帯区分別）・所得基準・適用年度
 * - 教育一般貸付（国の教育ローン）の貸付条件・正式名称・根拠法令
 * ══════════════════════════════════════════════════════════════════
 */
import {
  supportProgramSchema,
  type AmountBand,
  type Jurisdiction,
  type ProgramVerification,
  type SupportProgram,
  type UnconfirmedItem,
} from '../types/support'
import {
  normalizeResearchCandidate,
  type ResearchCandidate,
} from './research'

/** 公式ページの照合記録（RESEARCH_LOG に無い URL を検証済みにできない） */
export type ResearchLogEntry = {
  /** 公式ページの URL */
  url: string
  /** 情報提供元 */
  organization: string
  /** 照合日（YYYY-MM-DD） */
  checkedAt: string
  /** 取得日時（ISO 8601） */
  retrievedAt: string
  /** 実際に取得し、制度の内容と照合できたか */
  verified: boolean
  /** 照合できた内容の要約 */
  matchedContent: string
  /** 照合できなかった項目・補足 */
  note: string
}

/** M6-C 調査ログ（取得・照合できたページのみ記録） */
export const RESEARCH_LOG: readonly ResearchLogEntry[] = [
  {
    url: 'https://www.cfa.go.jp/policies/kokoseido/jidouteate',
    organization: 'こども家庭庁',
    checkedAt: '2026-10-15',
    retrievedAt: '2026-10-15T00:00:00+09:00',
    verified: true,
    matchedContent:
      '児童手当の目的・対象（国内に住所を有する0歳〜18歳に達する日以後の最初の3月31日までの児童を養育する方）',
    note: '法令名・支給額・所得制限の記載なし',
  },
  {
    url: 'https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai',
    organization: 'こども家庭庁',
    checkedAt: '2026-10-15',
    retrievedAt: '2026-10-15T00:00:00+09:00',
    verified: true,
    matchedContent:
      '支給額（3歳未満 月15,000円〔第3子以降30,000円〕／3歳以上〜高校生年代まで 月10,000円〔第3子以降30,000円〕）・支給時期（偶数月に2か月分）・認定請求（市区町村）・申請期限（出生日の翌日から15日以内等）・添付書類',
    note: '所得制限・根拠法令名・金額の適用年度（適用開始時期）の明記なし',
  },
  {
    url: 'https://www.mext.go.jp/a_menu/shotou/mushouka/index.htm',
    organization: '文部科学省',
    checkedAt: '2026-10-15',
    retrievedAt: '2026-10-15T00:00:00+09:00',
    verified: true,
    matchedContent:
      '高校生等奨学給付金＝授業料以外の教育費（教科書費・教材費等）を支援する返還不要の給付金。申請先は都道府県または学校、手続きは都道府県により異なる',
    note: '給付額・所得基準・適用年度・根拠法令名の記載なし',
  },
  {
    url: 'https://www.jfc.go.jp/',
    organization: '日本政策金融公庫',
    checkedAt: '2026-10-15',
    retrievedAt: '2026-10-15T00:00:00+09:00',
    verified: true,
    matchedContent:
      '「国の教育ローン」＝お子さまの教育資金を必要とする方をサポートする日本政策金融公庫の取扱い、教育ローンコールセンターの案内',
    note: '貸付限度額・金利・必要書類・正式名称（教育一般貸付）・根拠法令は未確認（詳細ページに到達できず）',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-15',
    retrievedAt: '2026-10-15T00:00:00+09:00',
    verified: true,
    matchedContent:
      '学資の「貸与及び給付」を行う旨。貸与（返還あり）と給付の区別、家計（収入）による支援区分の存在',
    note: '金額・申込資格の詳細・適用年度は未確認',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/index.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-16',
    retrievedAt: '2026-10-16T00:41:36.795Z',
    verified: true,
    matchedContent:
      '給付型奨学金＋授業料等減免（予約採用）: 対象となる家計基準・予約採用の申込時期の案内',
    note: '公式ページを取得し、対象となる家計基準・予約採用の申込時期の記載と照合済み（2026-10-16）',
  },
  // ── 2026-10-17 に取得本文を人手照合した公式ページ ──────────────
  {
    url: 'https://www.cfa.go.jp/laws',
    organization: 'こども家庭庁',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:24:50.131Z',
    verified: true,
    matchedContent:
      '「児童手当法（昭和四十六年律第七十三号）（e-Gov）」の記載（e-Gov 法令 ID 346AC0000000073）',
    note:
      '児童手当法（e-Gov）への記載を確認（2026-10-17）。法令番号・施行日・施行令/施行規則は未確認',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kingaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:24:53.169Z',
    verified: true,
    matchedContent:
      '給付型奨学金の支給額（給付月額表）: 支援区分×学校種×設置者×通学形態の月額、通信教育課程は年額。第4区分は多子世帯に限る',
    note:
      '給付月額表（支援区分×学校種×設置者×通学形態）と照合済み（2026-10-17）。適用年度の記載なし',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/yoyaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:24:55.048Z',
    verified: true,
    matchedContent:
      '予約採用の家計基準: 支給額算定基準額の合計（100円未満/25,600円/51,300円/154,500円の各区分）と資産基準（資産合計5,000万円未満）',
    note:
      '予約採用（2027年度進学予定・2026年度住民税情報）の家計基準と照合済み（2026-10-17）。年間収入額とは別の指標',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/zaigaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:24:56.864Z',
    verified: true,
    matchedContent:
      '在学採用の家計基準: 支給額算定基準額の合計（100円未満/25,600円/51,300円/154,500円の各区分）と資産基準（資産合計5,000万円未満）',
    note: '在学採用の家計基準と照合済み（2026-10-17）。年間収入額とは別の指標',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/gakuryoku/yoyaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:25:11.934Z',
    verified: true,
    matchedContent:
      '予約採用の学力基準: 高等学校等における第1学年から申込時までの全履修科目の評定平均値が5段階評価で3.5以上',
    note: '予約採用の学力基準と照合済み（2026-10-17）。受給資格の自動判定には使用しない',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/gakuryoku/zaigaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:25:13.747Z',
    verified: true,
    matchedContent:
      '在学採用の学力基準: 評定平均値が3.5以上、又は入学者選抜試験の成績が上位2分の1、GPAが上位2分の1',
    note: '在学採用の学力基準と照合済み（2026-10-17）。受給資格の自動判定には使用しない',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/daiyonkubun.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:25:19.402Z',
    verified: true,
    matchedContent:
      '令和6年度から第4区分（支給額算定基準額の合計51,300円以上154,500円未満）を確認。第4区分は給付奨学金0円・授業料等減免のみ',
    note: '令和6年度の第4区分案内と照合済み（2026-10-17）。減免と現金給付を混同しない',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/r7tashikakudai/index.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:25:41.840Z',
    verified: true,
    matchedContent:
      '令和7年度から多子世帯は所得制限なく授業料等減免の対象。資産合計5,000万円以上3億円未満の多子世帯は減免のみで給付奨学金は支給されない',
    note: '令和7年度以降の多子世帯の案内と照合済み（2026-10-17）。減免と現金給付を混同しない',
  },
  {
    url: 'https://www.jasso.go.jp/shogakukin/about/taiyo/taiyo_2shu/kingaku.html',
    organization: '独立行政法人日本学生支援機構',
    checkedAt: '2026-10-17',
    retrievedAt: '2026-10-16T15:25:45.574Z',
    verified: true,
    matchedContent:
      '第二種の月額: 大学・短大・専修=20,000〜120,000円（10,000円刻み）/私立医歯は120,000円に40,000円増額/薬獣は20,000円増額/大学院=50,000・80,000・100,000・130,000・150,000円（法科大学院は150,000円に40,000円または70,000円増額）/高専本科4,5年・専攻科=20,000〜120,000円',
    note: '第二種の月額と学校種・増額条件の対応を照合済み（2026-10-17）。適用年度の記載なし',
  },
]

/** 内容照合できた公式 URL の集合（urlVerified を許可する唯一の根拠） */
export function verifiedOfficialUrls(): Set<string> {
  return new Set(RESEARCH_LOG.filter((e) => e.verified).map((e) => e.url))
}

/** 調査メモの1制度分（lib/supports/research.ts の候補形式＋M6-C の確認情報） */
export type OfficialResearchRecord = {
  /** 制度 ID（既存モックの ID を使うと、そのモックを確認済みデータで更新する） */
  programId: string
  /** 調査メモ（research.ts の候補スキーマで検証される） */
  candidate: ResearchCandidate
  /** 対象地域（確認できない場合は coverage: 'unknown'） */
  jurisdiction: Jurisdiction
  /** 年齢区分等の金額内訳（確認できた区分のみ） */
  amountBands: AmountBand[]
  /** 確認状況（確認できた項目のみ列挙する） */
  verification: ProgramVerification
  /** 未確認の項目と理由 */
  unconfirmedItems: UnconfirmedItem[]
}

/**
 * 調査レコードを SupportProgram に変換する（純関数）。
 *
 * - 出典の urlVerified は調査ログと突き合わせ、ログに無い URL は false に落とす
 *   （調査メモの自己申告だけでは検証済みにしない）
 * - 受給資格は 'unconfirmed' 固定（research.ts の正規化に従う）
 * - 検証済み公式出典なしでは金額・法令名・申請期限を確定しない（research.ts に準拠）
 */
export function buildOfficialProgram(
  record: OfficialResearchRecord,
): SupportProgram {
  const verifiedUrls = verifiedOfficialUrls()
  const sanitized: ResearchCandidate = {
    ...record.candidate,
    sources: record.candidate.sources.map((s) => ({
      ...s,
      urlVerified:
        s.urlVerified === true &&
        s.url !== null &&
        s.url !== undefined &&
        verifiedUrls.has(s.url),
    })),
  }
  const normalized = normalizeResearchCandidate(sanitized, {
    trustVerification: true,
    programId: record.programId,
    extractionMethod: 'manual',
  })
  if (normalized.program === null) {
    throw new Error(
      `公式調査データを正規化できません（${record.programId}）: ${normalized.problems.join(' / ')}`,
    )
  }
  const base = normalized.program
  const program: SupportProgram = {
    ...base,
    eligibilityNote:
      '公式情報の調査結果からの整理。受給資格は未判定（正式な受給資格の決定ではありません）',
    unconfirmedItems: [
      ...(base.unconfirmedItems ?? []),
      ...record.unconfirmedItems,
    ],
    jurisdiction: record.jurisdiction,
    ...(record.amountBands.length > 0
      ? { amountBands: record.amountBands }
      : {}),
    verification: record.verification,
  }
  const validated = supportProgramSchema.safeParse(program)
  if (!validated.success) {
    throw new Error(
      `公式調査データがスキーマ検証に失敗しました（${record.programId}）: ${validated.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(' / ')}`,
    )
  }
  return validated.data
}

/** 公式調査データ（確認済み）の制度一覧を構築する */
export function buildOfficialPrograms(): SupportProgram[] {
  return OFFICIAL_RESEARCH_RECORDS.map(buildOfficialProgram)
}

/**
 * M6-C 公式調査レコード（調査ログで照合できた公式情報のみ）。
 * - programId に既存モックの ID を指定した制度は、レジストリでモックを更新する
 * - 未確認の項目は unconfirmedItems に理由付きで残す（推測で補完しない）
 */
export const OFFICIAL_RESEARCH_RECORDS: readonly OfficialResearchRecord[] = [
  // ── 1. 児童手当（こども家庭庁・国の制度）────────────────────────
  {
    programId: 'mock-child-allowance',
    candidate: {
      name: '児童手当',
      summary:
        '0歳から18歳に達する日以後の最初の3月31日までの児童を養育している方に支給される手当（こども家庭庁の公式情報で確認）',
      category: 'cash_benefit',
      level: 'national',
      amount: {
        value: 120_000,
        unit: 'yen_per_year',
        claimedBasis: 'estimated',
        description:
          '単一金額は「3歳以上〜高校生年代まで（第3子以外）の月額10,000円×12か月」の代表値（要確認）。年齢区分・第3子以降により金額が異なるため、確認済みの内訳は金額内訳（amountBands）を参照',
        scope: 'per_child',
      },
      period: { startAgeYears: 0, endAgeYears: 17, durationMonths: null },
      conditions: {
        combinedWith: [],
        incomeLimitNote:
          '所得制限の有無・基準額は今回の公式情報の確認範囲では未確認（要確認）',
        householdNote:
          '児童を養育している方が対象（生計同一などの一定の要件あり・詳細は要確認）',
        other: [
          '国内に住所を有する児童が対象（公式確認済み）',
          '支給は毎年2・4・6・8・10・12月（偶数月）に、それぞれの前月分まで（2か月分）を支給（公式確認済み）',
          '保育料・学校給食費等を市区町村が児童手当等から徴収する場合がある（実施は市区町村による・公式確認済み）',
        ],
      },
      application: {
        where: 'お住まいの市区町村（公務員の場合は勤務先）',
        documents: [
          '認定請求書',
          '健康保険の資格証明書等（請求者が被用者の場合）',
          '児童手当用所得証明書（該当時）',
          '金融機関の口座番号がわかるもの等',
        ],
        deadlineNote:
          '出生の日の翌日から15日以内に認定請求が必要。原則申請した月の翌月分から支給（月末に近い異動は異動日の翌日から15日以内なら申請月分から）',
        steps: [
          '現住所の市区町村に認定請求書を提出（公務員は勤務先に申請）',
          '市区町村の認定後、原則申請した月の翌月分から支給',
        ],
      },
      legalBasis: {
        lawName: '児童手当法',
        ordinanceName: null,
        note: '法令名はこども家庭庁の「法令」ページ（e-Gov）の記載で確認（2026-10-17）。法令番号は同ページ上「昭和四十六年律第七十三号」（原文ママ・脱字の可能性）と記載されるが確認済みにしない。施行日・施行令/施行規則は未確認',
      },
      sources: [
        {
          title: 'こども家庭庁「児童手当」',
          organization: 'こども家庭庁',
          url: 'https://www.cfa.go.jp/policies/kokoseido/jidouteate',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式ページを取得し、制度の目的・支給対象の記載と照合済み（2026-10-15）',
        },
        {
          title: 'こども家庭庁「児童手当制度のご案内」',
          organization: 'こども家庭庁',
          url: 'https://www.cfa.go.jp/policies/kokoseido/jidouteate/annai',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式ページを取得し、支給額・支給時期・申請手続き・添付書類の記載と照合済み（2026-10-15）',
        },
        {
          title: 'こども家庭庁「法令」',
          organization: 'こども家庭庁',
          url: 'https://www.cfa.go.jp/laws',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:24:50.131Z',
          verificationNote:
            '法令一覧ページを取得し、児童手当法（e-Gov）への記載と照合済み（2026-10-17）。法令番号・施行日は未確認',
        },
      ],
      checkedAt: '2026-10-17',
      missingInformation: [
        '所得制限の基準額',
        '施行令・施行規則名（根拠法令の詳細）',
        '金額の適用年度（適用開始時期）',
      ],
      mock: false,
    },
    jurisdiction: {
      coverage: 'nationwide',
      prefecture: null,
      municipality: null,
      ward: null,
      scopeNote:
        '全国の市区町村が実施（公務員は勤務先経由）。こども家庭庁の公式情報で確認',
      confidence: 'confirmed',
    },
    amountBands: [
      {
        label: '3歳未満（第3子以外）',
        value: 15_000,
        unit: 'yen_per_month',
        basis: 'confirmed',
        fiscalYear: null,
        note: '一人あたり月額（こども家庭庁の公式情報で確認。適用年度の明記なし）',
      },
      {
        label: '3歳未満（第3子以降）',
        value: 30_000,
        unit: 'yen_per_month',
        basis: 'confirmed',
        fiscalYear: null,
        note: '一人あたり月額（こども家庭庁の公式情報で確認。適用年度の明記なし）',
      },
      {
        label: '3歳以上〜高校生年代（第3子以外）',
        value: 10_000,
        unit: 'yen_per_month',
        basis: 'confirmed',
        fiscalYear: null,
        note: '一人あたり月額（こども家庭庁の公式情報で確認。適用年度の明記なし）',
      },
      {
        label: '3歳以上〜高校生年代（第3子以降）',
        value: 30_000,
        unit: 'yen_per_month',
        basis: 'confirmed',
        fiscalYear: null,
        note: '一人あたり月額（こども家庭庁の公式情報で確認。適用年度の明記なし）',
      },
    ],
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-17',
      verifiedFields: [
        'name',
        'summary',
        'amountBands',
        'period',
        'application.where',
        'application.documents',
        'application.deadlineNote',
        'application.steps',
        'jurisdiction',
        'legalBasis.lawName',
      ],
      note: 'こども家庭庁の公式ページ3件（取得・本文照合済み 2026-10-15/2026-10-17）で確認した項目のみ確認済み。法令名は「法令」ページ（e-Gov）の記載で確認。単一金額・所得制限の基準額・適用年度・施行令/施行規則名は未確認',
    },
    unconfirmedItems: [
      {
        field: 'amount.value',
        reason:
          '年齢区分・第3子以降により金額が異なるため、単一金額は確認済みの代表値ではありません（要確認）',
      },
      {
        field: 'amount.fiscalYear',
        reason:
          '公式ページに金額の適用年度・適用開始時期の明記がないため未確認',
      },
      {
        field: 'conditions.incomeLimit',
        reason:
          '今回の公式情報の確認範囲に所得制限の記載がないため未確認（推測で補完しません）',
      },
      {
        field: 'legalBasis.ordinanceName',
        reason:
          '施行令・施行規則（根拠法令の詳細）は今回の公式情報の確認範囲では未確認（推測で補完しません）',
      },
      {
        field: 'eligibility',
        reason:
          '受給資格は所得要件等を含め個別に確認が必要（要確認）。自動判定は行いません',
      },
    ],
  },
  // ── 2. 高校生等奨学給付金（文部科学省・都道府県が実施）──────────
  {
    programId: 'mock-high-school-scholarship',
    candidate: {
      name: '高校生等奨学給付金',
      summary:
        '高校等に通う生徒の授業料以外の教育費（教科書費・教材費等）を支援する返還不要の給付金（文部科学省の公式情報で確認）。高等学校等就学支援金（授業料支援）とは別の制度',
      category: 'cash_benefit',
      level: 'national',
      amount: {
        value: 118_800,
        unit: 'yen_per_year',
        claimedBasis: 'estimated',
        description:
          'モックの仮定値を暫定保持した推定値（要確認）。公式情報の確認範囲では給付額を確認できていません（課程・世帯区分により金額が異なる）',
        scope: 'per_child',
      },
      period: { startAgeYears: 15, endAgeYears: 17, durationMonths: null },
      conditions: {
        combinedWith: [],
        incomeLimitNote:
          '中・低所得世帯が対象の制度（所得基準の具体額は未確認・要確認）',
        householdNote: null,
        other: [
          '返還不要の給付金であり、貸付ではない（公式確認済み）',
          '申請先はお住いの都道府県または学校（公式確認済み）',
          '申請手続き・開始時期は都道府県により異なる（公式確認済み）',
        ],
      },
      application: {
        where: 'お住いの都道府県または学校',
        documents: [],
        deadlineNote:
          '申請手続き・開始時期は都道府県により異なる（公式確認済み）。具体的な期限は未確認',
        steps: ['都道府県または学校から案内される手続きに従って申請'],
      },
      legalBasis: {
        lawName: null,
        ordinanceName: null,
        note: '根拠法令の名称は今回の公式情報の確認範囲では未確認（推測で補完しません）',
      },
      sources: [
        {
          title: '文部科学省「高校生等への修学支援」',
          organization: '文部科学省',
          url: 'https://www.mext.go.jp/a_menu/shotou/mushouka/index.htm',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式ページを取得し、制度の位置付け（授業料以外の教育費を支援する返還不要の給付金）・申請先の記載と照合済み（2026-10-15）',
        },
      ],
      checkedAt: '2026-10-15',
      missingInformation: [
        '給付額（課程・世帯区分別）',
        '所得基準の具体額',
        '金額の適用年度',
        '根拠法令名',
        '申請期限（都道府県による）',
      ],
      mock: false,
    },
    jurisdiction: {
      coverage: 'nationwide',
      prefecture: null,
      municipality: null,
      ward: null,
      scopeNote:
        '全国（都道府県が実施。東京都の場合は東京都が実施主体となるが、都ごとの給付額・手続きは今回の調査では未確認）',
      confidence: 'confirmed',
    },
    amountBands: [],
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-15',
      verifiedFields: [
        'name',
        'summary',
        'category',
        'application.where',
        'conditions.other',
        'jurisdiction',
      ],
      note: '文部科学省の公式ページ（取得・本文照合済み 2026-10-15）で確認した項目のみ確認済み。給付額・所得基準・適用年度は未確認',
    },
    unconfirmedItems: [
      {
        field: 'amount.value',
        reason:
          '公式情報の確認範囲では給付額を確認できていません（課程・世帯区分により異なる）。モックの仮定値は推定のまま扱います',
      },
      {
        field: 'amount.fiscalYear',
        reason: '給付額の適用年度を確認できていないため未確認',
      },
      {
        field: 'conditions.incomeLimit',
        reason:
          '所得基準の具体額を確認できていないため未確認（要確認）',
      },
      {
        field: 'legalBasis.lawName',
        reason:
          '公式ページに給付金の根拠法令名の記載がないため未確認（推測で補完しません）',
      },
      {
        field: 'eligibility',
        reason:
          '受給資格は世帯所得・在学状況等の確認が必要（要確認）。自動判定は行いません',
      },
    ],
  },
  // ── 3. 教育一般貸付（日本政策金融公庫・貸付＝返済必要）──────────
  {
    programId: 'mock-education-loan',
    candidate: {
      name: '教育一般貸付（正式名称は要確認）',
      summary:
        '日本政策金融公庫の「国の教育ローン」は、お子さまの教育資金を必要とする方をサポートする貸付制度（返済義務あり）（日本政策金融公庫の公式ページで確認）',
      category: 'loan',
      level: 'national',
      amount: {
        value: null,
        unit: 'other',
        claimedBasis: 'unknown',
        description: '貸付限度額・金利は今回の公式情報の確認範囲では未確認',
      },
      period: {
        startAgeYears: null,
        endAgeYears: null,
        durationMonths: null,
      },
      conditions: {
        combinedWith: [],
        incomeLimitNote: null,
        householdNote: null,
        other: [
          '貸付制度のため給付と異なり返済義務がある（貸付／給付の区分は公式確認済み）',
          '融資審査あり（融資条件の詳細は未確認）',
        ],
      },
      application: {
        where: '日本政策金融公庫（教育ローンコールセンターの案内あり）',
        documents: [],
        deadlineNote: null,
        steps: [],
      },
      legalBasis: {
        lawName: null,
        ordinanceName: null,
        note: '根拠法令（日本政策金融公庫法等）は今回の公式情報の確認範囲では未確認（推測で補完しません）',
      },
      sources: [
        {
          title: '日本政策金融公庫（「国の教育ローン」の案内）',
          organization: '日本政策金融公庫',
          url: 'https://www.jfc.go.jp/',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式トップページを取得し、「国の教育ローン」の存在・実施主体・教育ローンコールセンターの案内と照合済み（2026-10-15）。貸付条件は未照合',
        },
      ],
      checkedAt: '2026-10-15',
      missingInformation: [
        '正式名称（教育一般貸付であることの確認）',
        '貸付限度額',
        '金利',
        '返済期間',
        '必要書類',
        '根拠法令名',
      ],
      mock: false,
    },
    jurisdiction: {
      coverage: 'unknown',
      prefecture: null,
      municipality: null,
      ward: null,
      scopeNote:
        '対象地域の記載は今回の確認範囲では未確認（推測して設定しません）',
      confidence: 'unconfirmed',
    },
    amountBands: [],
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-15',
      verifiedFields: ['summary', 'category', 'application.where'],
      note: '日本政策金融公庫の公式ページ（取得・本文照合済み 2026-10-15）で確認した項目のみ確認済み。正式名称・貸付条件・根拠法令は未確認',
    },
    unconfirmedItems: [
      {
        field: 'name',
        reason:
          '正式名称「教育一般貸付」は今回の調査で到達できた公式ページでは確認できていません（通称「国の教育ローン」のみ確認済み）',
      },
      {
        field: 'amount.value',
        reason: '貸付限度額・金利を確認できていないため未確認（推測で補完しません）',
      },
      {
        field: 'period',
        reason: '対象年齢・対象者の範囲を確認できていないため未確認',
      },
      {
        field: 'legalBasis.lawName',
        reason: '根拠法令名を確認できていないため未確認（推測で補完しません）',
      },
      {
        field: 'eligibility',
        reason: '融資審査によるため受給資格の判定は行いません（要確認）',
      },
    ],
  },
  // ── 4. JASSO 給付奨学金（返還不要・給付）─────────────────────
  {
    programId: 'official-jasso-kyufu-shogakukin',
    candidate: {
      name: '日本学生支援機構 給付奨学金',
      summary:
        '独立行政法人日本学生支援機構が、経済的理由で修学が困難な優れた学生等に給付する奨学金（返還不要）（公式情報で確認）',
      category: 'cash_benefit',
      level: 'national',
      amount: {
        value: null,
        unit: 'other',
        claimedBasis: 'unknown',
        description:
          '給付型奨学金（返済不要の現金給付）の給付月額は支援区分（第1〜第4区分）・学校種・設置者・通学形態で決まり、金額内訳（amountBands）に反映。単一の月額は無く、計算用の単一金額は未確認のまま。授業料等減免は別支援（混同しない）。適用年度の記載なし',
      },
      period: {
        startAgeYears: null,
        endAgeYears: null,
        durationMonths: null,
      },
      conditions: {
        combinedWith: [],
        incomeLimitNote:
          '家計基準は支給額算定基準額の合計による支援区分（境界: 100円未満・25,600円・51,300円・154,500円。第4区分は支給額算定基準額の合計51,300円以上154,500円未満と明記）と資産基準（生計維持者の資産合計5,000万円未満。2026-10-17 照合）。年間収入額ではなく支給額算定基準額の合計（混同しない）。予約採用は2027年度進学予定・2026年度住民税情報',
        householdNote: null,
        other: [
          '給付（返還不要）であり貸付ではない（貸与奨学金と区別・公式確認済み）',
          '採用には選考あり（学力基準は確認済み・その他の選考基準の詳細は未確認）',
          '学力基準（予約採用）: 高等学校等における第1学年から申込時までの全履修科目の評定平均値が5段階評価で3.5以上（2026-10-17 照合）',
          '学力基準（在学採用）: 評定平均値が3.5以上、又は入学者選抜試験の成績が上位2分の1、GPAが上位2分の1（2026-10-17 照合）',
          '第4区分は令和6年度から（支給額算定基準額の合計51,300円以上154,500円未満。多子世帯に属するか私立の理工農系課程に在籍することが採用条件。2026-10-17 照合）。令和6年度の案内では第4区分は給付奨学金0円・授業料等減免のみ（減免と現金給付を混同しない）',
          '令和7年度から多子世帯は所得制限なく授業料等減免の対象（給付奨学金の支給額は令和6年度以前と同様）。資産合計5,000万円以上3億円未満の多子世帯は授業料等減免のみで給付奨学金は支給されない（減免と現金給付を混同しない。2026-10-17 照合）',
          '給付月額は支援区分・学校種・設置者・通学形態で決まる（金額内訳に反映）。第一種（無利子）貸与併給時は支給調整あり（調整額は未取得のため未確認）',
          '授業料等減免は授業料の減免であり給付奨学金（現金給付）とは別の支援（混同しない）',
        ],
      },
      application: {
        where: '日本学生支援機構（申込経路の詳細は未確認）',
        documents: [],
        deadlineNote: null,
        steps: [],
      },
      legalBasis: {
        lawName: null,
        ordinanceName: null,
        note: '根拠法令の名称は今回の公式情報の確認範囲では未確認（推測で補完しません）',
      },
      sources: [
        {
          title: '日本学生支援機構「奨学金」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式ページを取得し、学資の「貸与及び給付」を行う旨・給付と貸与の区別・家計による支援区分の存在と照合済み（2026-10-15）',
        },
        {
          title: '日本学生支援機構「給付型奨学金」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/index.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-16',
          retrievedAt: '2026-10-16T00:41:36.795Z',
          verificationNote:
            '公式ページを取得し、給付型奨学金＋授業料等減免の対象となる家計基準・予約採用の申込時期の記載と照合済み（2026-10-16）',
        },
        {
          title: '日本学生支援機構「給付型奨学金の支給額」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kingaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:24:53.169Z',
          verificationNote:
            '給付月額表（支援区分×学校種×設置者×通学形態）と照合済み（2026-10-17）。適用年度の記載なし',
        },
        {
          title: '日本学生支援機構「家計基準（予約採用）」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/yoyaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:24:55.048Z',
          verificationNote:
            '予約採用（2027年度進学予定・2026年度住民税情報）の家計基準と照合済み（2026-10-17）。年間収入額とは別の指標',
        },
        {
          title: '日本学生支援機構「家計基準（在学採用）」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/zaigaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:24:56.864Z',
          verificationNote:
            '在学採用の家計基準と照合済み（2026-10-17）。年間収入額とは別の指標',
        },
        {
          title: '日本学生支援機構「学力基準（予約採用）」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/gakuryoku/yoyaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:25:11.934Z',
          verificationNote:
            '予約採用の学力基準と照合済み（2026-10-17）。受給資格の自動判定には使用しない',
        },
        {
          title: '日本学生支援機構「学力基準（在学採用）」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/gakuryoku/zaigaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:25:13.747Z',
          verificationNote:
            '在学採用の学力基準と照合済み（2026-10-17）。受給資格の自動判定には使用しない',
        },
        {
          title: '日本学生支援機構「第4区分」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/daiyonkubun.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:25:19.402Z',
          verificationNote:
            '令和6年度の第4区分案内と照合済み（2026-10-17）。減免と現金給付を混同しない',
        },
        {
          title: '日本学生支援機構「多子世帯の授業料等減免（令和7年度）」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/kyufu/kakei/r7tashikakudai/index.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:25:41.840Z',
          verificationNote:
            '令和7年度以降の多子世帯の案内と照合済み（2026-10-17）。減免と現金給付を混同しない',
        },
      ],
      checkedAt: '2026-10-17',
      missingInformation: [
        '申込資格・申込時期',
        '第一種貸与併給時の支給調整額',
        '適用年度',
        '根拠法令名',
      ],
      mock: false,
    },
    jurisdiction: {
      coverage: 'unknown',
      prefecture: null,
      municipality: null,
      ward: null,
      scopeNote:
        '対象地域の記載は今回の確認範囲では未確認（推測して設定しません）',
      confidence: 'unconfirmed',
    },
    // 給付月額表（2026-10-17 照合・確認済み）:
    //  - 「大学等」= 大学・短期大学・専修学校（専門課程）、「高専」= 高等専門学校（第4学年以上）
    //  - 「国公立」= 国立（独立行政法人大学等を含む）・公立（地方独立行政法人を含む）
    //  - note の「カッコ内」= 生活保護受給の生計維持者と同居、又は児童養護施設等から通学の場合の月額
    //  - 第4区分は多子世帯に限る／通信教育課程は年額（年1回）／大学院は表に記載なし／適用年度の記載なし
    amountBands: [
      { label: '国公立・大学等・自宅通学・第1区分', value: 29_200, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 33,300円' },
      { label: '国公立・大学等・自宅通学・第2区分', value: 38_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 42,400円' },
      { label: '国公立・大学等・自宅通学・第3区分', value: 68_600, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 72,700円' },
      { label: '国公立・大学等・自宅通学・第4区分（多子世帯に限る）', value: 80_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 84,400円' },
      { label: '国公立・大学等・自宅外通学・第1区分', value: 66_700, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 70,800円' },
      { label: '国公立・大学等・自宅外通学・第2区分', value: 75_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 79,900円' },
      { label: '国公立・大学等・自宅外通学・第3区分', value: 106_100, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 110,200円' },
      { label: '国公立・大学等・自宅外通学・第4区分（多子世帯に限る）', value: 117_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 121,900円' },
      { label: '国公立・高専（第4学年以上）・自宅通学・第1区分', value: 19_700, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 23,800円' },
      { label: '国公立・高専（第4学年以上）・自宅通学・第2区分', value: 28_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 32,900円' },
      { label: '国公立・高専（第4学年以上）・自宅通学・第3区分', value: 59_100, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 63,200円' },
      { label: '国公立・高専（第4学年以上）・自宅通学・第4区分（多子世帯に限る）', value: 70_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 74,900円' },
      { label: '国公立・高専（第4学年以上）・自宅外通学・第1区分', value: 57_200, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 61,300円' },
      { label: '国公立・高専（第4学年以上）・自宅外通学・第2区分', value: 66_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 70,400円' },
      { label: '国公立・高専（第4学年以上）・自宅外通学・第3区分', value: 96_600, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 100,700円' },
      { label: '国公立・高専（第4学年以上）・自宅外通学・第4区分（多子世帯に限る）', value: 108_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 112,400円' },
      { label: '私立・大学等・自宅通学・第1区分', value: 38_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 42,400円' },
      { label: '私立・大学等・自宅通学・第2区分', value: 47_400, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 51,500円' },
      { label: '私立・大学等・自宅通学・第3区分', value: 77_700, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 81,800円' },
      { label: '私立・大学等・自宅通学・第4区分（多子世帯に限る）', value: 89_400, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 93,500円' },
      { label: '私立・大学等・自宅外通学・第1区分', value: 75_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 79,900円' },
      { label: '私立・大学等・自宅外通学・第2区分', value: 84_900, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 89,000円' },
      { label: '私立・大学等・自宅外通学・第3区分', value: 115_200, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 119,300円' },
      { label: '私立・大学等・自宅外通学・第4区分（多子世帯に限る）', value: 126_900, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 131,000円' },
      { label: '私立・高専（第4学年以上）・自宅通学・第1区分', value: 28_800, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 32,900円' },
      { label: '私立・高専（第4学年以上）・自宅通学・第2区分', value: 37_900, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 42,000円' },
      { label: '私立・高専（第4学年以上）・自宅通学・第3区分', value: 68_200, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 72,300円' },
      { label: '私立・高専（第4学年以上）・自宅通学・第4区分（多子世帯に限る）', value: 79_900, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 84,000円' },
      { label: '私立・高専（第4学年以上）・自宅外通学・第1区分', value: 66_300, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 70,400円' },
      { label: '私立・高専（第4学年以上）・自宅外通学・第2区分', value: 75_400, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 79,500円' },
      { label: '私立・高専（第4学年以上）・自宅外通学・第3区分', value: 105_700, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 109,800円' },
      { label: '私立・高専（第4学年以上）・自宅外通学・第4区分（多子世帯に限る）', value: 117_400, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: 'カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 121,500円' },
      { label: '通信教育課程・第1区分', value: 10_100, unit: 'yen_per_year', basis: 'confirmed', fiscalYear: null, note: '年額（年1回・国公立/私立・自宅/自宅外で同一金額）。カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 13,600円' },
      { label: '通信教育課程・第2区分', value: 20_200, unit: 'yen_per_year', basis: 'confirmed', fiscalYear: null, note: '年額（年1回・国公立/私立・自宅/自宅外で同一金額）。カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 23,700円' },
      { label: '通信教育課程・第3区分', value: 50_500, unit: 'yen_per_year', basis: 'confirmed', fiscalYear: null, note: '年額（年1回・国公立/私立・自宅/自宅外で同一金額）。カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 54,000円' },
      { label: '通信教育課程・第4区分（多子世帯に限る）', value: 62_200, unit: 'yen_per_year', basis: 'confirmed', fiscalYear: null, note: '年額（年1回・国公立/私立・自宅/自宅外で同一金額）。カッコ内（生活保護受給の生計維持者と同居、又は児童養護施設等から通学）: 65,700円' },
    ],
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-17',
      verifiedFields: [
        'name',
        'summary',
        'category',
        'conditions.other',
        'conditions.incomeLimit',
        'amountBands',
      ],
      note: '日本学生支援機構の公式ページ（取得・本文照合済み 2026-10-15/2026-10-16/2026-10-17）で確認した項目のみ確認済み。給付月額表（支援区分×学校種×設置者×通学形態）・家計基準・学力基準を確認。適用年度・申込資格の詳細・根拠法令名・第一種併給時の支給調整額は未確認。授業料等減免（別支援）と混同しない',
    },
    unconfirmedItems: [
      {
        field: 'amount.value',
        reason:
          '給付月額は支援区分×学校種×設置者×通学形態で変動するため単一金額は未確認（金額内訳は amountBands を確認済み。推測で補完しません）',
      },
      {
        field: 'period',
        reason: '対象者の年齢・在学期間の範囲を確認できていないため未確認',
      },
      {
        field: 'eligibility',
        reason: '採用選考があるため受給資格の判定は行いません（要確認）',
      },
    ],
  },
  // ── 5. JASSO 貸与奨学金（返済必要・貸付）─────────────────────
  {
    programId: 'official-jasso-taiyo-shogakukin',
    candidate: {
      name: '日本学生支援機構 貸与奨学金',
      summary:
        '独立行政法人日本学生支援機構が、経済的理由で修学が困難な優れた学生等に貸与する奨学金（返済が必要）（公式情報で確認）',
      category: 'loan',
      level: 'national',
      amount: {
        value: null,
        unit: 'other',
        claimedBasis: 'unknown',
        description:
          '貸与月額は第一種/第二種・学校種・入学年度等により異なる。第二種の月額の選択範囲・学校種別増額は金額内訳（amountBands）に反映（適用年度の記載なし）。第一種の月額・入学年度別の月額は未取得ページのため未確認。貸与（返済必要）は給付と混同しない',
      },
      period: {
        startAgeYears: null,
        endAgeYears: null,
        durationMonths: null,
      },
      conditions: {
        combinedWith: [],
        incomeLimitNote:
          '家計（収入・所得）による選考・区分あり（基準額は未確認・要確認）',
        householdNote: null,
        other: [
          '貸与（返済が必要）であり給付ではない（給付奨学金と区別・公式確認済み）',
          '卒業後の返還の制度がある（公式確認済み）',
        ],
      },
      application: {
        where: '日本学生支援機構（申込経路の詳細は未確認）',
        documents: [],
        deadlineNote: null,
        steps: [],
      },
      legalBasis: {
        lawName: null,
        ordinanceName: null,
        note: '根拠法令の名称は今回の公式情報の確認範囲では未確認（推測で補完しません）',
      },
      sources: [
        {
          title: '日本学生支援機構「奨学金」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-15',
          retrievedAt: '2026-10-15T00:00:00+09:00',
          verificationNote:
            '公式ページを取得し、学資の「貸与及び給付」を行う旨・貸与（返還あり）の区別と照合済み（2026-10-15）',
        },
        {
          title: '日本学生支援機構「貸与型（第二種）の月額」',
          organization: '独立行政法人日本学生支援機構',
          url: 'https://www.jasso.go.jp/shogakukin/about/taiyo/taiyo_2shu/kingaku.html',
          urlVerified: true,
          official: true,
          checkedAt: '2026-10-17',
          retrievedAt: '2026-10-16T15:25:45.574Z',
          verificationNote:
            '第二種の月額と学校種・増額条件の対応を照合済み（2026-10-17）。適用年度の記載なし',
        },
      ],
      checkedAt: '2026-10-17',
      missingInformation: [
        '貸与月額（第一種・入学年度別の月額）',
        '貸与利率',
        '申込資格・申込時期',
        '返済条件',
        '適用年度',
        '根拠法令名',
      ],
      mock: false,
    },
    jurisdiction: {
      coverage: 'unknown',
      prefecture: null,
      municipality: null,
      ward: null,
      scopeNote:
        '対象地域の記載は今回の確認範囲では未確認（推測して設定しません）',
      confidence: 'unconfirmed',
    },
    // 貸与型・第二種の月額（2026-10-17 照合・確認済み）:
    //  - 「大学等」= 大学・短期大学・専修学校（専門課程）、「高専」= 高等専門学校（本科4,5年・専攻科）
    //  - 大学等・高専の第二種は20,000〜120,000円（10,000円刻み）。医歯/薬獣の増額は上限120,000円に対する増額
    //  - 第一種（無利子）の月額・入学年度別の月額は未取得ページのため未確認。適用年度の記載なし
    amountBands: [
      { label: '第二種・大学等・月額の選択範囲（下限）', value: 20_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '20,000〜120,000円（10,000円刻み）の範囲。「大学等」= 大学・短期大学・専修学校（専門課程）' },
      { label: '第二種・大学等・月額の選択範囲（上限）', value: 120_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '20,000〜120,000円（10,000円刻み）の上限' },
      { label: '第二種・大学等・私立医歯課程（増額）', value: 40_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '第二種の上限120,000円に増額（120,000円に40,000円増額）' },
      { label: '第二種・大学等・私立薬獣課程（増額）', value: 20_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '第二種の上限120,000円に増額（120,000円に20,000円増額）' },
      { label: '第二種・大学院・月額（1）', value: 50_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '大学院の月額の選択肢' },
      { label: '第二種・大学院・月額（2）', value: 80_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '大学院の月額の選択肢' },
      { label: '第二種・大学院・月額（3）', value: 100_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '大学院の月額の選択肢' },
      { label: '第二種・大学院・月額（4）', value: 130_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '大学院の月額の選択肢' },
      { label: '第二種・大学院・月額（5）', value: 150_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '大学院の月額の選択肢。法科大学院は150,000円に40,000円または70,000円増額（どちらかは課程により要確認・未確認）' },
      { label: '第二種・高等専門学校（本科4,5年・専攻科）・月額の選択範囲（下限）', value: 20_000, unit: 'yen_per_month', basis: 'confirmed', fiscalYear: null, note: '20,000〜120,000円（10,000円刻み）の範囲' },
    ],
    verification: {
      status: 'partial',
      verifiedAt: '2026-10-17',
      verifiedFields: [
        'name',
        'summary',
        'category',
        'conditions.other',
        'amountBands',
      ],
      note: '日本学生支援機構の公式ページ（取得・本文照合済み 2026-10-15/2026-10-17）で確認した項目のみ確認済み。第二種の月額の範囲（大学等・高専は20,000〜120,000円）と学校種別増額、大学院の月額5段階を確認。第一種の月額・利率・返済条件・適用年度は未確認。貸与（返済必要）は給付と混同しない',
    },
    unconfirmedItems: [
      {
        field: 'amount.value',
        reason:
          '単一の貸与月額は未確認（第二種の範囲は amountBands を確認済み・第一種の月額は未取得ページのため未確認。推測で補完しません）',
      },
      {
        field: 'conditions.incomeLimit',
        reason: '選考・所得基準の具体額を確認できていないため未確認',
      },
      {
        field: 'period',
        reason: '対象者の年齢・在学期間の範囲を確認できていないため未確認',
      },
      {
        field: 'eligibility',
        reason: '採用選考があるため受給資格の判定は行いません（要確認）',
      },
    ],
  },
]