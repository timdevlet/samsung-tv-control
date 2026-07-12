// Procedural TV artwork for the app and tray icons — no image files, no image deps.
//
// Both scenes (color app icon, monochrome tray silhouette) are composed from simple shape
// predicates and painted hard-edged into an RGBA buffer at a large master size. The caller
// downscales with build-electron.mjs's box-filter resizeRGBA, which is what produces the
// anti-aliasing (same premultiplied-downscale approach the build already relies on).
//
// All geometry is expressed as fractions of the square canvas, so one scene definition serves
// every output size.

const BEZEL = [30, 36, 48, 255]; // dark slate, #1e2430
const SCREEN = [37, 99, 235, 255]; // app accent blue, #2563eb
const WHITE = [255, 255, 255, 255];

// --- shape predicates (coordinates in canvas fractions) --------------------------------------

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  // distance check only matters inside the corner squares
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Rounded-cap line segment of half-width hw (only vertical/horizontal bars are used here, but
// the general point-to-segment distance keeps it simple).
function inCapsule(px, py, x1, y1, x2, y2, hw) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy)));
  const dx = px - (x1 + t * vx);
  const dy = py - (y1 + t * vy);
  return dx * dx + dy * dy <= hw * hw;
}

// Power-symbol ring: an annulus around (cx, cy) with a gap at the top for the bar to pass
// through. rMid is the centerline radius, hw the half-thickness, gapHalf the half-angle of the
// gap measured from straight up.
function inPowerRing(px, py, cx, cy, rMid, hw, gapHalf) {
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < rMid - hw || d > rMid + hw) return false;
  return Math.abs(Math.atan2(dx, -(dy))) > gapHalf; // angle from the up direction
}

// --- painter ----------------------------------------------------------------------------------

// Paint every pixel where test(fx, fy) holds (fx/fy are the pixel center in canvas fractions).
// Shapes are painted opaquely in order, later over earlier.
function paint(rgba, size, color, test) {
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      if (test((x + 0.5) / size, fy)) rgba.set(color, (y * size + x) * 4);
    }
  }
}

// --- scenes -----------------------------------------------------------------------------------

// Color app icon: flat-panel TV — dark slate bezel, blue screen with a white power symbol,
// center stand. Transparent background.
export function drawAppIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  // stand behind the bezel
  paint(rgba, size, BEZEL, (x, y) => inRoundedRect(x, y, 0.475, 0.6, 0.05, 0.185, 0.015));
  paint(rgba, size, BEZEL, (x, y) => inRoundedRect(x, y, 0.32, 0.765, 0.36, 0.045, 0.0225));
  // panel
  paint(rgba, size, BEZEL, (x, y) => inRoundedRect(x, y, 0.08, 0.14, 0.84, 0.54, 0.045));
  paint(rgba, size, SCREEN, (x, y) => inRoundedRect(x, y, 0.115, 0.175, 0.77, 0.47, 0.025));
  // power symbol on the screen (center of the screen area is (0.5, 0.41))
  paint(rgba, size, WHITE, (x, y) => inPowerRing(x, y, 0.5, 0.41, 0.095, 0.019, (40 * Math.PI) / 180));
  paint(rgba, size, WHITE, (x, y) => inCapsule(x, y, 0.5, 0.285, 0.5, 0.41, 0.019));
  return rgba;
}

// Monochrome tray silhouette: the same TV as an outline — frame stroke, power glyph, stand —
// where the shape lives in the alpha channel. Geometry is designed on a 16px grid (the tray's
// base size) and expressed as sixteenths.
export function drawTraySilhouette(size, color) {
  const u = (v) => v / 16;
  const rgba = Buffer.alloc(size * size * 4);
  // frame: outer rounded rect minus the screen opening
  paint(
    rgba,
    size,
    color,
    (x, y) =>
      inRoundedRect(x, y, u(1), u(2), u(14), u(10), u(2)) &&
      !inRoundedRect(x, y, u(2.5), u(3.5), u(11), u(7), u(1)),
  );
  // power glyph on the screen
  paint(rgba, size, color, (x, y) => inPowerRing(x, y, u(8), u(7), u(2.1), u(0.65), (40 * Math.PI) / 180));
  paint(rgba, size, color, (x, y) => inCapsule(x, y, u(8), u(4.6), u(8), u(7), u(0.65)));
  // stand: neck + base bar
  paint(rgba, size, color, (x, y) => inRoundedRect(x, y, u(7.4), u(12), u(1.2), u(1.6), u(0.4)));
  paint(rgba, size, color, (x, y) => inRoundedRect(x, y, u(4.75), u(13.4), u(6.5), u(1.2), u(0.6)));
  return rgba;
}
