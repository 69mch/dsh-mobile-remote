/**
 * skin/index.js — DSH 移动端皮肤装配器
 * 把 mobile.css / mobile.js / skin.json 组装成待注入 <head> 的片段。
 * proxy.js 通过 buildSkinInject() 获取注入内容（替代原先内联的 MOBILE_INJECT）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

function read(name) {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}

/** 组装注入片段：CSS <style> + JS <script>。presets 开关来自 skin.json。 */
function buildSkinInject() {
  const meta = `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">`;

  let css;
  try {
    const skin = JSON.parse(read('skin.json'));
    css = read('mobile.css');
    // presets 开关：默认全部启用；如需按 preset 裁剪 CSS，可在此按 skin.presets 过滤（暂全量注入）
    if (!skin || !skin.presets || Object.values(skin.presets).every(p => p.enabled !== false)) {
      // 全量
    }
  } catch (e) {
    css = `/* skin load failed: ${String(e && e.message || e)} */`;
  }

  let js = '';
  try { js = read('mobile.js'); } catch { js = ''; }

  return `${meta}\n<style id="dsh-mobile-skin">${css}</style>${js ? `\n<script id="dsh-mobile-js">${js}</script>` : ''}`;
}

module.exports = { buildSkinInject };
