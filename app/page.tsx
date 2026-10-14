'use client'

import { useState } from 'react'
import Top from '@/components/Top'
import Form from '@/components/Form'
import Result from '@/components/Result'
import Consult from '@/components/Consult'
import {
  toConsultContextProgram,
  type ConsultSession,
} from '@/lib/consult/conversation'
import { useConsultChat } from '@/lib/consult/useConsultChat'
import type { ConsultContextProgram } from '@/lib/consult/types'
import type { SimulationInput } from '@/lib/simulation'
import type { SupportProgram } from '@/lib/types/support'

/** 画面の切り替え状態（SPAライクな遷移） */
type Step = 'top' | 'form' | 'result' | 'consult'

export default function Home() {
  const [step, setStep] = useState<Step>('top')
  const [input, setInput] = useState<SimulationInput | null>(null)
  /**
   * 相談対象の制度（M5）。
   * - 制度カードの「この制度について相談する」→ 制度情報を引き継いで相談開始
   * - 「支援制度の相談（制度を指定せず）」→ null で自由な相談を開始
   * 制度は相談のきっかけにすぎず、相談画面では他の制度も自由に質問できる。
   */
  const [consultTarget, setConsultTarget] = useState<ConsultContextProgram | null>(null)
  /** 相談の会話状態（メモリのみ。リロードで消える） */
  const chat = useConsultChat()

  /** 相談に渡す最小限の入力情報（金額は渡さない） */
  const buildConsultSession = (program: SupportProgram | null): ConsultSession => ({
    program: program ? toConsultContextProgram(program) : null,
    userContext: input
      ? {
          childCount: input.childCount,
          hasAnnualIncome: input.household.annualIncomeYen !== null,
          usedProgramIds: input.household.usedSupportProgramIds,
        }
      : null,
  })

  /** 相談開始（自由な相談 / 制度カードからの相談の2つの入口） */
  const handleConsult = (program: SupportProgram | null) => {
    const session = buildConsultSession(program)
    chat.startSession(session)
    setConsultTarget(session.program)
    setStep('consult')
  }

  /** アンケート送信時：入力値を保存して結果画面へ */
  const handleSubmit = (values: SimulationInput) => {
    setInput(values)
    setConsultTarget(null)
    chat.clear()
    setStep('result')
  }

  /** 「最初からやり直す」：すべてリセットしてトップへ */
  const handleReset = () => {
    setInput(null)
    setConsultTarget(null)
    chat.clear()
    setStep('top')
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-slate-50 via-white to-blue-50">
      {/* ヘッダー */}
      <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-500 text-sm font-black text-white shadow-sm">
              ¥
            </span>
            <span className="text-sm font-bold text-slate-800">
              養育費・公的支援シミュレーター
            </span>
          </div>
          {step !== 'top' && (
            <div className="flex items-center gap-2">
              {step === 'result' && (
                <button
                  type="button"
                  onClick={() => handleConsult(null)}
                  data-testid="header-consult-button"
                  className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-bold text-blue-600 hover:bg-blue-100"
                >
                  支援制度の相談
                </button>
              )}
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                {step === 'form'
                  ? 'STEP 1 / 2'
                  : step === 'result'
                    ? 'STEP 2 / 2'
                    : '相談'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* 画面本体（状態に応じてコンポーネントを切り替え） */}
      <main className="flex flex-1 flex-col">
        {step === 'top' && <Top onStart={() => setStep('form')} />}
        {step === 'form' && (
          <Form onSubmit={handleSubmit} onBack={() => setStep('top')} />
        )}
        {step === 'result' && input && (
          <Result
            input={input}
            onEdit={() => setStep('form')}
            onReset={handleReset}
            onConsult={handleConsult}
          />
        )}
        {step === 'consult' && (
          <Consult
            program={consultTarget}
            userContext={
              input
                ? {
                    childCount: input.childCount,
                    hasAnnualIncome: input.household.annualIncomeYen !== null,
                    usedProgramIds: input.household.usedSupportProgramIds,
                  }
                : null
            }
            messages={chat.messages}
            sending={chat.sending}
            error={chat.error}
            onSend={(text) => void chat.send(text)}
            onReset={chat.reset}
            onRetry={() => void chat.retry()}
            retryable={chat.retryable}
            onBack={() => setStep('result')}
            onOpenSupports={() => setStep('result')}
          />
        )}
      </main>

      {/* フッター */}
      <footer className="border-t border-slate-100 bg-white/70">
        <p className="mx-auto w-full max-w-3xl px-5 py-4 text-center text-xs leading-5 text-slate-400">
          ※ 本アプリはプロトタイプです。表示される支援額はモックデータに基づく試算であり、
          実際の支給額・制度とは異なります。
        </p>
      </footer>
    </div>
  )
}
