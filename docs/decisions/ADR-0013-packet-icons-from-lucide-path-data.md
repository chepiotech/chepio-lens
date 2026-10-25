# ADR-0013: Packet icons are Lucide path data drawn on the canvas, not an icon package

## Status
Accepted

## Date
2026-10-25

## Context
The map showed every hop of a request as a dot moving along its edge. The owner asked to see what travels instead: an
HTTP or HTTPS document with its body type, a SQL query by operation, the response coming back, failed calls, and log
records and user actions at their nodes. The map is one canvas drawn without a graphics library (ADR-0006), and every
third-party asset needs a license the project accepts (MIT, Apache-2.0, BSD, ISC, …) and the owner's approval.

## Decision
- The icons are outlines from Lucide 1.55.0 (`lucide-static`, ISC; `database`, `lock` and `navigation` are derived
  from Feather, MIT). `ui/scripts/importLucideIcons.mjs` converts the twelve SVGs the map uses into path data in
  `ui/src/map/icons/lucideIcons.ts`; both licenses are in `ui/src/map/icons/LICENSE-lucide.txt`. Lucide is not a
  package dependency. The owner approved Lucide on 2026-10-25.
- `MapRenderer` strokes the outlines with cached `Path2D` objects on a dark disc, so the canvas stays the only map
  surface (ADR-0006). The legend uses the same path data as React SVG elements, never `innerHTML` (I11).
- What each hop carries comes from the collector (`HopView.packet`), so the UI does not read span attributes.

## Rationale
- Lucide's icons are consistent, legible at 16 px, and permissively licensed; copying twelve outlines adds about
  3 KB and no runtime code, transitive dependencies or update churn.
- Path data keeps drawing in the renderer and works with `Path2D`, which every supported browser has.
- Deriving the packet in the collector keeps the attribute rules in one place, next to the edge error rule they share.

## Alternatives considered
- **Own simple glyphs** in code: no third-party license at all, but less recognisable shapes and design work for
  every new type. Recommended first; the owner chose Lucide.
- **`lucide` or `lucide-react` as a dependency**: the full icon set and a component per icon, but more code in the
  bundle than the twelve outlines, and React components do not draw on a canvas.
- **Icon font or sprite images**: text-shaped fonts and bitmaps blur when zoomed and need loading before the first
  frame.

## Consequences
- Easier: a new data type is an entry in the import list, a colour and a glyph rule in `ui/src/map/packets.ts`.
- Constrained: the license file must ship with the icons, and the import script's version must be stated when the
  set changes. Drawing an icon costs more than a dot: frame time rose from 0.8 ms to 1.9 ms at p95 at the target
  graph size, still within one 60 fps frame (`../architecture/quality-attributes.md`, run G).

## Validation / fitness criteria
- `ui/src/map/packets.test.ts` checks every icon the legend uses exists in the imported set.
- The frame-time harness stays within one 60 fps frame with icons and flashes.

## Reconsider when
- The map needs more than a few dozen icons, or Lucide's license changes.
- Canvas drawing of icons becomes a measured bottleneck.

## References
- `../../ui/scripts/importLucideIcons.mjs`, `../../ui/src/map/icons/LICENSE-lucide.txt`, ADR-0006
