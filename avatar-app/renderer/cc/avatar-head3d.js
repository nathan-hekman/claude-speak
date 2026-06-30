// Reusable 3D head core — the single source of truth for "the Claudette GLB,
// rigged + animated". Loads the morph GLB with the vendored GLTFLoader, drives the
// real ARKit morphs + visemes, renders to its OWN offscreen canvas, and exposes a
// tiny imperative API. Both the textured look and every ASCII look read from
// `core.canvas`, so the GLB loads once and all panels share one render.
//
//   const core = createAvatarHead({ url, renderW, renderH });
//   core.setState('speaking'); core.setMouthOpen(0.6); ...
//   // each frame:
//   core.tick(performance.now());        // updates morphs + pose, renders to core.canvas
//   ctx.drawImage(core.canvas, ...);     // textured, or sample it into ASCII
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const DEG = Math.PI / 180;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number(v) || 0));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const _e = new THREE.Euler();      // scratch — reused each tick (single-threaded, no await between set+use)
const _dq = new THREE.Quaternion();
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

// Rotate a bone about a WORLD axis by `angle`, regardless of the bone's local frame.
// (Avaturn arm bones run their long axis along local +Y, so a naive local-Z spin just
// twists them in depth — useless for swinging the arm down. World-Z is "down" in screen space.)
function rotateAboutWorldAxis(bone, axisWorld, angle) {
  if (!bone || !bone.parent) return;
  const pW = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const qW = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
  const delta = pW.clone().invert().multiply(qW).multiply(pW);   // world rotation expressed in the bone's local space
  bone.quaternion.premultiply(delta);
}

