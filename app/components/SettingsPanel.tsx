"use client";

import { useState } from "react";

interface SettingsPanelProps {
  showSunLines: boolean;
  onShowSunLinesChange: (v: boolean) => void;
}

export default function SettingsPanel({
  showSunLines,
  onShowSunLinesChange,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 items-start">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
          open
            ? "bg-white/20 text-white border border-white/30"
            : "bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10"
        }`}
        title="Settings"
      >
        ⚙ Settings
      </button>

      {open && (
        <div className="bg-black/70 backdrop-blur-sm rounded-lg p-3 flex flex-col gap-3 text-white text-xs min-w-[200px] border border-white/10">
          <div className="text-white/40 uppercase tracking-widest text-[9px] font-semibold">
            Display
          </div>

          {/* Sun direction lines toggle */}
          <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
            <span className="text-white/80">Sun direction lines</span>
            <input
              type="checkbox"
              checked={showSunLines}
              onChange={(e) => onShowSunLinesChange(e.target.checked)}
              className="accent-amber-400 w-4 h-4"
            />
          </label>

          {/* Legend shown when lines are active */}
          {showSunLines && (
            <div className="flex flex-col gap-1.5 pl-1 border-l border-white/10">
              <div className="flex items-center gap-2">
                <span className="text-yellow-300 text-sm leading-none">☀</span>
                <span className="text-white/50">Current sun (overlay)</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ backgroundColor: "#c2410c" }}
                />
                <span className="text-white/50">Sunrise</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ backgroundColor: "#1e40af" }}
                />
                <span className="text-white/50">Sunset</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
