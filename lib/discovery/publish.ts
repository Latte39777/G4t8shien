/**
 * 承認済み候補の公開用 SupportProgram への変換と公開ゲート（M7-E・純関数）
 *
 * 【責務】
 * - 制度候補（DiscoveryCandidate）を確定制度データ（SupportProgram）へ変換する
 *   （正規化は lib/supports/research.ts の normalizeResearchCandidate を再利用）
 * - 公開（data/programs/programs.json への反映）の前に、必要な検証をすべて行い、
 *   条件を満たさない場合は公開を拒否して不足項目を具体的に報告する
 * - 既存制度の更新（mergeProgramUpdate）では、既存の制度 ID・確認済みの根拠・
 *   適用年度を無視して上書きしない
 *
 * 【変換と公開承認の分離】
 * - 変換（convertCandidateToProgram）だけでは公開されない。
 *   公開は evaluatePublishGate を通過した候補に対してのみ、明示的な承認操作と
 *   別の公開操作で行う。AI が作成した候補を変換しただけで公開しない。
 *
 * 【外部通信なし・ファイル I/O なし】純関数のみ。
 */
import {
  VERIFICATION_ABSENT_VALUE,
  type DiscoveryCandidate,
  type DiscoveryKind,
  type FieldVerification,
} from './discoveryStore'
import {
  CRITICAL_FIELD_LABELS,
  evaluateEvidenceGate,
  familyOfField,
  fieldVerificationError,
  type CriticalFieldFamily,
} from './reviewStore'
import {
  normalizeResearchCandidate,
  type ResearchCandidate,
} from '../supports/research'
import { isOfficialLink } from '../supports/evidence'
import {
  TOKYO_WARD_CODES,
  supportProgramSchema,
  type Jurisdiction,
  type SupportCategory,
  type SupportLevel,
  type SupportProgram,
  type TokyoWardCode,
  type UnconfirmedItem,
} from '../types/support'

/** 公開モード（新規登録 / 既存制度の更新） */
export type PublishMode = 'new' | 'update'

/** 候補から導く公開用制度 ID（候補 ID と 1:1 で安定） */
export function candidateProgramId(candidate: DiscoveryCandidate): string {
  return `disc-${candidate.candidateId.replace(/^cand-/, '')}`
}

/** 支援種別（給付・減免・貸付・税）が明確か */
export function categoryOfKind(kind: DiscoveryKind | null): SupportCategory | null {
  if (
    kind === 'cash_benefit' ||
    kind === 'fee_reduction' ||
    kind === 'loan' ||
    kind === 'tax'
  ) {
    return kind
  }
  return null
}

/** 調査タスクの地域 ID から管轄区分を導く（nation / tokyo / 23区 / その他） */
export function levelOfRegionId(regionId: string): SupportLevel {
  if (regionId === 'nation') return 'national'
  if (regionId === 'tokyo') return 'tokyo'
  if (/^[a-z]+-ku$/.test(regionId)) return 'ward'
  return 'municipal'
}

/**
 * 候補の地域情報から対象地域（jurisdiction）を組み立てる。
 * - regionScope（確認済みの対象地域の記述）は scopeNote に保持し、
 *   確認できた場合のみ confidence を 'confirmed' にする
 * - 調査タスクの地域から推測できる範囲（国・都・23区）のみ prefecture/ward に
 *   設定し、それ以外は推測しない（coverage 'unknown'）
 */
export function jurisdictionOfCandidate(
  candidate: DiscoveryCandidate,
  regionVerified: boolean,
): Jurisdiction {
  const scopeNote = candidate.regionScope ?? null
  const confidence: 'confirmed' | 'unconfirmed' = regionVerified ? 'confirmed' : 'unconfirmed'
  const regionId = candidate.regionId
  if (regionId === 'nation') {
    return { coverage: 'nationwide', prefecture: null, municipality: null, ward: null, scopeNote, confidence }
  }
  if (regionId === 'tokyo') {
    return {
      coverage: 'prefecture',
      prefecture: '東京都',
      municipality: null,
      ward: null,
      scopeNote,
      confidence,
    }
  }
  const m = /^([a-z]+)-ku$/.exec(regionId)
  const wardCode = m?.[1] ?? null
  if (wardCode !== null && (TOKYO_WARD_CODES as readonly string[]).includes(wardCode)) {
    return {
      coverage: 'ward',
      prefecture: '東京都',
      municipality: null,
      ward: wardCode as TokyoWardCode,
      scopeNote,
      confidence,
    }
  }
  return {
    coverage: 'unknown',
    prefecture: null,
    municipality: null,
    ward: null,
    scopeNote: scopeNote ?? '対象地域は未整理（要確認）',
    confidence: 'unconfirmed',
  }
}

