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

**Phase 2:** weld, offset, weed border and weed lines, step and repeat, tiling, color layers.
**Phase 3:** trace upgrades, nesting, node editing.
**Later (needs a cutter with an optical sensor):** print and cut, contour cut, sublimation and inkjet sticker die-cutting.

## Run it locally

Web Serial only works on an `https://` page or on `localhost`.

```
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

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
src/job.js            cut order, overcut, blade offset, axes, time estimate
src/hpgl.js           HPGL output
src/serial.js         Web Serial connection
src/presets.js        materials and settings
vendor/               opentype.js, ImageTracer.js, dxf-parser, svgpath (ES module builds)
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

opentype.js (MIT), ImageTracer.js (Unlicense), dxf-parser (MIT), svgpath (MIT). Fonts are under the SIL Open Font License 1.1.
