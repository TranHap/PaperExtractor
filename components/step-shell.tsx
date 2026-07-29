"use client"

import type React from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

interface StepShellProps {
  step: number
  total: number
  title: string
  description: string
  children: React.ReactNode
  onBack?: () => void
  onNext?: () => void
  backLabel?: string
  nextLabel?: string
  nextDisabled?: boolean
  nextLoading?: boolean
  hideBack?: boolean
  hideNext?: boolean
}

export function StepShell({
  step,
  total,
  title,
  description,
  children,
  onBack,
  onNext,
  backLabel = "Quay lại",
  nextLabel = "Tiếp tục",
  nextDisabled,
  nextLoading,
  hideBack,
  hideNext,
}: StepShellProps) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border px-6 py-5 md:px-10">
        <p className="text-xs font-medium uppercase tracking-wider text-primary">
          Bước {step} / {total}
        </p>
        <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">{description}</p>
      </header>

      <div className="flex-1 px-6 py-6 md:px-10">{children}</div>

      <footer className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background/80 px-6 py-4 backdrop-blur md:px-10">
        <div>
          {!hideBack && (
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="size-4" />
              <span>{backLabel}</span>
            </Button>
          )}
        </div>
        <div>
          {!hideNext && (
            <Button onClick={onNext} disabled={nextDisabled || nextLoading}>
              {nextLoading ? (
                <span>Đang xử lý...</span>
              ) : (
                <span>{nextLabel}</span>
              )}
              {!nextLoading && <ArrowRight className="size-4" />}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}
