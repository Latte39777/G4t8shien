/**
 * 地域（都道府県・市区町村）の型定義。
 *
 * - 制度検索（将来の AI 調査）に使えるよう、コード付きの正規化済みデータとして保持する
 * - 本改修では外部 API・AI 検索を呼ばず、静的マスタ（lib/regions/data.ts）のみを使う
 */

/** 市区町村の種別（東京23区は ward、政令市の区は designated-ward） */
export type MunicipalityKind =
  | "ward"
  | "designated-ward"
  | "city"
  | "town"
  | "village"
  | "other";

/** 正規化された地域情報（送信データに保存する） */
export type RegionSelection = {
  /** 都道府県コード（JIS X 0401・2桁文字列） */
  prefectureCode: string;
  /** 都道府県名 */
  prefectureName: string;
  /** 市区町村名（東京都23区は区名）。都道府県のみ選択のときは null */
  municipalityName: string | null;
  /** 市区町村の種別。都道府県のみ選択のときは null */
  municipalityKind: MunicipalityKind | null;
  /** 正規化ラベル（例: "東京都世田谷区" / "北海道"） */
  label: string;
};
