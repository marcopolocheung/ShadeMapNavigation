"use client";

import type { RouteOption } from "../lib/routing";

export interface NavigationPanelProps {
  navMode: boolean;
  onToggleNavMode: () => void;
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  onClear: () => void;
  onCalculate: () => void;
  isCalculating: boolean;
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  error: string | null;
  solarIntensity?: number | null;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatCoord(c: [number, number]): string {
  return `${c[1].toFixed(4)}, ${c[0].toFixed(4)}`;
}

function formatShadeStreak(m: number): string | null {
  return m >= 10 ? `${Math.round(m)}m shade` : null;
}

function formatTransitions(n: number): string {
  return n === 0 ? "continuous" : `${n} break${n === 1 ? "" : "s"}`;
}

function formatDetour(r: number): string | null {
  return r > 1.05 ? `${r.toFixed(1)}× detour` : null;
}

function SolarPill({ intensity }: { intensity: number }) {
  if (intensity < 0.15) {
    return (
      <div className="text-xs px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 self-start">
        Low sun — shade routing minimal
      </div>
    );
  }
  if (intensity <= 0.6) {
    return (
      <div className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300 self-start">
        Moderate solar load
      </div>
    );
  }
  return (
    <div className="text-xs px-2 py-0.5 rounded-full bg-amber-900/50 text-amber-300 self-start">
      High solar load — shade matters
    </div>
  );
}

export default function NavigationPanel({
  navMode,
  onToggleNavMode,
  waypointA,
  waypointB,
  onClear,
  onCalculate,
  isCalculating,
  routes,
  selectedRouteIndex,
  onSelectRoute,
  error,
  solarIntensity,
}: NavigationPanelProps) {
  return (
    <div className="flex flex-col gap-2">
      {/* Toggle button */}
      <button
        onClick={onToggleNavMode}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          navMode
            ? "bg-amber-500 text-black hover:bg-amber-400"
            : "bg-black/70 backdrop-blur-sm text-white/80 hover:text-white border border-white/10"
        }`}
      >
        {navMode ? "Navigating — click to exit" : "Navigate"}
      </button>

      {/* Expanded panel when nav mode is active */}
      {navMode && (
        <div className="bg-black/70 backdrop-blur-sm rounded-lg px-3 py-2.5 flex flex-col gap-2 min-w-[220px]">
          {/* Waypoints */}
          <div className="flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-green-500 shrink-0 inline-block" />
              <span className="text-white/70">
                {waypointA ? formatCoord(waypointA) : "Click map to set A"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-red-500 shrink-0 inline-block" />
              <span className="text-white/70">
                {waypointB ? formatCoord(waypointB) : "Click map to set B"}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={onCalculate}
              disabled={!waypointA || !waypointB || isCalculating}
              className="flex-1 px-2 py-1 rounded text-xs font-medium bg-amber-500 text-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-400 transition-colors flex items-center justify-center gap-1"
            >
              {isCalculating && (
                <svg
                  className="animate-spin h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
              )}
              {isCalculating ? "Calculating…" : "Find Shaded Route"}
            </button>
            <button
              onClick={onClear}
              className="px-2 py-1 rounded text-xs text-white/60 hover:text-white/90 border border-white/10 transition-colors"
            >
              Clear
            </button>
          </div>

          {/* Solar context pill + route option cards */}
          {routes.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
              {solarIntensity != null && (
                <SolarPill intensity={solarIntensity} />
              )}
              {routes.map((r, i) => {
                const streak = formatShadeStreak(r.longestContinuousShadeM);
                const transitions = formatTransitions(r.shadeTransitions);
                const detour = formatDetour(r.detourRatio);
                const hasSecondLine =
                  streak !== null ||
                  r.shadeTransitions > 0 ||
                  r.detourRatio > 1.05 ||
                  r.turnCount > 0;

                return (
                  <button
                    key={i}
                    onClick={() => onSelectRoute(i)}
                    className={`text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      i === selectedRouteIndex
                        ? "bg-amber-500/20 border border-amber-500/50"
                        : "border border-white/10 hover:border-white/30"
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <span
                        className={
                          i === selectedRouteIndex
                            ? "text-amber-400 font-medium"
                            : "text-white/70"
                        }
                      >
                        {r.label}
                      </span>
                      <span className="text-white/40 text-[10px]">
                        {formatDist(r.distanceM)}
                      </span>
                    </div>
                    <div className="text-white/40 text-[10px] mt-0.5">
                      {Math.round(r.shadeCoverage * 100)}% shaded
                    </div>
                    {hasSecondLine && (
                      <div className="text-slate-400 text-[10px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                        {streak && <span>{streak}</span>}
                        <span>{transitions}</span>
                        {detour && <span>{detour}</span>}
                        {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? "" : "s"}</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs text-red-400 border-t border-white/10 pt-2">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
