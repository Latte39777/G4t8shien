/**
 * 地域（都道府県・市区町村）の選択・正規化ヘルパ（純関数）。
 *
 * - 使用するのは lib/regions/data.ts の静的マスタのみ（外部API・AI検索は呼ばない）
 * - マスタに存在しない組み合わせは null を返す（存在しない自治体を捏造しない）
 */
import { MUNICIPALITIES, PREFECTURES } from "./data";
import type { MunicipalityKind, RegionSelection } from "./types";

export type { MunicipalityKind, RegionSelection };

/** 都道府県の一覧（JIS X 0401 順） */
export function listPrefectures(): ReadonlyArray<{ code: string; name: string }> {
  return PREFECTURES;
}

/** 都道府県コードに対応する市区町村名の一覧（マスタ未収録なら空配列） */
export function listMunicipalities(prefectureCode: string): readonly string[] {
  return MUNICIPALITIES[prefectureCode] ?? [];
}

/** 市区町村名から種別を推定する（東京23区は ward、政令市の区は designated-ward） */
export function municipalityKind(
  name: string,
  prefectureCode: string,
): MunicipalityKind {
  if (prefectureCode === "13" && name.endsWith("区")) return "ward";
  if (name.endsWith("区")) return "designated-ward";
  if (name.endsWith("市")) return "city";
  if (name.endsWith("町")) return "town";
  if (name.endsWith("村")) return "village";
  return "other";
}

/**
 * 選択値から正規化済みの地域情報を組み立てる（純関数）。
 *
 * - municipalityName が null・空文字なら「都道府県のみ選択」として扱う
 * - 都道府県が未選択、またはマスタに無い市区町村名のときは null（推測しない）
 */
export function buildRegion(
  prefectureCode: string,
  municipalityName: string | null,
): RegionSelection | null {
  const pref = PREFECTURES.find((p) => p.code === prefectureCode);
  if (!pref) return null;
  const name =
    municipalityName === null || municipalityName === ""
      ? null
      : municipalityName;
  if (name !== null && !listMunicipalities(pref.code).includes(name)) {
    return null;
  }
  return {
    prefectureCode: pref.code,
    prefectureName: pref.name,
    municipalityName: name,
    municipalityKind: name === null ? null : municipalityKind(name, pref.code),
    label: name === null ? pref.name : `${pref.name}${name}`,
  };
}
