# ShadeMap Build — Archive

This directory contains the original ShadeMap API-based shadow engine build,
preserved before the Phase 3 migration to the native shadow engine.

## What's here

- `app/` — full application snapshot at time of migration
- `package.json` — dependencies snapshot (includes `mapbox-gl-shadow-simulator`)

## Key difference from current build

The original build used `mapbox-gl-shadow-simulator` (a paid API library) in
`app/components/MapView.tsx` for all shadow rendering. The current production
build uses the native engine in `app/lib/shadow-engine/` instead.

## To restore this build

```bash
# Restore MapView.tsx from this snapshot
cp oldbuild/app/components/MapView.tsx app/components/MapView.tsx

# Reinstall the ShadeMap package
npm install mapbox-gl-shadow-simulator

# Set the API key in .env.local
echo "NEXT_PUBLIC_SHADEMAP_API_KEY=your_key_here" >> .env.local
```
