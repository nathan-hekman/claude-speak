// ASCII look "blocks": chunky, high-contrast retro look over the 3D head render.
// Implements the shared renderer interface every look exports:
//
//   export default function createRenderer(outCanvas, opts) -> { draw(srcCanvas), resize() }
//
// `srcCanvas` is the shared 3D head WebGL canvas (transparent background, head drawn
// opaque). We downsample it to a coarse glyph grid (slightly larger cells than the
// classic ramp, so the blocks read as solid pixels), then map each cell's luminance
// to a Unicode block/shade glyph: ' .░▒▓█'. Dim-but-present cells get a quadrant
// block (▖▗▘▝) keyed off the cell's sub-pixel brightness gradient so edges feel
// chiseled rather than uniformly square. Color tints toward the cyan terminal
// palette in the mids and trends to near-white at the bright end. Transparent
// cells (the background) are skipped. Pure 2D canvas, self-contained, no deps.
export default function createRenderer(outCanvas, opts = {}) {
  // Denser blocks than classic: bigger cells so each glyph reads as a chunky pixel.
  const cell = opts.cell ? Math.max(7, opts.cell + 3) : 9;  // output px per glyph column
  const aspect = opts.aspect || 1.18;                       // glyph height / width (blocks ~square)
  // Luminance ramp, dark -> bright. Space is the floor (skipped); full block is peak.
  const shades = opts.ramp || " .░▒▓█"; // ' .░▒▓█'
  const quads = ["▖", "▗", "▘", "▝"];   // ▖ ▗ ▘ ▝ (corner accents)
  const ctx = outCanvas.getContext("2d");
  const sample = document.createElement("canvas");
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  let cols = 0, rows = 0, cw = 0, ch = 0;

  function resize() {
    if (!outCanvas.width || !outCanvas.height) return;
    cols = Math.max(1, Math.floor(outCanvas.width / cell));
    rows = Math.max(1, Math.floor(outCanvas.height / (cell * aspect)));
    cw = outCanvas.width / cols;
    ch = outCanvas.height / rows;
    sample.width = cols; sample.height = rows;
    // Block glyphs fill their em box; size to the full cell so they butt together.
    ctx.font = `${Math.round(ch * 1.02)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
  }
  resize();

  return {
    resize,
    draw(srcCanvas) {
      if (!outCanvas.width || !srcCanvas.width) return;
      if (Math.floor(outCanvas.width / cell) !== cols) resize();
      sctx.clearRect(0, 0, cols, rows);
      sctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, cols, rows);
      const data = sctx.getImageData(0, 0, cols, rows).data;
      ctx.clearRect(0, 0, outCanvas.width, outCanvas.height);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const a = data[i + 3];
          if (a < 24) continue;                            // background -> skip
          const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;

          // Map luminance to a shade glyph. High contrast: push the curve so dark
          // areas collapse to the lighter blocks and bright areas slam to full block.
          const c = Math.pow(lum, 0.72);
          let gi = Math.floor(c * (shades.length - 1) + 0.5);
          gi = Math.min(shades.length - 1, Math.max(0, gi));
          let glyph = shades[gi];

          // Faint-but-lit cells: instead of a flat shade, drop a quadrant block whose
          // corner points toward the brighter neighbor, giving edges a chiseled feel.
          if (gi <= 1) {
            const right = x + 1 < cols ? lumAt(data, x + 1, y, cols) : lum;
            const down = y + 1 < rows ? lumAt(data, x, y + 1, cols) : lum;
            const dx = right - lum, dy = down - lum;
            const qi = (dy >= 0 ? 0 : 2) + (dx >= 0 ? 1 : 0); // ▗ ▖(no)... map to set below
            // qi: dy>=0,dx>=0 ->1(▗) ; dy>=0,dx<0 ->0(▖) ; dy<0,dx>=0 ->3(▝) ; dy<0,dx<0 ->2(▘)
            glyph = quads[qi];
          }
          if (glyph === " ") continue;

          // Color: cyan terminal palette in the mids, trending to near-white when bright.
          // Blue/green stay high; red ramps in hard past mid-luminance so peaks go white.
          const t = lum;
          const r = Math.round(40 + Math.pow(t, 1.6) * 205);
          const g = Math.round(150 + t * 105);
          const b = Math.round(170 + t * 85);
          ctx.fillStyle = `rgb(${r},${Math.min(255, g)},${Math.min(255, b)})`;
          ctx.fillText(glyph, x * cw + cw / 2, y * ch + ch / 2);
        }
      }
    },
  };
}

function lumAt(data, x, y, cols) {
  const i = (y * cols + x) * 4;
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
}
