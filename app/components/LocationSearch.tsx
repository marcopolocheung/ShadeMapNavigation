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
      <input
        type="text"
        value={query}
        onChange={handleChange}
        placeholder="Search location…"
        className="w-full bg-black/70 backdrop-blur-sm text-white placeholder-white/40 text-sm rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:border-white/30"
      />
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
