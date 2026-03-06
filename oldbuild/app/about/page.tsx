import Link from "next/link";

export default function About() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <Link
          href="/"
          className="text-white/40 text-sm hover:text-white/70 transition-colors mb-8 block"
        >
          ← Map
        </Link>

        <h1 className="text-3xl font-semibold mb-1">ShadeMap API</h1>
        <p className="text-white/50 mb-10">
          Embed sun shadow simulation in your web app
        </p>

        {/* npm packages */}
        <section className="mb-10">
          <h2 className="text-base font-semibold mb-4 text-white/80 uppercase tracking-wider text-xs">
            npm Packages
          </h2>

          <div className="space-y-3">
            <div className="bg-white/5 border border-white/10 rounded-lg p-4">
              <h3 className="font-medium mb-1">Leaflet Plugin</h3>
              <code className="text-sm text-amber-400 block mb-2">
                npm install leaflet-shadow-simulator
              </code>
              <p className="text-sm text-white/50">
                Drop-in shadow layer for Leaflet maps
              </p>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-lg p-4">
              <h3 className="font-medium mb-1">
                Mapbox GL JS / MapLibre GL JS Plugin
              </h3>
              <code className="text-sm text-amber-400 block mb-2">
                npm install mapbox-gl-shadow-simulator
              </code>
              <p className="text-sm text-white/50">
                Shadow layer for Mapbox GL JS and MapLibre GL JS
              </p>
            </div>
          </div>
        </section>

        {/* Pricing tiers */}
        <section className="mb-10">
          <h2 className="text-base font-semibold mb-4 text-white/80 uppercase tracking-wider text-xs">
            API Tiers
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-white/40 text-left">
                <th className="pb-2 pr-6 font-normal">Tier</th>
                <th className="pb-2 pr-6 font-normal">Scope</th>
                <th className="pb-2 font-normal">Notes</th>
              </tr>
            </thead>
            <tbody className="text-white/70">
              <tr className="border-t border-white/10">
                <td className="py-3 pr-6 text-amber-400 font-medium">
                  Educational
                </td>
                <td className="py-3 pr-6">localhost only</td>
                <td className="py-3">Free API key</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="py-3 pr-6 font-medium">Commercial</td>
                <td className="py-3 pr-6">Custom domains</td>
                <td className="py-3">Paid</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="py-3 pr-6 font-medium">Enterprise</td>
                <td className="py-3 pr-6">Custom domains + basemap</td>
                <td className="py-3">
                  Paid, higher-accuracy building data
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* Features */}
        <section>
          <h2 className="text-base font-semibold mb-4 text-white/80 uppercase tracking-wider text-xs">
            Features
          </h2>
          <ul className="space-y-2 text-sm text-white/60">
            <li>Real-time shadow simulation from terrain elevation data (GeoTIFF, RGB tiles)</li>
            <li>OpenStreetMap building shadows with height-accurate 3D volumes</li>
            <li>Shadow accumulation maps — single day, date range, or full year</li>
            <li>GeoTIFF export for use in GIS workflows</li>
            <li>Custom GeoJSON building data supported</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
