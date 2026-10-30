"use client";

/**
 * 支援制度の相談画面（M5）
 *
 * - 自由な相談（制度を指定しない）と、制度カードからの相談の2つの入口に対応
 * - 応答はモック（開発用サンプル）。UI と応答生成（lib/consult/provider.ts）を分離
 * - 会話履歴はブラウザのメモリ上のみ（リロードで消える旨を画面に明示）
 * - モック・未確認情報はバッジ等で明確に区別する
 * - スマートフォンでも使いやすい縦積みレイアウト
 *
 * 【出典・確認状態の表示（P3）】
 * - 出典は応答に付いた citations（公式情報KB由来）だけを表示する。
 *   回答本文から URL・機関名を抽出して出典に追加することはない
 * - リンク化できるのは urlVerified === true かつ reviewOutdated !== true
 *   の HTTPS URL だけ。それ以外はリンクを公開せず状態を明示する
 * - 確認状態の値が無いものを「確認済み」と推測して表示しない。
 *   eligibility（利用資格）は常に未確認として扱う
 *
 * 【回答モード別の表示（P9-4）】
 * - 通常モック / ライブ AI / 障害時フォールバックの3モードを、応答の
 *   フィールド（isMock / sourceType）だけで判定して表示を分ける
 *   （lib/consult/replyMode.ts。本文の表現からは推測しない）
 * - フォールバック時はライブ AI が回答したかのような表示をしない
 *
 * 【個人情報の注意表示（P9-4 / P10-1 / M7-M）】
 * - 質問入力欄の近くに、送信内容・個人情報・マスクの限界の短い注意を常に表示し、
 *   詳細（シミュレーション情報の範囲・履歴の非保存など）は折りたたみに集約する
 * - 外部送信の説明は環境の実態（GET /api/consult の liveAiEnabled。POST と
 *   同じ 2 重スイッチ判定）に合わせて切り替える。ライブ AI 有効時は
 *   質問文・会話履歴が外部 AI（INIAD AI-MOP API）へ送信されることを
 *   送信前に案内し、「送信していない」という実態と矛盾する表示をしない
 *   （状態未確認時は安全側＝送信され得る前提の表示。API キー等は表示しない）
 * - 外部 AI への送信が行われることは折りたたみの中だけに隠さず、
 *   常時見える短い注意書きで必ず案内する
 *
 * 【画面構成（M7-M: 説明文の最適化）】
 * - 上部: 結果画面に戻る／会話をリセット（消える旨を確認してから実行）／
 *   タイトル／相談対象の制度名と短い説明（金額・申請先などの詳細は折りたたみ）
 * - 実AIとモックの説明は実行モードに応じて1つだけ表示し、混在させない
 *   （判定は既存の GET liveAiEnabled と各回答の isMock / sourceType のみ）
 * - 質問例はクリックできるチップ表示（既存の送信動作を維持）
 * - 下部の誘導は「結果画面で支援制度一覧を見る」の1つだけ（重複リンクを廃止）
 */
import { useEffect, useState, type FormEvent } from "react";
import {
  MOCK_CONSULT_EXAMPLES,
  categoryLabel,
} from "@/lib/consult/mockAdvisor";
import { replyDisplayMode } from "@/lib/consult/replyMode";
import type {
  ChatMessage,
  ConsultCitation,
  ConsultContextProgram,
  ConsultRelatedProgram,
  ConsultUserContext,
} from "@/lib/consult/types";

