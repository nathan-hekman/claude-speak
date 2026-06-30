// ASCII look "classic": luminance ramp over the 3D head render, with PROCEDURAL
// mouth + blink carved into the glyph grid (the head GLB may have no blendshapes,
// so we fake speech/blink in the ASCII layer the way avatar-ascii.js does).
//
//   export default function createRenderer(outCanvas, opts) -> { draw(srcCanvas, fx), resize() }
//
// srcCanvas: the shared 3D head WebGL canvas (transparent bg; head opaque). The core
// renders it at the OUTPUT's aspect ratio, so sampling never stretches the face.
// fx (optional): { mouth: 0..1, blink: 0..1 } from core.drive(). Mouth opens a dark
// cavity at the mouth anchor (grows with `mouth`); blink draws closed lids over the eyes.
export default function createRenderer(outCanvas, opts = {}) {
  // cell = output px per glyph column. The host passes a perf-tuned value; floor it so a
  // stray tiny cell can't explode the grid — per-frame cost scales with cols*rows (one
  // fillText per filled cell), so e.g. cell 2.5 quadrupled the glyph count vs cell 5.
  const cell = Math.max(3.5, opts.cell || 4.5);
  const aspect = opts.aspect || 1.7;                 // glyph height / width
  const ramp = opts.ramp || " .,:;irsc020+*#MW&%@";
  // Face anchors as fractions of the output canvas. MUTABLE: the rig tool (/face-rig)
  // calls setFace() live and command-center loads a saved override from localStorage,
  // so the mouth/eyes/chin can be wired to wherever they actually land on each avatar.
  const F = Object.assign({
    mouthCx: 0.50, mouthCy: 0.635, mouthRx: 0.060, mouthRy: 0.013, mouthGrowRx: 0.016, mouthGrowRy: 0.040,
    eyeRx: 0.050, eyeRy: 0.020,
    lEyeX: 0.410, lEyeY: 0.470, rEyeX: 0.590, rEyeY: 0.470,   // eyes are INDEPENDENT (drag each in /face-rig)
    chinY: 0.760,   // jaw-drop floor: an open mouth slides toward this anchor
  }, opts.face || {});
  // Migrate legacy symmetric eye anchors (eyeDx/eyeY) from rigs saved before eyes split.
  {
    const f = opts.face || {};
    if (f.eyeDx != null || f.eyeY != null) {
      const dx = f.eyeDx != null ? f.eyeDx : 0.09, ey = f.eyeY != null ? f.eyeY : 0.47;
      if (f.lEyeX == null) F.lEyeX = 0.5 - dx;
      if (f.rEyeX == null) F.rEyeX = 0.5 + dx;
      if (f.lEyeY == null) F.lEyeY = ey;
      if (f.rEyeY == null) F.rEyeY = ey;
    }
    delete F.eyeDx; delete F.eyeY;
  }
  const ctx = outCanvas.getContext("2d");
  const sample = document.createElement("canvas");
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  let cols = 0, rows = 0, cw = 0, ch = 0;
  // Batched paint. The old hot loop set ctx.fillStyle to a freshly-built rgb() string and
  // called fillText once PER cell — tens of thousands of string allocs + state changes per
  // frame (the lag). Glyph colour is a pure function of the glyph index, so precompute one
  // fillStyle per ramp level and bucket cells by level: we then set fillStyle ~20x/frame and
  // allocate no colour strings in the loop. Buckets are reused (length=0) to avoid GC churn.
  const PAL = ramp.split("").map((_, gi) => {
    const t = gi / (ramp.length - 1);
    return `rgb(${Math.round(36 + t * 70)},${Math.round(120 + t * 135)},${Math.round(150 + t * 105)})`;
  });
  const lumBuckets = ramp.split("").map(() => []);   // per ramp level: flat [x0,y0,x1,y1,...]
  const mInner = [], mRim = [], lid = [];            // procedural carve cells (fixed colours)
  // Last contain-fit box of the head render inside the glyph grid (cells). Anchors
  // are fractions of THIS box, so the rig set in /face-rig maps 1:1 everywhere.
  let lastFit = { x0: 0, y0: 0, w: 1, h: 1, cols: 1, rows: 1 };
  // Procedural mouth/blink are a FALLBACK for GLBs with no blendshapes. A fully
  // ARKit-rigged model already opens its mouth / closes its eyes in the 3D render,
  // so carving fake lids/lips on top double-blinks. The host disables those via
  // setCarve() once it detects real morphs. Default ON for un-rigged placeholders.
  let carveMouth = true, carveBlink = true;
  if (opts.carve) {
    if ("mouth" in opts.carve) carveMouth = !!opts.carve.mouth;
    if ("blink" in opts.carve) carveBlink = !!opts.carve.blink;
  }

  function resize() {
    if (!outCanvas.width || !outCanvas.height) return;
    cols = Math.max(1, Math.floor(outCanvas.width / cell));
    rows = Math.max(1, Math.floor(outCanvas.height / (cell * aspect)));
    cw = outCanvas.width / cols;
    ch = outCanvas.height / rows;
    sample.width = cols; sample.height = rows;
    ctx.font = `${Math.round(ch * 0.95)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
  }
  resize();

  return {
    resize,
    setFace(p) { if (p) for (const k in p) if (typeof p[k] === "number" && isFinite(p[k])) F[k] = p[k]; },
    getFace() { return Object.assign({}, F); },
    setCarve(p) { if (p) { if ("mouth" in p) carveMouth = !!p.mouth; if ("blink" in p) carveBlink = !!p.blink; } },
    // Current head box inside the grid (cells) — /face-rig uses it to place handles
    // exactly over the face, matching where the renderer carves eyes/mouth.
    getFit() { return Object.assign({}, lastFit); },
    draw(srcCanvas, fx) {
      if (!outCanvas.width || !srcCanvas.width) return;
      if (Math.floor(outCanvas.width / cell) !== cols) resize();
      // Contain-fit the head render into the grid at the SOURCE aspect, centered
      // (letterboxed) — not stretched to fill. This keeps the head framed identically
      // regardless of panel shape, so a rig set in /face-rig's portrait preview lands
      // on the same spot in command-center's wide panel and on the phone. All anchors
      // below are fractions of this fitted box, not of the whole grid.
      const srcAR = srcCanvas.width / srcCanvas.height;     // fixed by the caller's core.resize
      const cellAR = srcAR * aspect;                        // grid-cell ratio that renders undistorted
      let fCols, fRows;
      if (cols / rows >= cellAR) { fRows = rows; fCols = Math.max(1, Math.round(rows * cellAR)); }
      else { fCols = cols; fRows = Math.max(1, Math.round(cols / cellAR)); }
      const ox = Math.floor((cols - fCols) / 2), oy = Math.floor((rows - fRows) / 2);
      lastFit = { x0: ox, y0: oy, w: fCols, h: fRows, cols, rows };
      sctx.clearRect(0, 0, cols, rows);
      sctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, ox, oy, fCols, fRows);
      const data = sctx.getImageData(0, 0, cols, rows).data;
      ctx.clearRect(0, 0, outCanvas.width, outCanvas.height);

      const m = fx ? (fx.mouth || 0) : 0;
      const blink = fx ? (fx.blink || 0) : 0;
      // Mouth opening tuned to read as lips parting (not a gaping void): vertical growth
      // is capped to a fraction of the mouth->chin gap and the jaw eases only gently down.
      const openShift = m * (F.chinY - F.mouthCy) * 0.18;   // jaw eases toward the chin
      const capH = (F.chinY - F.mouthCy) * 0.42;            // never swallow the chin
      const mcx = ox + F.mouthCx * fCols, mcy = oy + (F.mouthCy + openShift) * fRows;
      const mrx = (F.mouthRx + m * F.mouthGrowRx) * fCols;
      const mry = (F.mouthRy + Math.min(m * F.mouthGrowRy, capH)) * fRows;
      const erx = F.eyeRx * fCols, ery = F.eyeRy * fRows;
      const lcx = ox + F.lEyeX * fCols, lcy = oy + F.lEyeY * fRows, rcx = ox + F.rEyeX * fCols, rcy = oy + F.rEyeY * fRows;

      // Reset frame buckets (length=0 keeps the backing array, so no per-frame realloc).
      for (let k = 0; k < lumBuckets.length; k++) lumBuckets[k].length = 0;
      mInner.length = 0; mRim.length = 0; lid.length = 0;

      // Pass 1 — classify each cell into a colour bucket (no painting yet). Each cell lands
      // in exactly one bucket (carve cells `continue`, so they never also get a luma glyph),
      // so bucket draw order is irrelevant — the result is identical to painting in scan order.
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const px = x * cw + cw / 2, py = y * ch + ch / 2;
          // procedural mouth: soft-dark interior (reads as an open mouth, not a punched hole)
          // ringed by a lip rim, instead of skipping to the bare background.
          if (carveMouth && m > 0.04) {
            const ndx = (x - mcx) / mrx, ndy = (y - mcy) / mry, d = ndx * ndx + ndy * ndy;
            if (d < 1) { (d < 0.58 ? mInner : mRim).push(px, py); continue; }
          }
          // procedural blink: closed lid line over each eye (independent L/R positions)
          if (carveBlink && blink > 0.5) {
            const inL = Math.abs(x - lcx) < erx && Math.abs(y - lcy) < ery;
            const inR = Math.abs(x - rcx) < erx && Math.abs(y - rcy) < ery;
            if (inL || inR) {
              const cy = inL ? lcy : rcy;
              if (Math.abs(y - cy) < ery * 0.55) lid.push(px, py);
              continue;                              // suppress eye glyphs while closed
            }
          }
          const i = (y * cols + x) * 4;
          if (data[i + 3] < 24) continue;             // background -> skip
          const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          const gi = Math.min(ramp.length - 1, Math.max(0, Math.floor(lum * (ramp.length - 1))));
          if (ramp[gi] === " ") continue;
          lumBuckets[gi].push(px, py);
        }
      }

      // Pass 2 — paint each bucket with a SINGLE fillStyle: ~20 luminance levels + 3 carve
      // colours, vs. a fillStyle change + colour-string alloc per cell in the old loop.
      for (let gi = 0; gi < lumBuckets.length; gi++) {
        const b = lumBuckets[gi];
        if (!b.length) continue;
        ctx.fillStyle = PAL[gi];
        const glyph = ramp[gi];
        for (let j = 0; j < b.length; j += 2) ctx.fillText(glyph, b[j], b[j + 1]);
      }
      if (mInner.length) { ctx.fillStyle = "rgb(24,52,66)";   for (let j = 0; j < mInner.length; j += 2) ctx.fillText(":", mInner[j], mInner[j + 1]); }
      if (mRim.length)   { ctx.fillStyle = "rgb(70,150,180)";  for (let j = 0; j < mRim.length;   j += 2) ctx.fillText("-", mRim[j],   mRim[j + 1]); }
      if (lid.length)    { ctx.fillStyle = "rgb(120,210,235)"; for (let j = 0; j < lid.length;    j += 2) ctx.fillText("-", lid[j],    lid[j + 1]); }
    },
  };
}
