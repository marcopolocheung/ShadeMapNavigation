"use client";

import { useState } from "react";
import type { AccumulationOptions } from "./MapView";

interface Bounds {
  getWest(): number;
  getEast(): number;
  getNorth(): number;
  getSouth(): number;
}

interface AccumulationPanelProps {
  accumulation: AccumulationOptions;
  onChange: (opts: AccumulationOptions) => void;
  getCanvas: () => HTMLCanvasElement | undefined;
  getBounds: () => Bounds | undefined;
}

function toDateInput(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateInput(value: string, base: Date): Date {
  const [y, m, d] = value.split("-").map(Number);
  const next = new Date(base);
  next.setFullYear(y, m - 1, d);
  return next;
}

/**
 * Writes a minimal GeoTIFF (uncompressed RGB) with geographic metadata.
 * Uses ModelTiepointTag and ModelPixelScaleTag for georeferencing.
 */
function buildGeoTIFF(
  imageData: ImageData,
  west: number,
  north: number,
  east: number,
  south: number
): Blob {
  const { width, height } = imageData;
  const rgba = imageData.data;

  // Convert RGBA → RGB
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }

  const pixelScaleX = (east - west) / width;
  const pixelScaleY = (north - south) / height;

  // TIFF layout (little-endian):
  //   offset 0: 8-byte header
  //   offset 8: IFD (2 + 11*12 + 4 = 138 bytes)
  //   offset 146: BitsPerSample data (3 * 2 = 6 bytes)
  //   offset 152: ModelPixelScaleTag data (3 * 8 = 24 bytes)
  //   offset 176: ModelTiepointTag data (6 * 8 = 48 bytes)
  //   offset 224: RGB pixel data
  const NUM_ENTRIES = 11;
  const IFD_OFFSET = 8;
  const DATA_OFFSET = IFD_OFFSET + 2 + NUM_ENTRIES * 12 + 4; // 146
  const BPS_OFFSET = DATA_OFFSET; // 146
  const SCALE_OFFSET = BPS_OFFSET + 6; // 152
  const TIEPOINT_OFFSET = SCALE_OFFSET + 24; // 176
  const PIXEL_OFFSET = TIEPOINT_OFFSET + 48; // 224

  const buf = new ArrayBuffer(PIXEL_OFFSET + rgb.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let o = 0;

  // TIFF header
  view.setUint16(o, 0x4949, true); o += 2; // Little-endian ('II')
  view.setUint16(o, 42, true); o += 2;       // TIFF magic
  view.setUint32(o, IFD_OFFSET, true); o += 4;

  // IFD entry count
  view.setUint16(o, NUM_ENTRIES, true); o += 2;

  // Helper: write one 12-byte IFD entry
  function entry(tag: number, type: number, count: number, value: number) {
    view.setUint16(o, tag, true); o += 2;
    view.setUint16(o, type, true); o += 2;
    view.setUint32(o, count, true); o += 4;
    view.setUint32(o, value, true); o += 4;
  }

  // IFD entries (must be sorted by tag number)
  entry(256, 4, 1, width);                    // ImageWidth (LONG)
  entry(257, 4, 1, height);                   // ImageLength (LONG)
  entry(258, 3, 3, BPS_OFFSET);               // BitsPerSample (SHORT[3]) → offset
  entry(259, 3, 1, 1);                        // Compression: none
  entry(262, 3, 1, 2);                        // PhotometricInterpretation: RGB
  entry(273, 4, 1, PIXEL_OFFSET);             // StripOffsets
  entry(277, 3, 1, 3);                        // SamplesPerPixel
  entry(278, 4, 1, height);                   // RowsPerStrip
  entry(279, 4, 1, rgb.length);               // StripByteCounts
  entry(33550, 12, 3, SCALE_OFFSET);          // ModelPixelScaleTag (DOUBLE[3]) → offset
  entry(33922, 12, 6, TIEPOINT_OFFSET);       // ModelTiepointTag (DOUBLE[6]) → offset

  // Next IFD offset = 0 (no more IFDs)
  view.setUint32(o, 0, true); o += 4;

  // BitsPerSample data: [8, 8, 8]
  view.setUint16(BPS_OFFSET, 8, true);
  view.setUint16(BPS_OFFSET + 2, 8, true);
  view.setUint16(BPS_OFFSET + 4, 8, true);

  // ModelPixelScaleTag: [scaleX, scaleY, 0]
  view.setFloat64(SCALE_OFFSET, pixelScaleX, true);
  view.setFloat64(SCALE_OFFSET + 8, pixelScaleY, true);
  view.setFloat64(SCALE_OFFSET + 16, 0, true);

  // ModelTiepointTag: [i=0, j=0, k=0, x=west, y=north, z=0]
  view.setFloat64(TIEPOINT_OFFSET, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 8, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 16, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 24, west, true);
  view.setFloat64(TIEPOINT_OFFSET + 32, north, true);
  view.setFloat64(TIEPOINT_OFFSET + 40, 0, true);

  // Pixel data
  bytes.set(rgb, PIXEL_OFFSET);

  return new Blob([buf], { type: "image/tiff" });
}

export default function AccumulationPanel({
  accumulation,
  onChange,
  getCanvas,
  getBounds,
}: AccumulationPanelProps) {
  const [open, setOpen] = useState(false);

  function toggle() {
    const next = !accumulation.enabled;
    onChange({ ...accumulation, enabled: next });
    setOpen(next);
  }

  async function exportGeoTIFF() {
    const canvas = getCanvas();
    const bounds = getBounds();
    if (!canvas || !bounds) return;

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res));
    if (!blob) return;

    const bmp = await createImageBitmap(blob);
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, tmp.width, tmp.height);

    const tif = buildGeoTIFF(
      imageData,
      bounds.getWest(),
      bounds.getNorth(),
      bounds.getEast(),
      bounds.getSouth()
    );

    const url = URL.createObjectURL(tif);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shademap-accumulation.tif";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2 items-start">
      <button
        onClick={toggle}
        className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
          accumulation.enabled
            ? "bg-amber-500/90 text-black font-medium"
            : "bg-black/70 backdrop-blur-sm text-white/70 hover:text-white border border-white/10"
        }`}
      >
        ☀ Sun Exposure
      </button>

      {open && (
        <div className="bg-black/70 backdrop-blur-sm rounded-lg p-3 flex flex-col gap-2 text-white text-xs min-w-[240px]">
          <div className="flex items-center gap-2">
            <label className="text-white/50 w-12">From</label>
            <input
              type="date"
              value={toDateInput(accumulation.startDate)}
              onChange={(e) =>
                onChange({
                  ...accumulation,
                  startDate: parseDateInput(e.target.value, accumulation.startDate),
                })
              }
              className="flex-1 bg-white/10 rounded px-2 py-1 text-white border border-white/10 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-white/50 w-12">To</label>
            <input
              type="date"
              value={toDateInput(accumulation.endDate)}
              onChange={(e) =>
                onChange({
                  ...accumulation,
                  endDate: parseDateInput(e.target.value, accumulation.endDate),
                })
              }
              className="flex-1 bg-white/10 rounded px-2 py-1 text-white border border-white/10 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-white/50 w-12">Quality</label>
            <input
              type="range"
              min={8}
              max={64}
              step={8}
              value={accumulation.iterations}
              onChange={(e) =>
                onChange({ ...accumulation, iterations: Number(e.target.value) })
              }
              className="flex-1 accent-amber-400"
            />
            <span className="w-6 text-right tabular-nums">
              {accumulation.iterations}
            </span>
          </div>

          {/* Sun exposure legend */}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-white/50">0h</span>
            <div
              className="flex-1 h-2 rounded"
              style={{
                background:
                  "linear-gradient(to right, #000080, #0000ff, #00ffff, #00ff00, #ffff00, #ff8800, #ff0000)",
              }}
            />
            <span className="text-white/50">12h+</span>
          </div>

          <button
            onClick={exportGeoTIFF}
            className="mt-1 bg-white/10 hover:bg-white/20 transition-colors rounded px-3 py-1.5 text-center"
          >
            Export GeoTIFF
          </button>
        </div>
      )}
    </div>
  );
}
