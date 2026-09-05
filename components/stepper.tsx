"use client"

import { Check } from "lucide-react"
import { STEPS, type StepPhase } from "@/lib/types"
import { useWorkflow } from "@/lib/workflow-context"
import { cn } from "@/lib/utils"

const ORDER = STEPS.map((s) => s.id)

const PHASE_LABEL: Record<StepPhase, string> = {
  setup: "Thiết lập (1 lần)",
  figure: "Xử lý figure (lặp lại)",
  export: "Xuất dữ liệu",
}

export function Stepper() {
  const { currentStep, setCurrentStep, figures, selectedFigure } = useWorkflow()
  const currentIndex = ORDER.indexOf(currentStep)
  const figureIndex = selectedFigure
    ? figures.findIndex((f) => f.id === selectedFigure.id)
    : -1

  let lastPhase: StepPhase | null = null

  return (
    <nav aria-label="Các bước trong pipeline" className="flex items-center gap-1 overflow-x-auto">
      {STEPS.map((step, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        const isNewGroup = step.phase !== lastPhase
        lastPhase = step.phase

        return (
          <div key={step.id} className="flex shrink-0 items-center">
            {isNewGroup && (
              <div className="mr-1 flex shrink-0 flex-col items-start justify-center gap-0.5 self-stretch border-r border-border pr-2">
                <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {PHASE_LABEL[step.phase]}
                </span>
                {step.phase === "figure" && figures.length > 0 && (
                  <span className="whitespace-nowrap text-[10px] font-medium text-primary">
                    {figureIndex >= 0
                      ? `Figure ${figureIndex + 1}/${figures.length}${
                          selectedFigure ? ` · ${selectedFigure.label}` : ""
                        }`
                      : `${figures.length} figure`}
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setCurrentStep(step.id)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "group flex shrink-0 flex-col items-center gap-1 rounded-lg px-3 py-2 text-center transition-colors",
                active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50",
              )}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary",
                  !done && !active && "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3.5" /> : step.index}
              </span>
              <span className="flex flex-col leading-tight">
                <span
                  className={cn(
                    "text-xs font-medium",
                    active ? "text-sidebar-foreground" : "text-sidebar-foreground/80",
                  )}
                >
                  {step.title}
                </span>
              </span>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
