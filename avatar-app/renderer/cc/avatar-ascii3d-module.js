// Command-center avatar: the chosen direction — a clean pre-rigged 3D head rendered
// as ASCII, with pointer/gyro parallax. Uses the shared avatar-head3d core (loads the
// GLB once, drives real ARKit visemes/blink) and an ASCII renderer that samples the
// core's render each frame. Installs into the window.AvatarAnim shim like the other
// loaders, so orb.js / SSE voice state drive it unchanged.
//
// Face selection is automatic: drop an Avaturn/RPM-generated GLB at
// pwa/static/vendor/claudette.glb and it is used on next load; otherwise the clean
// RPM placeholder (full visemes) is used. No code edit needed to swap her in.
import { createAvatarHead } from "/cc/avatar-head3d.js";
import createClassic from "/cc/ascii-render-classic.js";
import createBlocks from "/cc/ascii-render-blocks.js";

const api = window.AvatarAnim;
const host = document.getElementById("avatar");

// Selectable avatars (settings model picker). Both are Avaturn ARKit-rigged GLBs.
const MODELS = {
  a: { url: "/vendor/model6.glb", label: "Avatar A" },
  b: { url: "/vendor/model4.glb", label: "Avatar B" },
};
const FALLBACK = "/vendor/avatar-clean.glb";      // placeholder if the chosen model 404s
// Phone is a tall, full-bleed portrait: zoom out so the WHOLE head shows (no cropped
// hairline) and drop the aim so she rides high with neck/shoulders filling down to the
// bottom edge (kills the black gap). The desktop panel keeps the tighter original frame.
const PORTRAIT = (window.matchMedia && window.matchMedia("(max-width: 600px)").matches)
  || (window.innerHeight > window.innerWidth * 1.4);
const FRAME = PORTRAIT
  ? { head: "Head", fit: 1.30, aim: -0.05 }   // phone: whole head, centered; host shrinks when the terminal opens
  : { head: "Head", fit: 1.0, aim: 0.10 };    // desktop: tight shoulders-up face

let modelName = "a";
try { const s = localStorage.getItem("claudette.model"); if (s && MODELS[s]) modelName = s; } catch (_) {}

