"use client"

import { Check } from "lucide-react"
import { STEPS, type StepPhase } from "@/lib/types"
import { useWorkflow } from "@/lib/workflow-context"
import { cn } from "@/lib/utils"

const ORDER = STEPS.map((s) => s.id)

// One line under the rail instead of a header per phase group — the phase
// structure (what runs once vs. what repeats per figure) is stated once in
// prose rather than repeated as a label over every step in that phase.
const PHASE_CAPTION =
  "Upload → Schema → Materials chạy 1 lần cho paper này. Digitize → Fill Values → Review lặp lại cho mỗi figure. Dataset chạy 1 lần ở cuối."

export function Stepper() {
  const { currentStep, setCurrentStep, figures, selectedFigure } = useWorkflow()
  const currentIndex = ORDER.indexOf(currentStep)
  const figureIndex = selectedFigure
    ? figures.findIndex((f) => f.id === selectedFigure.id)
    : -1
  const currentPhase: StepPhase | undefined = STEPS[currentIndex]?.phase

  // Progress fill runs to the midpoint of the current step's dot, matching
  // how a progress bar reads ("this much done, this much left") rather than
  // stopping short of it or overshooting into the next step.
  const fillPct =
    STEPS.length > 1 ? (currentIndex / (STEPS.length - 1)) * 100 : 0

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pipeline
        </span>
        {currentPhase === "figure" && figures.length > 0 && (
          <span className="font-mono text-xs text-foreground">
            Figure <span className="font-semibold text-primary">{figureIndex >= 0 ? figureIndex + 1 : "–"}</span>
            {" "}/ {figures.length}
            {selectedFigure ? ` · ${selectedFigure.label}` : ""}
          </span>
        )}
      </div>

      <nav aria-label="Các bước trong pipeline" className="relative">
        <div className="pointer-events-none absolute left-[14px] right-[14px] top-[13px] h-px bg-border" />
        <div
          className="pointer-events-none absolute left-[14px] top-[13px] h-px bg-primary transition-[width] duration-300"
          style={{ width: `calc((100% - 28px) * ${fillPct / 100})` }}
        />
        <ol className="relative flex items-start">
          {STEPS.map((step, i) => {
            const done = i < currentIndex
            const active = i === currentIndex
            return (
              <li key={step.id} className="flex flex-1 basis-0 flex-col items-center first:items-start last:items-end">
                <button
                  type="button"
                  onClick={() => setCurrentStep(step.id)}
                  aria-current={active ? "step" : undefined}
                  className="group flex flex-col items-center gap-2"
                >
                  <span
                    className={cn(
                      "relative z-10 flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 bg-card text-[11px] font-medium tabular-nums transition-colors",
                      done && "border-primary bg-primary text-primary-foreground",
                      active && "border-primary text-primary ring-4 ring-primary/15",
                      !done && !active && "border-border text-muted-foreground group-hover:border-primary/40",
                    )}
                  >
                    {done ? <Check className="size-3.5" /> : step.index}
                  </span>
                  <span
                    className={cn(
                      "max-w-[76px] text-center text-[11.5px] leading-tight transition-colors",
                      active ? "font-semibold text-foreground" : "text-muted-foreground group-hover:text-foreground",
                      done && "text-muted-foreground",
                    )}
                  >
                    {step.title}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <p className="mt-4 border-t border-dashed border-border pt-3 text-xs leading-relaxed text-muted-foreground">
        {PHASE_CAPTION}
      </p>
    </div>
  )
}
