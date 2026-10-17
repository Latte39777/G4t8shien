/**
 * 対象地域（東京都・23区）のモデルと絞り込み（M6-C・純関数）
 *
 * 責務:
 * - 制度の対象地域（jurisdiction）を、国・東京都・区市町村・23区の粒度で扱う
 * - 東京都23区までの地域絞り込み（filterProgramsByRegion）を提供する
 *
 * 【推測しない原則】
 * - 対象地域が公式情報で確認できない制度は coverage: 'unknown' として扱い、
 *   ユーザーの地域に「適用される／されない」を決めつけず needsRegionCheck に回す
 * - 比較不能（要確認）なものを「対象外」に落とさない
 *
 * 【外部通信なし】fetch や AI API は行わない。
 */
import type {
  Jurisdiction,
  SupportProgram,
  TokyoWardCode,
} from '../types/support'

/** 東京都23区の表示名 */
export const TOKYO_WARD_LABELS: Record<TokyoWardCode, string> = {
  chiyoda: '千代田区',
  chuo: '中央区',
  minato: '港区',
  shinjuku: '新宿区',
  bunkyo: '文京区',
  taito: '台東区',
  sumida: '墨田区',
  koto: '江東区',
  shinagawa: '品川区',
  meguro: '目黒区',
  ota: '大田区',
  setagaya: '世田谷区',
  shibuya: '渋谷区',
  nakano: '中野区',
  suginami: '杉並区',
  toshima: '豊島区',
  kita: '北区',
  arakawa: '荒川区',
  itabashi: '板橋区',
  nerima: '練馬区',
  adachi: '足立区',
  katsushika: '葛飾区',
  edogawa: '江戸川区',
}

/** 区コードから表示名（未登録コードはそのまま返さず '不明'） */
export function wardLabel(code: TokyoWardCode | null): string | null {
  if (code === null) return null
  return TOKYO_WARD_LABELS[code] ?? '不明（要確認）'
}

/**
 * 対象地域の表示文言。
 * 未確認の地域は推測せず「未確認」と明示する。
 */
export function jurisdictionText(jurisdiction: Jurisdiction | undefined | null): string {
  if (jurisdiction === undefined || jurisdiction === null) {
    return '対象地域は未整理（要確認）'
  }
  const ward = wardLabel(jurisdiction.ward)
  const area =
    ward ??
    jurisdiction.municipality ??
    jurisdiction.prefecture ??
    null
  switch (jurisdiction.coverage) {
    case 'nationwide':
      return `全国${area ? `（${area}が実施）` : ''}${
        jurisdiction.scopeNote ? `。${jurisdiction.scopeNote}` : ''
      }`
    case 'prefecture':
      return `${jurisdiction.prefecture ?? '都道府県（名称未確認）'}${
        jurisdiction.scopeNote ? `。${jurisdiction.scopeNote}` : ''
      }`
    case 'municipality':
      return `${area ?? '市区町村（名称未確認）'}が実施${
        jurisdiction.scopeNote ? `。${jurisdiction.scopeNote}` : ''
      }`
    case 'ward':
      return `${ward ?? '区（名称未確認）'}が実施${
        jurisdiction.scopeNote ? `。${jurisdiction.scopeNote}` : ''
      }`
    case 'unknown':
    default:
      return `対象地域は未確認（推測して設定していません）${
        jurisdiction.scopeNote ? `。${jurisdiction.scopeNote}` : ''
      }`
  }
}

/** 絞り込み対象の地域（指定しない項目は判定を保留する） */
export type RegionQuery = {
  /** 都道府県名（例: '東京都'） */
  prefecture?: string | null
  /** 市区町村名（例: '文京区'） */
  municipality?: string | null
  /** 東京都23区の区コード */
  ward?: TokyoWardCode | null
}

export type RegionFilterResult = {
  /** ユーザーの地域で適用される（確認済み）制度 */
  applicable: SupportProgram[]
  /** 対象地域が未確認のため、適用可否を判定できない制度（要確認） */
  needsRegionCheck: SupportProgram[]
}

/**
 * 地域による制度の絞り込み（純関数）。
 *
 * 判定:
 * - nationwide（全国）: 常に applicable
 * - prefecture（都道府県）: ユーザーの都道府県が一致すれば applicable。
 *   ユーザーの都道府県が未指定なら needsRegionCheck、不一致なら両方に含めない（対象外）
 * - municipality / ward: ユーザーの市区町村・区が一致すれば applicable。
 *   未指定なら needsRegionCheck、不一致なら両方に含めない（対象外）
 * - unknown / 未整理: needsRegionCheck（推測で適用・不適用を決めない）
 */
export function filterProgramsByRegion(
  programs: readonly SupportProgram[],
  query: RegionQuery,
): RegionFilterResult {
  const applicable: SupportProgram[] = []
  const needsRegionCheck: SupportProgram[] = []
  for (const program of programs) {
    const j = program.jurisdiction
    if (j === undefined || j.coverage === 'unknown') {
      needsRegionCheck.push(program)
      continue
    }
    if (j.coverage === 'nationwide') {
      applicable.push(program)
      continue
    }
    if (j.coverage === 'prefecture') {
      const userPrefecture = query.prefecture ?? null
      if (userPrefecture === null) {
        needsRegionCheck.push(program)
      } else if (j.prefecture === userPrefecture) {
        applicable.push(program)
      }
      continue
    }
    // municipality / ward: 区市町村レベルの一致で判定
    const userWard = query.ward ?? null
    const userMunicipality = query.municipality ?? null
    if (userWard === null && userMunicipality === null) {
      needsRegionCheck.push(program)
      continue
    }
    // 区コードと名称（例: 'bunkyo' と '文京区'）のどちらでも一致判定できるようにする
    const programAreas = new Set<string>()
    if (j.ward !== null) {
      programAreas.add(j.ward)
      programAreas.add(TOKYO_WARD_LABELS[j.ward])
    }
    if (j.municipality !== null) programAreas.add(j.municipality)
    const userAreas = new Set<string>()
    if (userWard !== null) {
      userAreas.add(userWard)
      userAreas.add(TOKYO_WARD_LABELS[userWard])
    }
    if (userMunicipality !== null) userAreas.add(userMunicipality)
    const matched = [...userAreas].some((a) => programAreas.has(a))
    if (matched) {
      applicable.push(program)
    }
    // 不一致は対象外として両方に含めない（判定済みのため「要確認」には回さない）
  }
  return { applicable, needsRegionCheck }
}
