# Navigation UX Improvements — Design

**Date:** 2026-03-03
**Status:** Approved

## Summary

Four improvements to the navigation system:
1. Draggable waypoint markers on the map
2. Explicit waypoint slot selection (prevent accidental map taps)
3. Full-height collapsible left sidebar for navigation panel
4. Move AccumulationPanel/SettingsPanel to bottom-right

---

## Layout

### When navMode = false
- Small standalone "Navigate" button at `bottom-6 left-3`
- AccumulationPanel + SettingsPanel + About link at `bottom-20 right-3` (glass card)
- LocationSearch stays at `top-3 left-3`

### When navMode = true (sidebar expanded)
- Full-height sidebar: `absolute inset-y-0 left-0 w-72 z-20`, glass dark background
- Sidebar contains: LocationSearch at top, waypoint inputs, action buttons, route cards (scrollable)
- Collapse tab: `→/←` button on right edge of sidebar, vertically centered
- Map remains full-width underneath (overlay approach)

### When navMode = true (sidebar collapsed)
- 40px-wide strip at left with just the collapse toggle tab
- Map is fully visible

---

## Feature: Waypoint Selection (prevent accidental taps)

- New `pendingSlot: 'A' | 'B' | null` state in `page.tsx`
- Map click **only fires** when `pendingSlot !== null`
- Each waypoint row has a map-pin icon button; clicking sets `pendingSlot`
- When active: pin button shows amber pulse ring; floating banner at map top shows "Click map to place waypoint A/B"
- After click: auto-advance A→B if B is empty, else null
- Escape cancels `pendingSlot`
- Map div gets `cursor-crosshair` when `pendingSlot !== null`

---

## Feature: Draggable Markers

- MapLibre Marker: `{ draggable: true }`
- New `MapView` prop: `onMarkerDragEnd: (slot: 'A' | 'B', coord: {lng, lat}) => void`
- On drag end: update waypoint coord + reverse geocode for label; clear stale routes

---

## Files Changed

| File | Changes |
|---|---|
| `app/page.tsx` | `pendingSlot` state; updated `handleMapClick`; drag callbacks; layout reorg |
| `app/components/NavigationPanel.tsx` | Full-height sidebar; pin buttons; collapse toggle; scrollable |
| `app/components/MapView.tsx` | `draggable: true`; `onMarkerDragEnd` prop; `mapClickActive` prop; crosshair cursor |
