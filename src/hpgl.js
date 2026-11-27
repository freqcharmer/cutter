// HPGL builder for the USCutter MH series (limited HPGL subset: IN, SP, PU, PD, VS, FS).
export const UNITS_PER_INCH = 1016; // 40 units/mm; calibrate with the test square

/**
 * Builds HPGL from cut-ready paths (already compensated, ordered, and in cutter axes).
 * @param {Array<Array<[number, number]>>} paths  points in inches, origin at the blade start
 * @param {object} o  { speed (cm/s), force (g), stepsPerInch, sendSpeedForce, end: [x, y] }
 */
export function buildJob(paths, o = {}) {
  const k = o.stepsPerInch || UNITS_PER_INCH;
  const u = (v) => Math.round(v * k);
  const cmds = ['IN', 'SP1', 'PU0,0'];
  if (o.sendSpeedForce !== false) {
    if (o.speed) cmds.push(`VS${Math.round(o.speed)}`);
    if (o.force) cmds.push(`FS${Math.round(o.force)}`);
  }
  for (const path of paths) {
    if (path.length < 2) continue;
    const [x0, y0] = path[0];
    cmds.push(`PU${u(x0)},${u(y0)}`);
    // Drop repeated points after rounding, and keep each PD command a sensible length.
    let last = `${u(x0)},${u(y0)}`, batch = [];
    for (let i = 1; i < path.length; i++) {
      const p = `${u(path[i][0])},${u(path[i][1])}`;
      if (p === last) continue;
      batch.push(p); last = p;
      if (batch.length >= 40) { cmds.push('PD' + batch.join(',')); batch = []; }
    }
    if (batch.length) cmds.push('PD' + batch.join(','));
  }
  const [ex, ey] = o.end || [0, 0];
  cmds.push(`PU${u(ex)},${u(ey)}`, 'SP0');
  return cmds.join(';') + ';';
}
