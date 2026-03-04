"use client";

import { useState, useRef, useEffect } from "react";
import type { RouteOption } from "../lib/routing";
import { geocodeForward, type NominatimResult } from "../lib/nominatim";

export interface NavigationPanelProps {
  navMode: boolean;
  onToggleNavMode: () => void;
  waypointA: [number, number] | null;
  waypointB: [number, number] | null;
  waypointALabel: string | null;
  waypointBLabel: string | null;
  onSetWaypointA: (coord: [number, number], label: string) => void;
  onSetWaypointB: (coord: [number, number], label: string) => void;
  onSwapWaypoints: () => void;
  onClearWaypointA: () => void;
  onClearWaypointB: () => void;
  onClear: () => void;
  onCalculate: () => void;
  isCalculating: boolean;
  routes: RouteOption[];
  selectedRouteIndex: number;
  onSelectRoute: (i: number) => void;
  error: string | null;
  solarIntensity?: number | null;
  pendingSlot: 'A' | 'B' | null;
  onSetPendingSlot: (slot: 'A' | 'B' | null) => void;
  locationSearchSlot?: React.ReactNode;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
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

function WaypointInput({
  label,
  placeholder,
  dotColor,
  onSet,
  onClear,
}: {
  label: string | null;
  placeholder: string;
  dotColor: "green" | "red";
  onSet: (coord: [number, number], label: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState(label ?? "");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedRef = useRef(false);
  const labelRef = useRef(label);
  labelRef.current = label;

  // Sync query when label changes externally (e.g. reverse geocode resolves, swap)
  useEffect(() => {
    if (!focusedRef.current) {
      setQuery(label ?? "");
    }
  }, [label]);

  function closeDropdown() {
    setResults([]);
    setHighlight(-1);
    setInlineError(null);
  }

  function search(q: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.length < 2) { closeDropdown(); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await geocodeForward(q);
        if (res.length === 0) {
          setResults([]);
          setInlineError(`No results found for "${q}". Try a different address.`);
        } else {
          setResults(res);
          setInlineError(null);
        }
      } catch {
        setResults([]);
        setInlineError("Address search failed. Check your connection.");
      }
    }, 400);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    // Clear the waypoint only if one was set — avoids repeated parent updates
    if (labelRef.current !== null) onClear();
    setHighlight(-1);
    search(val);
  }

