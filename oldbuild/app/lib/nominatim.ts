export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

// Nominatim usage policy: max 1 request per second.
// A simple FIFO queue ensures forward + reverse geocode calls never exceed this.
const THROTTLE_MS = 1050; // slightly over 1 s to be safe
let lastMs = 0;
const pending: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (timer !== null) return;
  const fn = pending.shift();
  if (!fn) return;
  const wait = Math.max(0, lastMs + THROTTLE_MS - Date.now());
  timer = setTimeout(() => {
    timer = null;
    lastMs = Date.now();
    fn();
    if (pending.length > 0) flush();
  }, wait);
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.push(() => task().then(resolve, reject));
    flush();
  });
}

const HEADERS = { "User-Agent": "ShadeMapNavigator/1.0" };

export function geocodeForward(query: string): Promise<NominatimResult[]> {
  return enqueue(async () => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    return res.json() as Promise<NominatimResult[]>;
  });
}

/** Reverse geocode a point; returns first two comma segments of display_name, or null on failure. */
export function geocodeReverse(lat: number, lng: number): Promise<string | null> {
  return enqueue(async () => {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.display_name) return null;
    const parts: string[] = (data.display_name as string).split(",");
    return parts.slice(0, 2).map((p) => p.trim()).join(", ");
  });
}