// ── 変換（候補 → SupportProgram。変換だけでは公開しない） ─────────

export type ConvertOptions = {
  /** 公開先の制度 ID */
  programId: string
  /** 承認日（YYYY-MM-DD。出典の確認日・検証日として記録する） */
  approvedAt: string
  /** 承認者（検証メモに記録する） */
  approvedBy: string
  /**
   * 現行の本文ハッシュに対する有効な確認記録（呼び出し側で評価済みのもの）。
   * verification.verifiedFields と未確認項目の整理に使う。
   */
  verifications: readonly FieldVerification[]
}

export type ConvertResult =
  | { ok: true; program: SupportProgram }
  | { ok: false; problems: string[] }

/**
 * 制度候補を公開用 SupportProgram に変換する（純関数）。
 *
 * - 正規化は normalizeResearchCandidate（research.ts）を再利用する。
 *   受給資格は常に 'unconfirmed'、根拠なしの確定をしない。
 * - 人手確認済みの重要項目は確認済みとして整理し、「（記載なし）」で確認した
 *   項目は missingInformation（確認済みの不足情報）に移す。
 * - 未確認のまま残る重要項目があれば変換結果に残し、公開ゲートで拒否する。
 */
export function convertCandidateToProgram(
  candidate: DiscoveryCandidate,
  options: ConvertOptions,
): ConvertResult {
  const problems: string[] = []
  // 確認者が AI エージェントの場合、「人間が確認済み」とは記録しない（M7-G）
  const actorIsAgent = /AI|エージェント/i.test(options.approvedBy)
  const category = categoryOfKind(candidate.kind)
  if (category === null) {
    problems.push(
      `支援種別が明確でありません（kind: ${candidate.kind ?? '未設定'}。給付・減免・貸付・税のいずれかが必要です）`,
    )
  }
  if (candidate.name.trim() === '') problems.push('制度名がありません')
  if (candidate.sourceUrl.trim() === '') {
    problems.push('根拠となる公式 URL が記録されていません')
  }
  if (problems.length > 0) return { ok: false, problems }

  const researchCandidate: ResearchCandidate = {
    name: candidate.name,
    summary: candidate.summary,
    category,
    level: levelOfRegionId(candidate.regionId),
    amount: {
      value: candidate.amount.value,
      unit: candidate.amount.unit ?? null,
      claimedBasis: candidate.amount.value !== null ? 'confirmed' : 'unknown',
      description: candidate.amount.description,
    },
    period: { startAgeYears: null, endAgeYears: null, durationMonths: null },
    conditions: {
      combinedWith: [],
      incomeLimitNote: candidate.eligibility.incomeNote,
      householdNote: candidate.eligibility.householdNote,
      other: [
        ...(candidate.eligibility.ageNote !== null
          ? [`対象年齢: ${candidate.eligibility.ageNote}`]
          : []),
        ...candidate.eligibility.other,
      ],
    },
    application: {
      where: null,
      documents: candidate.application.documents,
      deadlineNote: candidate.application.deadlineNote,
      steps: candidate.application.how !== null ? [candidate.application.how] : [],
    },
    legalBasis: {},
    sources: [
      {
        title: candidate.name,
        organization: candidate.implementer ?? '（実施主体は未確認）',
        url: candidate.sourceUrl,
        // 公式 URL・実在は人手の承認操作（検証レイヤ）でのみ確定扱いにする
        urlVerified: true,
        official: true,
        checkedAt: options.approvedAt,
        retrievedAt: candidate.retrievedAt,
        verificationNote: `M7-E フローで承認・照合（確認者: ${options.approvedBy}${actorIsAgent ? '・人手確認は未実施' : ''}）。根拠抜粋と本文ハッシュを照合済み`,
      },
    ],
    checkedAt: options.approvedAt,
    missingInformation: [],
    mock: false,
  }
  const normalized = normalizeResearchCandidate(researchCandidate, {
    trustVerification: true,
    programId: options.programId,
    extractionMethod: 'ai-extraction',
  })
  if (normalized.program === null) {
    return { ok: false, problems: normalized.problems }
  }
  const base = normalized.program

  // 人手確認済みの項目は確認済みとして整理し、「（記載なし）」は不足情報へ
  // （normalizeResearchCandidate の未確認項目と、候補側の未確認項目の両方を整理する）
  const unconfirmedItems: UnconfirmedItem[] = []
  const missingInformation: string[] = [...base.missingInformation]
  const normalizeFamily = (field: string): CriticalFieldFamily | null =>
    field === 'period' ? 'eligibility.age' : familyOfField(field)
  for (const item of [...(base.unconfirmedItems ?? []), ...candidate.unconfirmedItems]) {
    const family = normalizeFamily(item.field)
    const verification =
      family === null
        ? null
        : options.verifications.find((v) => familyOfField(v.field) === family) ?? null
    if (family === null || verification === null) {
      if (!unconfirmedItems.some((e) => e.field === item.field && e.reason === item.reason)) {
        unconfirmedItems.push(item)
      }
      continue
    }
    if (verification.value === VERIFICATION_ABSENT_VALUE) {
      missingInformation.push(
        `${CRITICAL_FIELD_LABELS[family]}: 公式ページに記載なし（${verification.reviewedAt.slice(0, 10)} に ${options.approvedBy} が照合${actorIsAgent ? '。人手確認は未実施' : ''}）`,
      )
      continue
    }
    // 確認済み（値は本文と照合済み）。未確認としては残さない
  }

  const regionVerified = options.verifications.some(
    (v) => familyOfField(v.field) === 'regionScope',
  )
  const fiscalVerified = options.verifications.some(
    (v) => familyOfField(v.field) === 'fiscalYear',
  )
  const program: SupportProgram = {
    ...base,
    amount: {
      ...base.amount,
      // 適用年度は人手確認済みの場合のみ。確認できなければ null（跨ぎの混同を防ぐ）
      fiscalYear: fiscalVerified ? candidate.fiscalYear : null,
    },
    unconfirmedItems,
    missingInformation: [...new Set(missingInformation)],
    jurisdiction: jurisdictionOfCandidate(candidate, regionVerified),
    verification: {
      status: 'partial',
      verifiedAt: options.approvedAt,
      verifiedFields: [...new Set(options.verifications.map((v) => v.field))],
      note: `M7-E フローで承認・照合（確認者: ${options.approvedBy}${actorIsAgent ? '・人手確認は未実施' : ''}）。候補 ${candidate.candidateId} の根拠抜粋と本文ハッシュを照合`,
      confirmedBy: options.approvedBy,
      // 人手確認済みと表示してよいのは、確認者が人間として記録されている場合のみ（M7-G）
      humanConfirmed: !actorIsAgent,
    },
  }
  const validated = supportProgramSchema.safeParse(program)
  if (!validated.success) {
    return {
      ok: false,
      problems: [
        '変換後のデータが SupportProgram スキーマに適合しません',
        ...validated.error.issues.map(
          (i) => `${i.path.map(String).join('.') || '(top)'}: ${i.message}`,
        ),
      ],
    }
  }
  return { ok: true, program: validated.data }
}

