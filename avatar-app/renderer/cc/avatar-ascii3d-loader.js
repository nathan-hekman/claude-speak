// Synchronous AvatarAnim facade for the async ASCII-3D avatar module.
(() => {
  const pending = {
    state: "idle", level: 0, pose: [0, 0, 0],
    blink: false, mouth: 0, brow: 0, smile: 0, bs: null, audio: null,
  };
  let impl = null;
  function call(name, args) { if (impl && typeof impl[name] === "function") impl[name](...args); }

  window.AvatarAnim = {
    setState(state) { pending.state = state; call("setState", [state]); },
    attachAudio(audioEl, audioCtx) { pending.audio = [audioEl, audioCtx]; call("attachAudio", pending.audio); },
    detachAudio() { pending.audio = null; call("detachAudio", []); },
    setLevel(value) { pending.level = value; call("setLevel", [value]); },
    setHeadPose(yaw, pitch, roll) { pending.pose = [yaw, pitch, roll]; call("setHeadPose", pending.pose); },
    setBlink(value) { pending.blink = !!value; call("setBlink", [pending.blink]); },
    setBlinkAmount(value) { call("setBlinkAmount", [value]); },
    setMouthOpen(value) { pending.mouth = value; call("setMouthOpen", [value]); },
    setBrow(value) { pending.brow = value; call("setBrow", [value]); },
    setSmile(value) { pending.smile = value; call("setSmile", [value]); },
    setExpressionDrive(on) { call("setExpressionDrive", [on]); },
    setBlendshapes(obj) { pending.bs = obj; call("setBlendshapes", [obj]); },
    setOrbit(yaw, pitch) { call("setOrbit", [yaw, pitch]); },
    setZoom(factor) { call("setZoom", [factor]); },
    playExpression(name) { call("playExpression", [name]); },
    turboBlink(ms) { call("turboBlink", [ms]); },
    setConfig(cfg) { call("setConfig", [cfg]); },
    getConfig() { return impl && impl.getConfig ? impl.getConfig() : null; },
    expressions() { return impl && impl.expressions ? impl.expressions() : []; },
    setLook(name) { call("setLook", [name]); },
    getLook() { return impl && impl.getLook ? impl.getLook() : "ascii"; },
    looks() { return impl && impl.looks ? impl.looks() : []; },
    setModel(name) { call("setModel", [name]); },
    getModel() { return impl && impl.getModel ? impl.getModel() : "a"; },
    models() { return impl && impl.models ? impl.models() : []; },
    sourceCanvas() { return impl && impl.sourceCanvas ? impl.sourceCanvas() : null; },
    morphNames() { return impl && impl.morphNames ? impl.morphNames() : []; },
    getDrive() { return impl && impl.getDrive ? impl.getDrive() : null; },
    _install(nextImpl) {
      impl = nextImpl;
      impl.setState(pending.state);
      impl.setLevel(pending.level);
      impl.setHeadPose(...pending.pose);
      impl.setBlink(pending.blink);
      impl.setMouthOpen(pending.mouth);
      impl.setBrow(pending.brow);
      impl.setSmile(pending.smile);
      if (pending.bs && impl.setBlendshapes) impl.setBlendshapes(pending.bs);
      if (pending.audio) impl.attachAudio(...pending.audio);
      window.dispatchEvent(new CustomEvent("avataranim-ready", { detail: window.AvatarAnim }));
    },
  };

  import("/cc/avatar-ascii3d-module.js").catch((error) => {
    console.error(error);
    const host = document.getElementById("avatar");
    if (host) host.dataset.error = error.message || String(error);
  });
})();