// /vendor is GET-only (HEAD -> 405), so probe with a 1-byte ranged GET.
async function probe(u) {
  try { const r = await fetch(u, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" }); return r.ok || r.status === 206; } catch (_) { return false; }
}

(async () => {
  if (!host) return;

  // Device-pixel ratio (capped) — drives crisp rendering on Retina / large fullscreen
  // panels. The avatar was fuzzy because everything ran at CSS resolution and got
  // upscaled; we now size the offscreen + output canvases in real device pixels.
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  let url = (await probe(MODELS[modelName].url)) ? MODELS[modelName].url : FALLBACK;

  host.innerHTML = "";

  // Static fallback face — shown when WebGL can't start (or the context is lost) so the
  // panel never goes blank. On-brand cyan ASCII; caption tells the user why + how to fix.
  let fbEl = null;
  function showFallback(msg) {
    if (!fbEl) {
      fbEl = document.createElement("div");
      fbEl.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:10px;pointer-events:none;" +
        "color:#5fd4ff;text-shadow:0 0 6px rgba(95,212,255,0.55);font-family:ui-monospace,Menlo,monospace;";
      const face = document.createElement("pre");
      face.style.cssText = "margin:0;line-height:1.05;font-size:clamp(11px,2.4vw,20px);opacity:0.92;";
      face.textContent = [
        " ╭───────────╮ ",
        " │  ◠     ◠  │ ",
        " │     ·     │ ",
        " │   ╲___╱   │ ",
        " ╰───────────╯ ",
      ].join("\n");
      const cap = document.createElement("div");
      cap.className = "avatar-fallback-cap";
      cap.style.cssText = "font-size:11px;letter-spacing:0.12em;opacity:0.7;text-align:center;max-width:80%;";
      fbEl.appendChild(face);
      fbEl.appendChild(cap);
      host.appendChild(fbEl);
    }
    fbEl.querySelector(".avatar-fallback-cap").textContent = msg || "AVATAR OFFLINE";
    fbEl.style.display = "flex";
  }
  function hideFallback() { if (fbEl) fbEl.style.display = "none"; }

  const out = document.createElement("canvas");
  out.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;" +
    "pointer-events:none;filter:drop-shadow(0 0 4px rgba(95,212,255,0.5));";
  host.appendChild(out);

  let core;
  try {
    core = createAvatarHead({
      url, renderW: 620, renderH: 700, frame: FRAME,
      // Context lost AFTER startup: show the fallback; hide it again on restore.
      onGL: (ok) => { if (ok) hideFallback(); else showFallback("AVATAR PAUSED · GPU CONTEXT LOST · reload if it persists"); },
    });
  } catch (e) {
    // Context never created (GPU blocklisted / hardware accel off / too many contexts).
    out.remove();
    showFallback("3D AVATAR UNAVAILABLE · WebGL blocked · enable hardware acceleration in chrome://settings, then reload");
    return;
  }

  // Load the face rig set in /face-rig. The SERVER copy (/api/face-anchors) is
  // authoritative so a rig set on the Mac reaches the phone too; localStorage is a
  // fast same-machine cache for an instant first paint.
  const FACE_KEY = "claudette.face.v1";
  let savedFace = {};
  try { savedFace = JSON.parse(localStorage.getItem(FACE_KEY) || "{}"); } catch (_) {}
  // ---- look / filter switching ---------------------------------------------------
  // Each ASCII look exports createRenderer(out, opts) -> { draw(src, fx?), resize() }.
  // "original" has no renderer — the loop blits the textured 3D canvas straight. A
  // per-look CSS filter retints the output (amber/green) without touching renderer code.
  const SHADOW = "drop-shadow(0 0 4px rgba(95,212,255,0.5))";
  const ctx2d = out.getContext("2d");
  // ASCII looks render at 1x (their natural coarse resolution) — device-pixel scaling only
  // helps the textured "original" look and would multiply ASCII's per-frame getImageData +
  // fillText cost on Retina. effDPR() returns 1 for ASCII looks, DPR for textured.
  // CLASSIC_CELL is the classic ramp's glyph size. It used to share blocks' 2.5 base, which
  // gave a ~240-wide grid (~28k cells, one fillText each) and stalled ascii/amber/green below
  // 60fps. 4.0 cuts the grid ~2.7x (the renderer also batches paints by colour); blocks and
  // the textured look are unaffected.
  const CELL = 2.5;            // base; blocks bumps to max(7, CELL+3)
  const CLASSIC_CELL = 4.0;    // classic ramp (ascii/amber/green) — tuned for 60fps incl. mobile
  const effDPR = () => (lookName === "original" ? DPR : 1);
  const LOOKS = {
    ascii:    { make: (o) => createClassic(o, { cell: CLASSIC_CELL, face: savedFace }), css: SHADOW },
    blocks:   { make: (o) => createBlocks(o, { cell: CELL }), css: SHADOW },
    original: { make: null, css: "drop-shadow(0 0 7px rgba(95,212,255,0.4))" },
    amber:    { make: (o) => createClassic(o, { cell: CLASSIC_CELL, face: savedFace }), css: SHADOW + " sepia(0.78) hue-rotate(-32deg) saturate(2.6) brightness(1.08)" },
    green:    { make: (o) => createClassic(o, { cell: CLASSIC_CELL, face: savedFace }), css: SHADOW + " hue-rotate(96deg) saturate(1.5)" },
  };
  let lookName = "ascii";
  try { const s = localStorage.getItem("claudette.look"); if (s && LOOKS[s]) lookName = s; } catch (_) {}
  let renderer = null;       // null => "original" look (blit the textured canvas)
  let carveFlags = null;     // set once the GLB's morphs are known (see detectRig)
  function applyCarve() { if (renderer && renderer.setCarve && carveFlags) renderer.setCarve(carveFlags); }
  function applyLook(name) {
    if (!LOOKS[name]) name = "ascii";
    lookName = name;
    try { localStorage.setItem("claudette.look", name); } catch (_) {}
    const L = LOOKS[name];
    out.style.filter = L.css;
    renderer = L.make ? L.make(out) : null;
    if (renderer) {
      if (renderer.resize) renderer.resize();
      applyCarve();
      if (savedFace && renderer.setFace) renderer.setFace(savedFace);
    } else {
      ctx2d.clearRect(0, 0, out.width, out.height);   // drop the last ASCII frame
    }
    if (typeof size === "function") size();   // re-resolution for this look's effDPR (ASCII=1x, original=DPR)
  }
  function applyAnchors(a) { if (a && typeof a === "object") { delete a.ts; Object.assign(savedFace, a); if (renderer && renderer.setFace) renderer.setFace(a); } }
  applyLook(lookName);
  function reapplyLocal() { try { const s = localStorage.getItem(FACE_KEY); if (s) applyAnchors(JSON.parse(s)); } catch (_) {} }
  function reapplyServer() {
    fetch("/api/face-anchors", { cache: "no-store" }).then((r) => r.json())
      .then((d) => { if (d && !d.empty) applyAnchors(d); }).catch(() => {});
  }
  reapplyServer();   // authoritative, shared across devices
  // Live updates: same-machine tabs via the storage event; any device re-pulls the
  // server on refocus (so the phone catches a rig you just saved on the Mac).
  window.addEventListener("storage", (e) => { if (e.key === FACE_KEY) reapplyLocal(); });
  window.addEventListener("pageshow", reapplyServer);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) reapplyServer(); });

  function size() {
    const r = host.getBoundingClientRect();
    const w = Math.max(2, Math.round(r.width)), h = Math.max(2, Math.round(r.height));
    // Textured "original" look renders at device pixels for crispness; ASCII looks render
    // at 1x (coarse by nature) so Retina doesn't 4x their per-frame readback cost.
    const eff = effDPR();
    const dw = Math.max(2, Math.round(w * eff)), dh = Math.max(2, Math.round(h * eff));
    out.width = dw; out.height = dh;
    // Render the head at the PANEL's own aspect so the ASCII fills edge-to-edge (no
    // pillarboxed sides) with the face centered by the core's vertical-fov framing —
    // a wider panel just reveals more shoulder, it never crops her sides. Resolution is
    // capped so a very wide panel doesn't blow up the offscreen GL target.
    const cap = 1400, scale = Math.min(1, cap / Math.max(dw, dh));
    core.resize(Math.max(2, Math.round(dw * scale)), Math.max(2, Math.round(dh * scale)));
    if (renderer && renderer.resize) renderer.resize();
  }
  if (window.ResizeObserver) new ResizeObserver(size).observe(host);
  window.addEventListener("resize", size);
  size();

  // A fully ARKit-rigged GLB (model6) blinks + speaks via real morphs, so the ASCII
  // layer must NOT also carve fake lids/lips on top (that double-blinks). Detect the
  // real morphs once the GLB is loaded and switch the procedural carve off; un-rigged
  // placeholders keep it on.
  (function detectRig() {
    if (!core.ready()) { setTimeout(detectRig, 120); return; }
    const names = new Set(core.morphNames());
    carveFlags = {
      blink: !(names.has("eyeBlinkLeft") || names.has("eyeBlinkRight") || names.has("eyesClosed")),
      mouth: !(names.has("jawOpen") || names.has("mouthOpen")),
    };
    applyCarve();
  })();

  // Settings model picker: hot-swap the GLB in place (no reload), persist the choice,
  // then re-frame at the current panel size.
  function applyModel(name) {
    if (!MODELS[name]) return;
    modelName = name;
    try { localStorage.setItem("claudette.model", name); } catch (_) {}
    probe(MODELS[name].url).then((ok) => { core.reload(ok ? MODELS[name].url : FALLBACK); size(); });
  }

  api._install({
    setState: (s) => core.setState(s),
    attachAudio: (el, ctx) => core.attachAudio(el, ctx),
    detachAudio: () => core.detachAudio(),
    setLevel: (v) => core.setLevel(v),
    setHeadPose: (y, p, r) => core.setHeadPose(y, p, r),
    setBlink: (v) => core.setBlink(v),
    setBlinkAmount: (v) => core.setBlinkAmount(v),
    setMouthOpen: (v) => core.setMouthOpen(v),
    setBrow: (v) => core.setBrow(v),
    setSmile: (v) => core.setSmile(v),
    setExpressionDrive: (on) => core.setExpressionDrive(on),
    setBlendshapes: (o) => core.setBlendshapes(o),
    morphNames: () => core.morphNames(),
    getDrive: () => core.getDrive(),
    setOrbit: (y, p) => core.setOrbit(y, p),
    setZoom: (f) => core.setZoom(f),
    playExpression: (n) => core.playExpression(n),
    turboBlink: (ms) => core.turboBlink(ms),
    setConfig: (c) => core.setConfig(c),
    getConfig: () => core.getConfig(),
    expressions: () => core.expressions(),
    setLook: (n) => applyLook(n),
    getLook: () => lookName,
    looks: () => Object.keys(LOOKS),
    setModel: (n) => applyModel(n),
    getModel: () => modelName,
    models: () => Object.keys(MODELS).map((k) => ({ id: k, label: MODELS[k].label })),
    // The solid 3D render (transparent bg, avatar opaque). The background layer samples
    // it as an alpha mask to carve her silhouette out of matrix/grid/aurora so the
    // animation runs strictly AROUND her, never across her face/body.
    sourceCanvas: () => core.canvas,
  });

  // Cursor-follow: the eyes track the pointer anywhere on screen, and the head turns a
  // little toward it too (real people lead a glance with a small head move). After 5s of
  // no mouse movement she eases back to a neutral gaze + forward-facing head.
  let idleTimer = null, followActive = false;
  function relax() { followActive = false; core.setEyeTarget(0, 0); core.setHeadPose(0, 0, 0); }
  window.addEventListener("mousemove", (e) => {
    const r = host.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.5)));
    const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.5)));
    core.setEyeTarget(dx, -dy);
    core.setHeadPose(dx * 15, -dy * 10, dx * 4);   // subtle head lead toward the cursor (pitch matches eyes)
    followActive = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(relax, 5000);
  }, { passive: true });

  // ---- click-drag orbits the whole model; hover parallax tilts the head; scroll zooms ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let gyro = false, dragging = false, lx = 0, ly = 0, orbitYaw = 0, orbitPitch = 0, zoomLevel = 1.0;
  // Auto-return: 5s after the last orbit/zoom input, ease the model smoothly back to the
  // default framing (front-facing, zoom 1). The ease itself runs in loop() so it shares the
  // render frame; a new drag/zoom or a fresh grab cancels it so it never fights the user.
  let homing = false, homeTimer = null;
  function scheduleHome() { homing = false; clearTimeout(homeTimer); homeTimer = setTimeout(() => { homing = true; }, 5000); }
  host.style.cursor = "grab";
  host.addEventListener("pointerdown", (e) => {
    dragging = true; lx = e.clientX; ly = e.clientY; host.style.cursor = "grabbing";
    homing = false; clearTimeout(homeTimer);          // grabbing cancels an in-progress return
    try { host.setPointerCapture(e.pointerId); } catch (_) {}
  });
  window.addEventListener("pointerup", () => { dragging = false; host.style.cursor = "grab"; });
  host.addEventListener("pointermove", (e) => {
    if (gyro || !dragging) return;   // hover head-turn is handled globally (cursor-follow)
    orbitYaw += (e.clientX - lx) * 0.5;
    orbitPitch = clamp(orbitPitch + (e.clientY - ly) * 0.4, -85, 85);
    lx = e.clientX; ly = e.clientY;
    core.setOrbit(orbitYaw, orbitPitch);
    scheduleHome();                                    // start the 5s idle -> return-home countdown
  });
  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomLevel = clamp(zoomLevel * (e.deltaY < 0 ? 1.1 : 0.9), 0.35, 4.0);
    core.setZoom(zoomLevel);
    scheduleHome();                                    // re-arm the return-home countdown on zoom
  }, { passive: false });
  function onOrient(ev) {
    if (ev.gamma == null && ev.beta == null) return;
    gyro = true;
    core.setHeadPose((ev.gamma || 0) * 0.5, ((ev.beta || 0) - 45) * 0.35, (ev.gamma || 0) * 0.15);
  }
  function enableGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      DOE.requestPermission().then((s) => { if (s === "granted") window.addEventListener("deviceorientation", onOrient); }).catch(() => {});
    } else if (DOE) window.addEventListener("deviceorientation", onOrient);
  }
  window.addEventListener("pointerdown", enableGyro, { once: true });

  function loop() {
    requestAnimationFrame(loop);
    if (homing) {
      // Exponential ease toward the default pose (~0.75s settle at 60fps). When essentially
      // there, snap exactly and stop so we don't keep nudging the orbit/zoom every frame.
      const k = 0.08;
      orbitYaw   += (0 - orbitYaw)   * k;
      orbitPitch += (0 - orbitPitch) * k;
      zoomLevel  += (1 - zoomLevel)  * k;
      if (Math.abs(orbitYaw) < 0.1 && Math.abs(orbitPitch) < 0.1 && Math.abs(zoomLevel - 1) < 0.003) {
        orbitYaw = 0; orbitPitch = 0; zoomLevel = 1; homing = false;
      }
      core.setOrbit(orbitYaw, orbitPitch);
      core.setZoom(zoomLevel);
    }
    core.tick(performance.now());
    if (renderer) renderer.draw(core.canvas, core.drive());
    else { ctx2d.clearRect(0, 0, out.width, out.height); ctx2d.drawImage(core.canvas, 0, 0, out.width, out.height); }   // "original" textured look
  }
  loop();
})();
