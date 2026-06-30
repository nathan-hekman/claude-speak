// Shared avatar settings panel — the SAME rich controls on the desktop command center and
// the mobile phone PWA, so the phone never gets a hampered subset of the experience.
//
// Self-contained: it injects its own markup + scoped CSS and wires every control to
// window.AvatarAnim (plus AvatarBG / AvatarWorld when those layers are loaded). Each host
// page supplies only its own chrome (a header/close) and calls:
//
//     AvatarSettings.mount(hostEl)
//
// Styling is touch-first by media query: the base sizing matches the compact desktop card,
// and a max-width:600px block scales every target up to finger-friendly sizes on a phone.
// Sections whose backing API is absent on a page (e.g. Backgrounds on the phone, which
// doesn't load avatar-bg.js) hide themselves, so the panel degrades cleanly instead of
// showing dead buttons.
(() => {
  const A = () => window.AvatarAnim;
  const lerp = (a, b, t) => a + (b - a) * t;

  // Module-level so a re-mount can't stack timers/listeners. `root` is the currently
  // mounted .avset element; the once-registered global listeners always target it.
  const S = { root: null, surpriseOn: false, surpriseTimer: null, globalsBound: false };

  // ---------------------------------------------------------------- styles (once)
  function injectCSS() {
    if (document.getElementById('avset-styles')) return;
    const css = `
.avset { font: 11px/1.35 ui-monospace, Menlo, monospace; color: var(--ink, #cfe8f5); }
.avset .avset-sec { font: 600 9px/1 ui-monospace, Menlo, monospace; letter-spacing: .18em; text-transform: uppercase;
  color: var(--faint, #6f8398); margin: 14px 0 8px; display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; user-select: none; }
.avset .avset-sec:first-child { margin-top: 2px; }
.avset .avset-sec::after { content: "\\25be"; font-size: 9px; opacity: .6; transition: transform .15s ease; }
.avset .avset-sec.collapsed::after { transform: rotate(-90deg); }
.avset .avset-grp { display: flex; flex-direction: column; }
.avset .avset-grp.collapsed { display: none; }
.avset .avset-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.avset .avset-actions button { font: 600 11px/1 ui-monospace, Menlo, monospace; color: var(--ink, #cfe8f5);
  background: rgba(95,212,255,.07); border: 1px solid rgba(95,212,255,.22); border-radius: 8px; padding: 8px 6px;
  cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease, transform .08s ease; }
.avset .avset-actions button:active { transform: translateY(1px); }
.avset .avset-actions button.active { background: rgba(95,212,255,.30); border-color: var(--cyan, #5fd4ff); color: #eaffff; }
.avset .avset-slider { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 8px; margin: 10px 0;
  color: var(--faint, #6f8398); }
.avset .avset-slider output { font: 600 10px/1 ui-monospace, Menlo, monospace; color: var(--cyan, #5fd4ff); }
.avset .avset-slider input[type=range] { grid-column: 1 / -1; width: 100%; height: 4px; margin: 4px 0 0;
  -webkit-appearance: none; appearance: none; background: rgba(95,212,255,.18); border-radius: 4px; cursor: pointer; }
.avset .avset-slider input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
  width: 14px; height: 14px; border-radius: 50%; background: var(--cyan, #5fd4ff); border: 0; box-shadow: 0 0 8px rgba(95,212,255,.5); }
.avset .avset-slider input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--cyan, #5fd4ff); border: 0; }
.avset .avset-reset { margin-top: 16px; width: 100%; font: 600 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .1em;
  text-transform: uppercase; color: var(--faint, #6f8398); background: none; border: 1px solid rgba(95,212,255,.2);
  border-radius: 8px; padding: 9px; cursor: pointer; transition: color .15s ease, border-color .15s ease, transform .08s ease; }
.avset .avset-reset:active { transform: translateY(1px); }
.avset [hidden] { display: none !important; }
/* touch / phone — scale up to comfortable, finger-sized targets */
@media (max-width: 600px) {
  .avset { font-size: 13px; }
  .avset .avset-sec { font-size: 11px; margin: 24px 0 12px; }
  .avset .avset-sec::after { font-size: 12px; }
  .avset .avset-actions { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
  .avset .avset-actions button { padding: 0 12px; min-height: 52px; font-size: 13px; border-radius: 12px; }
  .avset .avset-slider { margin: 20px 0; gap: 8px 10px; font-size: 12px; }
  .avset .avset-slider output { font-size: 12px; }
  .avset .avset-slider input[type=range] { height: 7px; margin-top: 12px; }
  .avset .avset-slider input[type=range]::-webkit-slider-thumb { width: 28px; height: 28px; }
  .avset .avset-slider input[type=range]::-moz-range-thumb { width: 28px; height: 28px; }
  .avset .avset-reset { padding: 16px; font-size: 12px; margin-top: 24px; }
}`;
    const st = document.createElement('style'); st.id = 'avset-styles'; st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- markup
  function html() {
    return `
<div class="avset">
  <div class="avset-sec" data-key="model">Model</div>
  <div class="avset-actions" data-avset="model"></div>
  <div class="avset-sec" data-key="look">Look</div>
  <div class="avset-actions" data-avset="look">
    <button data-look="ascii">ASCII</button>
    <button data-look="blocks">Blocks</button>
    <button data-look="original">Original</button>
    <button data-look="amber">Amber</button>
    <button data-look="green">Green</button>
  </div>
  <div class="avset-sec" data-key="bg">Background</div>
  <div class="avset-actions" data-avset="bg"></div>
  <div class="avset-sec" data-key="expr">Expressions</div>
  <div class="avset-actions" data-avset="expr">
    <button data-expr="smile">Smile</button>
    <button data-expr="grin">Grin</button>
    <button data-expr="laugh">Laugh</button>
    <button data-expr="wink">Wink</button>
    <button data-expr="surprise">Surprise</button>
    <button data-expr="frown">Frown</button>
    <button data-expr="nod">Nod</button>
    <button data-turbo="1">Turbo blink</button>
  </div>
  <div class="avset-sec" data-key="fun">Fun</div>
  <div class="avset-actions"><button data-surprise type="button">Surprise me</button></div>
  <div class="avset-sec" data-key="tuners">Tuners</div>
  <label class="avset-slider">Blink frequency <output data-out="blink"></output>
    <input data-slider="blink" type="range" min="0" max="100" value="55"></label>
  <label class="avset-slider">Blink speed <output data-out="blinkSpeed"></output>
    <input data-slider="blinkSpeed" type="range" min="0" max="100" value="53"></label>
  <label class="avset-slider">Blink smoothness <output data-out="blinkSmooth"></output>
    <input data-slider="blinkSmooth" type="range" min="0" max="100" value="50"></label>
  <label class="avset-slider">Smile frequency <output data-out="smileFreq"></output>
    <input data-slider="smileFreq" type="range" min="0" max="100" value="50"></label>
  <label class="avset-slider">Smile intensity <output data-out="smileAmt"></output>
    <input data-slider="smileAmt" type="range" min="0" max="100" value="42"></label>
  <label class="avset-slider">Smile smoothness <output data-out="smileEase"></output>
    <input data-slider="smileEase" type="range" min="0" max="100" value="60"></label>
  <div class="avset-sec" data-key="eyes">Eyes</div>
  <div class="avset-actions"><button data-eyerelax type="button">Relaxed eyes</button></div>
  <button class="avset-reset" data-reset type="button">Reset to defaults</button>
</div>`;
  }

  // Collapsible categories: wrap each section's controls (every sibling up to the next
  // section or the reset button) in a foldable group. Tuners — the longest, least-touched
  // group — starts collapsed so the panel opens tidy.
  function groupSections(rootEl) {
    [...rootEl.children].forEach((sec) => {
      if (!(sec.classList && sec.classList.contains('avset-sec'))) return;
      const grp = document.createElement('div');
      grp.className = 'avset-grp';
      let n = sec.nextSibling;
      while (n && !(n.nodeType === 1 && (n.classList.contains('avset-sec') || n.classList.contains('avset-reset')))) {
        const next = n.nextSibling; grp.appendChild(n); n = next;
      }
      sec.after(grp);
      sec.addEventListener('click', () => { sec.classList.toggle('collapsed'); grp.classList.toggle('collapsed'); });
      if (sec.dataset.key === 'tuners') { sec.classList.add('collapsed'); grp.classList.add('collapsed'); }
    });
  }

  function hideSection(rootEl, key) {
    const sec = rootEl.querySelector(`.avset-sec[data-key="${key}"]`);
    if (!sec) return;
    sec.hidden = true;
    if (sec.nextElementSibling && sec.nextElementSibling.classList.contains('avset-grp')) sec.nextElementSibling.hidden = true;
  }

  // ---------------------------------------------------------------- surprise me
  const FUNNY_BS = [
    { jawOpen: 0.95, browInnerUp: 1, eyeWideLeft: 1, eyeWideRight: 1, mouthFunnel: 0.6 },
    { mouthPucker: 1, cheekPuff: 1, eyeSquintLeft: 0.9, eyeSquintRight: 0.9, browDownLeft: 0.7, browDownRight: 0.7 },
    { jawLeft: 1, mouthLeft: 1, eyeLookOutLeft: 1, browOuterUpLeft: 1, noseSneerLeft: 0.8 },
    { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 1, cheekSquintRight: 1, eyeWideRight: 1 },
    { jawOpen: 0.7, mouthStretchLeft: 1, mouthStretchRight: 1, browInnerUp: 1, eyeWideLeft: 1 },
    { mouthRight: 1, jawRight: 1, eyeLookOutRight: 1, browOuterUpRight: 1, noseSneerRight: 0.8 },
  ];
  const SURPRISE_EXPR = ['surprise', 'laugh', 'grin', 'wink', 'frown'];
  function surpriseTick() {
    const a = A(); if (!a) return;
    if (a.setBlendshapes) a.setBlendshapes(FUNNY_BS[Math.floor(Math.random() * FUNNY_BS.length)]);
    if (a.playExpression) a.playExpression(SURPRISE_EXPR[Math.floor(Math.random() * SURPRISE_EXPR.length)]);
    if (a.setHeadPose) a.setHeadPose((Math.random() - 0.5) * 80, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 36);
    if (Math.random() < 0.4 && a.turboBlink) a.turboBlink(500);
  }
  function setSurprise(on) {
    S.surpriseOn = on;
    try { localStorage.setItem('claudette.surprise', on ? '1' : '0'); } catch (e) {}
    markSurprise();
    clearInterval(S.surpriseTimer);
    if (on) { surpriseTick(); S.surpriseTimer = setInterval(surpriseTick, 1400); }
    else { const a = A(); if (a) { if (a.setBlendshapes) a.setBlendshapes(null); if (a.setHeadPose) a.setHeadPose(0, 0, 0); } }
  }
  function markSurprise() {
    const b = S.root && S.root.querySelector('[data-surprise]');
    if (b) b.classList.toggle('active', S.surpriseOn);
  }

  // ---------------------------------------------------------------- eye relax
  let eyeRelaxOn = true;
  try { const s = localStorage.getItem('claudette.eyeRelax'); if (s !== null) eyeRelaxOn = s === '1'; } catch (e) {}
  function applyEyeRelax() {
    const a = A(); if (a && a.setConfig) a.setConfig({ eyeRelax: eyeRelaxOn ? 0.15 : 0 });
    const b = S.root && S.root.querySelector('[data-eyerelax]'); if (b) b.classList.toggle('active', eyeRelaxOn);
  }

  // ---------------------------------------------------------------- sliders -> config
  // Each maps a 0..100 slider to real cfg values, pushed live via setConfig (instant retune).
  const CTRL = {
    blink:      { fmt: (t) => Math.round(lerp(8.0, 1.2, t) * 10) / 10 + 's',
                  apply: (t) => A().setConfig({ blinkPeriod: lerp(8000, 1200, t), blinkVar: lerp(3000, 800, t) }) },
    blinkSpeed: { fmt: (t) => Math.round(lerp(90, 280, t)) + 'ms',
                  apply: (t) => A().setConfig({ blinkDur: lerp(90, 280, t) }) },
    blinkSmooth:{ fmt: (t) => Math.round(lerp(0, 100, t)) + '%',
                  apply: (t) => A().setConfig({ blinkClose: lerp(0.18, 0.5, t) }) },
    smileFreq:  { fmt: (t) => Math.round(lerp(22, 3, t)) + 's',
                  apply: (t) => A().setConfig({ idleSmilePeriod: lerp(22000, 3000, t), idleSmileVar: lerp(9000, 2500, t) }) },
    smileAmt:   { fmt: (t) => Math.round(t * 100) + '%',
                  apply: (t) => A().setConfig({ idleSmileAmt: t }) },
    smileEase:  { fmt: (t) => Math.round(lerp(0, 100, 1 - t)) + '% soft',
                  apply: (t) => A().setConfig({ smileEase: lerp(0.26, 0.04, t) }) },
  };
  const SLIDER_DEFAULTS = { blink: 55, blinkSpeed: 53, blinkSmooth: 50, smileFreq: 50, smileAmt: 42, smileEase: 60 };
  function eachSlider(fn) { for (const k in CTRL) { const el = S.root.querySelector(`[data-slider="${k}"]`); if (el) fn(k, el); } }
  function syncOut(k, el) { const out = S.root.querySelector(`[data-out="${k}"]`); if (out) out.textContent = CTRL[k].fmt(el.value / 100); }
  function pushAllSliders() { if (!A() || !A().setConfig) return; eachSlider((k, el) => { CTRL[k].apply(el.value / 100); syncOut(k, el); }); }

  // ---------------------------------------------------------------- look / model / bg
  function markGroup(sel, attr, val) {
    const wrap = S.root && S.root.querySelector(sel); if (!wrap) return;
    [...wrap.children].forEach((b) => b.classList.toggle('active', b.dataset[attr] === val));
  }
  function syncLook() { const a = A(); if (a && a.getLook) markGroup('[data-avset="look"]', 'look', a.getLook()); }
  function buildModels() {
    const a = A(); const wrap = S.root && S.root.querySelector('[data-avset="model"]');
    if (!wrap || !a || !a.models) return;
    const list = a.models();
    if (!list || !list.length) { hideSection(S.root, 'model'); return; }
    if (!wrap.children.length) list.forEach((m) => { const b = document.createElement('button'); b.dataset.model = m.id; b.textContent = m.label; wrap.appendChild(b); });
    markGroup('[data-avset="model"]', 'model', a.getModel && a.getModel());
  }
  function buildBg() {
    const BG = window.AvatarBG; const wrap = S.root && S.root.querySelector('[data-avset="bg"]');
    if (!wrap) return;
    if (!BG) { hideSection(S.root, 'bg'); return; }            // phone doesn't load the bg layer
    const have = new Set([...wrap.children].map((b) => b.dataset.bg));
    const items = BG.modes().slice();
    if (window.AvatarWorld && window.AvatarWorld.modes) items.push(...window.AvatarWorld.modes());
    items.forEach((m) => { if (have.has(m.id)) return; const b = document.createElement('button'); b.dataset.bg = m.id; b.textContent = m.label; wrap.appendChild(b); });
    const w = window.AvatarWorld;
    markGroup('[data-avset="bg"]', 'bg', w && w.get && w.get() !== 'off' ? w.get() : BG.get());
  }

  // ---------------------------------------------------------------- wire one mounted root
  function wire(rootEl) {
    // Expressions + turbo blink
    const expr = rootEl.querySelector('[data-avset="expr"]');
    if (expr) expr.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !A()) return;
      if (b.dataset.turbo) A().turboBlink(3200);
      else if (b.dataset.expr) A().playExpression(b.dataset.expr);
    });

    // Surprise me (persisted)
    const sb = rootEl.querySelector('[data-surprise]');
    if (sb) sb.addEventListener('click', () => setSurprise(!S.surpriseOn));

    // Look
    const lookWrap = rootEl.querySelector('[data-avset="look"]');
    if (lookWrap) lookWrap.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !A() || !A().setLook) return;
      A().setLook(b.dataset.look); markGroup('[data-avset="look"]', 'look', b.dataset.look);
    });

    // Model (hot-swaps the GLB; disable briefly so a double-tap can't queue two reloads)
    const modelWrap = rootEl.querySelector('[data-avset="model"]');
    if (modelWrap) modelWrap.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !A() || !A().setModel) return;
      A().setModel(b.dataset.model); markGroup('[data-avset="model"]', 'model', b.dataset.model);
      [...modelWrap.children].forEach((x) => x.disabled = true);
      setTimeout(() => [...modelWrap.children].forEach((x) => x.disabled = false), 1200);
    });

    // Background (matrix / grid / aurora / solid / gsplat worlds)
    const bgWrap = rootEl.querySelector('[data-avset="bg"]');
    if (bgWrap) bgWrap.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const id = b.dataset.bg;
      if (id.indexOf('world') === 0) { if (window.AvatarWorld) window.AvatarWorld.set(id); if (window.AvatarBG) window.AvatarBG.set('default'); }
      else { if (window.AvatarWorld) window.AvatarWorld.set('off'); if (window.AvatarBG) window.AvatarBG.set(id); }
      markGroup('[data-avset="bg"]', 'bg', id);
    });

    // Sliders
    eachSlider((k, el) => {
      syncOut(k, el);
      el.addEventListener('input', () => { if (A()) CTRL[k].apply(el.value / 100); syncOut(k, el); });
    });

    // Eyes
    const eb = rootEl.querySelector('[data-eyerelax]');
    if (eb) eb.addEventListener('click', () => {
      eyeRelaxOn = !eyeRelaxOn;
      try { localStorage.setItem('claudette.eyeRelax', eyeRelaxOn ? '1' : '0'); } catch (e) {}
      applyEyeRelax();
    });

    // Reset
    const rb = rootEl.querySelector('[data-reset]');
    if (rb) rb.addEventListener('click', () => {
      eachSlider((k, el) => { el.value = SLIDER_DEFAULTS[k]; });
      pushAllSliders();
    });
  }

  // Re-pull live state from the engine into the freshly mounted controls.
  function resync() {
    buildModels(); buildBg(); syncLook(); pushAllSliders(); markSurprise(); applyEyeRelax();
  }

  // ---------------------------------------------------------------- public mount
  function mount(host) {
    if (!host) return;
    injectCSS();
    host.innerHTML = html();
    S.root = host.querySelector('.avset');
    groupSections(S.root);
    wire(S.root);

    // Restore the persisted "surprise me" state (off by default).
    try { if (localStorage.getItem('claudette.surprise') === '1') setSurprise(true); } catch (e) {}

    resync();
    // Worlds / models / the avatar engine can finish loading after the panel mounts; bind
    // once-only listeners that re-pull into whatever root is currently mounted, plus a
    // couple of late retries for the gsplat worlds (which register asynchronously).
    if (!S.globalsBound) {
      S.globalsBound = true;
      window.addEventListener('avataranim-ready', () => { if (S.root) resync(); });
      window.addEventListener('avatarworld-ready', () => { if (S.root) buildBg(); });
    }
    setTimeout(() => { if (S.root) buildBg(); }, 400);
    setTimeout(() => { if (S.root) buildModels(); }, 600);
  }

  window.AvatarSettings = { mount };
})();
