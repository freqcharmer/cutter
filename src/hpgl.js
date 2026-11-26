// HPGL builder for the USCutter MH series (limited HPGL subset).
export const UNITS_PER_INCH = 1016; // 40 units/mm; verify with the first test cut

const u = (inches) => Math.round(inches * UNITS_PER_INCH);

/**
 * Build HPGL for a list of paths.
 * @param {Array<Array<[number, number]>>} paths  points in inches, origin at the blade start
 * @param {{speed?: number, force?: number}} opts  speed in cm/s, force in grams (cutter-dependent)
 */
export function buildJob(paths, { speed, force } = {}) {
  const cmds = ['IN', 'SP1', 'PU0,0'];
  if (speed) cmds.push(`VS${speed}`);
  if (force) cmds.push(`FS${force}`);
  for (const path of paths) {
    if (path.length < 2) continue;
    const [x0, y0] = path[0];
    cmds.push(`PU${u(x0)},${u(y0)}`);
    const rest = path.slice(1).map(([x, y]) => `${u(x)},${u(y)}`).join(',');
    cmds.push(`PD${rest}`);
  }
  cmds.push('PU0,0', 'SP0', 'IN');
  return cmds.join(';') + ';';
}

/** A closed square, `size` inches, offset from the origin by `margin` inches. */
export function testSquare(size = 1, margin = 0.5) {
  const a = margin, b = margin + size;
  return [[[a, a], [b, a], [b, b], [a, b], [a, a]]];
}
