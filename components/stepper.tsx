"use client"

import { Check } from "lucide-react"
import { STEPS } from "@/lib/types"
import { useWorkflow } from "@/lib/workflow-context"
import { cn } from "@/lib/utils"

const ORDER = STEPS.map((s) => s.id)

export function Stepper() {
  const { currentStep, setCurrentStep } = useWorkflow()
  const currentIndex = ORDER.indexOf(currentStep)

  return (
    <nav aria-label="Các bước trong pipeline" className="flex items-center gap-1 overflow-x-auto">
      {STEPS.map((step, i) => {
        const done = i < currentIndex
        const active = i === currentIndex
        return (
          <button
            key={step.id}
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
        )
      })}
    </nav>
  )
}
