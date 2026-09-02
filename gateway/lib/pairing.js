/**
 * pairing.js — 连接码 + 首设备绑定（持久化 config/pairing.json）
 *
 * 规则：
 * - 一个 Harness 服务只有一个有效连接码（code，存 scrypt 哈希）。
 * - code 可轮换（gen-code）：旧码作废并清除设备绑定。
 * - 首次配对（code 正确且无绑定）→ 绑定该设备。
 * - 同设备再次配对（cookie 丢失/过期）→ 放行并续绑。
 * - 其他设备用同一 code → 拒绝（bound_other）。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function scryptHash(value, salt) {
  return crypto.scryptSync(String(value), salt, 64).toString('hex');
}

function randomCode() {
  // 8 位大写字母数字（去掉易混淆 0/O/1/I），形如 6X4K-9Q2T
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}

class Pairing {
  constructor(filePath, logger) {
    this.file = filePath;
    this.logger = logger;
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (e) {
      if (this.logger) this.logger.error({ msg: 'pairing_load_failed', err: String(e && e.message || e) });
    }
    return { codeHash: null, codeSalt: null, createdAt: null, bound: null, revoked: [] };
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }

  /** 生成新连接码：旧码作废 + 解绑 + 清空吊销名单。返回明文 code（仅本次展示）。 */
  rotateCode() {
    const code = randomCode();
    const salt = crypto.randomBytes(16).toString('hex');
    this.state = {
      codeHash: scryptHash(code.replace(/-/g, ''), salt),
      codeSalt: salt,
      createdAt: new Date().toISOString(),
      bound: null,
      revoked: [],
    };
    this._save();
    return code;
  }

  /** 无码时自动生成一个（首次启动）。 */
  ensureCode() {
    if (this.state.codeHash) return null;
    return this.rotateCode();
  }

  /** 校验 code（忽略分隔符/大小写）。 */
  verifyCode(code) {
    if (!this.state.codeHash || !code) return false;
    const norm = String(code).replace(/[- ]/g, '').toUpperCase();
    const h = scryptHash(norm, this.state.codeSalt);
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(this.state.codeHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  get boundDevice() { return this.state.bound || null; }
  get isBound() { return !!(this.state.bound && this.state.bound.deviceId); }

  /**
   * 配对尝试（先重读磁盘，保证 gen-code 轮换后立即生效）。
   * @returns {{ok:boolean, reason?:string, rebound?:boolean, device?:object}}
   */
  pair(code, device) {
    this.state = this._load(); // 实时同步磁盘（连接码可被 scripts/gen-code.ps1 轮换）
    if (!this.verifyCode(code)) return { ok: false, reason: 'invalid_code' };
    const deviceId = String(device && device.deviceId || '').trim();
    if (!deviceId) return { ok: false, reason: 'missing_device' };

    if (!this.isBound) {
      const dev = {
        deviceId,
        deviceModel: String(device.deviceModel || '').slice(0, 80),
        imei: String(device.imei || '').slice(0, 40) || undefined,
        boundAt: new Date().toISOString(),
      };
      this.state.bound = dev;
      this._save();
      return { ok: true, device: dev };
    }
    if (this.state.bound.deviceId === deviceId) {
      return { ok: true, rebound: true, device: this.state.bound };
    }
    return { ok: false, reason: 'bound_other', boundDeviceId: this.state.bound.deviceId };
  }

  /** 设备是否已被吊销（其既有会话应立即失效） */
  isRevoked(deviceId) {
    this.state = this._load(); // 实时同步（可被 revoke/gen-code 在其它进程修改）
    const rev = this.state.revoked || [];
    return rev.includes(String(deviceId));
  }

  /**
   * 吊销设备：将其加入吊销名单并清除绑定（若绑定同设备）。
   * 生效后其既有无状态会话在网关鉴权层被拒（见 server.js isRevoked 检查）。
   * @returns {{ok:boolean, revoked:string}}
   */
  revoke(deviceId) {
    this.state = this._load();
    const id = String(deviceId || '').trim();
    if (!id) return { ok: false, reason: 'missing_device' };
    const rev = Array.isArray(this.state.revoked) ? this.state.revoked.filter((x) => x !== id) : [];
    rev.push(id);
    this.state.revoked = rev;
    if (this.state.bound && this.state.bound.deviceId === id) {
      this.state.bound = null;
    }
    this._save();
    return { ok: true, revoked: id };
  }

  /** 返回设备视图：绑定中的设备（含元信息）+ 已吊销设备列表。 */
  listDevices() {
    this.state = this._load();
    const out = [];
    if (this.state.bound) {
      out.push({
        deviceId: this.state.bound.deviceId,
        deviceModel: this.state.bound.deviceModel || '',
        boundAt: this.state.bound.boundAt,
        status: 'bound',
      });
    }
    for (const id of this.state.revoked || []) {
      out.push({ deviceId: id, status: 'revoked' });
    }
    return out;
  }

  /** 返回可展示状态（不含哈希）。 */
  status() {
    return {
      hasCode: !!this.state.codeHash,
      codeCreatedAt: this.state.createdAt,
      revokedCount: (this.state.revoked || []).length,
      bound: this.state.bound ? {
        deviceId: this.state.bound.deviceId,
        deviceModel: this.state.bound.deviceModel || '',
        boundAt: this.state.bound.boundAt,
      } : null,
    };
  }
}

module.exports = { Pairing, randomCode };
