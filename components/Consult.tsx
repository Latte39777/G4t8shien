"use client";

/**
 * 支援制度の相談画面（M5）
 *
 * - 自由な相談（制度を指定しない）と、制度カードからの相談の2つの入口に対応
 * - 応答はモック（開発用サンプル）。UI と応答生成（lib/consult/provider.ts）を分離
 * - 会話履歴はブラウザのメモリ上のみ（リロードで消える旨を画面に明示）
 * - モック・未確認情報はバッジ等で明確に区別する
 * - スマートフォンでも使いやすい縦積みレイアウト
 */
import { useState, type FormEvent } from "react";
import { MOCK_CONSULT_EXAMPLES } from "@/lib/consult/mockAdvisor";
import type {
  ChatMessage,
  ConsultContextProgram,
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
};

/** 関連制度チップ（モック/確認済みを区別して表示） */
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
        {message.relatedPrograms.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={onOpenSupports}
              data-testid="consult-related-program"
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
            >
              {p.name}
              {p.sourceType === "mock" ? (
                <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-bold text-rose-600">
                  モック・未確認
                </span>
              ) : (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">
                  検証済み
                </span>
              )}
            </button>
          </li>
        ))}
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
            {message.isMock && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[9px] font-bold text-rose-600">
                開発用モックサンプル
              </span>
            )}
            {message.sourceType === "ai" && (
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
        <p
          className={`whitespace-pre-wrap text-xs leading-5 ${
            isUser ? "text-white" : "text-slate-700"
          }`}
        >
          {/* 本文はプレーンテキストとして描画する。
              AI が挙げた URL は出典ではないためアンカー（リンク）化しない */}
          {message.text}
        </p>
        {!isUser && (
          <RelatedChips message={message} onOpenSupports={onOpenSupports} />
        )}
      </div>
    </li>
  );
}

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
}: ConsultProps) {
  const [draft, setDraft] = useState("");

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

      {/* モック応答であることを必ず明示 */}
      <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">
        この相談アシスタントの回答は開発用のモックサンプルです。AI による検索や公式サイトの検索を行った結果ではありません。
        制度の受給資格・金額・申請期限・必要書類などは未確認であり、確定情報として回答することはありません。
      </p>

      {/* 会話履歴の取り扱いの明示 */}
      <p className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
        会話履歴はこのブラウザのメモリ上にのみ保持されます（localStorage・サーバー等には保存しません）。
        <span className="font-semibold text-slate-800">
          ページをリロードすると会話履歴は消えます。
        </span>
      </p>

      {/* 相談に利用する入力情報の範囲 */}
      {userContext && (
        <p className="mt-2 rounded-xl bg-slate-50 px-4 py-3 text-[11px] leading-5 text-slate-500">
          シミュレーションの入力情報のうち、相談に必要な範囲（お子さまの人数・世帯年収の入力有無・利用中の制度）のみを利用しています。
          収入・貯蓄などの金額は相談機能に渡していません。
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