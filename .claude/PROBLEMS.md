# TODO: Fix Snap-to-Exterior Landing in Unreachable Courtyards

## Background

The building footprint snap from the previous fix works for most cases, but fails at complex religious/institutional buildings with enclosed interior courtyards. At Santa Maria Novella, snapping projects the marker into a cloister (a hole in the multipolygon that is technically exterior to the building but completely walled off from the street network). The router then correctly reports no walkable path.

**Reproducer:**
- Point A: 18a, Piazza di Santa Maria Novella → fails ("No walkable path found")
- Point A: 20r, Piazza dell'Unità Italiana (same complex, street-facing side) → works

---

## Checklist

### Verify snapped point is routable

- [x] Find the snap-to-nearest-exterior logic added in the previous fix
- [x] After snapping outside the building polygon, add a second check: is the snapped point within a reasonable distance of a node or edge on the walkable street/path network?
- [x] If not reachable, discard that candidate snap point and find the nearest point that IS on a connected walkable segment instead
- [x] The final logic should be: snap to nearest routable node/edge, not snap to nearest building exterior

### Handle multipolygon inner rings correctly

- [x] Check how the snap logic treats inner rings (holes) in multipolygon buildings
- [x] Enclosed courtyards are geometrically "outside" the building polygon but physically unreachable — the snap must not treat them as valid landing zones
- [x] Consider filtering out candidate snap points that fall inside any enclosing outer ring but outside the building polygon (i.e., inside a hole)

### Fallback strategy

- [x] If the nearest routable point is unreasonably far from the original marker (e.g., >100m), surface a clear error to the user suggesting they move the marker closer to a street
- [x] Don't silently snap to a distant street — that would route from somewhere the user didn't intend

### Verification

- [ ] 18a, Piazza di Santa Maria Novella → 12, Piazza della Signoria: should find a route
- [ ] 20r, Piazza dell'Unità Italiana → 12, Piazza della Signoria: should still work (no regression)
- [ ] Marker dropped directly onto the basilica roof: should snap to a street-facing side, not a cloister
- [ ] Test against other cloister/courtyard buildings (e.g., Palazzo Pitti, Uffizi courtyard) to confirm the fix generalizes
- [ ] Run the 10x slight-variation stress test from the previous fix to confirm no regressions