export function createAvatarHead(opts = {}) {
  const url = opts.url || "/model/meshy_wJFC9A_talkinghead.glb";
  const renderW = opts.renderW || 360;
  const renderH = opts.renderH || 400;
  const FRAME = Object.assign({ fov: 18, fit: 1.18, lookY: 0.06, camY: 0.10 }, opts.frame || {});

  // Creating a WebGL context can fail outright (GPU blocklisted, hardware accel off,
  // or too many live contexts — Chrome caps ~16). Throw a clear, typed error so the
  // caller can paint a static fallback face instead of leaving the panel blank.
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  } catch (e) {
    const err = new Error("WebGL unavailable: " + (e && e.message || e));
    err.code = "NO_WEBGL";
    throw err;
  }
  renderer.setPixelRatio(1);                 // fixed-res offscreen target; consumers upscale
  renderer.setSize(renderW, renderH, false);
  renderer.setClearColor(0x000000, 0);

  // A context can also be LOST after creation (GPU reset, sleep/wake, contention). When
  // that happens we must stop issuing GL calls (they'd throw) and tell the caller to show
  // the fallback; on restore we resume. preventDefault() lets the browser try to restore.
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    state.glLost = true;
    try { opts.onGL && opts.onGL(false); } catch (_) {}
  }, false);
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    state.glLost = false;
    try { opts.onGL && opts.onGL(true); } catch (_) {}
  }, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FRAME.fov, renderW / renderH, 0.05, 100);
  camera.position.set(0, 0, 5);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x202833, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.5, 0.9, 1.2); scene.add(key);

  // Framing is vertical-fov based, so the head fills the frame HEIGHT and stays
  // undistorted at any aspect (wide panel -> head centered, transparent sides).
  // Recomputed on resize so changing the panel aspect never stretches the head.
  function applyFraming() {
    const size = state.size;
    if (!size) return;
    const zf = state.zoomFactor;
    if (state.headObj && state.headHp) {
      const hp = state.headHp;
      const headH = Math.max(0.16, (size.y / 2 - hp.y) * 2.2);
      const aimY = hp.y + headH * (FRAME.aim != null ? FRAME.aim : 0.06);
      const dist = (headH / 2) / Math.tan((FRAME.fov * DEG) / 2) * FRAME.fit / zf;
      camera.position.set(hp.x, aimY, hp.z + dist);
      camera.lookAt(hp.x, aimY, hp.z);
    } else {
      const maxDim = Math.max(size.x, size.y);
      const dist = (maxDim / 2) / Math.tan((FRAME.fov * DEG) / 2) * FRAME.fit / zf;
      camera.position.set(0, size.y * FRAME.camY, dist);
      camera.lookAt(0, size.y * FRAME.lookY, 0);
    }
    camera.updateProjectionMatrix();
  }
  function resizeRenderer(w, h) {
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyFraming();
  }

  const state = {
    name: "idle", micLevel: 0, glLost: false,
    extBlink: false, extBlinkAmt: 0, extMouth: 0, extBrow: 0, extSmile: 0, extBS: null, extBSSeen: new Set(),
    extDrive: false,             // realtime mocap owns the face: mute idle blink/smile + symmetric setters
                                 // so the per-side ARKit coeffs (wink, single brow, etc.) come through
    targetPose: { yaw: 0, pitch: 0, roll: 0 }, curPose: { yaw: 0, pitch: 0, roll: 0 },
    analyser: null, levelBuf: null, speechEnv: 0,
    blinkT0: -1e9, ready: false, morphs: new Map(), pivot: null,
    orbitYaw: 0, orbitPitch: 0, zoomFactor: 1.0,
    // smoothed drives (so smile/brow/teeth/idle-gaze ease in/out instead of snapping)
    smileCur: 0, browCur: 0, teethCur: 0, idleGazeX: 0, idleGazeY: 0,
    turboUntil: 0,                // performance.now() ms until which blinks fire rapidly
    expr: null,                   // user-triggered transient expression { name, t0, dur }
    idleExpr: null,               // ambient idle micro-expression { fn, t0, dur, seed }
    eyeTarget: { x: 0, y: 0 }, eyeCur: { x: 0, y: 0 },   // pupil gaze, smoothed toward target
    // user-tunable behaviour (settings overlay). Times in ms.
    cfg: {
      blinkPeriod: 3000, blinkVar: 2400, blinkDouble: 0.22,
      blinkDur: 170,             // ms for a full close+open; longer = more frames = smoother
      blinkClose: 0.34,          // fraction of the blink spent closing (rest = opening)
      eyeRelax: 0.15,            // constant lid lower so the eyes aren't wide-open (0 = wide)
      idleSmilePeriod: 8500, idleSmileVar: 9000, idleSmileAmt: 0.42,
      smileEase: 0.10,           // lower = slower/softer onset
    },
  };

  function setM(name, v) { const t = state.morphs.get(name); if (!t) return; const val = clamp(v); for (const e of t) e.infl[e.index] = val; }
  // Layer a value ON TOP of whatever a morph already holds (take the stronger of the
  // two). Used by the recorded ARKit performance so it adds expression without erasing
  // the idle blink/smile/visemes underneath.
  function addM(name, v) { const t = state.morphs.get(name); if (!t) return; const val = clamp(v); for (const e of t) if (val > e.infl[e.index]) e.infl[e.index] = val; }
  function mouthMorph(v) { setM("jawOpen", v * 0.46); setM("mouthOpen", v * 0.58); setM("mouth_open", v * 0.55); setM("jaw_drop", v * 0.4); }
  function smileMorph(v) { setM("mouthSmileLeft", v * 0.8); setM("mouthSmileRight", v * 0.8); setM("mouthSmile", v * 0.72); setM("mouth_smile", v * 0.7); }
  // A toothier smile: raise the upper lip (top teeth show) + a hair of jaw, layered ON TOP
  // of the corner-up smile so some idle smiles read open/bright and others stay closed-lip.
  // addM (not setM) so a 0 here never cancels the speaking jaw — it's a pure overlay.
  function teethMorph(v) { v = clamp(v); if (v <= 0) return; addM("mouthUpperUpLeft", v * 0.5); addM("mouthUpperUpRight", v * 0.5); addM("jawOpen", v * 0.13); addM("mouthOpen", v * 0.14); }
  function browMorph(v) { setM("browInnerUp", v * 0.7); setM("browOuterUpLeft", v * 0.76); setM("browOuterUpRight", v * 0.76); setM("brow_raise.L", v * 0.7); setM("brow_raise.R", v * 0.7); }
  function blinkMorph(v) { v = clamp(v); setM("eyeBlinkLeft", v); setM("eyeBlinkRight", v); setM("blink.L", v); setM("blink.R", v); setM("eyesClosed", v * 0.9); }
  // A real blink is fast and asymmetric: the lid SNAPS shut (~40 ms) then glides back
  // open (~110 ms). This shapes a 0..1 lid value over the blink's lifetime so the eye
  // never hard-cuts between open and closed.
  function blinkEnvelope(elapsed) {
    const dur = state.cfg.blinkDur, close = state.cfg.blinkClose;
    const p = elapsed / dur;
    if (p <= 0 || p >= 1) return 0;
    return p < close ? smoothstep(p / close) : smoothstep((1 - p) / (1 - close));
  }
  function squintMorph(v) { setM("eyeSquintLeft", v); setM("eyeSquintRight", v); setM("cheekSquintLeft", v * 0.6); setM("cheekSquintRight", v * 0.6); }
  function wideMorph(v) { setM("eyeWideLeft", v); setM("eyeWideRight", v); }
  function frownMorph(v) { setM("mouthFrownLeft", v); setM("mouthFrownRight", v); setM("browDownLeft", v * 0.5); setM("browDownRight", v * 0.5); }
  // Eye gaze: x,y in -1..1 (x>0 looks screen-right, y>0 looks up). She faces us, so a
  // glance screen-right = the right eye rotating nasally (In) + the left eye temporally
  // (Out). Drives the ARKit eyeLook* morphs so the pupils track without moving the head.
  function gazeMorph(x, y) {
    const r = Math.max(0, x), l = Math.max(0, -x), u = Math.max(0, y), dn = Math.max(0, -y);
    setM("eyeLookInRight", r); setM("eyeLookOutLeft", r);
    setM("eyeLookOutRight", l); setM("eyeLookInLeft", l);
    setM("eyeLookUpLeft", u); setM("eyeLookUpRight", u);
    setM("eyeLookDownLeft", dn); setM("eyeLookDownRight", dn);
  }

  // ---- transient expression programs -------------------------------------------------
  // Each returns morph overlays for a normalized progress p (0..1) and raw elapsed ms.
  // env() is a smooth attack/hold/release so nothing snaps. These layer ON TOP of the
  // base idle/speech drives in tick(), driving the avatar's real ARKit morphs.
  const env = (p, attack = 0.22, release = 0.30) =>
    p < attack ? smoothstep(p / attack)
      : p > 1 - release ? smoothstep((1 - p) / release) : 1;
  const EXPR = {
    smile:   { dur: 2600, fn: (p) => ({ smile: 0.95 * env(p) }) },
    grin:    { dur: 2400, fn: (p) => ({ smile: 1.0 * env(p), squint: 0.35 * env(p) }) },
    laugh:   { dur: 3000, fn: (p, t) => { const e = env(p, 0.12, 0.30); return {
                 smile: 0.85 * e, squint: 0.5 * e,
                 mouth: e * (0.45 + 0.45 * Math.max(0, Math.sin(t / 95))),   // ~5 Hz chuckle
                 bobY: Math.sin(t / 95) * 3.0 * e, bobX: Math.sin(t / 190) * 2.0 * e }; } },
    wink:    { dur: 520,  fn: (p) => ({ smile: 0.4 * env(p, 0.25, 0.35), winkL: env(p, 0.18, 0.30) }) },
    surprise:{ dur: 1500, fn: (p) => { const e = env(p, 0.10, 0.45); return {
                 mouth: 0.55 * e, wide: 0.9 * e, brow: 0.9 * e }; } },
    frown:   { dur: 2000, fn: (p) => ({ frown: 0.85 * env(p, 0.25, 0.30), brow: -0.3 * env(p) }) },
    nod:     { dur: 1400, fn: (p, t) => ({ smile: 0.3 * env(p), bobX: Math.sin(t / 150) * 7 * env(p) }) },
  };

  // ---- ambient idle micro-expressions ------------------------------------------------
  // A still face reads as dead. These small, SLOW looks fire on their own timers while
  // she's idle/listening and ease fully in and out (long attack + release) so nothing
  // snaps. `seed` (0..1, picked when a look starts) varies amplitude / toothiness / which
  // side / glance direction, so the same look never repeats identically. Each fn(p, seed)
  // returns an overlay { smile, teeth, brow, browL, browR, wide, squint, gazeX, gazeY }
  // that tick() folds onto the base drives; all are dropped the instant speech, a user
  // expression, or live mocap claims the face. Smiles also scale with the idleSmileAmt
  // slider, so the existing settings tuner keeps working.
  const slowEnv = (p, attack = 0.34, release = 0.42) =>
    p < attack ? smoothstep(p / attack)
      : p > 1 - release ? smoothstep((1 - p) / release) : 1;
  // Slow smiles — ride the settings cadence. seed decides how big + how toothy.
  const IDLE_SMILES = [
    { dur: 2600, fn: (p, s) => { const e = slowEnv(p); return {                  // soft, a little toothy
        smile: e * (0.34 + s * 0.40), teeth: e * s * s * 0.55, squint: e * (0.10 + s * 0.16) }; } },
    { dur: 2300, fn: (p, s) => { const e = slowEnv(p, 0.30, 0.46); return {      // closed-lip, gentlest
        smile: e * (0.24 + s * 0.22), squint: e * 0.09 }; } },
    { dur: 2900, fn: (p, s) => { const e = slowEnv(p); return {                  // warm grin, more teeth + faint brow
        smile: e * (0.42 + s * 0.34), teeth: e * (0.22 + s * 0.38), squint: e * 0.18, brow: e * 0.10 }; } },
  ];
  // Quick "sparks" — fire several times between the smiles to keep the in-between moments
  // alive: an eyebrow flash (acknowledgment), a quizzical single brow, an eye glance.
  const IDLE_SPARKS = [
    { dur: 1400, fn: (p, s) => { const e = slowEnv(p, 0.20, 0.44); return {      // brow flash + eyes raised ("mm-hm / oh")
        brow: e * (0.34 + s * 0.34), wide: e * (0.18 + s * 0.22), smile: e * 0.16 }; } },
    { dur: 1900, fn: (p, s) => { const e = slowEnv(p); const g = (s - 0.5) * 2; return {   // quizzical single brow
        browL: g < 0 ? e * (0.30 - g * 0.24) : 0, browR: g > 0 ? e * (0.30 + g * 0.24) : 0,
        brow: e * 0.08, smile: e * 0.12 }; } },
    { dur: 1700, fn: (p, s) => { const e = slowEnv(p, 0.28, 0.34); const g = (s - 0.5) * 2; return {  // eye glance away + back
        gazeX: g * 0.7 * e, gazeY: (s - 0.5) * 0.4 * e, brow: e * 0.06 }; } },
  ];

  // Load (or hot-swap) the GLB into the existing scene/renderer. Calling it again with a
  // new url disposes the previous model and remaps morphs, so the settings model picker
  // can switch avatars without a page reload or leaking a WebGL context.
  const loader = new GLTFLoader();
  function disposeCurrent() {
    if (!state.pivot) return;
    scene.remove(state.pivot);
    state.pivot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } if (m.dispose) m.dispose(); }
    });
    state.pivot = null;
  }
  function loadModel(u) {
    disposeCurrent();
    state.ready = false; state.morphs = new Map();
    state.headObj = state.headRest = state.neckObj = state.neckRest = state.size = null;
    loader.load(u, (gltf) => {
    const root = gltf.scene;
    state.pivot = new THREE.Group(); state.pivot.add(root); scene.add(state.pivot);
    const box = new THREE.Box3().setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    state.size = box.getSize(new THREE.Vector3());
    root.position.sub(c);
    state.pivot.updateMatrixWorld(true);
    // Head-shot: if the rig carries a head bone (RPM/Avaturn full-body avatars do),
    // frame to it; otherwise fit the whole bounding box (head-only Meshy meshes).
    state.headObj = null;
    if (FRAME.head) root.traverse((o) => { if (!state.headObj && o.name === FRAME.head) state.headObj = o; });
    state.headHp = state.headObj ? state.headObj.getWorldPosition(new THREE.Vector3()) : null;
    applyFraming();

    // Capture rest orientations so the pose composes ONTO them (head-only rotation),
    // and relax the arms out of any T-pose into a natural standing posture. Bone names
    // cover RPM/Avaturn ("Neck"/"LeftArm"...) and Mixamo ("mixamorig*") rigs.
    state.headRest = state.headObj ? state.headObj.quaternion.clone() : null;
    const bones = {};
    const want = ["Neck", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm",
      "mixamorigNeck", "mixamorigLeftArm", "mixamorigRightArm", "mixamorigLeftForeArm", "mixamorigRightForeArm"];
    root.traverse((o) => { if (!bones[o.name] && want.includes(o.name)) bones[o.name] = o; });
    state.neckObj = bones.Neck || bones.mixamorigNeck || null;
    state.neckRest = state.neckObj ? state.neckObj.quaternion.clone() : null;
    if (FRAME.relax !== false) {
      const lArm = bones.LeftArm || bones.mixamorigLeftArm;
      const rArm = bones.RightArm || bones.mixamorigRightArm;
      const lFore = bones.LeftForeArm || bones.mixamorigLeftForeArm;
      const rFore = bones.RightForeArm || bones.mixamorigRightForeArm;
      const ARM = FRAME.armDrop != null ? FRAME.armDrop : 1.18;   // ~68deg down out of T-pose
      root.updateWorldMatrix(true, true);                         // need fresh parent world quats
      rotateAboutWorldAxis(lArm, _AXIS_Z, -ARM);                  // her left arm: world +X -> swing down
      rotateAboutWorldAxis(rArm, _AXIS_Z, +ARM);                  // her right arm: world -X -> swing down
      rotateAboutWorldAxis(lFore, _AXIS_Z, -0.20);                // slight elbow bend so it reads relaxed
      rotateAboutWorldAxis(rFore, _AXIS_Z, +0.20);
    }
    root.traverse((o) => {
      if (!o.isMesh || !o.morphTargetDictionary || !o.morphTargetInfluences) return;
      o.frustumCulled = false;
      for (const [n, i] of Object.entries(o.morphTargetDictionary)) {
        if (!state.morphs.has(n)) state.morphs.set(n, []);
        state.morphs.get(n).push({ infl: o.morphTargetInfluences, index: i });
      }
    });
    blinkMorph(false);
    state.ready = true;
    if (opts.onReady) opts.onReady();
    }, opts.onProgress, (err) => { console.error("avatar-head3d load failed", err); if (opts.onError) opts.onError(err); });
  }
  loadModel(url);

  function readSpeech() {
    if (!state.analyser || !state.levelBuf) return 0;
    state.analyser.getByteTimeDomainData(state.levelBuf);
    let s = 0; for (let i = 0; i < state.levelBuf.length; i++) { const v = (state.levelBuf[i] - 128) / 128; s += v * v; }
    const rms = Math.sqrt(s / state.levelBuf.length);
    state.speechEnv = rms > state.speechEnv ? state.speechEnv + (rms - state.speechEnv) * 0.55 : state.speechEnv + (rms - state.speechEnv) * 0.18;
    return clamp(state.speechEnv * 4.5);
  }

  // Spectral lip-sync: instead of one open/close amplitude, classify WHERE the playing
  // TTS audio's energy sits — F1 (low) tracks jaw openness, F2 (mid) tracks vowel
  // frontness (ee/eh vs oo/oh), high band tracks fricatives (s/sh/f) — and ease a small
  // set of Oculus visemes toward those shapes. Purely local (no cloud), runs each frame.
  function readVisemes(loud) {
    const V = state.viseme || (state.viseme = { aa: 0, E: 0, O: 0, U: 0, SS: 0 });
    if (!state.analyser || !state.freqBuf || loud < 0.04) {        // silence/gap -> close
      for (const k in V) V[k] += (0 - V[k]) * 0.3;
      return V;
    }
    state.analyser.getByteFrequencyData(state.freqBuf);
    const buf = state.freqBuf, n = buf.length, binHz = (state.sampleRate / 2) / n;
    const band = (lo, hi) => { let s = 0, c = 0; const a = Math.max(1, (lo / binHz) | 0), b = Math.min(n - 1, (hi / binHz) | 0); for (let i = a; i <= b; i++) { s += buf[i]; c++; } return c ? s / c / 255 : 0; };
    const e1 = band(280, 900), e2 = band(900, 2600), eF = band(4200, 8500), eps = 1e-3;
    const fric = clamp(eF / (e1 + e2 + eF + eps) * 1.6);
    const front = clamp(e2 / (e1 + e2 + eps));
    const vowel = clamp(loud) * (1 - fric);
    const tgt = {
      aa: vowel * (0.55 + 0.45 * (1 - front)),   // open "ah"
      E:  vowel * front * 0.9,                    // wide front "ee/eh"
      O:  vowel * (1 - front) * 0.7,              // rounded "oh"
      U:  vowel * (1 - front) * 0.45,             // rounded "oo"
      SS: clamp(fric * (0.4 + loud)),             // narrow/teeth "s/sh/f"
    };
    for (const k in V) V[k] += ((tgt[k] || 0) - V[k]) * 0.4;       // ease toward target
    return V;
  }

  // auto-blink + idle smile schedulers (so a still panel still feels alive). Both read
  // from state.cfg so the settings overlay can retune frequency live. "Turbo blink"
  // shortens the interval while state.turboUntil is in the future.
  function fireBlink() {
    state.blinkT0 = performance.now();   // tick() plays the smooth lid envelope from here
    if (Math.random() < state.cfg.blinkDouble) setTimeout(() => { state.blinkT0 = performance.now(); }, state.cfg.blinkDur + 40);
  }
  (function blinkLoop() {
    const turbo = performance.now() < state.turboUntil;
    const delay = turbo ? (140 + Math.random() * 120) : (state.cfg.blinkPeriod + Math.random() * state.cfg.blinkVar);
    setTimeout(() => { fireBlink(turbo); blinkLoop(); }, Math.max(120, delay));
  })();
  // Start ONE idle look from `pool` — but only when she's genuinely idle/listening and
  // nothing higher-priority (speech, a user expression, live mocap) owns the face, and no
  // idle look is already playing. tick() reads state.idleExpr and eases it in/out.
  function tryIdle(pool) {
    if (state.extDrive || state.expr || state.idleExpr) return;
    if (state.name !== "idle" && state.name !== "listening") return;
    const e = pool[(Math.random() * pool.length) | 0];
    state.idleExpr = { fn: e.fn, dur: e.dur, t0: performance.now(), seed: Math.random() };
  }
  // Slow smiles ride the settings cadence (idleSmilePeriod/Var — the smile-frequency
  // slider); quick sparks fire more often so the between-smile moments stay alive.
  (function smileLoop() {
    setTimeout(() => { tryIdle(IDLE_SMILES); smileLoop(); },
      state.cfg.idleSmilePeriod + Math.random() * state.cfg.idleSmileVar);
  })();
  (function sparkLoop() {
    setTimeout(() => { tryIdle(IDLE_SPARKS); sparkLoop(); }, 3200 + Math.random() * 4200);
  })();

  function tick(nowMs) {
    if (state.glLost) return;                // context gone — skip GL work until restored
    const now = (nowMs == null ? performance.now() : nowMs) / 1000;
    if (state.ready) {
      const speaking = state.name === "speaking", listening = state.name === "listening", thinking = state.name === "thinking";
      const speech = speaking ? (readSpeech() || (0.18 + 0.18 * Math.sin(now * 14))) : 0;

      // Evaluate the active transient expression (laugh/smile/wink/...) into an overlay.
      let ex = null;
      if (state.expr) {
        const elapsed = (nowMs == null ? performance.now() : nowMs) - state.expr.t0;
        if (elapsed >= state.expr.dur) { state.expr = null; }
        else ex = EXPR[state.expr.name].fn(elapsed / state.expr.dur, elapsed);
      }

      // Ambient idle micro-expression overlay (varied slow smiles / brow flash / glance).
      // Lives only while genuinely idle or listening with nothing higher-priority active;
      // the moment speech, a user expression, or live mocap takes over it's dropped so it
      // never fights them. Smile/teeth scale with the idleSmileAmt slider (default 0.42).
      let idleEx = null;
      if (state.idleExpr) {
        const free = !state.extDrive && !ex && (state.name === "idle" || state.name === "listening");
        const el = (nowMs == null ? performance.now() : nowMs) - state.idleExpr.t0;
        if (!free || el >= state.idleExpr.dur) state.idleExpr = null;
        else idleEx = state.idleExpr.fn(el / state.idleExpr.dur, state.idleExpr.seed);
      }
      const idleAmt = clamp(state.cfg.idleSmileAmt / 0.42, 0, 1.7);   // smile-amount slider, ref'd to the default
      const idleSmile = idleEx ? clamp((idleEx.smile || 0) * idleAmt) : 0;

      // Realtime mocap (extDrive) owns the whole face: mute every idle/auto/symmetric
      // layer so the per-side ARKit coefficients (asymmetric blink, single brow, etc.)
      // overlaid below aren't flattened back to symmetric. extMouth/Smile/Brow stay 0 in
      // that mode (the live path drives via setBlendshapes only), so the symmetric
      // mouth/smile/brow morphs idle at 0 and the per-side coeffs come through clean.
      const ext = state.extDrive;
      const mouth = ext ? clamp(state.extMouth)
        : clamp(Math.max(speech, state.extMouth * 0.55, ex ? ex.mouth || 0 : 0));
      // smile/brow EASE toward their target (no snap from flat -> grin)
      const smileTarget = ext ? clamp(state.extSmile)
        : clamp(Math.max(state.extSmile, idleSmile, ex ? ex.smile || 0 : 0,
            listening ? 0.30 + state.micLevel * 0.14 : 0, speaking ? 0.12 : 0));
      const browTarget = ext ? clamp(state.extBrow)
        : clamp(Math.max(state.extBrow, ex ? ex.brow || 0 : 0, idleEx ? idleEx.brow || 0 : 0,
            thinking ? 0.30 : 0, listening ? 0.12 : 0,
            speaking ? 0.08 + speech * 0.16 : 0));   // brows lift a touch with the voice (co-speech)
      state.smileCur = lerp(state.smileCur, smileTarget, state.cfg.smileEase);
      state.browCur = lerp(state.browCur, browTarget, 0.14);
      // toothiness of the idle smile, eased on its own so teeth fade in/out with the smile
      const teethTarget = idleEx ? clamp((idleEx.teeth || 0) * idleAmt) : 0;
      state.teethCur = lerp(state.teethCur, teethTarget, 0.12);
      // blink: take the strongest of — manual hold (extBlink, pins shut), the recorded
      // mocap eyelid (extBlinkAmt, a continuous 0..1 so it rolls like a real blink), and
      // the idle auto-blink envelope. No path thresholds to 0/1, so none snap. In extDrive
      // the idle envelope + relaxed-lid baseline are muted so each eyelid is owned by its
      // own captured eyeBlinkLeft/Right coefficient.
      const blink = ext ? Math.max(state.extBlink ? 1 : 0, state.extBlinkAmt || 0)
        : Math.max(state.extBlink ? 1 : 0, state.extBlinkAmt || 0, state.cfg.eyeRelax,
            blinkEnvelope((nowMs == null ? performance.now() : nowMs) - state.blinkT0));
      state.driveMouth = mouth; state.driveBlink = blink; state.driveSmile = state.smileCur;
      // Zero every morph an extBS map ever touched (cheekPuff, mouthPucker, jawLeft, ...).
      // extBS overlays with addM (max), so when a map clears nothing else pulls these back
      // to 0 and the last pose stays baked in. The normal drives below re-set any of these
      // that are also idle-driven (jawOpen/eyeWide/etc), and the extBS pass re-overlays.
      for (const k of state.extBSSeen) setM(k, 0);
      // helper: clear the lip-shape + viseme set so a shape never sticks between states
      const clearLips = () => {
        setM("viseme_aa", 0); setM("viseme_E", 0); setM("viseme_I", 0); setM("viseme_O", 0); setM("viseme_U", 0);
        setM("viseme_SS", 0); setM("viseme_CH", 0); setM("viseme_FF", 0);
        setM("mouthFunnel", 0); setM("mouthPucker", 0); setM("mouthStretchLeft", 0); setM("mouthStretchRight", 0);
        setM("mouthClose", 0); setM("mouthPressLeft", 0); setM("mouthPressRight", 0); setM("mouthShrugUpper", 0);
      };
      if (speaking && state.analyser) {
        // Real lip-sync from the audio spectrum. Calm the jaw so it isn't a constant gape,
        // then layer the actual lip SHAPES (round / wide / closure) for word-like motion.
        const V = readVisemes(mouth);
        mouthMorph(clamp(V.aa * 0.42 + V.O * 0.22 + mouth * 0.08));
        setM("viseme_aa", V.aa); setM("viseme_E", V.E); setM("viseme_I", V.E * 0.7);
        setM("viseme_O", V.O); setM("viseme_U", V.U);
        setM("viseme_SS", V.SS); setM("viseme_CH", V.SS * 0.6); setM("viseme_FF", V.SS * 0.5);
        const round = clamp(V.O * 0.9 + V.U), wide = clamp(V.E), close = clamp(V.SS * 0.8);
        setM("mouthFunnel", round * 0.85); setM("mouthPucker", round * 0.6);   // oo / oh — lips forward+round
        setM("mouthStretchLeft", wide * 0.55); setM("mouthStretchRight", wide * 0.55);  // ee — lips wide
        setM("mouthClose", close * 0.5); setM("mouthPressLeft", close * 0.45); setM("mouthPressRight", close * 0.45); // s/f/m/p
        setM("mouthShrugUpper", V.SS * 0.25);
      } else if (speaking) {
        // Phone-mirror turn: no local audio to analyse, keep the amplitude proxy.
        mouthMorph(mouth);
        setM("viseme_aa", mouth * 0.90);
        setM("viseme_O", mouth * 0.30 * (0.5 + 0.5 * Math.sin(now * 9)));
        setM("viseme_U", Math.max(0, 0.22 - mouth * 0.16));
      } else {
        mouthMorph(mouth);
        clearLips();
      }
      smileMorph(state.smileCur); teethMorph(state.teethCur); browMorph(state.browCur); blinkMorph(blink);
      // Asymmetric idle brow (quizzical single-brow flick) layered on top of the symmetric
      // raise — addM so it only ever lifts one side further, never cancels the other.
      if (idleEx && (idleEx.browL || idleEx.browR)) {
        addM("browOuterUpLeft", idleEx.browL || 0); addM("brow_raise.L", idleEx.browL || 0);
        addM("browOuterUpRight", idleEx.browR || 0); addM("brow_raise.R", idleEx.browR || 0);
        addM("browInnerUp", Math.max(idleEx.browL || 0, idleEx.browR || 0) * 0.3);
      }
      // pupils ease toward the gaze target (cursor-follow) — drive after blink so eyeLook
      // and the lid coexist; gain keeps the eyes off the very corners.
      state.eyeCur.x = lerp(state.eyeCur.x, state.eyeTarget.x, 0.16);
      state.eyeCur.y = lerp(state.eyeCur.y, state.eyeTarget.y, 0.16);
      // idle eye glance eases on its own so the dart-and-return reads smooth, then adds on
      // top of the cursor-follow gaze (clamped so the pupils never hit the very corners).
      state.idleGazeX = lerp(state.idleGazeX, idleEx ? idleEx.gazeX || 0 : 0, 0.18);
      state.idleGazeY = lerp(state.idleGazeY, idleEx ? idleEx.gazeY || 0 : 0, 0.18);
      gazeMorph(clamp(state.eyeCur.x * 0.8 + state.idleGazeX * 0.7, -1, 1), clamp(state.eyeCur.y * 0.8 + state.idleGazeY * 0.6, -1, 1));
      // expression flavour morphs (squint/wide/frown/wink) — set every frame so they
      // return to 0 when no expression is active.
      squintMorph(Math.max(ex ? ex.squint || 0 : 0, idleEx ? idleEx.squint || 0 : 0, (speaking && !ext) ? speech * 0.16 : 0));   // slight squint with the voice
      wideMorph(Math.max(ex ? ex.wide || 0 : 0, idleEx ? idleEx.wide || 0 : 0));
      frownMorph(ex ? ex.frown || 0 : 0);
      if (ex && ex.winkL) { setM("eyeBlinkLeft", ex.winkL); setM("blink.L", ex.winkL); }
      // Recorded ARKit performance: overlay every captured coefficient by NAME onto its
      // matching morph (model6/avatar-clean GLBs use ARKit morph names verbatim). addM
      // takes the max so this rides on top of the idle drives above instead of fighting
      // them; coeffs with no matching morph are silently ignored.
      if (state.extBS) for (const k in state.extBS) addM(k, state.extBS[k]);
      const react = listening ? Math.min(state.micLevel * 30, 1) : 0;
      // Co-speech head motion: while speaking, add gentle nod/turn/tilt keyed to the voice
      // envelope so she moves WITH her words instead of sitting stock-still.
      const sp = (speaking && !ext) ? speech : 0;
      const swayY = Math.sin(now * 0.9) * (1.4 + react * 1.2) + Math.sin(now * 1.7) * sp * 2.4 + (ex ? ex.bobY || 0 : 0);
      const swayX = Math.cos(now * 0.61) * (1.0 + react) + Math.sin(now * 2.3) * sp * 1.6 + (ex ? ex.bobX || 0 : 0);
      const swayRoll = Math.sin(now * 1.3) * sp * 2.6;   // head tilt
      state.curPose.yaw = lerp(state.curPose.yaw, state.targetPose.yaw + swayY, 0.08);
      state.curPose.pitch = lerp(state.curPose.pitch, state.targetPose.pitch + swayX, 0.08);
      state.curPose.roll = lerp(state.curPose.roll, state.targetPose.roll + swayRoll, 0.08);
      // Head-only rotation: compose the pose delta onto the head bone's REST orientation
      // (so the face/eyes — parented under it — turn, but the body stays put). A fraction
      // bleeds into the neck so it doesn't look like a head spinning on a stiff stick.
      if (state.headObj && state.headRest) {
        _e.set(-state.curPose.pitch * DEG * 0.62, state.curPose.yaw * DEG * 0.62, state.curPose.roll * DEG * 0.55, "YXZ");
        _dq.setFromEuler(_e);
        state.headObj.quaternion.copy(state.headRest).multiply(_dq);
        if (state.neckObj && state.neckRest) {
          _e.set(-state.curPose.pitch * DEG * 0.26, state.curPose.yaw * DEG * 0.26, state.curPose.roll * DEG * 0.22, "YXZ");
          _dq.setFromEuler(_e);
          state.neckObj.quaternion.copy(state.neckRest).multiply(_dq);
        }
        // Orbit rotates the entire model independently of head-bone pose
        if (state.pivot) {
          state.pivot.rotation.y = state.orbitYaw * DEG;
          state.pivot.rotation.x = state.orbitPitch * DEG;
        }
      } else if (state.pivot) {
        // No head bone: orbit + head pose both on pivot
        state.pivot.rotation.y = state.curPose.yaw * DEG * 0.5 + state.orbitYaw * DEG;
        state.pivot.rotation.x = -state.curPose.pitch * DEG * 0.4 + state.orbitPitch * DEG;
        state.pivot.rotation.z = state.curPose.roll * DEG * 0.3;
      }
    }
    renderer.render(scene, camera);
  }

  function zeroAll() { for (const arr of state.morphs.values()) for (const e of arr) e.infl[e.index] = 0; }

  return {
    canvas: renderer.domElement,
    renderW, renderH,
    ready: () => state.ready,
    tick,
    resize: resizeRenderer,
    drive() { return { mouth: state.driveMouth || 0, blink: state.driveBlink || 0, smile: state.driveSmile || 0, speaking: state.name === "speaking" }; },
    // ---- debug / mapping helpers ----
    morphNames() { return Array.from(state.morphs.keys()); },
    getDrive() { return { name: state.name, mouth: state.driveMouth || 0, speech: state.speechEnv || 0, analyser: !!state.analyser, vis: Object.assign({}, state.viseme || {}) }; },
    zeroAll,
    applyMorphs(obj) { zeroAll(); for (const [k, v] of Object.entries(obj || {})) setM(k, v); },
    render() { if (!state.glLost) renderer.render(scene, camera); },
    glLost: () => state.glLost,
    object3d() { return state.pivot; },
    setState(n) { state.name = n || "idle"; if (state.name !== "speaking") state.speechEnv = 0; },
    setLevel(v) { state.micLevel = clamp(v * 8); },
    setHeadPose(yaw, pitch, roll) { state.targetPose = { yaw: clamp(yaw, -35, 35), pitch: clamp(pitch, -28, 28), roll: clamp(roll, -25, 25) }; },
    setBlink(v) { state.extBlink = !!v; },
    // continuous lid (0..1) — used by mocap playback so a recorded blink rolls smoothly
    // instead of thresholding to a binary open/closed.
    setBlinkAmount(v) { state.extBlinkAmt = clamp(v); },
    // pupil gaze target, x,y in -1..1 (x>0 = screen-right, y>0 = up). Eyes ease to it.
    setEyeTarget(x, y) { state.eyeTarget.x = Math.max(-1, Math.min(1, x || 0)); state.eyeTarget.y = Math.max(-1, Math.min(1, y || 0)); },
    // hot-swap the GLB (settings model picker). Re-applies framing on the next resize.
    reload(u) { if (u) loadModel(u); },
    // settings overlay: live-tune idle behaviour. Accepts any subset of cfg keys.
    setConfig(p) { if (p && typeof p === "object") for (const k in p) if (k in state.cfg && isFinite(p[k])) state.cfg[k] = +p[k]; },
    getConfig() { return Object.assign({}, state.cfg); },
    // play a transient expression preset (smile/grin/laugh/wink/surprise/frown/nod).
    playExpression(name) { if (EXPR[name]) state.expr = { name, t0: performance.now(), dur: EXPR[name].dur }; },
    expressions() { return Object.keys(EXPR); },
    // blink rapidly for `ms` (default 3s).
    turboBlink(ms) { state.turboUntil = performance.now() + (ms > 0 ? ms : 3000); },
    setMouthOpen(v) { state.extMouth = clamp(v); },
    setBrow(v) { state.extBrow = clamp(v); },
    setSmile(v) { state.extSmile = clamp(v); },
    // Realtime mocap on/off: when on, idle blink/smile + symmetric drives are muted so the
    // per-side ARKit coefficients fed via setBlendshapes drive the face directly.
    setExpressionDrive(on) { state.extDrive = !!on; },
    // Full ARKit coefficient map { morphName: 0..1 } from a recorded face performance.
    // Pass null/empty to clear. Names that don't exist on this GLB are no-ops.
    setBlendshapes(obj) { state.extBS = obj && typeof obj === "object" && Object.keys(obj).length ? obj : null; if (state.extBS) for (const k in state.extBS) state.extBSSeen.add(k); },
    setOrbit(yaw, pitch) { state.orbitYaw = yaw || 0; state.orbitPitch = Math.max(-85, Math.min(85, pitch || 0)); },
    setZoom(factor) { state.zoomFactor = Math.max(0.3, Math.min(5.0, factor || 1.0)); applyFraming(); },
    attachAudio(audioEl, audioCtx) {
      if (!audioEl || !audioCtx) return;
      try {
        if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
        const src = audioEl._ccHeadSource || audioEl._ccSource || audioCtx.createMediaElementSource(audioEl);
        audioEl._ccHeadSource = src;
        if (!audioEl._ccHeadAnalyser) { const an = audioCtx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.5; audioEl._ccHeadAnalyser = an; src.connect(an); an.connect(audioCtx.destination); }
        state.analyser = audioEl._ccHeadAnalyser;
        state.levelBuf = new Uint8Array(state.analyser.fftSize);            // time-domain (RMS)
        state.freqBuf = new Uint8Array(state.analyser.frequencyBinCount);   // spectrum (visemes)
        state.sampleRate = audioCtx.sampleRate || 48000;
      } catch (e) { console.warn("attachAudio failed", e); state.analyser = null; }
    },
    // Drop the audio analyser + zero the mouth drives — called on STOP so no stale audio
    // data (or the speaking sine fallback) keeps the jaw moving after she's done.
    detachAudio() { state.analyser = null; state.levelBuf = null; state.speechEnv = 0; state.extMouth = 0; state.driveMouth = 0; },
  };
}
