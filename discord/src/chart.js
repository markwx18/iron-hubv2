/* e1RM trend chart as SVG. Pure string-building so it is testable in Node; worker.js turns it
   into a PNG with resvg (Discord will not display SVG). Colours match the app's
   "forge on steel" palette. */
const C = { bg: '#0E1217', panel: '#151A21', grid: '#232A33', dim: '#8D909A', text: '#E6E8EB', amber: '#F6862F', cyan: '#46CDBA', red: '#E5534B' };
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function chartSVG(exercise, pts, opts) {
  const W = 900, H = 460, L = 70, R = 30, T = 80, B = 56;
  const font = (opts && opts.font) || 'IBM Plex Mono';
  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  const padV = (hi - lo) * 0.12; lo = Math.floor((lo - padV) / 5) * 5; hi = Math.ceil((hi + padV) / 5) * 5;
  // Spaced by DATE, not by index: a skipped week must show as a gap, or a lay-off reads as steady progress.
  const t0 = Date.parse(pts[0][0]), span = Date.parse(pts[pts.length - 1][0]) - t0;
  const x = (i) => L + (span <= 0 ? (W - L - R) / 2 : ((Date.parse(pts[i][0]) - t0) * (W - L - R)) / span);
  const weeks = Math.round(span / (7 * 86400000)) + 1;
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);

  const first = vals[0], last = vals[vals.length - 1];
  const change = Math.round((last - first) * 10) / 10;
  const best = Math.max(...vals);
  const trendCol = change > 0 ? C.cyan : change < 0 ? C.red : C.dim;

  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="' + escXml(font) + '">';
  s += '<rect width="100%" height="100%" fill="' + C.bg + '"/>';
  s += '<text x="' + L + '" y="36" fill="' + C.text + '" font-size="24" font-weight="600">' + escXml(exercise) + '</text>';
  s += '<text x="' + L + '" y="62" fill="' + C.dim + '" font-size="15">best e1RM per week · ' + pts.length + ' of ' + weeks + ' weeks logged</text>';
  s += '<text x="' + (W - R) + '" y="36" fill="' + C.amber + '" font-size="24" font-weight="600" text-anchor="end">' + last + ' lb</text>';
  s += '<text x="' + (W - R) + '" y="62" fill="' + trendCol + '" font-size="15" text-anchor="end">' + (change > 0 ? '+' : '') + change + ' lb · best ' + best + '</text>';

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = lo + ((hi - lo) * i) / steps, yy = y(v).toFixed(1);
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + C.grid + '" stroke-width="1"/>';
    s += '<text x="' + (L - 10) + '" y="' + (+yy + 5) + '" fill="' + C.dim + '" font-size="13" text-anchor="end">' + Math.round(v) + '</text>';
  }
  const labelIdx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
  labelIdx.forEach((i) => {
    s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - B + 26) + '" fill="' + C.dim + '" font-size="13" text-anchor="middle">' + escXml(pts[i][0].slice(5)) + '</text>';
  });

  const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
  if (pts.length > 1) {
    const area = path + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (H - B) + ' L' + x(0).toFixed(1) + ' ' + (H - B) + ' Z';
    s += '<path d="' + area + '" fill="' + C.amber + '" fill-opacity="0.08"/>';
    s += '<path d="' + path + '" fill="none" stroke="' + C.amber + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  pts.forEach((p, i) => {
    const isBest = p[1] === best;
    s += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p[1]).toFixed(1) + '" r="' + (isBest ? 6 : 4) + '" fill="' + (isBest ? C.cyan : C.amber) + '" stroke="' + C.bg + '" stroke-width="2"/>';
  });
  return s + '</svg>';
}
