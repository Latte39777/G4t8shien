/**
 * P11-1 検証: 実 AI 応答・回答内容の品質確認（合成質問・外部通信は最大 2 回）
 *
 * 実行: npx tsx scripts/verify-p11-1.ts（モック品質のみ・外部通信なし）
 *       VERIFY_P11_1_LIVE=1 npx tsx scripts/verify-p11-1.ts（実 AI 確認を含む。
 *       合成質問 2 回の外部通信が発生する。実行は必要性を確認してから）
 *
 * - 合成質問のみ（実ユーザーの相談文・個人情報は使わない）
 * - API キー・質問文・会話履歴・上流レスポンス全文は console に出力しない。
 *   出力するのは判定結果・件数・短い抜粋（各 40 文字以内）と、
 *   サーバー側 KB/レジストリ由来のメタデータ（制度名・出典名・確認日）のみ
 * - 検証内容:
 *   1. 実 AI（sourceType='ai' / isMock=false）が応答するか
 *   2. 出典がサーバー側 KB の出典と一致するか（AI 生成の URL は採用されない）
 *   3. 関連制度チップの ID がサーバー側レジストリに存在するものだけか
 *   4. 資格を断定していないか・KB 未確認の金額を捏造していないか
 *   5. 関連しない質問で無理に制度候補を出さないか
 * - 注意: このテストの合格は「制約が守られたこと」の確認であり、
 *   制度情報の事実としての正確性の証明ではない（公式照合が必要な箇所は
 *   レポートで「未確認」として扱う）
 */
import { handleConsultRequest } from '../lib/consult/api'
import { resolveKbConsultContext } from '../lib/consult/kbContext'
import { mockConsultProvider } from '../lib/consult/mockAdvisor'
import { replyDisplayMode } from '../lib/consult/replyMode'
import { getConsultProvider, isLiveConsultEnabled } from '../lib/consult/provider'
import type { ConsultReply, ConsultRequest } from '../lib/consult/types'
import { buildKnowledgeBase } from '../lib/supports/kb'
import { getSupportPrograms } from '../lib/supports/registry'

