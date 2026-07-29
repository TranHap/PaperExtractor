"use client";

import { FlaskConical, Moon, RotateCcw, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme-context";
import { useWorkflow } from "@/lib/workflow-context";

export function AppHeader() {
  const { resolvedTheme, setTheme } = useTheme();
  const { reset } = useWorkflow();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <FlaskConical className="size-5" aria-hidden="true" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold text-foreground">
              Paper Data Extractor
            </h1>
            {/* <p className="text-xs text-muted-foreground">ChatGPT-powered figure digitization workflow</p> */}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            {resolvedTheme === "dark" ? (
              <Sun className="size-4" aria-hidden="true" />
            ) : (
              <Moon className="size-4" aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  "Reset the entire workflow? All extracted data will be lost.",
                )
              )
                reset();
            }}
          >
            <RotateCcw className="mr-2 size-4" aria-hidden="true" />
            Reset
          </Button>
        </div>
      </div>
    </header>
  );
}
