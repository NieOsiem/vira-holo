# Vira Holo

Holographic projections for Foundry VTT (v12–v14): a tile becomes a floating projection of an image, a heightmap terrain, or a sign, with a shared camera, annotations and links.

## Install

In Foundry, open **Add-on Modules → Install Module**, paste the manifest URL and install:

```text
https://github.com/NieOsiem/vira-holo/releases/latest/download/module.json
```

The module is installed as `vira-holo`; enable it in your world's module settings.

## Use

Give a tile holographic data from the Tile HUD button or the Tile config header ("Vira Holo", GMs only — settings are per tile and can be shared through a link).

- **Content**: mode `image` (floating panel), `terrain` (heightmap image) or `text` (signs). Cards show the projected image; terrain needs a matching heightmap.
- **Look**: colour, opacity, projector disc parts (solid ring, dashed ring, glow, north marker) as separate switches, auto-spin, data motes, terrain display style (terrain or wireframe, see-through or opaque, with contour lines and a coastline).
- **Annotations**: waypoints, freehand strokes, measurements (with optional map scale).
- **Link**: share content, annotations, view and/or look between tiles through a JournalEntry "link".
- **Maps** (GM): every link is a "map". A map can sit above another at a chosen spot — that spot becomes a portal pin — so one hologram can hold a world, a region, a town. Portals open a card to travel into a map; the ring's up glyph goes to the parent. Each map keeps its own camera, pins, drawings and measurements.
- **View**: camera, and who may drive it (the GM, plus players listed as owners).

Camera: drag to orbit, Shift+drag to pan, wheel to zoom, double-click to toggle auto-spin. Players with ownership of the tile can drive it; their camera and edits are shown live to everyone else.

Tools (ring under the hologram): recenter, auto-spin, waypoint, ping, pen, eraser, ruler (measure / adjust), undo, redo, settings (GM). Inks and stroke widths are picked in the strip under the active glyph. Ctrl/Cmd+click pings a spot on any hologram you can see, whether or not you drive it.

## Compatibility

Foundry VTT v12, v13 and v14. Verified on v12.343, v13.351 and v14.369.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
