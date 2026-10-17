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
 * 【個人情報の注意表示（P9-4 / P10-1）】
 * - 質問入力欄付近で、入力してはいけない個人情報・マスクの限界・
 *   質問文中の金額や個人情報の取り扱いを案内する
 * - 外部送信の説明は環境の実態（GET /api/consult の liveAiEnabled。POST と
 *   同じ 2 重スイッチ判定）に合わせて切り替える。ライブ AI 有効時は
 *   質問文・会話履歴が外部 AI（INIAD AI-MOP API）へ送信されることを
 *   送信前に案内し、「送信していない」という実態と矛盾する表示をしない
 *   （状態未確認時は安全側＝送信され得る前提の表示。API キー等は表示しない）
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
        出典（公式情報KBで確認した資料）
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
              <button
                type="button"
                onClick={onOpenSupports}
                data-testid="consult-related-program"
                className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
              >
                {p.name}
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
 * 外部 AI への送信状況の説明文（送信前・質問入力欄の直前。P10-1）。
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
 * 回答モードの注意書き（上部の赤い注意書き。実行モードと一致させる）
 * - live: 外部 AI（INIAD AI-MOP API）の生成応答であることを明示する
 * - mock: 従来どおり開発用モックサンプルであることを明示する
 * - unknown: 環境状態が未確認のときは、どちらとも断定しない（特に
 *   「AI が回答している」と断定しない）。実際の種類は各回答のバッジで区別する
 */
const MODE_NOTICE: Record<"live" | "mock" | "unknown", string> = {
  live: "この相談アシスタントの回答は、外部の生成 AI サービス（INIAD AI-MOP API）が生成した応答です。AI による検索や公式サイトの検索を行った結果ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認であり、確定情報として回答することはありません。回答の種類（AI・モック）は各回答のバッジで区別しています。",
  mock: "この相談アシスタントの回答は開発用のモックサンプルです。AI による検索や公式サイトの検索を行った結果ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認であり、確定情報として回答することはありません。",
  unknown:
    "この相談アシスタントの回答は、環境の設定によっては開発用のモックサンプルの場合と AI 生成応答の場合があります。AI による検索や公式サイトの検索を行った結果ではありません。制度の受給資格・金額・申請期限・必要書類などは未確認であり、確定情報として回答することはありません。実際の種類（AI・モック）は各回答のバッジで区別しています。",
};

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

  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6" data-testid="consult-screen">
      {/* ヘッダー（戻る・リセット） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          data-testid="consult-back"
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          ← 結果画面に戻る
        </button>
        <button
          type="button"
          onClick={onReset}
          data-testid="consult-reset"
          className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          会話をリセット
        </button>
      </div>

      <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">
        支援制度の相談
      </h1>

      {/* 制度カードから開始された場合の引き継ぎ情報 */}
      {program ? (
        <div
          className="mt-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3"
          data-testid="consult-program-context"
        >
          <p className="text-xs font-bold text-blue-800">
            「{program.name}」についての相談から開始しています
            {program.mock && (
              <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-600">
                モック・未確認
              </span>
            )}
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[11px] leading-5 text-blue-800">
            <li>・概要（要確認）：{program.summary}</li>
            <li>・金額（要確認）：{program.amountDescription}</li>
            <li>・申請先（要確認）：{program.where ?? "未確認"}</li>
          </ul>
          <p className="mt-1.5 text-[11px] leading-5 text-blue-700">
            この制度は相談のきっかけにすぎません。この制度以外の支援制度についても自由に質問できます。
          </p>
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

      {/* 実行モード（モック/ライブ AI）に応じた注意書きを必ず明示。状態が未確認のときはどちらとも断定しない */}
      <p
        className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700"
        data-testid="consult-mode-notice"
      >
        {liveAiState === true
          ? MODE_NOTICE.live
          : liveAiState === false
            ? MODE_NOTICE.mock
            : MODE_NOTICE.unknown}
      </p>

      {/* 会話履歴の取り扱いの明示 */}
      <p className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        会話履歴はこのブラウザのメモリ上にのみ保持されます（localStorage・サーバー等には保存しません）。
        <span className="font-semibold text-slate-800">
          ページをリロードすると会話履歴は消えます。
        </span>
      </p>

      {/* 相談に利用する入力情報の範囲（フォームの金額と質問文中の金額を区別する） */}
      {userContext && (
        <p className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-[11px] leading-5 text-slate-500">
          シミュレーションの入力情報のうち、相談に必要な範囲（お子さまの人数・世帯年収の入力有無・利用中の制度）のみを利用しています。
          シミュレーションの入力フォームで入力した金額（収入・貯蓄など）は相談機能に渡していません。ただし、質問文に自分で書いた金額は相談の本文として扱われます。
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

      {/* 初めて使う人向けの質問例 */}
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
                className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-left text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* 個人情報の取り扱いの注意（質問入力欄の直前で確認できるようにする） */}
      <div
        className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"
        data-testid="consult-privacy-notice"
      >
        <p className="text-xs font-bold text-amber-800">
          ご入力の前にご確認ください（個人情報の取り扱い）
        </p>
        <ul className="mt-2 space-y-1 text-[11px] leading-5 text-amber-900/90">
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
        </ul>
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
          className="mt-2 w-full rounded-full bg-blue-500 px-6 py-3 text-sm font-bold text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:opacity-50 sm:w-auto"
        >
          {sending ? "送信中…" : "送信する"}
        </button>
      </form>

      {/* 関連制度・公式情報の確認導線 */}
      <div className="mt-5 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <p className="text-xs font-bold text-slate-700">
          関連する支援制度・公式情報の確認
        </p>
        <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
          モックデータに基づく制度一覧は結果画面で確認できます。実際の受給資格・金額・申請期限・必要書類は、
          お住まいの自治体の窓口や公式情報を必ずご確認ください。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenSupports}
            data-testid="consult-open-supports"
            className="rounded-full border border-blue-500 px-4 py-2 text-xs font-bold text-blue-600 hover:bg-blue-50"
          >
            結果画面の支援制度一覧を見る
          </button>
          <button
            type="button"
            onClick={onBack}
            data-testid="consult-back-bottom"
            className="rounded-full border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            結果画面に戻る
          </button>
        </div>
      </div>
    </div>
  );
}