  function handleSelect(r: NominatimResult) {
    const coord: [number, number] = [parseFloat(r.lon), parseFloat(r.lat)];
    setQuery(r.display_name);
    closeDropdown();
    onSet(coord, r.display_name);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      handleSelect(results[highlight]);
    } else if (e.key === "Escape") {
      closeDropdown();
    }
  }

  const dotClass =
    dotColor === "green"
      ? label
        ? "bg-green-400 shadow-[0_0_6px_1px_rgba(74,222,128,0.5)]"
        : "bg-green-900/60 border border-green-700/50"
      : label
      ? "bg-red-400 shadow-[0_0_6px_1px_rgba(248,113,113,0.5)]"
      : "bg-red-900/60 border border-red-700/50";

  return (
    <div className="relative flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full shrink-0 transition-all ${dotClass}`} />
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={(e) => {
            focusedRef.current = true;
            setTimeout(() => e.target.select(), 0);
          }}
          onBlur={() => {
            focusedRef.current = false;
            // Revert to current label (or empty) if user didn't complete a selection
            setQuery(labelRef.current ?? "");
            closeDropdown();
          }}
          className="flex-1 min-w-0 bg-white/5 rounded px-2 py-1 text-xs text-white/80 placeholder-white/30 border border-white/10 focus:outline-none focus:border-white/25 transition-colors"
        />
        {label && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onClear(); setQuery(""); closeDropdown(); }}
            className="shrink-0 text-white/30 hover:text-white/70 transition-colors leading-none px-0.5"
            title="Clear waypoint"
          >
            ×
          </button>
        )}
      </div>
      {inlineError && (
        <p className="text-[10px] text-red-400 pl-5">{inlineError}</p>
      )}
      {results.length > 0 && (
        <div className="absolute top-full left-5 right-0 mt-0.5 z-50 bg-[#1c1c1c] border border-white/10 rounded shadow-xl overflow-hidden">
          {results.map((r, i) => {
            const comma = r.display_name.indexOf(",");
            const primary = comma >= 0 ? r.display_name.slice(0, comma) : r.display_name;
            const secondary = comma >= 0 ? r.display_name.slice(comma + 1).trim() : "";
            return (
              <button
                key={r.place_id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(r)}
                onMouseEnter={() => setHighlight(i)}
                className={`w-full text-left px-2 py-1.5 transition-colors ${
                  i === highlight ? "bg-amber-500/20" : "hover:bg-white/5"
                }`}
              >
                <div className={`text-xs truncate ${i === highlight ? "text-amber-300" : "text-white/80"}`}>
                  {primary}
                </div>
                {secondary && (
                  <div className="text-[10px] text-white/30 truncate">{secondary}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function NavigationPanel({
  navMode,
  onToggleNavMode,
  waypointA,
  waypointB,
  waypointALabel,
  waypointBLabel,
  onSetWaypointA,
  onSetWaypointB,
  onSwapWaypoints,
  onClearWaypointA,
  onClearWaypointB,
  onClear,
  onCalculate,
  isCalculating,
  routes,
  selectedRouteIndex,
  onSelectRoute,
  error,
  solarIntensity,
  pendingSlot,
  onSetPendingSlot,
  locationSearchSlot,
}: NavigationPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!navMode) setCollapsed(false);
  }, [navMode]);

  if (!navMode) {
    return (
      <div className="absolute bottom-6 left-3 z-20">
        <button
          onClick={onToggleNavMode}
          className="bg-black/70 backdrop-blur-sm text-white/80 hover:text-white border border-white/10 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:border-white/25"
        >
          Navigate
        </button>
      </div>
    );
  }

  return (
    <div className="absolute inset-y-0 left-0 z-20 flex items-stretch pointer-events-none">
      {/* Panel content — 288px when expanded, 0 when collapsed */}
      <div
        className={`relative flex flex-col overflow-hidden transition-all duration-200 ease-in-out pointer-events-auto ${
          collapsed ? 'w-0' : 'w-72'
        }`}
      >
        <div className="w-72 h-full flex flex-col bg-black/85 backdrop-blur-md border-r border-white/[0.07]">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.07] shrink-0">
            <span className="text-white/80 text-sm font-semibold tracking-wide">Navigate</span>
            <button
              onClick={onToggleNavMode}
              className="text-white/30 hover:text-white/70 transition-colors p-1 rounded"
              title="Exit navigation mode"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="1" y1="1" x2="9" y2="9" />
                <line x1="9" y1="1" x2="1" y2="9" />
              </svg>
            </button>
          </div>

          {/* LocationSearch slot */}
          {locationSearchSlot && (
            <div className="px-2 py-2 border-b border-white/[0.07] shrink-0">
              {locationSearchSlot}
            </div>
          )}

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 flex flex-col gap-3 min-h-0">
            {/* Waypoint rows */}
            <div className="flex flex-col gap-1 text-xs">
              {/* Waypoint A */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointALabel}
                    placeholder="Search or click pin for start"
                    dotColor="green"
                    onSet={onSetWaypointA}
                    onClear={onClearWaypointA}
                  />
                </div>
                <button
                  onClick={() => onSetPendingSlot(pendingSlot === 'A' ? null : 'A')}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'A'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>

              {/* Swap */}
              <div className="flex items-center pl-1">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onSwapWaypoints}
                  className="text-white/30 hover:text-white/70 transition-colors text-base leading-none px-1"
                  title="Swap start and destination"
                >
                  ⇅
                </button>
              </div>

              {/* Waypoint B */}
              <div className="flex items-start gap-1.5">
                <div className="flex-1 min-w-0">
                  <WaypointInput
                    label={waypointBLabel}
                    placeholder="Search or click pin for destination"
                    dotColor="red"
                    onSet={onSetWaypointB}
                    onClear={onClearWaypointB}
                  />
                </div>
                <button
                  onClick={() => onSetPendingSlot(pendingSlot === 'B' ? null : 'B')}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-all ${
                    pendingSlot === 'B'
                      ? 'text-amber-400 ring-1 ring-amber-400/60 bg-amber-400/10 animate-pulse'
                      : 'text-white/25 hover:text-white/60'
                  }`}
                  title="Click to place on map"
                >
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
                    <path d="M6 0C3.24 0 1 2.24 1 5c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5zm0 6.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={onCalculate}
                disabled={!waypointA || !waypointB || isCalculating}
                className="flex-1 px-2 py-1.5 rounded text-xs font-medium bg-amber-500 text-black disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-400 transition-colors flex items-center justify-center gap-1"
              >
                {isCalculating && (
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {isCalculating ? 'Calculating…' : 'Find Shaded Route'}
              </button>
              <button
                onClick={onClear}
                className="px-2 py-1.5 rounded text-xs text-white/60 hover:text-white/90 border border-white/10 transition-colors"
              >
                Clear
              </button>
            </div>

            {/* Route cards */}
            {routes.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
                {solarIntensity != null && <SolarPill intensity={solarIntensity} />}
                {routes.map((r, i) => {
                  const streak = formatShadeStreak(r.longestContinuousShadeM);
                  const transitions = formatTransitions(r.shadeTransitions);
                  const detour = formatDetour(r.detourRatio);
                  const hasSecondLine =
                    streak !== null || r.shadeTransitions > 0 || r.detourRatio > 1.05 || r.turnCount > 0;
                  return (
                    <button
                      key={i}
                      onClick={() => onSelectRoute(i)}
                      className={`text-left px-2 py-1.5 rounded text-xs transition-all ${
                        i === selectedRouteIndex
                          ? 'bg-amber-500/20 border border-amber-500 shadow-sm shadow-amber-500/20'
                          : 'border border-white/10 hover:border-white/25 hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="flex justify-between items-center">
                        <span className={i === selectedRouteIndex ? 'text-amber-300 font-semibold' : 'text-white/50'}>
                          {r.label}
                        </span>
                        <span className={`text-[10px] tabular-nums ${i === selectedRouteIndex ? 'text-amber-400/70' : 'text-white/30'}`}>
                          {formatDist(r.distanceM)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-400 transition-all duration-300"
                            style={{ width: `${Math.round(r.shadeCoverage * 100)}%` }}
                          />
                        </div>
                        <span className="text-white/40 text-[10px] tabular-nums w-7 text-right">
                          {Math.round(r.shadeCoverage * 100)}%
                        </span>
                      </div>
                      {hasSecondLine && (
                        <div className="text-slate-400 text-[10px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                          {streak && <span>{streak}</span>}
                          <span>{transitions}</span>
                          {detour && <span>{detour}</span>}
                          {r.turnCount > 0 && <span>{r.turnCount} turn{r.turnCount === 1 ? '' : 's'}</span>}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="text-xs text-red-400 border-t border-white/10 pt-2 shrink-0">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Collapse toggle tab — always visible on the sidebar's right edge */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="pointer-events-auto self-center bg-black/85 backdrop-blur-md border border-l-0 border-white/[0.07] rounded-r-lg px-1 py-4 text-white/40 hover:text-white/80 transition-colors shrink-0"
        title={collapsed ? 'Expand navigation panel' : 'Collapse navigation panel'}
      >
        <svg
          width="8" height="12" viewBox="0 0 8 12"
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        >
          {collapsed
            ? <polyline points="2,2 6,6 2,10" />
            : <polyline points="6,2 2,6 6,10" />
          }
        </svg>
      </button>
    </div>
  );
}
