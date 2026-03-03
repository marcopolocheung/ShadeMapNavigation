"use client";

import { useRef, useEffect, useCallback } from "react";

interface Props {
  minutes: number; // 0–1439
  onChange: (minutes: number) => void;
  date?: Date;       // used for sunrise/sunset calculation
  latDeg?: number;   // map center latitude
  lngDeg?: number;   // map center longitude
}

// ---------------------------------------------------------------------------
// Solar math — exact same orbital mechanics as computeSunriseSetAzimuths in
// MapView.tsx; adapted to output minutes-from-midnight instead of azimuths.
// ---------------------------------------------------------------------------

function computeSunriseSetMinutes(
  date: Date,
  latDeg: number,
  lngDeg: number
): { riseMin: number; setMin: number } | null {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);
  const noonN = noon.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * noonN) % 360;
  const g = ((357.528 + 0.9856003 * noonN) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * noonN) * (Math.PI / 180);
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const latRad = latDeg * (Math.PI / 180);
  const cosHA0 = -Math.tan(latRad) * Math.tan(dec);
  if (Math.abs(cosHA0) > 1) return null; // polar day or polar night
  const HA0 = Math.acos(cosHA0);
  const halfDayMin = HA0 * (720 / Math.PI);
  // Solar noon in local clock minutes; longitude-based correction + DST via getTimezoneOffset()
  const solarNoonLocal = 720 - lngDeg * 4 - date.getTimezoneOffset();
  return {
    riseMin: Math.round(solarNoonLocal - halfDayMin),
    setMin:  Math.round(solarNoonLocal + halfDayMin),
  };
}

const PX_PER_MIN = 2;
// Exponential velocity decay: 0.009 /ms ≈ velocity halves every ~77 ms.
// Halving FRICTION from 0.018 doubles the total inertia distance.
const FRICTION = 0.009;

function hourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function fmtMin(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Static tick data — computed once at module load, never changes
const TICKS = (() => {
  const out: { x: number; h: number; label?: string }[] = [];
  for (let m = 0; m <= 1440; m += 5) {
    const min = m % 60;
    const hr = Math.floor(m / 60);
    const isHour = min === 0;
    const isQuarter = !isHour && min % 15 === 0;
    out.push({
      x: m * PX_PER_MIN,
      h: isHour ? 20 : isQuarter ? 12 : 5,
      label: isHour && hr < 24 ? hourLabel(hr) : undefined,
    });
  }
  return out;
})();

const TOTAL_PX = 1440 * PX_PER_MIN;

export default function TimelineSlider({ minutes, onChange, date, latDeg, lngDeg }: Props) {
  const sunRiseSet =
    date !== undefined && latDeg !== undefined && lngDeg !== undefined
      ? computeSunriseSetMinutes(date, latDeg, lngDeg)
      : null;
  const sunriseMin = sunRiseSet?.riseMin;
  const sunsetMin  = sunRiseSet?.setMin;
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const isDragging = useRef(false);
  const lastX = useRef(0);
  const lastMoveTime = useRef(0);
  // EMA-smoothed velocity in px/ms; positive = dragging left (time advances)
  const lastVelocity = useRef(0);
  // fracMin accumulates fractional minutes so sub-pixel drags are never lost
  const fracMin = useRef(minutes);
  // curMin mirrors the `minutes` prop — always current via render-time assignment
  const curMin = useRef(minutes);
  curMin.current = minutes;

  const inertiaFrame = useRef<number | null>(null);

  const getTranslateX = useCallback((m: number): number => {
    const half = (containerRef.current?.clientWidth ?? 0) / 2;
    return half - m * PX_PER_MIN;
  }, []);

  const applyTranslate = useCallback(
    (m: number) => {
      if (contentRef.current)
        contentRef.current.style.transform = `translateX(${getTranslateX(m)}px)`;
    },
    [getTranslateX]
  );

  const cancelInertia = useCallback(() => {
    if (inertiaFrame.current !== null) {
      cancelAnimationFrame(inertiaFrame.current);
      inertiaFrame.current = null;
    }
  }, []);

  const startInertia = useCallback(
    (v0: number) => {
      cancelInertia();
      let velocity = v0; // px/ms
      let lastTime = performance.now();

      const tick = (now: number) => {
        // Cap dt so a tab-switch freeze doesn't teleport the timeline
        const dt = Math.min(now - lastTime, 64);
        lastTime = now;

        velocity *= Math.exp(-FRICTION * dt);
        if (Math.abs(velocity) < 0.04) {
          inertiaFrame.current = null;
          return;
        }

        const next = fracMin.current - (velocity * dt) / PX_PER_MIN;
        if (next <= 0 || next >= 1439) {
          fracMin.current = Math.max(0, Math.min(1439, next));
          applyTranslate(fracMin.current);
          onChange(Math.round(fracMin.current));
          inertiaFrame.current = null;
          return;
        }

        fracMin.current = next;
        applyTranslate(next);
        onChange(Math.round(next));
        inertiaFrame.current = requestAnimationFrame(tick);
      };

      inertiaFrame.current = requestAnimationFrame(tick);
    },
    [applyTranslate, cancelInertia, onChange]
  );

  // Mount: set initial position + keep in sync when container resizes
  useEffect(() => {
    applyTranslate(curMin.current);
    const ro = new ResizeObserver(() => applyTranslate(curMin.current));
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [applyTranslate]);

  // External value changes (play animation) — skip while drag or inertia owns the position
  useEffect(() => {
    if (!isDragging.current && inertiaFrame.current === null)
      applyTranslate(minutes);
  }, [minutes, applyTranslate]);

  // Cleanup on unmount
  useEffect(() => () => cancelInertia(), [cancelInertia]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      cancelInertia();
      isDragging.current = true;
      fracMin.current = curMin.current;
      lastX.current = e.clientX;
      lastMoveTime.current = performance.now();
      lastVelocity.current = 0;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [cancelInertia]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      const now = performance.now();
      const dt = now - lastMoveTime.current;
      const dx = e.clientX - lastX.current;
      lastX.current = e.clientX;
      // EMA: 70% new sample, 30% history — reduces single-frame noise
      if (dt > 0 && dt < 150)
        lastVelocity.current = lastVelocity.current * 0.3 + (dx / dt) * 0.7;
      lastMoveTime.current = now;

      fracMin.current = Math.max(0, Math.min(1439, fracMin.current - dx / PX_PER_MIN));
      applyTranslate(fracMin.current);
      onChange(Math.round(fracMin.current));
    },
    [applyTranslate, onChange]
  );

  const onPointerUp = useCallback(() => {
    isDragging.current = false;
    const stale = performance.now() - lastMoveTime.current;
    // Only launch inertia if the pointer was still moving when released
    if (stale < 80 && Math.abs(lastVelocity.current) > 0.08)
      startInertia(lastVelocity.current);
  }, [startInertia]);

  const hasRise = sunriseMin !== undefined;
  const hasSet  = sunsetMin  !== undefined;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-11 overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Scrolling ruler */}
      <div
        ref={contentRef}
        className="absolute inset-y-0"
        style={{ width: TOTAL_PX, willChange: "transform" }}
      >
        {/* ── Night before sunrise ─────────────────────────────────────── */}
        {hasRise && (
          <div
            style={{
              position: "absolute",
              left: 0,
              width: sunriseMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              backgroundColor: "rgba(55, 65, 81, 0.45)",
            }}
          />
        )}

        {/* ── Daytime gradient: burnt-orange → navy (mirrors circle sector) */}
        {hasRise && hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunriseMin! * PX_PER_MIN,
              width: (sunsetMin! - sunriseMin!) * PX_PER_MIN,
              top: 0, bottom: 0,
              background: "linear-gradient(to right, rgba(194,65,12,0.28), rgba(30,64,175,0.28))",
            }}
          />
        )}

        {/* ── Night after sunset ───────────────────────────────────────── */}
        {hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunsetMin! * PX_PER_MIN,
              width: TOTAL_PX - sunsetMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              backgroundColor: "rgba(55, 65, 81, 0.45)",
            }}
          />
        )}

        {/* ── Sunrise marker + label (label inside slider at top) ──────── */}
        {hasRise && (
          <div
            style={{
              position: "absolute",
              left: sunriseMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              width: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: 0, width: 2,
                backgroundColor: "#c2410c",
                boxShadow: "0 0 6px 2px rgba(194,65,12,0.55)",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: 2,
                left: 4,
                fontSize: 9,
                lineHeight: 1,
                color: "#c2410c",
                whiteSpace: "nowrap",
                userSelect: "none",
                pointerEvents: "none",
              }}
            >
              ▲ {fmtMin(sunriseMin!)}
            </span>
          </div>
        )}

        {/* ── Sunset marker + label (label inside slider at top) ───────── */}
        {hasSet && (
          <div
            style={{
              position: "absolute",
              left: sunsetMin! * PX_PER_MIN,
              top: 0, bottom: 0,
              width: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: 0, width: 2,
                backgroundColor: "#1e40af",
                boxShadow: "0 0 6px 2px rgba(30,64,175,0.55)",
              }}
            />
            <span
              style={{
                position: "absolute",
                top: 2,
                left: 4,
                fontSize: 9,
                lineHeight: 1,
                color: "#6b9fff",
                whiteSpace: "nowrap",
                userSelect: "none",
                pointerEvents: "none",
              }}
            >
              ▼ {fmtMin(sunsetMin!)}
            </span>
          </div>
        )}

        {/* ── Hour/minute ticks ────────────────────────────────────────── */}
        {TICKS.map(({ x, h, label }) => (
          <div
            key={x}
            style={{ position: "absolute", left: x, bottom: 0, top: 0 }}
          >
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                width: 1,
                height: h,
                backgroundColor: label
                  ? "rgba(255,255,255,0.35)"
                  : "rgba(255,255,255,0.18)",
              }}
            />
            {label && (
              <span
                style={{
                  position: "absolute",
                  bottom: h + 4,
                  left: 0,
                  transform: "translateX(-50%)",
                  whiteSpace: "nowrap",
                  fontSize: 10,
                  lineHeight: 1,
                  color: "rgba(255,255,255,0.45)",
                  fontVariantNumeric: "tabular-nums",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              >
                {label}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Fixed red center cursor — never moves, content scrolls under it */}
      <div
        className="absolute inset-y-0 pointer-events-none z-10"
        style={{
          left: "50%",
          width: 2,
          transform: "translateX(-1px)",
          backgroundColor: "#ef4444",
          boxShadow: "0 0 6px 2px rgba(239,68,68,0.55)",
        }}
      />
    </div>
  );
}
