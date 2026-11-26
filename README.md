# FantastiCut

A clean, fast, license-key-free cutting app for the **USCutter MH 871** (and other HPGL vinyl cutters).
Runs in Chrome or Edge. Nothing to install.

From **EMFDPRODCO**.

## Status

Phase 0: proving the connection. The diagnostic page can find the cutter and send a test square.

## Run it

Web Serial only works on an `https://` page or on `localhost`.

Local (any computer with Python):

```
python -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge.

## Plan

1. **Connect:** find the MH 871 on USB or serial and cut a 1-inch test square (HPGL: `IN; PU; PD;`).
2. **Usable core:** import SVG, PDF, and DXF; mat and roll view; size and position; speed, force, and blade-offset settings; send to the cutter.
3. **Better than SCAL:** text from installed fonts, weld and combine, weeding boxes and lines, image trace, nesting, and material presets.
4. **Later, maybe:** manual-registration print-and-cut. The MH has no optical sensor.

## Layout

```
index.html        app shell
styles.css        dark theme
src/app.js        UI wiring
src/serial.js     Web Serial connection (find port, open, write, log)
src/hpgl.js       HPGL command builder
```

## Cutter notes (MH 871)

- Language: a limited subset of HPGL (`IN`, `PU`, `PD`, `VS`, `FS`, `SP`).
- Units: 1016 per inch (40 per mm). To be confirmed on the first test cut.
- Serial: commonly 9600 baud, 8 data bits, no parity, 1 stop bit, XON/XOFF flow control. The baud rate must match the cutter's own menu setting.
