# Save Route Feature — Implementation TODO (ClaudeCode)

## Overview

This document describes the implementation plan for adding a **Save Route** feature to the shade-based navigation system.

The feature allows users to:

* Save a generated route
* Name the route
* Organize routes into folders
* Re-open saved routes later

This supports common user workflows such as:

* Hotel → Train Station routes
* Daily walking routes
* Running routes
* Frequently used shaded paths

The system currently supports only **Point A → Point B routing**, which introduces constraints for users who want **looped routes (running routes)**.

This implementation focuses on **saving generated routes**, while introducing a **lightweight waypoint system** to enable more complex paths without building a full route-drawing engine.

The design prioritizes:

* compatibility with **OpenStreetMap data**
* compatibility with **Mapbox + WebGL rendering**
* minimal backend complexity
* entirely **free infrastructure**

---

# Feature Goals

## Core Goal

Allow users to **save and organize routes they frequently use**.

## Secondary Goal

Allow users to **build multi-point routes** using waypoints so they can create loop routes (useful for running).

---

# High-Level Architecture

Routes will be stored as:

```
Route {
    id
    name
    folder
    start_point
    end_point
    waypoints[]
    geometry
    created_at
}
```

Where:

* `geometry` = encoded polyline or GeoJSON
* `waypoints` = optional intermediate routing points

Routes will be stored using **localStorage or IndexedDB**.

Reason:

* avoids building backend
* privacy-friendly
* instant performance

---

# TODO LIST

## 1. Route Save Button

### Task

Add a **"Save Route" button** to the route result UI.

Visible only when:

* a route is currently displayed on the map

### Behavior

When clicked:

Open modal:

```
Save Route

Name: [____________]

Folder: [Dropdown]

[Create New Folder]

[Save]
```

### Reason

Users must be able to save routes **immediately after generating them**.

Placing the button near the routing result minimizes friction.

---

# 2. Folder System

### Task

Implement route folders.

Data structure:

```
Folder {
    id
    name
    created_at
}
```

Routes reference folder by `folder_id`.

### UI

Sidebar section:

```
Saved Routes
    Work
    Running
    Tourist Walks
```

Clicking folder expands routes.

### Reason

Users may save **many routes over time**.

Folders prevent clutter and mirror familiar paradigms (Google Maps lists).

---

# 3. Store Route Geometry

### Task

Save the **exact route geometry returned by the router**.

Recommended format:

```
Encoded polyline
```

Alternative:

```
GeoJSON LineString
```

Example:

```
geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@"
```

### Reason

Saving geometry avoids needing to **recompute the route**.

Benefits:

* fast route loading
* deterministic shading
* avoids API calls

---

# 4. Save Route Context

### Task

Save additional route metadata:

```
{
  time_of_day
  month_of_year
  shading_mode
}
```

### Reason

Shading depends on **solar position**.

Reopening a route should replicate the **original conditions** used when the route was saved.

---

# 5. Route Loading

### Task

When a saved route is clicked:

1. Load geometry
2. Render line on map
3. Place markers at start/end
4. Restore slider positions

### Reason

Users expect a saved route to **fully restore the previous state**.

---

# 6. Waypoint Support (Critical Feature)

### Problem

The router currently supports:

```
Point A → Point B
```

This prevents:

* loop running routes
* scenic routes
* multi-stop walking paths

### Task

Add **optional waypoints**.

New routing format:

```
A → W1 → W2 → B
```

Implementation:

```
route(points[])
```

Where:

```
points = [start, waypoint1, waypoint2, end]
```

### UI

Allow user to:

```
Alt + Click on map → Add waypoint
```

Waypoints appear as numbered markers.

### Reason

This provides **powerful routing flexibility** without requiring freehand drawing.

It also stays compatible with standard routing APIs.

---

# 7. Loop Route Creation

### Task

Allow user to generate a **loop route**.

Implementation:

```
start_point = end_point
waypoints define loop
```

Example:

```
Hotel → Park → River → Hotel
```

### Reason

Most runners want **circular routes**.

Waypoints make this possible without complex geometry editing.

---

# 8. Optional: Route Drawing Mode (Future Enhancement)

### Description

Allow user to draw a route manually.

System then **snaps the path to roads** using OSM graph.

### Reason

This enables extremely custom running routes.

However it requires:

* snapping algorithms
* path smoothing
* graph matching

Therefore this is **not recommended for first implementation**.

---

# 9. Route Editing

### Task

Allow users to:

```
Rename route
Move route to folder
Delete route
```

### UI

Context menu:

```
Rename
Move
Delete
```

---

# 10. Route Export (Optional)

### Task

Allow exporting route as:

```
GPX
GeoJSON
```

### Reason

Useful for:

* running watches
* sharing routes
* external mapping apps

---

# Storage Design

Recommended:

```
IndexedDB
```

Fallback:

```
localStorage
```

Reason:

Routes may contain long geometry strings.

IndexedDB scales better.

---

# UI Layout

Add a **left sidebar**:

```
Saved Routes
    + New Folder

    Running
        River Loop
        Downtown Loop

    Tourist Walks
        Cathedral → Plaza
```

Clicking route loads it.

---

# Edge Cases

### 1. Map Data Changes

If OSM roads change later, saved geometry may become outdated.

Mitigation:

Display warning:

```
"This route was saved previously and may not reflect current map data."
```

---

### 2. Sun Position Differences

If user loads route with different time/month:

Prompt:

```
Load with original sun conditions?

[Yes] [Use Current Settings]
```

---

# Technical Implementation Order

ClaudeCode should implement tasks in this order:

1. Save Route button
2. Route storage model
3. Folder system
4. Geometry saving
5. Route loading
6. Waypoints
7. Loop route support
8. Route editing
9. Export feature (optional)

---

# Final Notes

Key principle:

**Save the route geometry rather than recomputing routes.**

This ensures:

* faster performance
* predictable shading
* independence from routing APIs

Waypoints provide the **minimum viable flexibility** needed for running routes without building a full path editing engine.

This approach keeps the system:

* lightweight
* free
* compatible with OpenStreetMap
* compatible with Mapbox + WebGL rendering
* scalable for future features
