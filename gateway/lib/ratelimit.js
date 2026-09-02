/**
 * ratelimit.js — 简化限流器（依赖 store）
 */
'use strict';
module.exports = {
  /** 登录接口限流：每 IP 每分钟 ≤ loginPerMin */
  loginOk(store, ip, cfg) {
    return store.hit(`login:${ip}`, 60_000, cfg.loginPerMin || 5);
  },
  /** 常规请求限流：每 IP 每秒 ≤ reqPerSec（突发可容忍则宽松些） */
  reqOk(store, ip, cfg) {
    return store.hit(`req:${ip}`, 1000, cfg.reqPerSec || 20);
  },
};
