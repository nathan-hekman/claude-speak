// Background layer that sits BEHIND the avatar inside the stage. The avatar canvas is
// transparent except for her, so the chosen background shows through and around her —
// dropping her into a "world" (matrix rain, a moving grid, an aurora, a solid wash) or
// the default cyan glow. Self-contained; exposes window.AvatarBG for the settings panel.
// The gsplat "world" backgrounds are handled separately by avatar-bg-spark.js, which
// this controller defers to when the mode id starts with "world".
(() => {
  const stage = document.getElementById("ccAvatarStage");
  if (!stage) return;

  let cv = document.getElementById("avatarBg");
  if (!cv) { cv = document.createElement("canvas"); cv.id = "avatarBg"; stage.insertBefore(cv, stage.firstChild); }
  const ctx = cv.getContext("2d");

  const KEY = "claudette.bg";
  const MODES = ["default", "matrix", "grid", "aurora", "solid"];
  const LABELS = { default: "Default", matrix: "Matrix", grid: "Grid", aurora: "Aurora", solid: "Solid" };
  let mode = "default", raf = 0, start = 0, drops = [];
  try { const s = localStorage.getItem(KEY); if (s) mode = s; } catch (_) {}

  function resize() {
    const r = stage.getBoundingClientRect();
    cv.width = Math.max(2, Math.round(r.width));
    cv.height = Math.max(2, Math.round(r.height));
    initMatrix();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  window.addEventListener("resize", resize);

  // ---- matrix rain ----
  const FS = 15;
  function initMatrix() { const n = Math.ceil(cv.width / FS); drops = []; for (let i = 0; i < n; i++) drops[i] = Math.random() * -40; }
  function drawMatrix() {
    ctx.fillStyle = "rgba(2,7,13,0.12)"; ctx.fillRect(0, 0, cv.width, cv.height);   // trails
    ctx.font = `${FS}px ui-monospace, monospace`;
    for (let i = 0; i < drops.length; i++) {
      const x = i * FS, y = drops[i] * FS;
      const ch = String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96));
      ctx.fillStyle = Math.random() < 0.025 ? "rgba(207,255,224,0.95)" : "rgba(57,224,150,0.5)";
      ctx.fillText(ch, x, y);
      if (y > cv.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 0.55;
    }
  }

  // ---- moving perspective grid ----
  function drawGrid(t) {
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#03070e"; ctx.fillRect(0, 0, W, H);
    const horizon = H * 0.42, vx = W / 2;
    ctx.strokeStyle = "rgba(95,212,255,0.28)"; ctx.lineWidth = 1;
    // receding horizontal lines (scroll toward viewer)
    const scroll = (t * 0.00025) % 1;
    for (let i = 0; i < 16; i++) {
      const f = (i + scroll) / 16;
      const y = horizon + (H - horizon) * f * f;
      ctx.globalAlpha = Math.min(1, f * 1.4);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // converging verticals
    ctx.globalAlpha = 0.5;
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(vx + i * 26, horizon); ctx.lineTo(vx + i * (W / 5), H); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const g = ctx.createLinearGradient(0, horizon - 40, 0, horizon + 10);
    g.addColorStop(0, "rgba(120,90,255,0.18)"); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.fillRect(0, horizon - 40, W, 50);
  }

  // ---- soft drifting aurora blobs ----
  function drawAurora(t) {
    const W = cv.width, H = cv.height;
    ctx.fillStyle = "#03060d"; ctx.fillRect(0, 0, W, H);
    const blobs = [["rgba(60,200,255,0.22)", 0.27, 0.0009, 0.36], ["rgba(150,90,255,0.20)", 0.6, 0.0007, 0.3], ["rgba(60,255,170,0.16)", 0.5, 0.0011, 0.62]];
    for (const [col, phase, sp, yf] of blobs) {
      const x = W * (0.5 + 0.42 * Math.sin(t * sp + phase * 6.28));
      const y = H * (yf + 0.16 * Math.cos(t * sp * 0.8 + phase * 6.28));
      const rad = Math.max(W, H) * 0.42;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, col); g.addColorStop(1, "transparent");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }

  function drawSolid() { ctx.fillStyle = "#05080f"; ctx.fillRect(0, 0, cv.width, cv.height); }

  // Carve the avatar's silhouette out of whatever we just drew, so the animated world
  // lives strictly BEHIND/AROUND her (never painting over her face or body). The 3D core
  // canvas is the mask source: opaque where she is, transparent elsewhere. We erase with
  // destination-out, dilating a couple px so no stray glyph/line leaks at her edge. It
  // maps 1:1 to how the avatar layer blits the same source, so the cut lines up.
  function maskAvatar() {
    const A = window.AvatarAnim;
    const s = A && A.sourceCanvas && A.sourceCanvas();
    if (!s || !s.width || !s.height) return;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    const d = 2;
    for (let dx = -d; dx <= d; dx += d) for (let dy = -d; dy <= d; dy += d) {
      ctx.drawImage(s, 0, 0, s.width, s.height, dx, dy, cv.width, cv.height);
    }
    ctx.restore();
  }

  function loop(ms) {
    raf = requestAnimationFrame(loop);
    const t = ms - start;
    if (mode === "matrix") drawMatrix();
    else if (mode === "grid") drawGrid(t);
    else if (mode === "aurora") drawAurora(t * 0.001);
    else if (mode === "solid") drawSolid();
    if (mode !== "default") maskAvatar();
  }

  function apply(m) {
    if (!MODES.includes(m)) m = "default";
    mode = m;
    try { localStorage.setItem(KEY, m); } catch (_) {}
    stage.classList.toggle("bg-active", m !== "default");
    cancelAnimationFrame(raf); raf = 0;
    if (m === "default") { ctx.clearRect(0, 0, cv.width, cv.height); return; }
    resize(); start = performance.now();
    raf = requestAnimationFrame(loop);
  }

  window.AvatarBG = {
    set: apply,
    get: () => mode,
    modes: () => MODES.map((id) => ({ id, label: LABELS[id] })),
  };

  resize();
  apply(mode);
})();
