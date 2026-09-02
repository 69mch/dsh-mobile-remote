// dsh-mobile-skin / mobile.js — 轻量客户端增强（随皮肤注入，务必小而稳、异常静默）
(function () {
  try {
    var narrow = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
    if (narrow && document.documentElement) {
      // 给 <html> 打移动标记，便于 skin 内 CSS/JS 作用域判定
      document.documentElement.setAttribute('data-dsh-mobile', '');
    }
  } catch (e) { /* 忽略 */ }
})();
