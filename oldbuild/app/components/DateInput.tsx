"use client";

import { useState, useRef } from "react";
import { toMapLocal } from "../lib/timezone";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatDateDisplay(d: Date, utcOffsetMin: number): string {
  const { year, month, day } = toMapLocal(d, utcOffsetMin);
  return `${MONTHS[month]} ${day}, ${year}`;
}

/**
 * Parse a user-typed date string. Accepts:
 *   "Mar 3" | "March 3" | "3/3" | "3/3/2026" | "2026-03-03"
 * Preserves the map-local hours/minutes of the base date.
 * Returns a new Date, or null if unparseable.
 */
function parseDateText(s: string, base: Date, utcOffsetMin: number): Date | null {
  s = s.trim();
  const { hours, minutes } = toMapLocal(base, utcOffsetMin);

  // Helper: produce a Date where the map-local date is year/month/day and
  // the map-local time is preserved from `base`.
  const makeDate = (year: number, month: number, day: number): Date | null => {
    const d = new Date(
      Date.UTC(year, month, day) - utcOffsetMin * 60000 + (hours * 60 + minutes) * 60000
    );
    return isNaN(d.getTime()) ? null : d;
  };

  // ISO: 2026-03-03
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return makeDate(+iso[1], +iso[2] - 1, +iso[3]);

  // MM/DD or MM/DD/YY or MM/DD/YYYY
  const mdy = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (mdy) {
    const { year: baseYear } = toMapLocal(base, utcOffsetMin);
    const rawYear = mdy[3] ? +mdy[3] : baseYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return makeDate(year, +mdy[1] - 1, +mdy[2]);
  }

  // Natural: "Mar 3", "March 3", "3 Mar" etc. — try parsing with current map-local year appended
  const { year: baseYear } = toMapLocal(base, utcOffsetMin);
  const attempt = new Date(`${s} ${baseYear}`);
  if (!isNaN(attempt.getTime())) {
    return makeDate(baseYear, attempt.getMonth(), attempt.getDate());
  }

  return null;
}

interface DateInputProps {
  date: Date;
  onChange: (d: Date) => void;
  utcOffsetMin?: number; // defaults to browser's own timezone if not provided
}

export default function DateInput({ date, onChange, utcOffsetMin: utcOffsetMinProp }: DateInputProps) {
  const utcOffsetMin = utcOffsetMinProp ?? -new Date().getTimezoneOffset();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const shouldCommit = useRef(true);

  function startEdit() {
    shouldCommit.current = true;
    setText(formatDateDisplay(date, utcOffsetMin));
    setEditing(true);
  }

  function commit(val: string) {
    if (!shouldCommit.current) {
      shouldCommit.current = true;
      return;
    }
    setEditing(false);
    const next = parseDateText(val, date, utcOffsetMin);
    if (next) onChange(next);
  }

  if (editing) {
    return (
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            shouldCommit.current = false;
            setEditing(false);
          }
        }}
        className="bg-white/10 rounded px-2 py-1 text-white text-xs border border-amber-400/60 focus:outline-none w-32 text-center"
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      className="text-white/70 hover:text-white/90 text-xs tabular-nums w-32 text-center rounded px-2 py-1 hover:bg-white/10 transition-colors"
      title="Click to set date (e.g. Mar 3, 3/3/2026)"
    >
      {formatDateDisplay(date, utcOffsetMin)}
    </button>
  );
}
