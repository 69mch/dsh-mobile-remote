/**
 * dsh-mobile-compat — DSH 客户端插件（source）
 * 通过 DSH 客户端插件服务把"移动端皮肤"以原生方式注入并可用开关启停。
 *
 * 注意：这是源码（ESM）。需按下方 build 一步生成 lib/client.js
 * （window.__ModuleLoader__.load({id, factory}) 格式，参考同仓 MIT 示例
 * dsh-remote-mobile / dsh-webgate 的 scripts/build-client.js），再装入 web profile。
 */
const MOBILE_CSS = String.raw`/* 在此粘贴 gateway/skin/mobile.css 全量内容（见仓库 README） */
@media (max-width:900px){
  html,body{max-width:100vw;overflow-x:hidden}
  #root{width:100%;max-width:100vw;min-width:0;overflow-x:hidden}
  pre,code,textarea{white-space:pre-wrap !important;overflow-wrap:anywhere !important;word-break:break-word !important}
}`;

export const name = 'dsh-mobile-compat';

export const apply = (ctx) => {
  // 移动端兼容开关（localStorage 持久化；桌面/宽屏不启用皮肤）
  let dispose = null;
  const isNarrow = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 900px)').matches;
  const isEnabled = () => {
    try {
      return localStorage.getItem('dsh_mobile_skin') !== '0';
    } catch (e) {
      return true;
    }
  };
  const applyEnabled = (on) => {
    const styles = ctx.get('styles'); // 客户端样式服务（查询后再定名；此处按规范占位）
    if (styles && typeof styles.insert === 'function') {
      if (on && !dispose) dispose = styles.insert(MOBILE_CSS);
      if (!on && dispose) {
        try { dispose(); } catch (e) { /* ignore */ }
        dispose = null;
      }
    }
    if (typeof document !== 'undefined' && document.documentElement) {
      if (on && isNarrow()) document.documentElement.setAttribute('data-dsh-mobile', '');
      else document.documentElement.removeAttribute('data-dsh-mobile');
    }
  };

  if (isNarrow()) applyEnabled(isEnabled());
  const onResize = () => {
    if (!isNarrow()) { if (dispose) { try { dispose(); } catch (e) {} dispose = null; } return; }
    applyEnabled(isEnabled());
  };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', onResize);
  }
  // 归还清理
  ctx.effect(() => () => {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('resize', onResize);
    }
    if (dispose) { try { dispose(); } catch (e) {} dispose = null; }
  });
};
