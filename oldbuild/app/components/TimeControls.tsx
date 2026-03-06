"use client";

interface TimeControlsProps {
  date: Date;
  onChange: (date: Date) => void;
}

function toDateInput(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

export default function TimeControls({ date, onChange }: TimeControlsProps) {
  function handleDateChange(value: string) {
    const [y, m, d] = value.split("-").map(Number);
    const next = new Date(date);
    next.setFullYear(y, m - 1, d);
    onChange(next);
  }

  return (
    <div className="bg-black/70 backdrop-blur-sm rounded-lg p-3 flex items-center gap-2 text-white text-sm min-w-[240px]">
      <label className="text-white/50 text-xs w-8">Date</label>
      <input
        type="date"
        value={toDateInput(date)}
        onChange={(e) => handleDateChange(e.target.value)}
        className="flex-1 bg-white/10 rounded px-2 py-1 text-white text-xs border border-white/10 focus:outline-none focus:border-white/30"
      />
    </div>
  );
}
