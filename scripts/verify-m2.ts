/**
 * M2 検証スクリプト：支援制度モックデータと /api/supports ルートハンドラ
 * 実行: npx tsx scripts/verify-m2.ts
 */
import { z } from "zod";
import { supportProgramSchema } from "../lib/types/support";
import {
  MOCK_DISCLAIMER,
  MOCK_SUPPORT_PROGRAMS,
} from "../lib/supports/mockPrograms";
import { GET } from "../app/api/supports/route";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    failed += 1;
    console.error(`NG: ${name}`);
  }
}

// ── モックデータのスキーマ検証 ──
const parsed = z.array(supportProgramSchema).safeParse(MOCK_SUPPORT_PROGRAMS);
check("モックデータ: supportProgramSchema を全件通過", parsed.success);
check("モックデータ: 4件以上", MOCK_SUPPORT_PROGRAMS.length >= 4);
check(
  "モックデータ: 全制度が mock=true",
  MOCK_SUPPORT_PROGRAMS.every((p) => p.mock),
);
check(
  "モックデータ: amount.basis=confirmed を使用しない",
  MOCK_SUPPORT_PROGRAMS.every((p) => p.amount.basis !== "confirmed"),
);
check(
  "モックデータ: 全出典が未確認（urlVerified=false・url=null）",
  MOCK_SUPPORT_PROGRAMS.every((p) =>
    p.sources.every((s) => !s.urlVerified && s.url === null),
  ),
);
check(
  "モックデータ: 貸付制度を含む（合計除外の検証用）",
  MOCK_SUPPORT_PROGRAMS.some((p) => p.category === "loan"),
);
check(
  "モックデータ: 金額未確認（unknown）を含む",
  MOCK_SUPPORT_PROGRAMS.some((p) => p.amount.basis === "unknown"),
);
check(
  "モックデータ: 併用不可条件・不足情報フィールドが欠けていない",
  MOCK_SUPPORT_PROGRAMS.every(
    (p) => Array.isArray(p.conditions.combinedWith) && Array.isArray(p.missingInformation),
  ),
);

// ── ルートハンドラ（GET） ──
async function main() {
  const res = await GET();
  check("GET /api/supports: status 200", res.status === 200);
  const body = (await res.json()) as {
    mock: boolean;
    disclaimer: string;
    generatedAt: string;
    programs: unknown[];
  };
  check("GET: mock=true", body.mock === true);
  check(
    "GET: 免責文言つき",
    body.disclaimer === MOCK_DISCLAIMER && body.disclaimer.length > 0,
  );
  check(
    "GET: programs を返す",
    Array.isArray(body.programs) && body.programs.length >= 4,
  );
  check("GET: generatedAt がISO形式", !Number.isNaN(Date.parse(body.generatedAt)));

  console.log(
    failed === 0
      ? "\nM2 verification: ALL PASSED"
      : `\nM2 verification: ${failed} FAILED`,
  );
  if (failed > 0) process.exit(1);
}

void main();