"use client";

import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import {
  Crosshair,
  Plus,
  Trash2,
  Undo2,
  Redo2,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Square,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type {
  AxisCalibration,
  DigitizedPoint,
  Digitization,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Pending = "x1" | "x2" | "y1" | "y2" | "point" | null;

function getSeriesColor(index: number): string {
  const hue = (index * 137.508) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

interface RefPoint {
  fx: number;
  fy: number;
}

function mapAxis(
  cal: AxisCalibration | undefined,
  frac: number,
): number | null {
  if (!cal) return null;
  const f1 = cal.p1.px;
  const f2 = cal.p2.px;
  if (f1 === f2) return null;
  const t = (frac - f1) / (f2 - f1);
  if (cal.log) {
    const l1 = Math.log10(cal.p1.value);
    const l2 = Math.log10(cal.p2.value);
    return Math.pow(10, l1 + t * (l2 - l1));
  }
  return cal.p1.value + t * (cal.p2.value - cal.p1.value);
}

// Rehydrates the draggable reference-point markers from a previously
// committed AxisCalibration, so re-opening a figure that was already
// calibrated shows the same X1/X2/Y1/Y2 handles instead of forcing the
// user to recalibrate from scratch. Note the x/y swap for the y-axis:
// yCal stores p.px as the "along axis" (vertical) fraction and p.py as
// the perpendicular (horizontal) fraction — see the yCal useMemo below.
function refPointsFromCal(
  cal: AxisCalibration | undefined,
  axis: "x" | "y",
): (RefPoint | null)[] {
  if (!cal) return [null, null];
  if (axis === "x") {
    return [
      { fx: cal.p1.px, fy: cal.p1.py },
      { fx: cal.p2.px, fy: cal.p2.py },
    ];
  }
  return [
    { fx: cal.p1.py, fy: cal.p1.px },
    { fx: cal.p2.py, fy: cal.p2.px },
  ];
}

function valsFromCal(cal: AxisCalibration | undefined): [string, string] {
  if (!cal) return ["", ""];
  return [String(cal.p1.value), String(cal.p2.value)];
}

function isValidNumberStr(s: string): boolean {
  if (s.trim() === "") return false;
  return Number.isFinite(Number(s));
}

export function FigureDigitizer({
  value,
  onChange,
}: {
  value: Digitization;
  onChange: (d: Digitization) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<Pending>(null);

  const MIN_SCALE = 1;
  const MAX_SCALE = 12;

  // translate is the pixel offset of the (unscaled) image's top-left corner
  // relative to the container's top-left corner. Combined with `scale`, the
  // on-screen box of the image is [translate.x, translate.x + rect.width*scale].
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panStartTranslate = useRef({ x: 0, y: 0 });
  const didPanRef = useRef(false);
  const draggingRef = useRef<{
    axis: "x" | "y";
    idx: 0 | 1;
  } | null>(null);

  // Dragging an already-digitized data point to fix a mis-click, instead of
  // forcing delete + re-add.
  const draggingPointRef = useRef<number | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    index: number;
    fx: number;
    fy: number;
  } | null>(null);

  // Holding Space (or holding the middle mouse button) always pans the
  // canvas, no matter what tool/mode is active — mirrors the convention
  // from Figma/Photoshop/etc. This gives an unambiguous way to move the
  // image around without ever risking placing/dragging a point.
  const [spacePressed, setSpacePressed] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (isTyping) return;
      e.preventDefault();
      setSpacePressed(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Multi-level undo/redo history over `value.points` snapshots.
  const [past, setPast] = useState<DigitizedPoint[][]>([]);
  const [future, setFuture] = useState<DigitizedPoint[][]>([]);

  // Touch support (mobile/tablet): mirrors the mouse pan/zoom/click/drag
  // handlers below.
  const touchModeRef = useRef<
    "pan" | "pinch" | "drag-ref" | "drag-point" | null
  >(null);
  const pinchStartRef = useRef<{
    dist: number;
    scale: number;
    center: { x: number; y: number };
    translate: { x: number; y: number };
  } | null>(null);
  const lastTouchRef = useRef({ x: 0, y: 0 });

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    new Set(),
  );

  // Keeps the translated image from being panned further than its edges.
  const clampTranslate = useCallback(
    (s: number, t: { x: number; y: number }, width: number, height: number) => {
      const minX = Math.min(0, width - width * s);
      const minY = Math.min(0, height - height * s);
      return {
        x: Math.max(minX, Math.min(0, t.x)),
        y: Math.max(minY, Math.min(0, t.y)),
      };
    },
    [],
  );

  // Converts a client (viewport) coordinate to a 0..1 fraction of the image,
  // accounting for current pan/zoom. Shared by mouse and touch handlers.
  const fracFromClient = useCallback(
    (clientX: number, clientY: number, clamp = true) => {
      const el = wrapRef.current;
      if (!el) return { fx: 0, fy: 0 };
      const rect = el.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      let fx = (mx - translate.x) / (scale * rect.width);
      let fy = (my - translate.y) / (scale * rect.height);
      if (clamp) {
        fx = Math.min(1, Math.max(0, fx));
        fy = Math.min(1, Math.max(0, fy));
      }
      return { fx, fy };
    },
    [translate, scale],
  );

  // Zooms towards a specific point (in container-relative px), keeping that
  // point visually fixed under the cursor — this is what makes zoom feel precise.
  const zoomAround = useCallback(
    (mx: number, my: number, factor: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setScale((prevScale) => {
        const nextScale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, prevScale * factor),
        );
        setTranslate((prevT) => {
          const ix = (mx - prevT.x) / prevScale;
          const iy = (my - prevT.y) / prevScale;
          const nextT = { x: mx - ix * nextScale, y: my - iy * nextScale };
          return clampTranslate(nextScale, nextT, rect.width, rect.height);
        });
        return nextScale;
      });
    },
    [clampTranslate],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!el.contains(e.target as Node)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAround(mx, my, factor);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle mouse button, or Space held down, always pans — regardless
      // of selection mode or a pending add-point/calibration action.
      const forcePan = e.button === 1 || spacePressed;
      if (e.button !== 0 && !forcePan) return;
      e.preventDefault();

      if (draggingRef.current || draggingPointRef.current !== null) return;

      if (selectionMode && !forcePan) {
        const el = wrapRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const fx = Math.min(
          1,
          Math.max(0, (mx - translate.x) / (scale * rect.width)),
        );
        const fy = Math.min(
          1,
          Math.max(0, (my - translate.y) / (scale * rect.height)),
        );
        setSelectionRect({ x1: fx, y1: fy, x2: fx, y2: fy });
        setSelectedIndices(new Set());
        return;
      }

      // NOTE: we deliberately do NOT bail out when `pending` is set. A
      // press-and-drag here still pans the canvas; handleClick below
      // decides whether the gesture ended up being a genuine drag (pan)
      // or a stationary tap (place the point/ref), using didPanRef.
      didPanRef.current = false;
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      panStartTranslate.current = { ...translate };
    },
    [selectionMode, translate, scale, spacePressed],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;

      if (selectionMode && selectionRect) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const fx = Math.min(
          1,
          Math.max(0, (mx - translate.x) / (scale * rect.width)),
        );
        const fy = Math.min(
          1,
          Math.max(0, (my - translate.y) / (scale * rect.height)),
        );
        setSelectionRect((prev) => (prev ? { ...prev, x2: fx, y2: fy } : null));
        return;
      }

      if (draggingPointRef.current !== null) {
        const { fx, fy } = fracFromClient(e.clientX, e.clientY);
        setDragPreview({ index: draggingPointRef.current, fx, fy });
        return;
      }

      if (draggingRef.current) {
        const rect = el.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const fx = Math.min(
          1,
          Math.max(0, (mx - translate.x) / (scale * rect.width)),
        );
        const fy = Math.min(
          1,
          Math.max(0, (my - translate.y) / (scale * rect.height)),
        );
        if (draggingRef.current!.axis === "x") {
          setXPts((prev) => {
            const next = [...prev] as (RefPoint | null)[];
            next[draggingRef.current!.idx] = { fx, fy };
            return next;
          });
        } else {
          setYPts((prev) => {
            const next = [...prev] as (RefPoint | null)[];
            next[draggingRef.current!.idx] = { fx, fy };
            return next;
          });
        }
        return;
      }

      if (!isPanning) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        didPanRef.current = true;
      }
      const rect = el.getBoundingClientRect();
      const nextT = {
        x: panStartTranslate.current.x + dx,
        y: panStartTranslate.current.y + dy,
      };
      setTranslate(clampTranslate(scale, nextT, rect.width, rect.height));
    },
    [
      selectionMode,
      selectionRect,
      isPanning,
      scale,
      clampTranslate,
      translate,
      fracFromClient,
    ],
  );

  const handleMouseUp = useCallback(() => {
    if (draggingPointRef.current !== null) {
      const idx = draggingPointRef.current;
      const preview = dragPreview;
      draggingPointRef.current = null;
      setDragPreview(null);
      if (preview && preview.index === idx) {
        const raw = value.points.map((p, i) =>
          i === idx
            ? { fx: preview.fx, fy: preview.fy, series: p.series }
            : { fx: p.px, fy: p.py, series: p.series },
        );
        commit(raw);
      }
      return;
    }
    if (selectionMode && selectionRect) {
      const x1 = Math.min(selectionRect.x1, selectionRect.x2);
      const y1 = Math.min(selectionRect.y1, selectionRect.y2);
      const x2 = Math.max(selectionRect.x1, selectionRect.x2);
      const y2 = Math.max(selectionRect.y1, selectionRect.y2);
      const nextSelected = new Set<number>();
      value.points.forEach((p, i) => {
        if (p.px >= x1 && p.px <= x2 && p.py >= y1 && p.py <= y2) {
          nextSelected.add(i);
        }
      });
      setSelectedIndices(nextSelected);
      setSelectionRect(null);
    } else {
      setIsPanning(false);
    }
    draggingRef.current = null;
  }, [selectionMode, selectionRect, value.points, dragPreview]);

  const resetView = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAround(rect.width / 2, rect.height / 2, 1.3);
  }, [zoomAround]);

  const zoomOut = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAround(rect.width / 2, rect.height / 2, 1 / 1.3);
  }, [zoomAround]);

  // Reference points. Lazily hydrated from value.xCal/yCal so re-opening an
  // already-calibrated figure (e.g. switching back after visiting another
  // figure) shows existing calibration instead of forcing a redo. Because
  // <FigureDigitizer> is remounted with a fresh key per figure, these
  // initializers run exactly once per figure.
  const [xPts, setXPts] = useState<(RefPoint | null)[]>(() =>
    refPointsFromCal(value.xCal, "x"),
  );
  const [yPts, setYPts] = useState<(RefPoint | null)[]>(() =>
    refPointsFromCal(value.yCal, "y"),
  );
  const [xVals, setXVals] = useState<[string, string]>(() =>
    valsFromCal(value.xCal),
  );
  const [yVals, setYVals] = useState<[string, string]>(() =>
    valsFromCal(value.yCal),
  );
  const [logX, setLogX] = useState(() => value.xCal?.log ?? false);
  const [logY, setLogY] = useState(() => value.yCal?.log ?? false);

  const xValsValid: [boolean, boolean] = [
    xVals[0] === "" || isValidNumberStr(xVals[0]),
    xVals[1] === "" || isValidNumberStr(xVals[1]),
  ];
  const yValsValid: [boolean, boolean] = [
    yVals[0] === "" || isValidNumberStr(yVals[0]),
    yVals[1] === "" || isValidNumberStr(yVals[1]),
  ];

  const xCal = useMemo<AxisCalibration | undefined>(() => {
    if (
      xPts[0] &&
      xPts[1] &&
      isValidNumberStr(xVals[0]) &&
      isValidNumberStr(xVals[1])
    ) {
      return {
        p1: { px: xPts[0].fx, py: xPts[0].fy, value: Number(xVals[0]) },
        p2: { px: xPts[1].fx, py: xPts[1].fy, value: Number(xVals[1]) },
        log: logX,
      };
    }
    return undefined;
  }, [xPts, xVals, logX]);

  const yCal = useMemo<AxisCalibration | undefined>(() => {
    if (
      yPts[0] &&
      yPts[1] &&
      isValidNumberStr(yVals[0]) &&
      isValidNumberStr(yVals[1])
    ) {
      return {
        p1: { px: yPts[0].fy, py: yPts[0].fx, value: Number(yVals[0]) },
        p2: { px: yPts[1].fy, py: yPts[1].fx, value: Number(yVals[1]) },
        log: logY,
      };
    }
    return undefined;
  }, [yPts, yVals, logY]);

  const calibrated = Boolean(xCal && yCal);

  function commit(
    nextPoints: { fx: number; fy: number; series: string }[],
    opts: { pushHistory?: boolean } = {},
  ) {
    const points: DigitizedPoint[] = nextPoints
      .map((p) => {
        const x = mapAxis(xCal, p.fx);
        const y = mapAxis(yCal, p.fy);
        if (x === null || y === null) return null;
        return { px: p.fx, py: p.fy, x, y, series: p.series };
      })
      .filter((p): p is DigitizedPoint => p !== null);
    if (opts.pushHistory !== false) {
      setPast((prev) => [...prev, value.points]);
      setFuture([]);
    }
    onChange({ ...value, xCal, yCal, points });
  }

  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setPast(past.slice(0, -1));
    setFuture((f) => [value.points, ...f]);
    onChange({ ...value, xCal, yCal, points: prev });
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setFuture(future.slice(1));
    setPast((p) => [...p, value.points]);
    onChange({ ...value, xCal, yCal, points: next });
  }

  function handleClick(e: React.MouseEvent) {
    // Read-then-clear: this is the first point after mouseup where it's
    // safe to know "did this gesture just pan the canvas?" — clearing it
    // here (not in mouseup) matters because mouseup fires before click.
    const didPan = didPanRef.current;
    didPanRef.current = false;
    if (selectionMode) return;
    if (spacePressed || didPan) return;
    if (!pending || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const fx = (mx - translate.x) / (scale * rect.width);
    const fy = (my - translate.y) / (scale * rect.height);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;

    if (pending === "x1" || pending === "x2") {
      const idx = pending === "x1" ? 0 : 1;
      const next = [...xPts];
      next[idx] = { fx, fy };
      setXPts(next);
    } else if (pending === "y1" || pending === "y2") {
      const idx = pending === "y1" ? 0 : 1;
      const next = [...yPts];
      next[idx] = { fx, fy };
      setYPts(next);
    } else if (pending === "point") {
      const raw = value.points.map((p) => ({
        fx: p.px,
        fy: p.py,
        series: p.series,
      }));
      raw.push({ fx, fy, series: value.activeSeries });
      commit(raw);
      return;
    }
    setPending(null);
  }

  function touchDist(t1: React.Touch, t2: React.Touch) {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (draggingRef.current || draggingPointRef.current !== null) return;

      if (e.touches.length === 2) {
        const el = wrapRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const [t1, t2] = [e.touches[0], e.touches[1]];
        pinchStartRef.current = {
          dist: touchDist(t1, t2),
          scale,
          center: {
            x: (t1.clientX + t2.clientX) / 2 - rect.left,
            y: (t1.clientY + t2.clientY) / 2 - rect.top,
          },
          translate: { ...translate },
        };
        touchModeRef.current = "pinch";
        didPanRef.current = true;
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      if (selectionMode) {
        const { fx, fy } = fracFromClient(touch.clientX, touch.clientY);
        setSelectionRect({ x1: fx, y1: fy, x2: fx, y2: fy });
        setSelectedIndices(new Set());
        touchModeRef.current = "pan"; // reuse pan-move plumbing for the drag-select
        return;
      }

      if (pending) {
        // Tap-to-place: wait for touchend to know if it was a tap (short
        // move → place the point/ref) vs. a scroll/pan gesture. Still prime
        // panStart/panStartTranslate so that if it does turn into a real
        // drag, the canvas pans from the correct starting offset.
        lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
        didPanRef.current = false;
        touchModeRef.current = "pan";
        panStart.current = { x: touch.clientX, y: touch.clientY };
        panStartTranslate.current = { ...translate };
        return;
      }

      didPanRef.current = false;
      touchModeRef.current = "pan";
      lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
      panStart.current = { x: touch.clientX, y: touch.clientY };
      panStartTranslate.current = { ...translate };
    },
    [selectionMode, pending, scale, translate, fracFromClient],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const el = wrapRef.current;
      if (!el) return;

      if (touchModeRef.current === "pinch" && e.touches.length === 2) {
        e.preventDefault();
        const start = pinchStartRef.current;
        if (!start) return;
        const [t1, t2] = [e.touches[0], e.touches[1]];
        const dist = touchDist(t1, t2);
        const factor = dist / start.dist;
        const rect = el.getBoundingClientRect();
        const nextScale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, start.scale * factor),
        );
        const ix = (start.center.x - start.translate.x) / start.scale;
        const iy = (start.center.y - start.translate.y) / start.scale;
        const nextT = {
          x: start.center.x - ix * nextScale,
          y: start.center.y - iy * nextScale,
        };
        setScale(nextScale);
        setTranslate(clampTranslate(nextScale, nextT, rect.width, rect.height));
        return;
      }

      if (e.touches.length !== 1) return;
      const touch = e.touches[0];

      if (draggingPointRef.current !== null) {
        e.preventDefault();
        const { fx, fy } = fracFromClient(touch.clientX, touch.clientY);
        setDragPreview({ index: draggingPointRef.current, fx, fy });
        return;
      }

      if (draggingRef.current) {
        e.preventDefault();
        const { fx, fy } = fracFromClient(touch.clientX, touch.clientY);
        if (draggingRef.current.axis === "x") {
          setXPts((prev) => {
            const next = [...prev] as (RefPoint | null)[];
            next[draggingRef.current!.idx] = { fx, fy };
            return next;
          });
        } else {
          setYPts((prev) => {
            const next = [...prev] as (RefPoint | null)[];
            next[draggingRef.current!.idx] = { fx, fy };
            return next;
          });
        }
        return;
      }

      if (selectionMode && selectionRect) {
        e.preventDefault();
        const { fx, fy } = fracFromClient(touch.clientX, touch.clientY);
        setSelectionRect((prev) => (prev ? { ...prev, x2: fx, y2: fy } : null));
        return;
      }

      if (touchModeRef.current !== "pan") return;
      const dx = touch.clientX - lastTouchRef.current.x;
      const dy = touch.clientY - lastTouchRef.current.y;
      if (
        Math.abs(touch.clientX - panStart.current.x) > 6 ||
        Math.abs(touch.clientY - panStart.current.y) > 6
      ) {
        didPanRef.current = true;
      }
      if (!didPanRef.current) return; // let a short tap fall through to touchend
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const nextT = {
        x: panStartTranslate.current.x + (touch.clientX - panStart.current.x),
        y: panStartTranslate.current.y + (touch.clientY - panStart.current.y),
      };
      setTranslate(clampTranslate(scale, nextT, rect.width, rect.height));
    },
    [selectionMode, selectionRect, scale, clampTranslate, fracFromClient],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const mode = touchModeRef.current;
      touchModeRef.current = null;
      pinchStartRef.current = null;

      if (draggingPointRef.current !== null) {
        const idx = draggingPointRef.current;
        const preview = dragPreview;
        draggingPointRef.current = null;
        setDragPreview(null);
        if (preview && preview.index === idx) {
          const raw = value.points.map((p, i) =>
            i === idx
              ? { fx: preview.fx, fy: preview.fy, series: p.series }
              : { fx: p.px, fy: p.py, series: p.series },
          );
          commit(raw);
        }
        return;
      }

      if (draggingRef.current) {
        draggingRef.current = null;
        return;
      }

      if (selectionMode && selectionRect) {
        const x1 = Math.min(selectionRect.x1, selectionRect.x2);
        const y1 = Math.min(selectionRect.y1, selectionRect.y2);
        const x2 = Math.max(selectionRect.x1, selectionRect.x2);
        const y2 = Math.max(selectionRect.y1, selectionRect.y2);
        const nextSelected = new Set<number>();
        value.points.forEach((p, i) => {
          if (p.px >= x1 && p.px <= x2 && p.py >= y1 && p.py <= y2) {
            nextSelected.add(i);
          }
        });
        setSelectedIndices(nextSelected);
        setSelectionRect(null);
        return;
      }

      if (mode === "pan" && pending && !didPanRef.current) {
        // A tap (not a pan/scroll) while a pending action is active places a
        // reference point or a data point, mirroring handleClick.
        const touch = e.changedTouches[0];
        if (touch) {
          const { fx, fy } = fracFromClient(
            touch.clientX,
            touch.clientY,
            false,
          );
          if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
            if (pending === "x1" || pending === "x2") {
              const idx = pending === "x1" ? 0 : 1;
              setXPts((prev) => {
                const next = [...prev];
                next[idx] = { fx, fy };
                return next;
              });
              setPending(null);
            } else if (pending === "y1" || pending === "y2") {
              const idx = pending === "y1" ? 0 : 1;
              setYPts((prev) => {
                const next = [...prev];
                next[idx] = { fx, fy };
                return next;
              });
              setPending(null);
            } else if (pending === "point") {
              const raw = value.points.map((p) => ({
                fx: p.px,
                fy: p.py,
                series: p.series,
              }));
              raw.push({ fx, fy, series: value.activeSeries });
              commit(raw);
            }
          }
        }
      }
      didPanRef.current = false;
    },
    [selectionMode, selectionRect, pending, value, fracFromClient, dragPreview],
  );

  const toggleSelectionMode = useCallback(() => {
    setPending(null);
    setSelectionRect(null);
    setSelectedIndices(new Set());
    setSelectionMode((prev) => !prev);
  }, []);

  function deleteSelected() {
    if (selectedIndices.size === 0) return;
    const raw = value.points
      .filter((_, i) => !selectedIndices.has(i))
      .map((p) => ({ fx: p.px, fy: p.py, series: p.series }));
    commit(raw);
    setSelectedIndices(new Set());
  }

  function clearSelection() {
    setSelectedIndices(new Set());
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        if (selectionMode) {
          setSelectionMode(false);
          setSelectedIndices(new Set());
          setSelectionRect(null);
        } else if (pending) {
          setPending(null);
        }
        return;
      }

      if (isTyping) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedIndices.size > 0
      ) {
        e.preventDefault();
        deleteSelected();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectionMode, pending, selectedIndices, past, future, value.points]);

  function removePoint(i: number) {
    const raw = value.points
      .filter((_, idx) => idx !== i)
      .map((p) => ({ fx: p.px, fy: p.py, series: p.series }));
    commit(raw);
  }

  function addSeries() {
    const name = `Series ${value.series.length + 1}`;
    onChange({ ...value, series: [...value.series, name], activeSeries: name });
  }

  function renameSeries(oldName: string, newName: string) {
    const series = value.series.map((s) => (s === oldName ? newName : s));
    const points = value.points.map((p) =>
      p.series === oldName ? { ...p, series: newName } : p,
    );
    onChange({
      ...value,
      series,
      points,
      activeSeries:
        value.activeSeries === oldName ? newName : value.activeSeries,
    });
  }

  function seriesColor(name: string) {
    const i = value.series.indexOf(name);
    return getSeriesColor(i);
  }

  const refDots: {
    fx: number;
    fy: number;
    label: string;
    tone: string;
    axis: "x" | "y";
    idx: 0 | 1;
  }[] = [];
  if (xPts[0])
    refDots.push({
      ...xPts[0],
      label: "X1",
      tone: "var(--primary)",
      axis: "x",
      idx: 0,
    });
  if (xPts[1])
    refDots.push({
      ...xPts[1],
      label: "X2",
      tone: "var(--primary)",
      axis: "x",
      idx: 1,
    });
  if (yPts[0])
    refDots.push({
      ...yPts[0],
      label: "Y1",
      tone: "var(--chart-2)",
      axis: "y",
      idx: 0,
    });
  if (yPts[1])
    refDots.push({
      ...yPts[1],
      label: "Y2",
      tone: "var(--chart-2)",
      axis: "y",
      idx: 1,
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div>
        <div
          ref={wrapRef}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          className={cn(
            "relative w-full select-none overflow-hidden rounded-lg border border-border bg-card",
            isPanning
              ? "cursor-grabbing"
              : spacePressed
                ? "cursor-grab"
                : selectionMode
                  ? "cursor-crosshair"
                  : pending
                    ? "cursor-crosshair"
                    : "cursor-default",
          )}
        >
          <img
            src={value.imageUrl || "/placeholder.svg"}
            alt="Figure cần số hóa"
            draggable={false}
            className="block w-full origin-top-left select-none pointer-events-none"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            }}
          />

          {/* Overlay shares the same transform as the image so markers never drift out of sync when zooming/panning. */}
          <div
            className="pointer-events-none absolute inset-0 origin-top-left"
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            }}
          >
            {selectionRect && (
              <div
                className="absolute border-2 border-primary bg-primary/10 pointer-events-none"
                style={{
                  left: `${Math.min(selectionRect.x1, selectionRect.x2) * 100}%`,
                  top: `${Math.min(selectionRect.y1, selectionRect.y2) * 100}%`,
                  width: `${Math.abs(selectionRect.x2 - selectionRect.x1) * 100}%`,
                  height: `${Math.abs(selectionRect.y2 - selectionRect.y1) * 100}%`,
                }}
              />
            )}
            {refDots.map((d, i) => (
              <span
                key={i}
                className="absolute pointer-events-auto cursor-grab active:cursor-grabbing"
                style={{
                  left: `${d.fx * 100}%`,
                  top: `${d.fy * 100}%`,
                  transform: `translate(-50%, -50%) scale(${1 / scale})`,
                }}
                onMouseDown={(e) => {
                  if (selectionMode || e.button !== 0) return;
                  if (spacePressed) return; // let Space+drag pan through
                  e.stopPropagation();
                  e.preventDefault();
                  draggingRef.current = { axis: d.axis, idx: d.idx };
                }}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  if (selectionMode) return;
                  draggingRef.current = { axis: d.axis, idx: d.idx };
                  touchModeRef.current = "drag-ref";
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <span
                  className="block size-3 rounded-full ring-2 ring-background"
                  style={{ background: d.tone }}
                />
                <span
                  className="absolute left-3 top-0 whitespace-nowrap rounded px-1 text-[10px] font-semibold text-background"
                  style={{ background: d.tone }}
                >
                  {d.label}
                </span>
              </span>
            ))}

            {value.points.map((p, i) => {
              const isSelected = selectedIndices.has(i);
              const isDragging = dragPreview?.index === i;
              const px = isDragging ? dragPreview.fx : p.px;
              const py = isDragging ? dragPreview.fy : p.py;
              return (
                <span
                  key={i}
                  className={cn(
                    "absolute rounded-full ring-2 ring-background pointer-events-auto cursor-grab active:cursor-grabbing",
                    isSelected && "ring-yellow-400 ring-offset-1 size-3",
                    !isSelected && "size-2.5",
                    isDragging && "z-10 opacity-90",
                  )}
                  style={{
                    left: `${px * 100}%`,
                    top: `${py * 100}%`,
                    background: seriesColor(p.series),
                    transform: `translate(-50%, -50%) scale(${1 / scale})`,
                  }}
                  onMouseDown={(e) => {
                    if (selectionMode || e.button !== 0) return;
                    if (spacePressed) return; // let Space+drag pan through
                    e.stopPropagation();
                    e.preventDefault();
                    draggingPointRef.current = i;
                  }}
                  onTouchStart={(e) => {
                    if (selectionMode) return;
                    e.stopPropagation();
                    draggingPointRef.current = i;
                    touchModeRef.current = "drag-point";
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              );
            })}
          </div>
        </div>

        {selectionMode && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-primary">
            <Square className="size-4" />
            Kéo chuột trên ảnh để chọn điểm. Nhấn Escape để thoát.
          </p>
        )}

        {pending && !selectionMode && (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-primary">
            <Crosshair className="size-4" />
            {pending === "point"
              ? "Bấm lên đường cong để thêm điểm. Kéo trái để di chuyển, cuộn để zoom."
              : `Bấm lên vị trí điểm tham chiếu ${pending.toUpperCase()} trên trục.`}
            <button
              className="ml-1 underline"
              onClick={() => setPending(null)}
              type="button"
            >
              Dừng
            </button>
          </p>
        )}

        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={zoomOut}
            disabled={scale <= MIN_SCALE}
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={zoomIn}
            disabled={scale >= MAX_SCALE}
          >
            <ZoomIn className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetView}
            disabled={
              scale === MIN_SCALE && translate.x === 0 && translate.y === 0
            }
          >
            <Maximize2 className="size-3.5" />
          </Button>
          <Button
            variant={selectionMode ? "secondary" : "ghost"}
            size="sm"
            onClick={toggleSelectionMode}
          >
            <Square className="size-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground">
            Cuộn / chụm hai ngón để zoom · Kéo để di chuyển ảnh · Kéo điểm tham
            chiếu hoặc điểm dữ liệu để chỉnh lại · Ctrl+Z hoàn tác
          </span>
        </div>
      </div>

      <aside className="flex flex-col gap-5">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Hiệu chỉnh trục X</h3>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={logX}
                onChange={(e) => setLogX(e.target.checked)}
                className="accent-primary"
              />
              log
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([0, 1] as const).map((i) => (
              <div key={i} className="flex flex-col gap-1">
                <Button
                  variant={xPts[i] ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setPending(i === 0 ? "x1" : "x2")}
                >
                  {xPts[i] ? `X${i + 1} ✓` : `Đặt X${i + 1}`}
                </Button>
                <Input
                  aria-label={`Giá trị X${i + 1}`}
                  placeholder={`giá trị X${i + 1}`}
                  value={xVals[i]}
                  inputMode="decimal"
                  aria-invalid={!xValsValid[i]}
                  onChange={(e) => {
                    const n = [...xVals] as [string, string];
                    n[i] = e.target.value;
                    setXVals(n);
                  }}
                  className={cn(
                    "h-8 font-mono text-xs",
                    !xValsValid[i] && "border-destructive text-destructive",
                  )}
                />
                {!xValsValid[i] && (
                  <span className="flex items-center gap-1 text-[10px] text-destructive">
                    <AlertCircle className="size-3" /> Không phải số hợp lệ
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Hiệu chỉnh trục Y</h3>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={logY}
                onChange={(e) => setLogY(e.target.checked)}
                className="accent-primary"
              />
              log
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([0, 1] as const).map((i) => (
              <div key={i} className="flex flex-col gap-1">
                <Button
                  variant={yPts[i] ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setPending(i === 0 ? "y1" : "y2")}
                >
                  {yPts[i] ? `Y${i + 1} ✓` : `Đặt Y${i + 1}`}
                </Button>
                <Input
                  aria-label={`Giá trị Y${i + 1}`}
                  placeholder={`giá trị Y${i + 1}`}
                  value={yVals[i]}
                  inputMode="decimal"
                  aria-invalid={!yValsValid[i]}
                  onChange={(e) => {
                    const n = [...yVals] as [string, string];
                    n[i] = e.target.value;
                    setYVals(n);
                  }}
                  className={cn(
                    "h-8 font-mono text-xs",
                    !yValsValid[i] && "border-destructive text-destructive",
                  )}
                />
                {!yValsValid[i] && (
                  <span className="flex items-center gap-1 text-[10px] text-destructive">
                    <AlertCircle className="size-3" /> Không phải số hợp lệ
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Đường cong / Series</h3>
            <Button variant="ghost" size="sm" onClick={addSeries}>
              <Plus className="size-3.5" /> Thêm
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {value.series.map((s, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5",
                  value.activeSeries === s
                    ? "border-primary bg-primary/5"
                    : "border-border",
                )}
              >
                <button
                  type="button"
                  onClick={() => onChange({ ...value, activeSeries: s })}
                  className="size-3 shrink-0 rounded-full"
                  style={{ background: seriesColor(s) }}
                  aria-label={`Chọn ${s}`}
                />
                <input
                  value={s}
                  onChange={(e) => renameSeries(s, e.target.value)}
                  autoComplete="off"
                  className="w-full bg-transparent text-xs outline-none"
                />
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {value.points.filter((p) => p.series === s).length}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={!calibrated}
              variant={pending === "point" ? "secondary" : "default"}
              onClick={() => setPending(pending === "point" ? null : "point")}
            >
              {pending === "point" ? (
                <X className="size-3.5" />
              ) : (
                <Crosshair className="size-3.5" />
              )}
              {pending === "point" ? "Dừng" : "Thêm điểm"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={past.length === 0}
              onClick={undo}
              title="Hoàn tác (Ctrl+Z)"
            >
              <Undo2 className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={future.length === 0}
              onClick={redo}
              title="Làm lại (Ctrl+Shift+Z)"
            >
              <Redo2 className="size-3.5" />
            </Button>
          </div>
          {!calibrated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Hoàn tất hiệu chỉnh X và Y trước khi thêm điểm.
            </p>
          )}
        </div>
      </aside>

      {value.points.length > 0 && (
        <div className="lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium">
                Điểm đã số hóa ({value.points.length})
              </h3>
              {selectedIndices.size > 0 && (
                <Badge variant="outline">
                  {selectedIndices.size} được chọn
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedIndices.size > 0 && (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={deleteSelected}
                  >
                    <Trash2 className="size-3.5" /> Xóa
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearSelection}>
                    Bỏ chọn
                  </Button>
                </>
              )}
              <Badge variant="secondary">{value.series.length} series</Badge>
            </div>
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 text-left backdrop-blur">
                <tr>
                  <th className="px-3 py-2 font-medium">Series</th>
                  <th className="px-3 py-2 font-medium">X</th>
                  <th className="px-3 py-2 font-medium">Y</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {value.points.map((p, i) => (
                  <tr
                    key={i}
                    className={cn(
                      "border-t border-border",
                      selectedIndices.has(i) &&
                        "bg-yellow-50/50 dark:bg-yellow-900/20",
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: seriesColor(p.series) }}
                        />
                        {p.series}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">
                      {p.x.toPrecision(4)}
                    </td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">
                      {p.y.toPrecision(4)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => removePoint(i)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Xóa điểm"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
