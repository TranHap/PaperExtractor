"use client";

import { useWorkflow } from "@/lib/workflow-context";
import { STEPS } from "@/lib/types";
import { Stepper } from "@/components/stepper";
import { AppHeader } from "@/components/app-header";
import { SchemaStep } from "@/components/steps/schema-step";
import { ParseStep } from "@/components/steps/parse-step";
import { PaperCharacteristicsStep } from "@/components/steps/paper-characteristics-step";
import { FiguresVariablesStep } from "@/components/steps/figures-variables-step";
import { FigureValuesStep } from "@/components/steps/figure-values-step";
// import { ImageParamsStep } from "@/components/steps/image-params-step";
import { DigitizeStep } from "@/components/steps/digitize-step";
import { MergeStep } from "@/components/steps/merge-step";
import { DatasetStep } from "@/components/steps/dataset-step";

export function Workflow() {
  const { currentStep } = useWorkflow();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="rounded-xl border border-border bg-card p-4">
          <Stepper />
        </div>
        <div className="mt-6 min-w-0 rounded-xl border border-border bg-card p-6">
          {currentStep === "schema" && <SchemaStep />}
          {currentStep === "parse" && <ParseStep />}
          {currentStep === "paper-characteristics" && (
            <PaperCharacteristicsStep />
          )}
          {currentStep === "figures-variables" && <FiguresVariablesStep />}
          {currentStep === "figure-values" && <FigureValuesStep />}
          {/* {currentStep === "image-params" && <ImageParamsStep />} */}
          {currentStep === "digitize" && <DigitizeStep />}
          {currentStep === "merge" && <MergeStep />}
          {currentStep === "dataset" && <DatasetStep />}
        </div>
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        {STEPS.length}-step workflow · dữ liệu chỉ lưu trong phiên làm việc này
      </footer>
    </div>
  );
}
