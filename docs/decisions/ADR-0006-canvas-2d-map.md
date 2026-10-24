# ADR-0006: The map is drawn on Canvas 2D without a graphics library

## Status
Accepted

## Date
2026-10-23

## Context
The owner wants the map drawn on a canvas. It must show up to ~50 nodes and ~100 edges in the MVP (hundreds later,
with containers and pods), animate many requests at once, support pan, zoom and clicking, and keep a stable layout:
nodes must not jump when new ones appear.

## Decision
- Render with the browser's Canvas 2D API, through a small renderer module of our own (scene, hit-testing, pan and
  zoom, HiDPI scaling, animation loop) kept outside React's render cycle.
- Lay out nodes in fixed columns by kind (frontend → services → databases → external), with services ordered by
  call depth and nodes sorted by id inside a column. The layout depends only on the graph, so it is deterministic.
- No new UI graphics dependencies in the MVP.

## Rationale
- Canvas 2D easily handles the MVP's scale at 60 fps.
- No dependency to vet, update or fight; full control of the visuals.
- Column layout matches how developers think about a full-stack app and does not jump around.

## Alternatives considered
- **PixiJS** (MIT, WebGL): far more headroom for thousands of objects; adds a large dependency and blurry text when
  zoomed unless bitmap fonts are used. First choice if Canvas 2D runs out of speed.
- **Konva** (MIT): a scene graph with events on Canvas 2D; convenient, but slows down with many animated shapes.
- **React Flow / `@xyflow/react`** (MIT): DOM and SVG rather than canvas, and many animated elements are expensive.
- **Layout libraries**: dagre (`@dagrejs/dagre`, MIT) for layered graphs; d3-force (ISC) is unstable as nodes
  appear; ELK.js is EPL-2.0 and excluded by the license policy.

## Consequences
- Harder: we write hit-testing, pan and zoom, and text layout ourselves (a few hundred lines).
- Constrained: nested groups (container → pods) will need a real layout algorithm later.

## Validation / fitness criteria
- Frame time stays under 16 ms at the MVP target in `../architecture/quality-attributes.md`.
- Layout tests: the same graph always gives the same positions.

## Reconsider when
- Frame time exceeds 16 ms at target size → PixiJS.
- Docker or Kubernetes grouping is added → dagre with compound graphs.

## References
- `../architecture/components.md` (UI internals)