export type ConsultProps = {
  /** 制度カードから開始された場合の制度（自由相談は null） */
  program: ConsultContextProgram | null;
  /** 相談に必要な最小限の入力情報 */
  userContext: ConsultUserContext | null;
  messages: ChatMessage[];
  sending: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onReset: () => void;
  /** 通信障害時の再試行（retryable のときだけ再試行ボタンを表示） */
  onRetry?: () => void;
  retryable?: boolean;
  /** 結果画面へ戻る */
  onBack: () => void;
  /** 結果画面の支援制度一覧（公式情報の確認導線）へ移動 */
  onOpenSupports: () => void;
  /**
   * 外部 AI（INIAD AI-MOP API）が有効な環境か（送信前の注意表示用。P10-1）。
   * true=質問文・会話履歴が外部 AI へ送信される / false=モックのみ（外部送信なし）/
   * null=未確認（安全側＝送信され得る前提の表示）。
   * 未指定なら GET /api/consult が返す真偽値を自動取得する（API キー等は取得しない）
   */
  liveAiEnabled?: boolean | null;
};

/** リンク化できる URL か（HTTPS かつ妥当な URL のみ。検証結果は別途見る） */
function isHttpsUrl(url: string | null): boolean {
  if (url === null) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 確認状態の表示文言（制度チップ）。
 * 値が無い場合は null を返し、確認済みと推測して表示しない。
 */
const VERIFICATION_LABELS: Record<
  NonNullable<ConsultRelatedProgram["verification"]>,
  { text: string; className: string }
> = {
  "official-verified": {
    text: "公式情報で確認済み",
    className: "bg-emerald-100 text-emerald-700",
  },
  partial: {
    text: "一部未確認",
    className: "bg-amber-100 text-amber-700",
  },
  unverified: {
    text: "未確認",
    className: "bg-rose-100 text-rose-600",
  },
};

/**
 * 出典1件のリンク判定と状態文言。
 * - リンクを公開できるのは「urlVerified === true かつ reviewOutdated !== true かつ HTTPS」のみ
 * - それ以外はリンクにせず、理由を明示する（本文中の URL を拾って出典にすることはない）
 */
function citationLinkState(c: ConsultCitation): {
  href: string | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (c.reviewOutdated === true) reasons.push("情報の再確認が必要です");
  if (c.url === null) {
    reasons.push("URL の登録なし");
  } else if (c.urlVerified !== true) {
    reasons.push("URL 未確認");
  } else if (!isHttpsUrl(c.url)) {
    reasons.push("HTTPS の URL ではないためリンクを掲載できません");
  }
  const linkable =
    c.urlVerified === true && c.reviewOutdated !== true && isHttpsUrl(c.url);
  return { href: linkable ? c.url : null, reasons };
}

/** 出典一覧（citations がある場合のみ表示。KB 由来の情報だけを載せる） */
function CitationList({ citations }: { citations: ConsultCitation[] }) {
  return (
    <div
      className="mt-2 border-t border-slate-100 pt-2"
      data-testid="consult-citations"
    >
      <p className="text-[10px] font-bold text-slate-400">
        参考にした公式ページ
      </p>
      <ul className="mt-1 space-y-1.5">
        {citations.map((c, index) => {
          const { href, reasons } = citationLinkState(c);
          return (
            <li
              key={`${c.title}-${index}`}
              className="rounded-xl bg-slate-50 px-2.5 py-1.5 text-[11px] leading-5 text-slate-600"
              data-testid="consult-citation"
            >
              <p className="font-semibold text-slate-700">{c.title}</p>
              <p>機関：{c.organization}</p>
              <p>{`確認日：${c.checkedAt ?? "未確認"}`}</p>
              {href !== null ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="consult-citation-link"
                  className="break-all text-blue-600 underline underline-offset-2 hover:text-blue-800"
                >
                  {href}
                </a>
              ) : (
                <p
                  className="text-slate-500"
                  data-testid="consult-citation-unlinked"
                >
                  {reasons.join("／")}（リンクは掲載していません）
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 関連制度チップ（モック/確認済みを区別して表示。区分・確認状態・確認日を付記） */
function RelatedChips({
  message,
  onOpenSupports,
}: {
  message: ChatMessage;
  onOpenSupports: () => void;
}) {
  if (message.relatedPrograms.length === 0) return null;
  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <p className="text-[10px] font-bold text-slate-400">関連する制度</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {message.relatedPrograms.map((p) => {
          const verification =
            p.verification !== undefined
              ? VERIFICATION_LABELS[p.verification]
              : null;
          const needsRecheck =
            p.sources?.some((s) => s.reviewOutdated === true) ?? false;
          return (
            <li key={p.id} className="flex flex-col items-start gap-0.5">
              {/* 名前とバッジを行で分離し、「児童手当検証済み」のような連結表示にしない */}
              <button
                type="button"
                onClick={onOpenSupports}
                data-testid="consult-related-program"
                className="inline-flex flex-col items-start gap-1 rounded-2xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
              >
                <span>{p.name}</span>
                <span className="flex flex-wrap items-center gap-1">
                  {p.category !== undefined && (
                    <span
                      className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500"
                      data-testid="consult-related-category"
                    >
                      {categoryLabel(p.category)}
                    </span>
                  )}
                {p.sourceType === "mock" ? (
                  <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold text-rose-600">
                    モック・未確認
                  </span>
                ) : verification !== null ? (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${verification.className}`}
                    data-testid="consult-related-verification"
                  >
                    {verification.text}
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">
                    検証済み
                  </span>
                )}
                </span>
              </button>
              {(p.verification !== undefined ||
                p.checkedAt !== undefined ||
                needsRecheck) && (
                <p className="px-1 text-[9px] leading-4 text-slate-400">
                  {`確認日：${p.checkedAt ?? "未確認"}${
                    needsRecheck ? "／情報の再確認が必要です" : ""
                  }`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 会話メッセージ1件の表示 */
function MessageBubble({
  message,
  onOpenSupports,
}: {
  message: ChatMessage;
  onOpenSupports: () => void;
}) {
  const isUser = message.role === "user";
  /** 回答モード（応答フィールドのみで判定。本文からは推測しない） */
  const mode = replyDisplayMode(message);
  return (
    <li
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
      data-testid={isUser ? "chat-user-message" : "chat-assistant-message"}
    >
      <div
        className={`max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[80%] ${
          isUser
            ? "bg-blue-500 text-white"
            : "border border-slate-200 bg-white text-slate-700"
        }`}
      >
        {!isUser && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold text-slate-400">
              相談アシスタント
            </span>
            {/* 通常モック・障害時フォールバックはモックサンプルであることを表示 */}
            {mode !== "ai" && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[9px] font-bold text-rose-600">
                開発用モックサンプル
              </span>
            )}
            {/* フォールバック時はライブ AI が回答したかのような表示をしない */}
            {mode === "mock-fallback" && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700"
                data-testid="consult-fallback-badge"
              >
                障害時のモック回答（AI は回答できませんでした）
              </span>
            )}
            {mode === "ai" && (
              <span
                className="rounded-full bg-indigo-100 px-2 py-0.5 text-[9px] font-bold text-indigo-700"
                data-testid="consult-ai-badge"
              >
                AI回答（Web検索なし・未確認の可能性があります）
              </span>
            )}
            {message.hasUnverified && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold text-amber-700">
                未確認情報を含む
              </span>
            )}
          </div>
        )}
        {/* ライブ AI の応答は AI 生成である旨と、誤り・未確認があり得ることを伝える */}
        {!isUser && mode === "ai" && (
          <p
            className="mb-1.5 text-[10px] leading-4 text-slate-500"
            data-testid="consult-ai-mode-note"
          >
            AI
            が生成した自動応答です。内容に誤りや未確認の事項が含まれることがあります。
          </p>
        )}
        <p
          className={`whitespace-pre-wrap text-xs leading-5 ${
            isUser ? "text-white" : "text-slate-700"
          }`}
        >
          {/* 本文はプレーンテキストとして描画する。
              AI が挙げた URL は出典ではないためアンカー（リンク）化しない */}
          {message.text}
        </p>
        {!isUser && (message.citations?.length ?? 0) > 0 && (
          <CitationList citations={message.citations ?? []} />
        )}
        {!isUser && (
          <RelatedChips message={message} onOpenSupports={onOpenSupports} />
        )}
        {!isUser &&
          ((message.citations?.length ?? 0) > 0 ||
            message.relatedPrograms.length > 0) && (
            <p
              className="mt-2 text-[10px] leading-4 text-slate-500"
              data-testid="consult-eligibility-note"
            >
              ※受給資格（利用資格）は未確認です。ご本人が対象かどうか・金額・申請方法は、公式窓口・公式サイトで必ずご確認ください。
            </p>
          )}
      </div>
    </li>
  );
}

/**
 * 外部 AI への送信状況の説明文（詳細折りたたみ内の送信仕様の説明。P10-1 / M7-M）。
 * POST と同じ 2 重スイッチ判定（GET /api/consult の liveAiEnabled）に合わせて
 * 切り替え、環境の実態と矛盾する表示をしない。
 * - live: ライブ AI 有効（質問文・会話履歴が外部 AI サービスへ送信される）
 * - mock: モックのみ（外部 AI へ送信していない）
 * - unknown: 未確認。安全側＝送信され得る前提の説明にし、「送信していない」とは書かない
 */
const PRIVACY_TRANSMISSION_NOTICE: Record<
  "live" | "mock" | "unknown",
  string
> = {
  live: "・質問文に直接書いた金額や個人情報は、伏せ字にならないことがあります。現在は外部の AI（INIAD AI-MOP API）が有効で、質問文・会話履歴が外部 AI サービスへ送信されます。この表示が送信前のお知らせです。",
  mock: "・質問文に直接書いた金額や個人情報は、伏せ字にならないことがあります。現在は外部の AI へ送信していませんが、AI 回答を有効にする場合は、質問文・会話履歴が外部 AI サービスへ送信されることがあります。その際は利用の前に告知します。",
  unknown:
    "・質問文に直接書いた金額や個人情報は、伏せ字にならないことがあります。環境の設定によっては、質問文・会話履歴が外部 AI サービスへ送信されることがあります。",
};

/**
 * 外部送信の短い注意書き（質問入力欄・送信ボタンの近くに常に表示。M7-M）。
 * 外部 AI への送信が行われることは折りたたみの中だけに隠さず、この短い文で必ず案内する。
 * 実態（liveAiState）に合わせて表現を切り替え、「送信していない」と矛盾する表示をしない。
 */
const PRIVACY_SHORT_NOTICE: Record<"live" | "mock" | "unknown", string> = {
  live: "質問文と会話履歴は外部AIサービス（INIAD AI-MOP API）へ送信されます。氏名・住所・マイナンバー・口座情報などは入力しないでください。",
  mock: "現在は外部AIへ送信していません（開発用のモックサンプル）。AI回答を有効にした場合は、質問文と会話履歴は外部AIサービスへ送信されます。氏名・住所・マイナンバー・口座情報などは入力しないでください。",
  unknown:
    "環境の設定によっては、質問文と会話履歴は外部AIサービスへ送信されます。氏名・住所・マイナンバー・口座情報などは入力しないでください。",
};

/**
 * 回答モードの注意書き（上部の注意書き。実行モードと一致させ、1つだけ表示する。M7-M）
 * - live: 外部 AI（INIAD AI-MOP API）が回答すること・リアルタイム検索でないことを明示する
 * - mock: 開発用のサンプル回答であることを明示する（AI が回答しているような説明をしない）
 * - unknown: 環境状態が未確認のときは、どちらとも断定しない（特に
 *   「AI が回答している」と断定しない）。実際の種類は各回答のバッジで区別する
 * 実AIとモックの説明を同時表示しない。判定は既存の GET liveAiEnabled のみを使う。
 */
const MODE_NOTICE: Record<"live" | "mock" | "unknown", string> = {
  live: "外部AI（INIAD AI-MOP API）が質問に回答します。公式サイトをリアルタイム検索する機能ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認であり、最新情報や受給条件は公式情報でご確認ください。回答の種類は各回答のバッジで区別しています。",
  mock: "現在は開発用のモックサンプルです。実際の制度相談や申請判断には使用できません。公式サイトをリアルタイム検索する機能ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認です。",
  unknown:
    "回答は、開発用のモックサンプルの場合と外部AI（INIAD AI-MOP API）の生成応答の場合があります。実際の種類は各回答のバッジで区別しています。公式サイトをリアルタイム検索する機能ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認です。",
};

/** 会話リセット前の確認文言（会話履歴が消えることを事前に確認する。M7-M） */
const RESET_CONFIRM_MESSAGE =
  "会話履歴は消えます。会話をリセットしますか？（この操作は取り消せません）";

export default function Consult({
  program,
  userContext,
  messages,
  sending,
  error,
  onSend,
  onReset,
  onRetry,
  retryable,
  onBack,
  onOpenSupports,
  liveAiEnabled,
}: ConsultProps) {
  const [draft, setDraft] = useState("");

  // 外部 AI の有効/無効（未指定時は GET /api/consult から真偽値のみ取得する）
  const [autoLiveAi, setAutoLiveAi] = useState<boolean | null>(null);
  const liveAiState = liveAiEnabled !== undefined ? liveAiEnabled : autoLiveAi;

  useEffect(() => {
    // 明示指定（テスト等）がある場合は取得しない
    if (liveAiEnabled !== undefined) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/consult", { cache: "no-store" });
        const body: unknown = await res.json();
        const flag = (body as { liveAiEnabled?: unknown } | null)?.liveAiEnabled;
        if (!cancelled && typeof flag === "boolean") setAutoLiveAi(flag);
      } catch {
        // 取得失敗時は「未確認」の安全側表示のまま（誤って「送信なし」と表示しない）
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [liveAiEnabled]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      // 空入力は送信せず、エラー表示につなげる
      onSend("");
      return;
    }
    setDraft("");
    onSend(trimmed);
  };

  /** 会話リセット前に、会話履歴が消えることを確認する（M7-M） */
  const handleResetClick = () => {
    if (window.confirm(RESET_CONFIRM_MESSAGE)) onReset();
  };

  /** ユーザー質問がある＝会話が始まった（初期説明を邪魔にならない形にする） */
  const hasConversation = messages.some((m) => m.role === "user");

  /** 回答モードの注意書き（実態に応じて1つだけ表示） */
  const modeNoticeText =
    liveAiState === true
      ? MODE_NOTICE.live
      : liveAiState === false
        ? MODE_NOTICE.mock
        : MODE_NOTICE.unknown;

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6" data-testid="consult-screen">
      {/* ヘッダー（戻る・リセット。リセットは会話履歴が消えることを確認してから実行） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="consult-back"
          className="min-h-11 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          ← 結果画面に戻る
        </button>
        <button
          type="button"
          onClick={handleResetClick}
          data-testid="consult-reset"
          className="min-h-11 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          会話をリセット
        </button>
      </div>

      <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
        支援制度の相談
      </h1>

      {/* 相談対象の制度（M7-M: 「〜について相談中」＋短い説明。
          金額・申請先などの詳細は折りたたみ、確認状態は隠さない） */}
      {program ? (
        <div
          className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3"
          data-testid="consult-program-context"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-bold text-blue-800">
              「{program.name}」について相談中
            </p>
            {program.mock ? (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-600">
                モック・未確認
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                公式情報で確認済み
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-blue-800">
            この制度をきっかけに、ほかの支援制度についても質問できます。
          </p>
          {program.missingInformation.length > 0 && (
            <p className="mt-1 text-[11px] leading-5 text-blue-700">
              {`未確認の項目：${program.missingInformation.length}件（制度の詳細で確認できます）`}
            </p>
          )}
          {/* 金額・申請先・確認状態などの詳細は折りたたみ */}
          <details className="mt-2" data-testid="consult-program-details">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-full px-3 py-2 text-[11px] font-bold text-blue-700 hover:bg-blue-100">
              制度の詳細（概要・金額・申請先・確認状態）
            </summary>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-5 text-blue-800">
              <li>{`・概要（${program.mock ? "要確認" : "確認済み"}）：${program.summary}`}</li>
              <li>{`・金額（${program.mock ? "要確認" : "確認済み"}）：${program.amountDescription}`}</li>
              <li>{`・申請先（${program.mock ? "要確認" : "確認済み"}）：${program.where ?? "未確認"}`}</li>
              <li>{`・申請期限・時期（${program.mock ? "要確認" : "確認済み"}）：${program.deadlineNote ?? "未確認"}`}</li>
              <li>{`・確認状態：${program.verification !== undefined ? VERIFICATION_LABELS[program.verification].text : program.mock ? "未確認（モックデータ）" : "確認済み"}`}</li>
              <li>{`・確認日：${program.checkedAt ?? "未確認"}`}</li>
              {program.missingInformation.length > 0 && (
                <li>{`・判定に不足している情報：${program.missingInformation.join("、")}`}</li>
              )}
            </ul>
          </details>
        </div>
      ) : (
        <div
          className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3"
          data-testid="consult-free-context"
        >
          <p className="text-xs leading-5 text-blue-800">
            制度を指定しない自由な相談です。気になる支援制度について、自由に質問してください。
          </p>
        </div>
      )}

      {/* 回答モードの注意書き（M7-M: 実AI/モックの説明はこの1つに集約。実態と一致させ、混在させない）。
          会話が始まった後は折りたたみ、実際の回答モードは各回答のバッジで区別する */}
      {hasConversation ? (
        <details
          className="mt-3 rounded-xl bg-rose-50"
          data-testid="consult-mode-notice-details"
        >
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-xl px-4 py-3 text-xs font-bold text-rose-700">
            回答モード・注意事項
          </summary>
          <p
            className="px-4 pb-3 text-xs leading-5 text-rose-700"
            data-testid="consult-mode-notice"
          >
            {modeNoticeText}
          </p>
        </details>
      ) : (
        <p
          className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700"
          data-testid="consult-mode-notice"
        >
          {modeNoticeText}
        </p>
      )}

      {/* 会話表示 */}
      <ul className="mt-4 space-y-3" data-testid="consult-messages">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onOpenSupports={onOpenSupports}
          />
        ))}
      </ul>

      {/* 送信中・エラーの状態表示 */}
      {sending && (
        <p
          className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-xs text-blue-700"
          data-testid="consult-sending"
        >
          回答を準備しています…（送信中は次の質問を送信できません）
        </p>
      )}
      {error && (
        <div
          className="mt-3 rounded-xl bg-rose-50 px-4 py-3"
          data-testid="consult-error"
        >
          <p className="text-xs font-semibold text-rose-700">{error}</p>
          {retryable && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              data-testid="consult-retry"
              className="mt-2 rounded-full border border-rose-300 bg-white px-4 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100"
            >
              再試行する
            </button>
          )}
        </div>
      )}

      {/* 個人情報・外部送信の注意（M7-M: 質問入力欄の近くに短い注意を常に表示し、詳細は折りたたみ。
          外部AIへの送信が行われることは折りたたみの中だけに隠さず、短い文で必ず案内する） */}
      <div
        className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"
        data-testid="consult-privacy-notice"
      >
        <p className="text-xs font-bold text-amber-800">
          ご入力の前にご確認ください（個人情報の取り扱い）
        </p>
        <p className="mt-1.5 text-[11px] leading-5 text-amber-900/90">
          {liveAiState === true
            ? PRIVACY_SHORT_NOTICE.live
            : liveAiState === false
              ? PRIVACY_SHORT_NOTICE.mock
              : PRIVACY_SHORT_NOTICE.unknown}
          自動マスキングは完全ではありません。
        </p>
        <details className="mt-2" data-testid="consult-privacy-details">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-full px-3 py-2 text-[11px] font-bold text-amber-800 hover:bg-amber-100">
            個人情報の取り扱いの詳細
          </summary>
          <ul className="mt-1 space-y-1 text-[11px] leading-5 text-amber-900/90">
            <li>
              ・氏名・住所・電話番号・メールアドレス・個人番号（マイナンバー）・口座情報など、相談に不要な個人情報は入力しないでください。
            </li>
            <li>
              ・入力内容には自動で伏せ字（マスク）をかける仕組みがありますが、完全な検出ではありません。氏名・住所・表記ゆれなどは伏せ字にできないことがあります。
            </li>
            <li>
              {liveAiState === true
                ? PRIVACY_TRANSMISSION_NOTICE.live
                : liveAiState === false
                  ? PRIVACY_TRANSMISSION_NOTICE.mock
                  : PRIVACY_TRANSMISSION_NOTICE.unknown}
            </li>
            {userContext && (
              <li>
                ・シミュレーションの入力情報のうち、相談に必要な範囲（お子さまの人数・世帯年収の入力有無・利用中の制度）のみを利用しています。
              </li>
            )}
            <li>
              ・シミュレーションの入力フォームで入力した金額（収入・貯蓄など）は相談機能に渡していません。ただし、質問文に自分で書いた金額は相談の本文として扱われます。
            </li>
            <li>
              ・会話履歴はこのブラウザのメモリ上にのみ保持されます（localStorage・サーバー等には保存しません）。
              <span className="font-semibold text-amber-900">
                ページをリロードすると会話履歴は消えます。
              </span>
            </li>
          </ul>
        </details>
      </div>

      {/* 質問入力 */}
      <form onSubmit={handleSubmit} className="mt-4">
        <label htmlFor="consult-input" className="text-xs font-bold text-slate-700">
          質問を入力
        </label>
        <textarea
          id="consult-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          rows={3}
          placeholder="例）申請はどこですればいい？"
          data-testid="consult-input"
          className="mt-1.5 w-full resize-y rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-6 text-slate-800 placeholder:text-slate-300 focus:border-blue-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending}
          data-testid="consult-send"
          className="mt-2 min-h-11 w-full rounded-full bg-blue-500 px-6 py-3 text-sm font-bold text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:opacity-50 sm:w-auto"
        >
          {sending ? "送信中…" : "送信する"}
        </button>
      </form>

      {/* 質問例（M7-M: クリックで送信するチップ表示。既存の送信動作を維持し、44px以上のタップ領域） */}
      <div className="mt-5 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <p className="text-xs font-bold text-slate-700">
          質問例（クリックで送信できます）
        </p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {MOCK_CONSULT_EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => onSend(example)}
                disabled={sending}
                data-testid="consult-example"
                className="min-h-11 rounded-full border border-blue-200 bg-blue-50 px-4 py-2.5 text-left text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* 下部の誘導は1つだけ（M7-M: 重複リンクを廃止。戻る導線は上部の1つで足りる） */}
      <div className="mt-5 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <p className="text-xs font-bold text-slate-700">
          制度一覧・公式情報へのリンク
        </p>
        <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
          制度一覧は結果画面で確認できます。実際の受給資格・金額・申請期限・必要書類は、
          お住まいの自治体の窓口や公式情報を必ずご確認ください。
        </p>
        <button
          type="button"
          onClick={onOpenSupports}
          data-testid="consult-open-supports"
          className="mt-2 min-h-11 rounded-full border border-blue-500 px-4 py-2 text-xs font-bold text-blue-600 hover:bg-blue-50"
        >
          結果画面で支援制度一覧を見る
        </button>
      </div>
    </div>
  );
}