// ── 公開ゲート（公開前の検証。不備は具体的に報告して拒否する） ─────

export type GateCheck = {
  /** 検査項目名 */
  name: string
  ok: boolean
  /** 不合格時の具体的な内容 */
  detail: string | null
}

export type PublishGateInput = {
  /** 根拠照合に使う取得済みページ本文 */
  page: { text: string; contentHash: string } | null
  /** 公開先の既存制度データ */
  existingPrograms: readonly SupportProgram[]
  mode: PublishMode
  /** update 時の更新対象制度 ID（new 時は null） */
  updateProgramId: string | null
  /** 後継制度へ切り替える旧制度 ID（追跡用） */
  supersedesProgramIds: readonly string[]
  approvedBy: string
  approvedAt: string
}

export type PublishGateResult = {
  ok: boolean
  checks: GateCheck[]
  /** 不合格項目の具体的な内容 */
  failures: string[]
  /** 変換済みの公開用データ（不合格の場合は null） */
  program: SupportProgram | null
  /** 重複・競合とみなした既存制度 ID */
  conflictingProgramId: string | null
  /** 公開で採用した確認済み項目 */
  verifiedFields: string[]
}

/** 制度名の比較用正規化（空白の有無を同一視。dedupeKey と同じ方針） */
function normalizeProgramName(name: string): string {
  return name.replace(/\s+/g, '')
}

