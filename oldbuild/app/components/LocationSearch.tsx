"use client";

import { useState, useRef, useCallback } from "react";

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
}

interface LocationSearchProps {
  onSelect: (center: [number, number], zoom: number) => void;
}

export default function LocationSearch({ onSelect }: LocationSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5`,
      { headers: { "User-Agent": "ShadeMapNav/1.0" } }
    );
    const data: NominatimResult[] = await res.json();
    setResults(data);
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(value), 400);
  }

  function handleSelect(r: NominatimResult) {
    setQuery(r.display_name.split(",")[0].trim());
    setResults([]);

    const [south, north, west, east] = r.boundingbox.map(Number);
    const center: [number, number] = [(west + east) / 2, (south + north) / 2];
    const latSpan = north - south;
    const zoom = Math.min(16, Math.max(2, Math.round(8 - Math.log2(latSpan))));
    onSelect(center, zoom);
  }

  return (
    <div className="relative min-w-[240px]">
      {/* Search icon */}
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-white/30"
        width="14" height="14" viewBox="0 0 20 20"
        fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="9" cy="9" r="6" />
        <line x1="14.5" y1="14.5" x2="18" y2="18" />
      </svg>
      <input
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Search location…"
        className="w-full bg-black/70 backdrop-blur-sm text-white placeholder-white/40 text-sm rounded-lg pl-9 pr-8 py-2 border border-white/10 focus:outline-none focus:border-white/30"
      />
      {/* Clear button — only when there is text */}
      {query.length > 0 && (
        <button
          onClick={() => { setQuery(""); setResults([]); }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors"
          aria-label="Clear search"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      )}
      {results.length > 0 && (
        <ul className="absolute top-full mt-1 w-full bg-black/90 backdrop-blur-sm rounded-lg overflow-hidden border border-white/10 z-20">
          {results.map((r, i) => (
            <li key={i}>
              <button
                onClick={() => handleSelect(r)}
                className="w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/10 transition-colors"
              >
                {r.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
