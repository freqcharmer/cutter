// Material presets and cutter settings, kept in this browser's storage.
import { lsGet, lsSet } from './store.js';

// Starting points for an MH-series cutter with a 45° blade. Always confirm with a test cut.
export const DEFAULT_PRESETS = [
  { id: 'p651', name: 'Oracal 651 (permanent)', speed: 30, force: 90, passes: 1, bladeOffset: 0.25, overcut: 0.5, mirror: false, knob: 'Blade tip just past the holder: about the thickness of a credit card' },
  { id: 'p631', name: 'Oracal 631 (removable / wall)', speed: 30, force: 80, passes: 1, bladeOffset: 0.25, overcut: 0.5, mirror: false, knob: 'Same as 651' },
  { id: 'p751', name: 'Oracal 751 / 951 (cast)', speed: 25, force: 80, passes: 1, bladeOffset: 0.25, overcut: 0.5, mirror: false, knob: 'Same as 651' },
  { id: 'phtv', name: 'HTV, Siser EasyWeed', speed: 25, force: 70, passes: 1, bladeOffset: 0.25, overcut: 0.5, mirror: true, knob: 'Same as 651; load shiny carrier side down' },
  { id: 'pglt', name: 'Glitter HTV (60° blade)', speed: 15, force: 150, passes: 2, bladeOffset: 0.5, overcut: 0.5, mirror: true, knob: 'Use a 60° blade, extended slightly more' },
  { id: 'pref', name: 'Reflective (60° blade)', speed: 15, force: 180, passes: 1, bladeOffset: 0.5, overcut: 0.5, mirror: false, knob: 'Use a 60° blade' },
  { id: 'pstn', name: 'Stencil, Oramask 813', speed: 30, force: 70, passes: 1, bladeOffset: 0.25, overcut: 0.5, mirror: false, knob: 'Same as 651' },
];

export const DEFAULT_SETTINGS = {
  units: 'in',            // display units: 'in' or 'mm'
  cutWidth: 31,           // usable cutting width across the roll, inches (MH 871: 31")
  baud: 9600,
  flow: 'none',           // 'none' or 'hardware'
  chunk: 64, chunkDelay: 20,
  stepsPerInch: 1016,     // HPGL units per inch; calibrate with the test square
  sendSpeedForce: true,   // send VS/FS; turn off to use the cutter panel's settings
  swapXY: false, flipX: false, flipY: false,
  startAtBlade: true,     // move the job so its corner starts at the blade position
  afterCut: 'advance',    // 'advance' past the job, or 'origin'
  margin: 0.25,           // inches added around the job when starting at the blade
  presetId: 'p651',
};

export function loadPresets() {
  const p = lsGet('fc.presets', null);
  return Array.isArray(p) && p.length ? p : structuredClone(DEFAULT_PRESETS);
}
export const savePresets = (p) => lsSet('fc.presets', p);
export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...lsGet('fc.settings', {}) });
export const saveSettings = (s) => lsSet('fc.settings', s);