/**
 * 公開前の検証（純関数）。少なくとも以下を検証する:
 * - 承認済み・未公開であること（変換しただけで公開しない）
 * - SupportProgram スキーマに適合する（変換で検証）
 * - 制度 ID が一意である
 * - 公式 URL と情報源が記録されている
 * - 制度の適用年度が適切に扱われている（確認済みのみ反映）
 * - 根拠が必要な重要項目に未確認情報が残っていない（人手確認必須）
 * - 給付・減免・貸付の区分が明確である
 * - 重複制度や年度違いの誤統合がない
 * - 未確認項目や検証状態が不適切に格上げされていない
 * 条件を満たさない場合は公開を拒否し、不足項目を failures で報告する。
 */
export function evaluatePublishGate(
  candidate: DiscoveryCandidate,
  input: PublishGateInput,
): PublishGateResult {
  const checks: GateCheck[] = []
  const add = (name: string, ok: boolean, detail: string | null = null): void => {
    checks.push({ name, ok, detail })
  }

  // 1. 承認状態（AI 抽出・変換だけでは公開できない）
  add(
    '公開承認済みであること',
    candidate.status === 'approved',
    candidate.status === 'approved'
      ? null
      : `候補の状態が「${candidate.status}」です。approve による公開承認が必要です`,
  )
  add(
    '未公開であること（重複公開の防止）',
    candidate.publication === undefined,
    candidate.publication === undefined
      ? null
      : `すでに公開済みです（${candidate.publication.programId} / ${candidate.publication.publishedAt}）`,
  )

  // 2. 本文ハッシュ（抽出時と異なる場合は過去の確認を引き継がない）
  const hashOk = input.page !== null && input.page.contentHash === candidate.contentHash
  add(
    '本文ハッシュが抽出時と一致すること',
    hashOk,
    hashOk ? null : '本文ハッシュが抽出時から変更されています（根拠の再確認が必要です）',
  )

  // 3. 重要項目の根拠確認（人手確認。AI の自己申告は不可）
  const page = input.page
  const evidenceGate = evaluateEvidenceGate(candidate, page)
  const validVerifications = (candidate.fieldVerifications ?? []).filter((v) => {
    if (page === null || v.contentHash !== page.contentHash) return false
    return (
      fieldVerificationError({
        field: v.field,
        value: v.value,
        evidenceQuote: v.evidenceQuote,
        candidate,
        pageText: page.text,
      }) === null
    )
  })
  add(
    '重要項目の根拠が人手で確認済みであること',
    evidenceGate.ok,
    evidenceGate.ok ? null : evidenceGate.failures.join(' / '),
  )

  // 4. 給付・減免・貸付の区分
  const category = categoryOfKind(candidate.kind)
  add(
    '支援種別が明確であること',
    category !== null,
    category !== null ? null : `支援種別が不明確です（kind: ${candidate.kind ?? '未設定'}）`,
  )

  // 5. 変換と SupportProgram スキーマ
  const programId =
    input.mode === 'update' ? (input.updateProgramId ?? '') : candidateProgramId(candidate)
  const converted =
    category === null || programId === ''
      ? { ok: false as const, problems: ['変換の前提を満たしていません'] }
      : convertCandidateToProgram(candidate, {
          programId,
          approvedAt: input.approvedAt,
          approvedBy: input.approvedBy,
          verifications: validVerifications,
        })
  add(
    'SupportProgram スキーマに適合すること',
    converted.ok,
    converted.ok ? null : converted.problems.join(' / '),
  )
  const program = converted.ok ? converted.program : null

  // 6. 制度 ID の一意性
  const idTaken = input.existingPrograms.some((p) => p.id === programId)
  let idOk: boolean
  let idDetail: string | null
  if (input.mode === 'new') {
    idOk = programId !== '' && !idTaken && input.updateProgramId === null
    idDetail = idOk
      ? null
      : idTaken
        ? `制度 ID「${programId}」は既に存在します（既存制度の更新は --update ${programId} を明示してください）`
        : '制度 ID を確定できません'
  } else {
    const targetExists = input.updateProgramId !== null && idTaken
    idOk = targetExists && programId === input.updateProgramId
    idDetail = idOk
      ? null
      : `更新対象の制度 ID「${input.updateProgramId ?? '（未指定）'}」が公開先に存在しません`
  }
  add('制度 ID が一意であること', idOk, idDetail)

  // 7. 公式 URL と情報源
  const sourceOk =
    program !== null &&
    program.sources.length > 0 &&
    program.sources.some(isOfficialLink) &&
    candidate.sourceUrl.trim() !== ''
  add(
    '公式 URL と情報源が記録されていること',
    sourceOk,
    sourceOk ? null : '根拠となる公式 URL・出典レコードが不足しています',
  )

  // 8. 適用年度の扱い（確認済みの年度のみ反映。跨ぎの混同を防ぐ）
  const fiscalVerified = validVerifications.some(
    (v) => familyOfField(v.field) === 'fiscalYear',
  )
  const fiscalOk = candidate.fiscalYear === null || fiscalVerified
  add(
    '適用年度が適切に扱われていること',
    fiscalOk,
    fiscalOk
      ? null
      : `適用年度「${candidate.fiscalYear}」が人手確認されていません（年度を跨いだ混同を防ぐため確認が必要です）`,
  )

  // 9. 重複制度・年度違いの誤統合の防止
  let conflictingProgramId: string | null = null
  const sameName = input.existingPrograms.filter(
    (p) =>
      normalizeProgramName(p.name) === normalizeProgramName(candidate.name) &&
      !(input.mode === 'update' && p.id === input.updateProgramId),
  )
  const conflicts = sameName.filter((p) => {
    const existingYear = p.amount.fiscalYear ?? null
    if (existingYear !== null && candidate.fiscalYear !== null) {
      return existingYear === candidate.fiscalYear // 同年度なら重複。年度違いは別制度
    }
    return true // 年度が確認できない側がある場合は重複の可能性として検出
  })
  const duplicateOk = conflicts.length === 0
  if (!duplicateOk) conflictingProgramId = conflicts[0]?.id ?? null
  add(
    '重複制度・年度違いの誤統合がないこと',
    duplicateOk,
    duplicateOk
      ? sameName.length > 0
        ? `同名の既存制度（${sameName.map((p) => p.id).join(', ')}）は適用年度が異なるため別制度として登録します`
        : null
      : `既存制度 ${conflicts.map((p) => `${p.id}「${p.name}」`).join(', ')} と重複の可能性があります（--update <制度ID> で明示的に更新するか、内容を確認してください）`,
  )

  // 10. 未確認項目・検証状態の不適切な格上げがないこと
  const verifiedFieldSet = new Set(validVerifications.map((v) => v.field))
  const amountVerified = validVerifications.some(
    (v) => familyOfField(v.field) === 'amount',
  )
  const elevationOk =
    program !== null &&
    program.eligibility === 'unconfirmed' &&
    program.verification !== undefined &&
    program.verification.status !== 'official-verified' &&
    program.verification.verifiedFields.every((f) => verifiedFieldSet.has(f)) &&
    (program.amount.basis !== 'confirmed' || amountVerified)
  add(
    '未確認項目・検証状態が不適切に格上げされていないこと',
    elevationOk,
    elevationOk ? null : '検証状態の記録と人手確認の内容が一致しません',
  )

  // 11. 旧制度からの切替の追跡情報（指定があれば実在すること）
  const supersedesOk = input.supersedesProgramIds.every((id) =>
    input.existingPrograms.some((p) => p.id === id),
  )
  add(
    '旧制度の切替先が追跡できること',
    supersedesOk,
    supersedesOk
      ? null
      : `--supersedes で指定された制度 ID（${input.supersedesProgramIds
          .filter((id) => !input.existingPrograms.some((p) => p.id === id))
          .join(', ')}）が公開先に存在しません`,
  )

  const failures = checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail ?? '条件を満たしていません'}`)
  return {
    ok: failures.length === 0 && program !== null,
    checks,
    failures,
    program: failures.length === 0 ? program : null,
    conflictingProgramId,
    verifiedFields: [...verifiedFieldSet],
  }
}

// ── 既存制度の更新と保存 ───────────────────────────────────────

/**
 * 既存制度の更新（純関数）。
 * - 既存の制度 ID・確認済みの根拠（sources・verification.verifiedFields）・
 *   適用年度（amount.fiscalYear）・適用期間（effectiveFrom/effectiveTo）を
 *   無視して上書きしない（新しい確認は追記・統合する）
 * - 未確認項目・不足情報は双方の記録を残す
 */
export function mergeProgramUpdate(
  existing: SupportProgram,
  incoming: SupportProgram,
): SupportProgram {
  const verifiedFields = [
    ...new Set([
      ...(existing.verification?.verifiedFields ?? []),
      ...(incoming.verification?.verifiedFields ?? []),
    ]),
  ]
  const sources = [...existing.sources]
  for (const s of incoming.sources) {
    const dup = sources.some(
      (e) => e.title === s.title && e.organization === s.organization && e.url === s.url,
    )
    if (!dup) sources.push(s)
  }
  const missingInformation = [
    ...new Set([...existing.missingInformation, ...incoming.missingInformation]),
  ]
  const unconfirmedItems = [...(existing.unconfirmedItems ?? [])]
  for (const item of incoming.unconfirmedItems ?? []) {
    if (!unconfirmedItems.some((e) => e.field === item.field && e.reason === item.reason)) {
      unconfirmedItems.push(item)
    }
  }
  return {
    ...incoming,
    id: existing.id,
    sources,
    missingInformation,
    unconfirmedItems,
    amount: {
      ...incoming.amount,
      // 既存の適用年度を無視して上書きしない
      fiscalYear: incoming.amount.fiscalYear ?? existing.amount.fiscalYear ?? null,
    },
    // 既存の適用期間を無視して上書きしない
    effectiveFrom: existing.effectiveFrom ?? incoming.effectiveFrom,
    effectiveTo: existing.effectiveTo ?? incoming.effectiveTo,
    checkedAt: incoming.checkedAt > existing.checkedAt ? incoming.checkedAt : existing.checkedAt,
    verification: {
      status: 'partial',
      verifiedAt: incoming.verification?.verifiedAt ?? existing.verification?.verifiedAt ?? null,
      verifiedFields,
      note: incoming.verification?.note ?? existing.verification?.note ?? null,
    },
  }
}

/**
 * 公開後の制度一覧を組み立てる（純関数）。
 * - new: 末尾に追加（既存制度は変更しない）
 * - update: 指定 ID の制度を mergeProgramUpdate で更新（他は変更しない）
 */
export function buildPublishedPrograms(
  existing: readonly SupportProgram[],
  program: SupportProgram,
  mode: PublishMode,
): SupportProgram[] {
  if (mode === 'new') return [...existing, program]
  return existing.map((p) => (p.id === program.id ? mergeProgramUpdate(p, program) : p))
}

/** 公開先ファイル（data/programs/programs.json）のシリアライズ */
export function serializeProgramsFile(programs: readonly SupportProgram[]): string {
  return `${JSON.stringify({ formatVersion: 1, programs }, null, 2)}\n`
}