try {
  process.loadEnvFile('.env')
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}${cond || !detail ? '' : ` -- ${detail}`}`)
  if (!cond) failed += 1
}

function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

/** 抜粋（全文は出力しない。最大 40 文字） */
function excerpt(s: string): string {
  return s.length <= 40 ? s : `${s.slice(0, 40)}…`
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/consult', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 合成質問（実相談文ではない。個人情報なし。KB にある制度名を含む） */
const Q1_MESSAGE =
  '児童手当について教えてください。どこに申請すればよくて、支給される金額はどのくらいですか。'
/** 制度と無関係な合成質問 */
const Q2_MESSAGE =
  '電車の窓から見える景色を楽しむには、どんな工夫がよいでしょうか。'

async function ask(message: string, useMock = false): Promise<ConsultReply | null> {
  const request: ConsultRequest = {
    message,
    history: [],
    program: null,
    userContext: null,
  }
  // useMock=false のときだけ実 API を使う（実行モードはサーバー側ログで確認できる）
  const res = await handleConsultRequest(jsonRequest(request), {
    resolveProvider: () => (useMock ? mockConsultProvider : getConsultProvider()),
    env: process.env,
    logger: {
      // 非機密メタデータ（モード名・リクエスト ID）のみ出す
      info: (msg: string) => console.log(`  [server] ${msg}`),
      warn: (msg: string) => console.log(`  [server:warn] ${msg}`),
      error: (msg: string) => console.log(`  [server:error] ${msg}`),
    },
  })
  if (res.status !== 200) {
    console.log(`  HTTP ${res.status}（応答本文は出力しません）`)
    return null
  }
  return (await res.json()) as ConsultReply
}

/** KB の根拠になり得る文字列（金額・場所などの照合用。決定論的） */
function kbGroundText(): string {
  return buildKnowledgeBase()
    .flatMap((e) => [
      e.name,
      e.jurisdiction.municipality ?? '',
      e.jurisdiction.scopeNote ?? '',
      ...e.fields.flatMap((f) => [
        f.label,
        f.value === null ? '' : String(f.value),
        f.unit ?? '',
        f.note ?? '',
        f.excerpt ?? '',
      ]),
      ...e.sources.flatMap((s) => [s.title, s.organization, s.url]),
    ])
    .join('\n')
}

/** 回答本文に含まれる金額（円）が KB の根拠に存在するか（数字の一致で判定） */
function checkAmountsGrounded(label: string, text: string, ground: string): void {
  const amounts = text.match(/\d[\d,]*\s*円/g) ?? []
  const normalizedGround = ground.replace(/[\s,]/g, '')
  const ungrounded = amounts.filter(
    (a) => !normalizedGround.includes(a.replace(/[\s,円]/g, '')),
  )
  check(
    `${label}: 金額の記載 ${amounts.length} 件は KB の根拠と一致（捏造なし）`,
    ungrounded.length === 0,
    ungrounded.map((a) => `未確認の金額「${excerpt(a)}」`).join(' / '),
  )
}

/** 資格・受給の断定らしい表現の検出（見つかったら要確認として抜粋報告） */
function checkNoEligibilityAssertion(label: string, text: string): void {
  const patterns = [
    /あなた[はが][^\n。]{0,20}(対象|資格)/g,
    /必ず[^\n。]{0,12}(受給|支給|もらえ)/g,
    /(受給|支給)(できます|されます)[^\n。]{0,8}(確定|間違い)/g,
  ]
  const hits: string[] = []
  for (const p of patterns) {
    for (const m of text.match(p) ?? []) hits.push(m)
  }
  check(
    `${label}: 資格・受給を断定する表現なし`,
    hits.length === 0,
    hits.map((h) => `要確認「${excerpt(h)}」`).join(' / '),
  )
}

/** 出典がサーバー側 KB の出典と一致するか（名称・確認日・リンクの 3 点セットで照合） */
function checkCitationsFromKb(
  label: string,
  reply: ConsultReply,
  kbCitations: Array<{ title: string; checkedAt: string | null; url: string | null }>,
): void {
  const citations = reply.citations ?? []
  if (citations.length === 0) {
    check(`${label}: 出典は KB 解決時のみ付与（今回の応答は出典 0 件）`, true)
    return
  }
  for (const c of citations) {
    // 同名の出典が複数あるため、名称・確認日・リンクの 3 点が一致するものを探す
    const matched = kbCitations.find(
      (k) =>
        k.title === c.title &&
        (k.checkedAt ?? null) === (c.checkedAt ?? null) &&
        (k.url ?? null) === (c.url ?? null),
    )
    check(
      `${label}: 出典「${excerpt(c.title)}」の名称・確認日・リンクはサーバー側 KB と一致`,
      matched !== undefined,
      `reply=${c.checkedAt ?? 'なし'}/${c.url ?? 'リンクなし'}`,
    )
  }
}

async function main(): Promise<void> {
  console.log('P11-1: 実 AI 応答・回答内容の品質確認')

  const ground = kbGroundText()
  const registryById = new Map(getSupportPrograms().map((p) => [p.id, p]))
  /** 回答に付与され得る出典は、同じ質問から解決される KB の出典のみのはず */
  const kbCitationsFor = (message: string) =>
    resolveKbConsultContext({ programId: null, message }).cards.flatMap((c) => c.citations)

  // ── 0. モック経路（外部通信なし。KB 制度への質問で決定論的に確認） ──
  section('0. モック応答の品質（外部通信なし・KB 制度への質問）')
  const mockReply = await ask(Q1_MESSAGE, true)
  if (mockReply === null) {
    check('モック応答を取得', false)
  } else {
    check(
      'モックはモックと表示される（UI のモード判定も mock）',
      replyDisplayMode(mockReply) === 'mock',
      `mode=${replyDisplayMode(mockReply)} isMock=${String(mockReply.isMock)} sourceType=${mockReply.sourceType ?? '未設定（mock 扱い）'}`,
    )
    check(
      'モック: 資格は常に未確認扱い（hasUnverified=true かつ本文に未確認の注記）',
      mockReply.hasUnverified === true && mockReply.text.includes('未確認'),
    )
    checkNoEligibilityAssertion('モック: 資格非断定', mockReply.text)
    checkAmountsGrounded('モック: 金額', mockReply.text, ground)
    const urlCount = (mockReply.text.match(/https?:\/\//g) ?? []).length
    check('モック: 回答本文に URL を埋め込まない', urlCount === 0, `URL 個数=${urlCount}`)
    check(
      'モック: KB 制度のチップが付く（レジストリ実在・区分も一致）',
      mockReply.relatedPrograms.length > 0,
      `チップ件数=${mockReply.relatedPrograms.length}`,
    )
    for (const p of mockReply.relatedPrograms) {
      const reg = registryById.get(p.id)
      check(
        `モック: 関連制度「${excerpt(p.name)}」(${p.id}) はレジストリに実在`,
        reg !== undefined && reg.name === p.name,
      )
      if (reg !== undefined) {
        check(
          `モック: 関連制度「${excerpt(p.name)}」の区分はレジストリと一致（混同なし）`,
          p.category === undefined || p.category === reg.category,
          `reply=${p.category ?? 'なし'} registry=${reg.category}`,
        )
      }
    }
    check(
      'モック: 出典はサーバー側 KB から付与される（1 件以上）',
      (mockReply.citations ?? []).length > 0,
      `出典件数=${(mockReply.citations ?? []).length}`,
    )
    checkCitationsFromKb('モック: 出典', mockReply, kbCitationsFor(Q1_MESSAGE))
    console.log(`  参考: 回答本文 ${mockReply.text.length} 文字・先頭「${excerpt(mockReply.text)}」`)
  }

  // ── 1-2. 実 AI（外部通信を伴うため明示指定時のみ。合成質問・最大 2 回） ──
  if (process.env.VERIFY_P11_1_LIVE !== '1') {
    section('実 AI 品質確認（外部通信のため明示指定時のみ実行）')
    console.log('  スキップしました（実 AI 確認は合成質問 2 回の外部通信を伴います）')
    console.log('  実行する場合: VERIFY_P11_1_LIVE=1 npx tsx scripts/verify-p11-1.ts')
    if (failed > 0) {
      console.log(`NG: ${failed} 件`)
      process.exitCode = 1
    } else {
      console.log('モック品質チェック: すべて ok（制約の確認結果。事実の正確性の証明ではない）')
    }
    return
  }
  if (!isLiveConsultEnabled(process.env)) {
    console.log('ライブ AI が無効のため実通信は行いません（モックのみの環境です）')
    return
  }
  const provider = getConsultProvider()
  if (provider.isMock) {
    console.log('provider がモックのため実通信は行いません')
    return
  }

  let calls = 0

  // ── 1. KB にある制度に関する合成質問（1 回目） ──
  section('1. KB 制度への合成質問（実 API 1 回目）')
  const reply1 = await ask(Q1_MESSAGE)
  if (reply1 === null) {
    check('実 AI 応答を取得', false)
  } else {
    calls += 1
    check(
      '実 AI が応答（sourceType=ai / isMock=false）',
      reply1.sourceType === 'ai' && reply1.isMock === false,
      `sourceType=${reply1.sourceType} isMock=${String(reply1.isMock)}`,
    )
    check(
      '資格は常に未確認扱い（hasUnverified=true かつ本文に未確認の注記）',
      reply1.hasUnverified === true && reply1.text.includes('未確認'),
    )
    checkNoEligibilityAssertion('資格非断定', reply1.text)
    checkAmountsGrounded('金額', reply1.text, ground)
    const urlCount = (reply1.text.match(/https?:\/\//g) ?? []).length
    check('回答本文に URL を埋め込まない', urlCount === 0, `URL 個数=${urlCount}`)
    // チップはサーバー側レジストリに存在する ID のみ（捏造 ID・名称の混入なし）
    for (const p of reply1.relatedPrograms) {
      const reg = registryById.get(p.id)
      check(
        `関連制度「${excerpt(p.name)}」(${p.id}) はレジストリに実在`,
        reg !== undefined && reg.name === p.name,
      )
      if (reg !== undefined) {
        check(
          `関連制度「${excerpt(p.name)}」の区分（給付/減免/貸与）はレジストリと一致（混同なし）`,
          p.category === undefined || p.category === reg.category,
          `reply=${p.category ?? 'なし'} registry=${reg.category}`,
        )
      }
    }
    checkCitationsFromKb('出典', reply1, kbCitationsFor(Q1_MESSAGE))
    // 全文は出力しない（先頭 40 文字のみ）
    console.log(`  参考: 回答本文 ${reply1.text.length} 文字・先頭「${excerpt(reply1.text)}」`)
  }

  // ── 2. 関連しない合成質問（2 回目） ──
  section('2. 関連しない合成質問（実 API 2 回目）')
  const reply2 = await ask(Q2_MESSAGE)
  if (reply2 === null) {
    check('実 AI 応答を取得', false)
  } else {
    calls += 1
    check(
      '実 AI が応答（sourceType=ai / isMock=false）',
      reply2.sourceType === 'ai' && reply2.isMock === false,
      `sourceType=${reply2.sourceType} isMock=${String(reply2.isMock)}`,
    )
    check(
      '無関係な質問に無理に制度候補を出さない',
      reply2.relatedPrograms.length === 0,
      `チップ件数=${reply2.relatedPrograms.length}`,
    )
    for (const p of reply2.relatedPrograms) {
      const reg = registryById.get(p.id)
      check(
        `（参考）チップ「${excerpt(p.name)}」(${p.id}) はレジストリに実在`,
        reg !== undefined && reg.name === p.name,
      )
    }
    console.log(`  参考: 回答本文 ${reply2.text.length} 文字・先頭「${excerpt(reply2.text)}」`)
  }

  console.log(`\n外部 API 呼び出し回数: ${calls} / 最大 2`)
  if (failed > 0) {
    console.log(`NG: ${failed} 件`)
    process.exitCode = 1
  } else {
    console.log('すべて ok（制約の確認結果。事実の正確性の証明ではない）')
  }
}

void main()