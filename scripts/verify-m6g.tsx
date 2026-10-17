/**
 * M6-G（相談画面 × 公式情報KB の接続・P1）の検証スクリプト
 *
 * 実行: npx tsx scripts/verify-m6g.tsx
 *
 * 確認項目:
 * 1. 制度 ID による解決
 * 2. 質問文内の制度名完全一致による解決
 * 3. 部分一致・無関係な制度名・KB 未収録制度を誤って追加しないこと
 * 4. 確認済み情報・未確認項目・出典・確認日の適切な分離
 * 5. 未検証 URL がリンク可・確認済み扱いにならないこと（公式クライアントと判定一致）
 * 6. eligibility（受給資格）が確認済みにならないこと
 * 7. 給付・減免・貸与の区別と、amountBands が計算へ流れないこと
 * 8. AI 由来の関連制度名・URL・金額を根拠として採用しないこと
 * 9. 外部通信が発生しないこと（globalThis.fetch をガードして 0 回であることを確認）
 * 10. API 経由（handleConsultRequest）で出典・確認状態が決定論的に付与され、
 *     KB にない制度・未確認情報・未検証 URL・AI 由来の情報を出典として
 *     採用しないこと（P2: モック相談APIへのKB接続）
 *
 * 通常テストはすべて同一プロセス内の呼び出しのみで行い、外部ネットワークへ
 * 一切接続しない。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KB_AMOUNT_CALCULATION_POLICY,
  buildKbAiContext,
  buildKnowledgeBase,
  type KbProgramEntry,
} from '../lib/supports/kb'
import { getSupportPrograms } from '../lib/supports/registry'
import { createKbOfficialSourceClient } from '../lib/consult/officialSource'
import {
  enrichReplyWithKb,
  resolveKbConsultContext,
  type KbConsultContext,
  type KbFactCard,
} from '../lib/consult/kbContext'
import {
  handleConsultRequest,
  type ConsultApiDeps,
} from '../lib/consult/api'
import { mockConsultProvider } from '../lib/consult/mockAdvisor'
import { MemoryRateLimiter } from '../lib/consult/rateLimit'
import { ConsultSendError } from '../lib/consult/errors'
import type {
  ConsultCitation,
  ConsultContextProgram,
  ConsultProvider,
  ConsultReply,
} from '../lib/consult/types'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(
    `  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`,
  )
  if (!cond) failed += 1
}

// ── 外部通信ガード（検証中の外部通信が 0 回であることを最後に確認する） ──
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown) => {
  fetchCalls.push(String(input))
  return Promise.reject(new Error('外部通信を検知しました（テスト中は禁止）'))
}) as typeof fetch

async function main(): Promise<void> {
  const kb = buildKnowledgeBase()
  const allowanceEntry = kb.find((e) => e.programId === 'mock-child-allowance')
  if (allowanceEntry === undefined) throw new Error('児童手当が KB にありません')
  const coreAllowance = allowanceEntry.name.replace(/（[^）]*）/g, '')
  const highSchoolEntry = kb.find(
    (e) => e.programId === 'mock-high-school-scholarship',
  )
  const coreHighSchool =
    highSchoolEntry === undefined
      ? ''
      : highSchoolEntry.name.replace(/（[^）]*）/g, '')

  // ── 1. 制度 ID による解決 ──
  console.log('── 1. 制度 ID による解決 ──')
  {
    const ctx = resolveKbConsultContext({ programId: 'mock-child-allowance' })
    check(
      '制度 ID で対象制度を解決できる',
      ctx.cards.length === 1 &&
        ctx.cards[0].programId === 'mock-child-allowance',
    )
    check('KB の制度名をそのまま持つ', ctx.cards[0].name === allowanceEntry.name)
    check('区分（給付）を保持する', ctx.cards[0].category === 'cash_benefit')
    check(
      '確認日は YYYY-MM-DD か null（推測で埋めない）',
      ctx.cards[0].checkedAt === null ||
        /^\d{4}-\d{2}-\d{2}$/.test(ctx.cards[0].checkedAt),
    )
    check(
      '金額計算の既存方針を引き継ぐ',
      ctx.amountCalculationPolicy === KB_AMOUNT_CALCULATION_POLICY,
    )
  }

  // ── 2. 質問文内の制度名完全一致による解決 ──
  console.log('── 2. 質問文内の制度名完全一致による解決 ──')
  {
    const ctx = resolveKbConsultContext({
      message: `${coreAllowance}の支給額について教えてください`,
    })
    check(
      '質問文の制度名（中核名の完全一致）で解決できる',
      ctx.cards.some((c) => c.programId === 'mock-child-allowance'),
    )
    const both = resolveKbConsultContext({
      programId: 'mock-child-allowance',
      message: `${coreAllowance}について`,
    })
    check(
      '制度 ID と質問文が同一制度なら重複させない',
      both.cards.length === 1,
    )
  }

  // ── 3. 部分一致・無関係・KB 未収録を誤って追加しない ──
  console.log('── 3. 誤マッチ防止 ──')
  {
    const partial = resolveKbConsultContext({
      message: `${coreAllowance.slice(0, Math.max(coreAllowance.length - 1, 1))}について`,
    })
    check('制度名の部分一致では追加しない', partial.cards.length === 0)
    const unrelated = resolveKbConsultContext({
      message: 'ばらすとスクールの利用を検討しています',
    })
    check('無関係な制度名では追加しない', unrelated.cards.length === 0)
    const unknown = resolveKbConsultContext({
      programId: 'not-a-kb-program',
    })
    check('KB 未収録の制度 ID では追加しない', unknown.cards.length === 0)
    const registryOnly = getSupportPrograms().find(
      (p) => !kb.some((e) => e.programId === p.id),
    )
    if (registryOnly !== undefined) {
      const r = resolveKbConsultContext({
        programId: registryOnly.id,
        message: `${registryOnly.name}について`,
      })
      check('KB 未収録のレジストリ制度は追加しない', r.cards.length === 0)
    } else {
      check(
        'KB 未収録のレジストリ制度は追加しない（現状は全制度が KB 収録済み）',
        true,
      )
    }
    if (coreHighSchool.length > 0) {
      const onlyOne = resolveKbConsultContext({
        message: `${coreHighSchool}について`,
      })
      check(
        '無関係な制度をまとめて追加しない',
        onlyOne.cards.length === 1 &&
          onlyOne.cards.every(
            (c) => c.programId === 'mock-high-school-scholarship',
          ),
      )
    }
  }
  // ── 4. 確認済み情報・未確認項目・出典・確認日の分離 ──
  console.log('── 4. 確認済み/未確認/出典/確認日の分離 ──')
  for (const entry of kb) {
    const ctx = resolveKbConsultContext({ programId: entry.programId }, kb)
    const card = ctx.cards[0]
    check(`(${entry.programId}) 対象は 1 制度のみ`, ctx.cards.length === 1)
    const ai = buildKbAiContext([entry])
    check(
      `(${entry.programId}) 事実は buildKbAiContext の分離結果と一致（既存整形の再利用）`,
      JSON.stringify(card.confirmedFacts) ===
        JSON.stringify(ai.confirmedFacts) &&
        JSON.stringify(card.unconfirmedNotes) ===
          JSON.stringify(ai.unconfirmedNotes),
    )
    let separated = true
    for (const f of entry.fields) {
      const confirmedLine = card.confirmedFacts.find((l) =>
        l.startsWith(`・${entry.name}｜${f.label}:`),
      )
      const unconfirmedLine = card.unconfirmedNotes.find((l) =>
        l.startsWith(`・${entry.name}｜${f.label}:`),
      )
      if (f.confidence === 'confirmed' && f.value !== null) {
        if (confirmedLine === undefined || unconfirmedLine !== undefined) {
          separated = false
        }
      } else if (confirmedLine !== undefined || unconfirmedLine === undefined) {
        separated = false
      }
    }
    check(
      `(${entry.programId}) 確認済みと未確認が項目単位で分離されている`,
      separated,
    )
    check(
      `(${entry.programId}) 確認済み事実にはすべて出典が付く`,
      card.confirmedFacts.every((l) => l.includes('［出典:')),
    )
    check(
      `(${entry.programId}) 未確認は公式情報が無い旨として分離される`,
      card.unconfirmedNotes.every((l) =>
        l.includes('確認できる公式情報がありません'),
      ),
    )
    check(
      `(${entry.programId}) 未確認項目の一覧と理由を保持する`,
      card.unconfirmedItems.length > 0 &&
        card.unconfirmedItems.every(
          (u) => u.field.length > 0 && u.reason.length > 0,
        ),
    )
    check(
      `(${entry.programId}) 確認日は YYYY-MM-DD か null（確認記録を失わない）`,
      (card.checkedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(card.checkedAt)) &&
        card.citations.every(
          (c) => c.checkedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(c.checkedAt),
        ),
    )
    check(
      `(${entry.programId}) 出典は provenance 付き（転記と実績を混同しない）`,
      card.citations.every(
        (c) => c.provenance !== undefined && c.reviewOutdated !== undefined,
      ),
    )
  }
  // ── 5. 未検証 URL がリンク可・確認済み扱いにならない ──
  console.log('── 5. URL 検証状態の引き継ぎ ──')
  {
    const base = kb.find((e) => e.programId === 'mock-child-medical-aid')
    if (base !== undefined) {
      const URL_REACHABLE = 'https://www.city.example.lg.jp/kosodate/iryou'
      const URL_REVIEWED = 'https://www.city.example.lg.jp/kosodate/jidoku'
      const URL_OUTDATED = 'https://www.city.example.lg.jp/kosodate/konnan'
      const URL_NO_CONTENT = 'https://www.city.example.lg.jp/kosodate/other'
      const synthetic: KbProgramEntry = {
        ...base,
        sources: [
          {
            sourceId: 'src-m6g-reachable',
            title: '到達のみの区ページ',
            url: URL_REACHABLE,
            organization: '仮の自治体',
            urlState: 'reachable',
            contentState: 'needs-review',
            retrievedAt: '2026-01-13T10:00:00+09:00',
            reviewedAt: null,
            reviewedFields: [],
            lastFetchResult: 'ok',
            reviewOutdated: false,
            provenance: {
              registered: 'user-registered',
              retrieval: 'fetch-run',
              review: null,
            },
            excerpt: '抜粋',
          },
          {
            sourceId: 'src-m6g-reviewed',
            title: '人手照合済みの区ページ',
            url: URL_REVIEWED,
            organization: '仮の自治体',
            urlState: 'official-confirmed',
            contentState: 'reviewed',
            retrievedAt: '2026-01-13T10:00:00+09:00',
            reviewedAt: '2026-01-14',
            reviewedFields: ['period'],
            lastFetchResult: 'ok',
            reviewOutdated: false,
            provenance: {
              registered: 'user-registered',
              retrieval: 'fetch-run',
              review: 'manual-review',
            },
            excerpt: '抜粋',
          },
          {
            sourceId: 'src-m6g-outdated',
            title: '照合が古い区ページ',
            url: URL_OUTDATED,
            organization: '仮の自治体',
            urlState: 'official-confirmed',
            contentState: 'reviewed',
            retrievedAt: '2026-01-20T10:00:00+09:00',
            reviewedAt: '2026-01-14',
            reviewedFields: ['period'],
            lastFetchResult: 'ok',
            reviewOutdated: true,
            provenance: {
              registered: 'user-registered',
              retrieval: 'fetch-run',
              review: 'manual-review',
            },
            excerpt: '抜粋',
          },
          {
            sourceId: 'src-m6g-no-content',
            title: '未取得の区ページ',
            url: URL_NO_CONTENT,
            organization: '仮の自治体',
            urlState: 'candidate-registered',
            contentState: 'no-content',
            retrievedAt: null,
            reviewedAt: null,
            reviewedFields: [],
            lastFetchResult: 'timeout',
            reviewOutdated: false,
            provenance: {
              registered: 'user-registered',
              retrieval: null,
              review: null,
            },
            excerpt: null,
          },
        ],
      }
      const card = resolveKbConsultContext(
        { programId: synthetic.programId },
        [synthetic],
      ).cards[0]
      const byUrl = (u: string) => card.citations.find((c) => c.url === u)
      const reachableCitation = byUrl(URL_REACHABLE)
      const reviewedCitation = byUrl(URL_REVIEWED)
      const outdatedCitation = byUrl(URL_OUTDATED)
      const noContentCitation = byUrl(URL_NO_CONTENT)
      check(
        'URL アクセス可・内容未照合は検証済みにしない（リンク不可）',
        reachableCitation !== undefined &&
          reachableCitation.urlVerified === false,
      )
      check(
        '人手照合済みの公式 URL のみ検証済み（リンク可）',
        reviewedCitation !== undefined && reviewedCitation.urlVerified === true,
      )
      check(
        '照合が古い（reviewOutdated）URL は検証済みに昇格させない',
        outdatedCitation !== undefined &&
          outdatedCitation.urlVerified === false &&
          outdatedCitation.reviewOutdated === true,
      )
      check(
        '未取得 URL は検証済みにせず確認日も持たない',
        noContentCitation !== undefined &&
          noContentCitation.urlVerified === false &&
          noContentCitation.checkedAt === null,
      )
      // 公式クライアント（officialSource.ts）と判定が一致すること（回帰で昇格を防ぐ）
      const client = createKbOfficialSourceClient([synthetic])
      for (const u of [URL_REACHABLE, URL_REVIEWED, URL_OUTDATED]) {
        const outcome = await client.fetchSource(u)
        const citation = byUrl(u)
        check(
          `(${u}) urlVerified が公式クライアントと一致`,
          outcome.ok &&
            citation !== undefined &&
            outcome.record.urlVerified === citation.urlVerified,
          outcome.ok ? '' : outcome.reason,
        )
      }
    }
    // 実 KB の全出典でも公式クライアントと一致する
    for (const entry of kb) {
      const client = createKbOfficialSourceClient([entry])
      const card = resolveKbConsultContext({ programId: entry.programId }, kb)
        .cards[0]
      for (const c of card.citations) {
        if (c.url === null) continue
        const outcome = await client.fetchSource(c.url)
        if (outcome.ok) {
          check(
            `(${c.url}) urlVerified が公式クライアントと一致`,
            outcome.record.urlVerified === c.urlVerified,
          )
        } else {
          check(`(${c.url}) 未検証 URL を検証済みにしない`, c.urlVerified === false)
        }
      }
    }
  }
  // ── 6. eligibility が確認済みにならない ──
  console.log('── 6. 受給資格（eligibility）の扱い ──')
  for (const entry of kb) {
    const card = resolveKbConsultContext({ programId: entry.programId }, kb)
      .cards[0]
    check(
      `(${entry.programId}) eligibility は常に未確認のまま扱う`,
      entry.fields.find((f) => f.field === 'eligibility')?.confidence ===
        'unconfirmed' &&
        card.unconfirmedItems.some((u) => u.field === 'eligibility'),
    )
    check(
      `(${entry.programId}) 受給可能性が確認済み事実に混入しない`,
      card.confirmedFacts.every(
        (l) => !l.includes('受給可能性（判定は常に未確認）'),
      ),
    )
    check(
      `(${entry.programId}) 受給資格を自動判定しない（確認済み状態にしない）`,
      !(
        card.verification === 'official-verified' &&
        card.unconfirmedItems.some((u) => u.field === 'eligibility')
      ),
    )
  }

  // ── 7. 給付・減免・貸与の区別と、amountBands の扱い ──
  console.log('── 7. 区分の保持と amountBands ──')
  {
    const allowanceCtx = resolveKbConsultContext({
      programId: 'mock-child-allowance',
    })
    const allowanceCard = allowanceCtx.cards[0]
    check(
      '児童手当は給付（cash_benefit）のまま保持する',
      allowanceCard.category === 'cash_benefit',
    )
    const loanCard = resolveKbConsultContext({
      programId: 'mock-education-loan',
    }).cards[0]
    check(
      '教育一般貸付は貸与（loan）のまま保持する',
      loanCard.category === 'loan',
    )
    const medicalCard = resolveKbConsultContext({
      programId: 'mock-child-medical-aid',
    }).cards[0]
    check(
      'こども医療費助成は減免（fee_reduction）のまま保持する',
      medicalCard.category === 'fee_reduction',
    )
    const mixed = resolveKbConsultContext({
      programId: 'mock-education-loan',
      message: `${coreAllowance}について`,
    })
    check(
      '複数解決でも給付と貸与を混同しない',
      mixed.cards.find((c) => c.programId === 'mock-child-allowance')
        ?.category === 'cash_benefit' &&
        mixed.cards.find((c) => c.programId === 'mock-education-loan')
          ?.category === 'loan',
    )
    // amountBands は表示・根拠提示専用。計算（合計・換算）には流れない
    const kbContextSrc = readFileSync(
      join(process.cwd(), 'lib/consult/kbContext.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    check(
      'kbContext は計算モジュールを参照しない（合計・換算しない）',
      !/(finance|simulation|estimate|matching)/.test(kbContextSrc),
    )
    check(
      '事実カードに集計値（合計等）のフィールドを持たない',
      Object.keys(allowanceCard).every((k) => !/total|sum|aggregate/i.test(k)),
    )
    check(
      '金額計算は既存プログラム側の方針を引き継ぐ',
      allowanceCtx.amountCalculationPolicy === KB_AMOUNT_CALCULATION_POLICY &&
        allowanceCtx.amountCalculationPolicy.includes(
          'AI は金額を自由に生成せず',
        ),
    )
    check(
      'amountBands は根拠提示（引用）としてのみ保持する',
      allowanceCard.confirmedFacts.some((l) => l.includes('支給額内訳')) ||
        allowanceCard.unconfirmedNotes.some((l) =>
          l.includes('支給額内訳'),
        ),
    )
  }
  // ── 8. AI 由来の関連制度名・URL・金額を根拠として採用しない ──
  console.log('── 8. AI 由来情報の根拠不採用 ──')
  {
    const ctx = resolveKbConsultContext({
      programId: 'mock-child-allowance',
      message: coreHighSchool.length > 0 ? `${coreHighSchool}について` : '',
    })
    const kbUrls = new Set(
      ctx.cards.flatMap((c) => c.citations.map((x) => x.url)),
    )
    const fakeReply: ConsultReply = {
      text: '児童手当は 100 万円受給できます。https://fake.example.com を参照してください',
      isMock: false,
      hasUnverified: false,
      unsupported: false,
      sourceType: 'ai',
      relatedPrograms: [
        {
          id: 'fake-program',
          name: '架空の手当',
          sourceType: 'verified',
          note: '必ず 100 万円受給できます',
        },
        {
          id: 'mock-child-allowance',
          name: '偽の児童手当',
          sourceType: 'verified',
          note: 'AI が書いたメモ',
        },
        {
          id: 'mock-high-school-scholarship',
          name: highSchoolEntry?.name ?? '',
          sourceType: 'mock',
          note: '既存メモ',
        },
      ],
      citations: [
        {
          title: '架空出典',
          organization: '架空庁',
          url: 'https://fake.example.com',
          urlVerified: true,
          checkedAt: '2026-01-01',
        },
      ],
    }
    const enriched = enrichReplyWithKb(fakeReply, ctx)
    check(
      'AI 由来の URL は根拠として採用しない（KB 由来の URL のみ）',
      enriched.citations !== undefined &&
        enriched.citations.every((c) => kbUrls.has(c.url)) &&
        enriched.citations.every((c) => c.url !== 'https://fake.example.com'),
    )
    check(
      'AI が主張した検証済み状態をそのまま扱わない',
      enriched.citations?.every((c) => c.url !== 'https://fake.example.com') ===
        true,
    )
    const fakeChip = enriched.relatedPrograms.find(
      (p) => p.id === 'fake-program',
    )
    check(
      '架空の関連制度に KB の出典・確認状態を付与しない',
      fakeChip !== undefined &&
        fakeChip.sources === undefined &&
        fakeChip.verification === undefined &&
        fakeChip.category === undefined &&
        fakeChip.checkedAt === undefined,
    )
    const fakeNameChip = enriched.relatedPrograms.find(
      (p) => p.id === 'mock-child-allowance',
    )
    check(
      '名称不一致の既存エントリに本物の出典を付けない',
      fakeNameChip !== undefined &&
        fakeNameChip.sources === undefined &&
        fakeNameChip.verification === undefined,
    )
    const realChip = enriched.relatedPrograms.find(
      (p) => p.id === 'mock-high-school-scholarship',
    )
    check(
      'KB と名称一致の既存エントリに確認状態・出典を付与する（既存の note は不変）',
      realChip !== undefined &&
        realChip.sources !== undefined &&
        realChip.verification !== undefined &&
        realChip.note === '既存メモ' &&
        realChip.sourceType === 'mock',
    )
    check(
      '応答本文・既存フィールドは変更しない（付加のみ）',
      enriched.text === fakeReply.text &&
        enriched.hasUnverified === fakeReply.hasUnverified &&
        enriched.isMock === fakeReply.isMock &&
        enriched.unsupported === fakeReply.unsupported,
    )
    // KB に無い制度は新規に追加しない
    check(
      'KB に無い制度を関連制度として追加しない',
      enriched.relatedPrograms.every((p) =>
        p.id === 'fake-program'
          ? p.sources === undefined
          : kb.some((e) => e.programId === p.id),
      ),
    )
    // 追加分の関連制度は区分・確認状態・確認日・出典を持つ
    const clean = enrichReplyWithKb(
      {
        text: '制度の案内をします',
        isMock: true,
        hasUnverified: true,
        unsupported: false,
        relatedPrograms: [],
      },
      ctx,
    )
    check(
      'KB の対象制度を出典付きの関連制度として付与する',
      clean.relatedPrograms.length === ctx.cards.length &&
        clean.relatedPrograms.every((p) => (p.sources?.length ?? 0) > 0),
    )
    check(
      '付与する関連制度は区分・確認状態・確認日を持つ',
      clean.relatedPrograms.every(
        (p) =>
          p.category !== undefined &&
          p.verification !== undefined &&
          (p.checkedAt === null ||
            /^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt ?? '')),
      ),
    )
    const medicalCtx = resolveKbConsultContext({
      programId: 'mock-child-medical-aid',
    })
    const medicalChip = enrichReplyWithKb(
      {
        text: '案内',
        isMock: true,
        hasUnverified: true,
        unsupported: false,
        relatedPrograms: [],
      },
      medicalCtx,
    ).relatedPrograms[0]
    check(
      '未確認（モック）制度は mock 表示のまま付与する',
      medicalChip !== undefined &&
        medicalChip.sourceType === 'mock' &&
        medicalChip.verification === 'unverified',
    )
  }

  // ── 9. 外部通信が発生しない ──
  console.log('── 9. 外部通信ゼロ ──')
  check(
    '検証中の外部通信は 0 回（fetch 未使用）',
    fetchCalls.length === 0,
    fetchCalls.join(', '),
  )

  // ── 10. API 経由の接続（M6-G P2: handleConsultRequest と同一の経路） ──
  console.log('── 10. API 経由の接続 ──')
  const silentLogger: Pick<Console, 'warn' | 'error'> = {
    warn: () => undefined,
    error: () => undefined,
  }
  const apiRateLimiter = new MemoryRateLimiter({
    perMinute: 100,
    perDay: 1000,
    globalPerMinute: 1000,
  })
  const jsonRequest = (body: unknown): Request =>
    new Request('http://localhost/api/consult', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const coreNameFor = (programId: string): string => {
    const entry = kb.find((e) => e.programId === programId)
    return entry === undefined ? '' : entry.name.replace(/（[^）]*）/g, '')
  }
  const requestFor = (message: string): Request =>
    jsonRequest({ message, program: null, history: [] })
  const callApi = (
    request: Request,
    extra: Partial<ConsultApiDeps> = {},
  ): Promise<Response> =>
    handleConsultRequest(request, {
      resolveProvider: () => mockConsultProvider,
      rateLimiter: apiRateLimiter,
      logger: silentLogger,
      ...extra,
    })
  const allowanceMessage = `${coreAllowance}の金額はいくら？`
  const expectedAllowanceCitations = resolveKbConsultContext({
    programId: null,
    message: allowanceMessage,
  }).cards.flatMap((c) => c.citations)

  // 10-1. 正常応答（既定の KB 解決・決定論的な出典付与）
  const resOk = await callApi(requestFor(allowanceMessage))
  const bodyOk = (await resOk.json()) as ConsultReply
  check(
    'API 経由: 正常応答は 200・モック明示と安全表示を維持',
    resOk.status === 200 &&
      bodyOk.text.startsWith('【開発用モック応答】') &&
      bodyOk.isMock === true &&
      bodyOk.hasUnverified === true &&
      // sourceType は通常のモック応答では未設定（切り替え時は 'mock-fallback'）
      (bodyOk.sourceType === undefined || bodyOk.sourceType === 'mock'),
  )
  check(
    'API 経由: 出典は既存 KB の内容と一致（URL・検証状態の改変なし）',
    expectedAllowanceCitations.length > 0 &&
      JSON.stringify(bodyOk.citations ?? []) ===
        JSON.stringify(expectedAllowanceCitations),
  )
  const allowanceChip = (bodyOk.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-child-allowance',
  )
  check(
    'API 経由: 関連制度に区分・確認状態・確認日・出典が付与される',
    allowanceChip !== undefined &&
      allowanceChip.category === 'cash_benefit' &&
      allowanceChip.verification !== 'official-verified' &&
      (allowanceChip.sources?.length ?? 0) ===
        expectedAllowanceCitations.length &&
      /^\d{4}-\d{2}-\d{2}$/.test(allowanceChip.checkedAt ?? ''),
  )
  // 10-2. 未確認情報（受給資格・モック制度の取り扱い）
  const ctxProgram: ConsultContextProgram = {
    id: 'mock-child-allowance',
    name: '児童手当',
    summary: '児童手当（テスト用の相談コンテキスト）',
    amountDescription: '1か月あたりの支給額（推定）',
    where: '市区町村の窓口（要確認）',
    deadlineNote: '毎年 6 月（要確認）',
    missingInformation: ['所得制限の基準'],
    mock: true,
  }
  const resElig = await callApi(
    jsonRequest({
      message: '自分の状況で対象になりそうな支援は？',
      program: ctxProgram,
      history: [],
    }),
  )
  const bodyElig = (await resElig.json()) as ConsultReply
  const eligChip = (bodyElig.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-child-allowance',
  )
  check(
    'API 経由: 受給資格（eligibility）は未確認のまま（正式判定にしない）',
    bodyElig.text.includes('正式な受給資格の決定ではありません') &&
      bodyElig.hasUnverified === true &&
      eligChip !== undefined &&
      eligChip.verification !== 'official-verified' &&
      (eligChip.sources?.length ?? 0) > 0,
  )
  const resMedical = await callApi(
    requestFor(`${coreNameFor('mock-child-medical-aid')}の金額はいくら？`),
  )
  const bodyMedical = (await resMedical.json()) as ConsultReply
  const medicalChip = (bodyMedical.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-child-medical-aid',
  )
  check(
    'API 経由: 未確認（モック）制度は unverified・mock 表示のまま',
    bodyMedical.text.includes('未確認（モック）') &&
      bodyMedical.hasUnverified === true &&
      medicalChip !== undefined &&
      medicalChip.sourceType === 'mock' &&
      medicalChip.verification === 'unverified',
  )

  // 10-3. KB にない制度
  const resUnknown = await callApi(
    requestFor('架空の給付金について教えてください'),
  )
  const bodyUnknown = (await resUnknown.json()) as ConsultReply
  check(
    'API 経由: KB にない制度には出典・確認状態を付与しない',
    (bodyUnknown.citations ?? []).length === 0 &&
      (bodyUnknown.relatedPrograms ?? []).every(
        (p) => p.sources === undefined && p.verification === undefined,
      ) &&
      !bodyUnknown.text.includes('架空の給付金'),
  )
  // 10-4. 未検証 URL・URL なし出典の検証状態をそのまま通す
  const syntheticCard: KbFactCard = {
    programId: 'mock-child-allowance',
    name: '児童手当',
    category: 'cash_benefit',
    verification: 'partial',
    checkedAt: '2026-10-15',
    reviewOutdated: false,
    confirmedFacts: [],
    unconfirmedNotes: [],
    unconfirmedItems: [],
    citations: [
      {
        title: '確認済み出典',
        organization: 'テスト',
        url: 'https://verified.example.jp/',
        urlVerified: true,
        checkedAt: '2026-10-15',
      },
      {
        title: '未検証出典',
        organization: 'テスト',
        url: 'https://unverified.example.jp/',
        urlVerified: false,
        checkedAt: null,
      },
      {
        title: 'URL なし出典',
        organization: 'テスト',
        url: null,
        urlVerified: false,
        checkedAt: null,
      },
    ],
  }
  const resUnverified = await callApi(requestFor(allowanceMessage), {
    resolveKbContext: (): KbConsultContext => ({
      cards: [syntheticCard],
      amountCalculationPolicy: KB_AMOUNT_CALCULATION_POLICY,
    }),
  })
  const bodyUnverified = (await resUnverified.json()) as ConsultReply
  check(
    'API 経由: 未検証 URL を検証済みに昇格させない（URL・検証状態のまま）',
    JSON.stringify(
      (bodyUnverified.citations ?? []).map((c) => [
        c.url,
        c.urlVerified,
        c.checkedAt,
      ]),
    ) ===
      JSON.stringify(
        syntheticCard.citations.map((c) => [c.url, c.urlVerified, c.checkedAt]),
      ),
  )

  // 10-5. 給付・減免・貸与の区別
  const resLoan = await callApi(
    requestFor(`${coreNameFor('mock-education-loan')}の金額はいくら？`),
  )
  const bodyLoan = (await resLoan.json()) as ConsultReply
  const loanChip = (bodyLoan.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-education-loan',
  )
  check(
    'API 経由: 給付（返還不要）・減免（返還不要）・貸与（返済が必要）が区別される',
    bodyOk.text.includes('給付金（返還不要）') &&
      !bodyOk.text.includes('返済が必要') &&
      bodyMedical.text.includes('減免・助成（返還不要）') &&
      !bodyMedical.text.includes('返済が必要') &&
      bodyLoan.text.includes('貸与・貸付（返済が必要）') &&
      !bodyLoan.text.includes('返還不要') &&
      allowanceChip?.category === 'cash_benefit' &&
      medicalChip?.category === 'fee_reduction' &&
      loanChip?.category === 'loan',
  )
  // 10-6. AI 由来の情報を出典として採用しない
  const aiFakeCitation: ConsultCitation = {
    title: '架空出典',
    organization: '架空省庁',
    url: 'https://fake.example.com/aid',
    urlVerified: true,
    checkedAt: '2026-01-01',
  }
  const aiLikeProvider: ConsultProvider = {
    id: 'test-ai',
    label: 'AI回答（テスト）',
    isMock: false,
    respond: () =>
      Promise.resolve({
        text: 'AI が生成した回答です。参考: https://fake.example.com/aid',
        isMock: false,
        hasUnverified: true,
        unsupported: false,
        relatedPrograms: [
          {
            id: 'mock-child-allowance',
            name: '架空の制度名',
            sourceType: 'verified',
            note: 'AI が確認したと言った',
          },
          {
            id: 'fictional-9999',
            name: '架空手当',
            sourceType: 'verified',
            note: 'AI が捏造した制度',
          },
        ],
        citations: [aiFakeCitation],
      }),
  }
  const resAi = await callApi(requestFor(allowanceMessage), {
    resolveProvider: () => aiLikeProvider,
  })
  const bodyAi = (await resAi.json()) as ConsultReply
  const aiChip = (bodyAi.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-child-allowance',
  )
  const fakeChip = (bodyAi.relatedPrograms ?? []).find(
    (p) => p.id === 'fictional-9999',
  )
  check(
    'API 経由: AI 由来の URL・出典を citations として採用しない（KB の出典のみ）',
    JSON.stringify(bodyAi.citations ?? []) ===
      JSON.stringify(expectedAllowanceCitations),
  )
  check(
    'API 経由: 名称不一致・KB 未収録の制度に出典・確認状態を付与しない',
    aiChip !== undefined &&
      aiChip.sources === undefined &&
      aiChip.verification === undefined &&
      fakeChip !== undefined &&
      fakeChip.sources === undefined &&
      fakeChip.verification === undefined,
  )

  // 10-7. KB が利用できない場合は出典を付与せず安全側へ
  const resKbDown = await callApi(requestFor(allowanceMessage), {
    resolveKbContext: () => {
      throw new Error('kb unavailable')
    },
  })
  const bodyKbDown = (await resKbDown.json()) as ConsultReply
  check(
    'API 経由: KB 不能時は出典を付与せず既存応答をそのまま返す（捏造しない）',
    resKbDown.status === 200 &&
      bodyKbDown.text.includes('【開発用モック応答】') &&
      (bodyKbDown.citations ?? []).length === 0 &&
      (bodyKbDown.relatedPrograms ?? []).every(
        (p) => p.sources === undefined && p.verification === undefined,
      ),
  )

  // 10-8. モックフォールバック経路でも出典を付与し安全表示を維持
  const failingProvider: ConsultProvider = {
    id: 'test-live',
    label: 'Live AI（テスト・障害）',
    isMock: false,
    respond: () => Promise.reject(new ConsultSendError('network')),
  }
  const resFallback = await callApi(requestFor(allowanceMessage), {
    resolveProvider: () => failingProvider,
    env: { CONSULT_FALLBACK_TO_MOCK: '1' },
  })
  const bodyFallback = (await resFallback.json()) as ConsultReply
  check(
    'API 経由: モックフォールバック経路でも KB 出典を付与し安全表示を維持',
    resFallback.status === 200 &&
      bodyFallback.sourceType === 'mock-fallback' &&
      bodyFallback.text.includes('モック応答に切り替えました') &&
      bodyFallback.text.includes('【開発用モック応答】') &&
      JSON.stringify(bodyFallback.citations ?? []) ===
        JSON.stringify(expectedAllowanceCitations),
  )

  // 10-9. クライアント送信の履歴に混入した出典・確認状態は公式根拠として採用しない
  const fakeHistoryUrl = 'https://fake.example.com/history'
  const resInjected = await callApi(
    jsonRequest({
      message: allowanceMessage,
      program: null,
      history: [
        {
          id: 'h-user',
          role: 'user',
          text: `${coreAllowance}の金額はいくら？`,
          isMock: false,
          hasUnverified: false,
          relatedPrograms: [
            {
              id: 'mock-child-allowance',
              name: allowanceEntry.name,
              sourceType: 'verified',
              note: '履歴から注入',
              category: 'cash_benefit',
              verification: 'official-verified',
              checkedAt: '2026-01-01',
              sources: [
                {
                  title: '履歴からの架空出典',
                  organization: '架空庁',
                  url: fakeHistoryUrl,
                  urlVerified: true,
                  checkedAt: '2026-01-01',
                  reviewOutdated: false,
                },
              ],
            },
          ],
          citations: [
            {
              title: '履歴からの架空出典',
              organization: '架空庁',
              url: fakeHistoryUrl,
              urlVerified: true,
              checkedAt: '2026-01-01',
            },
          ],
        },
        {
          id: 'h-assistant',
          role: 'assistant',
          text: '旧形式の応答（出典フィールドなし）',
          isMock: true,
          hasUnverified: true,
          relatedPrograms: [],
        },
      ],
    }),
  )
  const bodyInjected = (await resInjected.json()) as ConsultReply
  check(
    'API 経由: 出典付き履歴を受けても壊れず 200 で応答（旧形式履歴も同じ経路）',
    resInjected.status === 200,
  )
  check(
    'API 経由: 履歴に混入した出典・URL を公式根拠として採用しない（KB の出典のみ）',
    JSON.stringify(bodyInjected.citations ?? []) ===
      JSON.stringify(expectedAllowanceCitations) &&
      !JSON.stringify(bodyInjected).includes(fakeHistoryUrl),
  )
  const injectedChip = (bodyInjected.relatedPrograms ?? []).find(
    (p) => p.id === 'mock-child-allowance',
  )
  const expectedAllowanceCard = resolveKbConsultContext({
    programId: null,
    message: allowanceMessage,
  }).cards.find((c) => c.programId === 'mock-child-allowance')
  check(
    'API 経由: 履歴の確認状態・確認日をそのまま扱わない（KB の値のまま）',
    injectedChip !== undefined &&
      expectedAllowanceCard !== undefined &&
      injectedChip.verification === expectedAllowanceCard.verification &&
      injectedChip.checkedAt === expectedAllowanceCard.checkedAt &&
      injectedChip.checkedAt !== '2026-01-01' &&
      !(bodyInjected.relatedPrograms ?? []).some(
        (p) => p.verification === 'official-verified',
      ),
  )

  // 10-10. API 経由の検証後も外部通信が発生しない
  check(
    'API 経由の検証後も外部通信は 0 回（fetch 未使用）',
    fetchCalls.length === 0,
    fetchCalls.join(', '),
  )

  if (failed > 0) {
    console.log('M6-G verification: FAILED (' + failed + ')')
    process.exitCode = 1
    return
  }
  console.log('M6-G verification: ALL PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
