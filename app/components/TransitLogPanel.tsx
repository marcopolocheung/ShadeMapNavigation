"use client";

import type { TransitMode } from "../lib/transit";

interface TransitLogEntry {
  id: number;
  ts: Date;
  event: "FETCH" | "CACHE_HIT" | "SKIPPED" | "ERROR";
  zoom: number;
  stopCount?: number;
  modes?: Partial<Record<TransitMode, number>>;
  reason?: string;
}

interface Props {
  logs: TransitLogEntry[];
  onClear: () => void;
}

const EVENT_COLOR: Record<TransitLogEntry["event"], string> = {
  FETCH:     "text-green-400",
  CACHE_HIT: "text-cyan-400",
  SKIPPED:   "text-yellow-400",
  ERROR:     "text-red-400",
};

const MODE_COLOR: Record<string, string> = {
  subway: "text-blue-400",
  rail:   "text-red-400",
  tram:   "text-purple-400",
  bus:    "text-green-400",
  ferry:  "text-cyan-400",
};

function pad2(n: number) { return String(n).padStart(2, "0"); }

function fmtTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ModeBreakdown({ modes }: { modes: Partial<Record<TransitMode, number>> }) {
  const entries = Object.entries(modes).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return null;
  return (
    <span className="ml-1">
      {entries.map(([mode, count], i) => (
        <span key={mode}>
          {i > 0 && <span className="text-white/20"> · </span>}
          <span className={MODE_COLOR[mode] ?? "text-white/50"}>{mode}×{count}</span>
        </span>
      ))}
    </span>
  );
}

export default function TransitLogPanel({ logs, onClear }: Props) {
  return (
    <div className="fixed right-0 top-0 bottom-0 w-80 z-40 flex flex-col bg-black/85 backdrop-blur-md border-l border-white/10 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
        <span className="text-white/70 font-sans text-[11px] font-semibold tracking-wide uppercase">
          Transit Log
        </span>
        <button
          onClick={onClear}
          className="text-white/30 hover:text-white/70 transition-colors text-[10px] px-2 py-0.5 rounded border border-white/10 hover:border-white/30"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-1">
        {logs.length === 0 ? (
          <p className="text-white/20 text-center mt-6 font-sans text-[11px]">No entries yet</p>
        ) : (
          logs.map(entry => (
            <div
              key={entry.id}
              className="px-3 py-1.5 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors"
            >
              {/* Row 1: timestamp, event badge, zoom */}
              <div className="flex items-center gap-1.5 leading-none">
                <span className="text-white/30">{fmtTime(entry.ts)}</span>
                <span className={`font-bold ${EVENT_COLOR[entry.event]}`}>{entry.event}</span>
                <span className="text-white/25">z={entry.zoom.toFixed(1)}</span>
              </div>
              {/* Row 2: stop count + mode breakdown or reason */}
              <div className="mt-0.5 leading-none text-white/40">
                {entry.stopCount !== undefined ? (
                  <>
                    <span>{entry.stopCount} stop{entry.stopCount !== 1 ? "s" : ""}</span>
                    {entry.modes && <ModeBreakdown modes={entry.modes} />}
                  </>
                ) : entry.reason ? (
                  <span className="text-white/30 italic">{entry.reason}</span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
