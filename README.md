# FantastiCut

A clean, fast, license-key-free cutting app for the **USCutter MH 871** (and other HPGL vinyl cutters).
Runs in Chrome or Edge, installs as an app, and works offline. Nothing to license.

From **EMFDPRODCO**. Live at https://emfdprodco.com/cutter/

## Status

**Phase 1 (done): a version you can cut with**
- 31" roll view with rulers, grid, zoom, and pan (mouse, touch, and pen)
- Import SVG, DXF, PNG, and JPG (images are traced to cut lines with ImageTracer.js)
- Text in included fonts, uploaded fonts, or fonts installed on the computer; letter height is the capital-letter height
- Select, move, resize, rotate, mirror, flip, duplicate, ungroup, align, nudge
- Undo/redo (150 steps) and autosave to the browser; Save/Open `.fcut` design files
- Material presets (speed, force, passes, blade offset, overcut, mirror, blade-depth note) and a test cut
- Drag-blade offset compensation, overcut, and a cut order that cuts inner shapes first
- Send over Web Serial, or save the job as an HPGL `.plt` file
- Installable offline app

**Phase 2 (done): save vinyl and labor**
- Right-click (or press and hold on touch or pen) anything for a menu: Weld, Unweld, Offset, Step and repeat, and more
- Weld (Ctrl+G) joins overlapping shapes into one outline; Unweld (Ctrl+Shift+G) splits it back, even after moving or resizing
- Text welds its letters by default (the "Weld letters" box), so script fonts cut as one piece
- Offset: a border outside (or a shape inside) with round, sharp, or beveled corners. It stays linked to the original and updates when the original changes; Unlink makes it a plain shape
- Color layers: multi-color SVG and DXF files come in as one layer per color; name and recolor layers in the side panel
- Cut window: cut one color at a time (with registration marks and a pause to load each vinyl), weed border and weed lines (kept clear of the design), and tiling into numbered panels with alignment crosses for designs wider than the roll
- Step and repeat: rows, columns, a gap, "fill the roll width", and optional weed lines between copies
- Blade lead-in: the blade swivels into line before each cut starts, so open lines start cleanly

**Phase 3:** trace upgrades, nesting, node editing.
**Later (needs a cutter with an optical sensor):** print and cut, contour cut, sublimation and inkjet sticker die-cutting.

## Run it locally

Web Serial only works on an `https://` page or on `localhost`.

```
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

## Tests

With the local server running on port 8123:

```
node tests/run.mjs http://localhost:8123/
```

It drives the app in headless Chrome, checks text welding, color layers, weld and unweld, the right-click menu, linked offsets, step and repeat, cutting by color, weeding, tiling, undo and redo, autosave, and touch long-press, and saves screenshots to `tests/out/`.

## Layout

```
index.html            app shell          app.css      editor styles
styles.css            legal pages        sw.js        offline cache
manifest.webmanifest  install info
src/app.js            UI wiring, dialogs, keyboard, files
src/view.js           canvas: drawing, selection, move/scale/rotate, pan/zoom
src/doc.js            document model, undo/redo, autosave
src/geom.js           matrices, curve flattening, measurements
src/import-svg.js     SVG import (units, transforms, colors)
src/import-dxf.js     DXF import (polylines with bulges, arcs, splines, blocks)
src/import-image.js   PNG/JPG threshold + trace
src/text.js           fonts and text outlines
src/job.js            cut plan (layers, panels, weeding, marks), cut order, overcut, blade offset, axes, time estimate
src/clip.js           weld, offset, and clipping (Clipper2)
src/hpgl.js           HPGL output
src/serial.js         Web Serial connection
src/presets.js        materials and settings
vendor/               opentype.js, ImageTracer.js, dxf-parser, svgpath, Clipper2 (ES module builds)
tests/run.mjs         headless tests (Playwright + Chrome); not deployed
fonts/                Bebas Neue, Oswald, Space Grotesk, Pacifico (SIL OFL)
```

## Cutter notes (MH 871)

- Language: a limited subset of HPGL (`IN`, `SP`, `PU`, `PD`, `VS`, `FS`).
- Units: 1016 per inch (40 per mm). Calibrate in Settings with the test square.
- Cutting width 31", force up to 350 g.
- Serial: commonly 9600 baud, 8 data bits, no parity, 1 stop bit. The baud rate must match the cutter's own menu setting.
- Direction: if the test cut comes out turned or mirrored compared with the preview, fix it in Settings → Direction.

### Cutting without Web Serial (USB printer driver)

If Windows has the cutter installed as a printer through USCutter's driver, a saved `.plt` file can be sent straight to it:

1. Share the cutter's printer (Printer properties → Sharing) with a short share name, such as `MH871`.
2. In Command Prompt: `copy /b fantasticut-job.plt \\localhost\MH871`

## Licenses of included code

opentype.js (MIT), ImageTracer.js (Unlicense), dxf-parser (MIT), svgpath (MIT), Clipper2 via clipper2-ts 2.0.1 (Boost Software License 1.0). Fonts are under the SIL Open Font License 1.1.
