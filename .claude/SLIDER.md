# Time of Day Slider — Functional Specification (User Perspective)

## Purpose

The Time of Day Slider allows users to select a specific time within a 24-hour day to preview how sunlight and shadows appear on the map at that moment.

The map updates instantly as the time changes.

---

# 1. Core Component

## Horizontal Time Slider

- A horizontal bar representing a full 24-hour cycle:
  - Start: 12:00 AM (midnight)
  - End: 11:59 PM
- A draggable handle (thumb) that moves left and right.
- Position on the slider directly corresponds to time of day.
- Moving the handle updates:
  - Sun position
  - Shadow direction
  - Shadow length
  - Overall lighting

---

# 2. Time Display

## Digital Time Label

- A visible text label showing the currently selected time.
- Example formats:
  - `6:30 AM`
  - `14:30`
- Updates in real time as the slider moves.
- Always reflects the exact slider position.

---

# 3. Slider Behavior

## Continuous Movement

- The handle moves smoothly while dragging.
- Map updates continuously during drag.
- No “Apply” button required.

## Optional Snap Behavior

- Slider may optionally snap to:
  - 1-minute increments
  - 5-minute increments
  - 15-minute increments
  - Hour increments

If snapping is enabled:
- On release, the handle locks to the nearest increment.

---

# 4. Direct Track Interaction

Optional feature:

- Clicking anywhere on the slider track:
  - Moves the handle directly to that time.
  - Updates map immediately.

---

# 5. Play / Pause Animation (Optional)

## Controls

- A play button (▶)
- A pause button (⏸)

## Behavior

When Play is pressed:
- Time advances automatically.
- The slider handle moves smoothly.
- Shadows update continuously.
- Time label updates dynamically.

When Pause is pressed:
- Animation stops.
- Slider remains at current time.

## Optional Animation Settings

- Adjustable speed (e.g., 1 hour per second)
- Looping at end of day

---

# 6. Visual Markers (Optional)

The slider may include labeled markers such as:

- Midnight
- Sunrise
- Noon
- Sunset

These markers:
- Provide orientation context.
- Are not necessarily interactive.

---

# 7. User Experience Expectations

The slider should:

- Feel smooth and responsive.
- Update shadows immediately while dragging.
- Keep time label perfectly synchronized.
- Never require manual refresh.
- Avoid noticeable delay between slider movement and visual change.

---

# 8. Minimum Viable Implementation

At minimum, the component must include:

- Horizontal 24-hour slider
- Draggable handle
- Live-updating time label
- Immediate shadow recalculation on change

Optional enhancements (not required for MVP):

- Play/pause animation
- Snap increments
- Sunrise/sunset markers
- Click-to-jump functionality

---

# Summary

The Time of Day Slider is a real-time interactive control that:

1. Maps a 24-hour range to a horizontal slider.
2. Displays the currently selected time in text.
3. Recalculates sun position and shadows instantly as the slider moves.
4. Optionally animates time progression.

It is designed to be intuitive, responsive, and visually synchronized with the map at all times.