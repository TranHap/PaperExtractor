"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const ThemeCtx = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyThemeToHtml(theme: Theme, resolvedTheme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (theme === "system") {
    if (resolvedTheme === "dark") {
      root.classList.add("dark");
    }
  } else {
    root.classList.add(theme);
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const initial = stored ?? "system";
    setThemeState(initial);
    const resolved = initial === "system" ? getSystemTheme() : initial;
    setResolvedTheme(resolved);
    applyThemeToHtml(initial, resolved);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (initial === "system") {
        const sys = getSystemTheme();
        setResolvedTheme(sys);
        applyThemeToHtml(initial, sys);
      }
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const setTheme = (t: Theme) => {
    localStorage.setItem("theme", t);
    setThemeState(t);
    const resolved = t === "system" ? getSystemTheme() : t;
    setResolvedTheme(resolved);
    applyThemeToHtml(t, resolved);
  };

  return (
    <ThemeCtx.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx)
    throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
