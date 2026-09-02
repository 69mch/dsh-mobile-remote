/**
 * rsa.js — RSA-2048 密钥对（传输加密用）
 *
 * 用途：配对时客户端用本公钥把连接码加密后再发送（RSA-OAEP/SHA-256），
 *      服务端用私钥解密 → 连接码不再以明文出现在网络上（即使 HTTP 通道）。
 * 私钥持久化于 config/remote-key.json（0600，gitignore），仅首次生成。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadKeypair(keyFile, logger) {
  try {
    if (fs.existsSync(keyFile)) {
      const st = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      if (st.privateKey) return makeFacade(st.privateKey, logger);
    }
  } catch (e) {
    if (logger) logger.error({ msg: 'rsa_load_failed', err: String((e && e.message) || e) });
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, JSON.stringify({ publicKey, privateKey }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return makeFacade(privateKey, logger);
}

function makeFacade(privateKeyPem, logger) {
  let publicKeyPem = null;
  try {
    publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  } catch (e) {
    if (logger) logger.error({ msg: 'rsa_derive_pub_failed', err: String((e && e.message) || e) });
  }
  return {
    publicKeyPem,
    /** base64(RSA-OAEP/SHA-256 密文) → 明文；失败返回 null */
    decrypt(b64) {
      try {
        const buf = Buffer.from(String(b64 || ''), 'base64');
        if (!buf.length) return null;
        return crypto
          .privateDecrypt(
            {
              key: privateKeyPem,
              padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
              mgf1Hash: 'sha256', // 与 Android "OAEPWithSHA-256AndMGF1Padding" 对齐
            },
            buf
          )
          .toString('utf8');
      } catch (e) {
        if (logger) logger.error({ msg: 'rsa_decrypt_failed', err: String((e && e.message) || e) });
        return null;
      }
    },
  };
}

module.exports = { loadKeypair };
