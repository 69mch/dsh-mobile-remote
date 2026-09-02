// dsh-mobile-skin / mobile.js — 客户端侧皮肤控制（随网关注入，运行在 Harness 客户端页内）
// 功能：窄屏显示「移动适配 开/关」浮层开关，控制 #dsh-mobile-skin 样式是否生效（localStorage 持久化）。
(function () {
  function narrow() {
    try { return window.matchMedia('(max-width: 900px)').matches; } catch (e) { return false; }
  }
  function current() {
    try { return localStorage.getItem('dsh_mobile_skin') !== '0'; } catch (e) { return true; }
  }
  function persist(on) {
    try { localStorage.setItem('dsh_mobile_skin', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  function applyEnabled(on) {
    var s = document.getElementById('dsh-mobile-skin');
    if (!s) return;
    if (on) { if (!s.parentNode) document.head.appendChild(s); }
    else { if (s.parentNode) s.parentNode.removeChild(s); }
    try {
      if (on) document.documentElement.setAttribute('data-dsh-mobile', '');
      else document.documentElement.removeAttribute('data-dsh-mobile');
    } catch (e) { /* ignore */ }
  }
  function toggleLabel(on) { return on ? '移动适配：开' : '移动适配：关'; }
  function ensureToggle() {
    if (!narrow()) return;
    if (document.getElementById('dsh-mobile-skin-toggle')) return;
    var b = document.createElement('button');
    b.id = 'dsh-mobile-skin-toggle';
    b.textContent = toggleLabel(current());
    b.setAttribute('aria-label', 'toggle mobile skin');
    b.style.cssText =
      'position:fixed;right:8px;bottom:80px;z-index:99999;font:12px/1 system-ui,sans-serif;' +
      'padding:5px 10px;border-radius:14px;cursor:pointer;border:1px solid rgba(255,255,255,.18);' +
      'background:rgba(20,24,30,.86);color:#cbd5e1;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);';
    b.addEventListener('click', function () {
      var on = !current();
      persist(on);
      applyEnabled(on);
      b.textContent = toggleLabel(on);
    });
    document.body.appendChild(b);
  }
  function sync() {
    if (narrow()) {
      applyEnabled(current());
      ensureToggle();
    } else {
      applyEnabled(true); // 桌面始终全功能
      var t = document.getElementById('dsh-mobile-skin-toggle');
      if (t && t.parentNode) t.parentNode.removeChild(t);
    }
  }
  function boot() {
    try {
      sync();
      if (window.addEventListener) window.addEventListener('resize', function () { sync(); });
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
