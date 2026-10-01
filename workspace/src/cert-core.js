/**
 * cert-core.js —— 对外权利证明的密码学核心(浏览器 / Node 同一份代码,UMD 包裹)
 *
 * 设计原则:
 *  - 证明是自包含的扁平 JSON 信封:正文 claims + 签名 sig,离线环境仅需信任锚公钥即可验真;
 *  - 签名算法固定 ECDSA P-256 + SHA-256(Node ≥18 与全部现代浏览器 WebCrypto 均支持);
 *  - 签名输入为「去掉 sig 字段后稳定序列化」的信封,任意字节改动都导致验签失败;
 *  - 选择性披露:披露字段以明文放在 claims.d 中;未披露字段逐字段随机盐承诺(nonce 仅
 *    签发方留存,不进入证明/链事件),并对「完整权利快照 + 证明级盐」计算 stateDigest,
 *    第三方既无法验证承诺命中,也无法对低熵身份/估值/融资额做字典确认攻击;
 *  - 放行令牌不进入快照,从结构上保证证明不可能泄露放行令牌。
 *
 * 链头与「签发时状态」的离线校验:
 *  - 签发事务在同一 append-only 权利链追加 CERT_ISSUED 锚点事件,信封里固化:
 *      claims.ap = 锚点事件序号;claims.ah = 锚点事件重算哈希;claims.ph = 锚点前一链哈希;
 *  - 离线器按与平台完全一致的链式规则(prevHash|稳定载荷)重算锚点哈希并比对,
 *    这就是对「链头 + 签发时已上链」的离线自洽证明(无需联网取得全链)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EWR_CERT = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const ALG = 'ES256';
  const CRV = 'P-256';
  const KTY = 'EC';
  const CERT_VERSION = 1;

  /* ----------------------- 稳定序列化(与 storage.js 规则一致) ----------------------- */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }

  /* ----------------------- 跨环境 WebCrypto / 编码工具 ----------------------- */
  function webcrypto() {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ||
      (typeof require === 'function' ? require('node:crypto').webcrypto : null);
    if (!c || !c.subtle) throw new Error('当前运行环境不支持 WebCrypto(SubtleCrypto)');
    return c;
  }
  function te() {
    return new ((typeof TextEncoder !== 'undefined' ? TextEncoder : require('node:util').TextEncoder))();
  }
  function bytesToHex(buf) {
    return Buffer_like(buf).toString('hex');
  }
  function hexToBytes(hex) {
    return new Uint8Array(Uint8_from(hex.length / 2, (i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
  }
  // 浏览器无 Buffer:统一走 Uint8Array 分块转 hex/base64
  function Buffer_like(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return {
      toString(enc) {
        let s = '';
        if (enc === 'hex') {
          for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
          return s;
        }
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa64(bin);
      }
    };
  }
  function btoa64(bin) {
    if (typeof btoa === 'function') return btoa(bin);
    return require('node:buffer').Buffer.from(bin, 'binary').toString('base64');
  }
  function atob64(b64) {
    if (typeof atob === 'function') return atob(b64);
    return require('node:buffer').Buffer.from(b64, 'base64').toString('binary');
  }
  function Uint8_from(n, fill) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = fill(i);
    return a;
  }
  function base64ToBytes(b64) {
    const bin = atob64(b64);
    return Uint8_from(bin.length, (i) => bin.charCodeAt(i));
  }
  function randomHex(bytes) {
    return bytesToHex(webcrypto().getRandomValues(new Uint8Array(bytes)));
  }

  function sha256Hex(str) {
    const c = webcrypto();
    return c.subtle.digest('SHA-256', te().encode(str)).then((buf) => bytesToHex(buf));
  }
  /** 与 storage.chainHash 完全一致的事件哈希规则(供离线器重算锚点) */
  async function chainHashOf(event) {
    const payload = {
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      receiptId: event.receiptId || null,
      pledgeId: event.pledgeId || null,
      actorId: event.actorId || null,
      payload: event.payload || {}
    };
    return sha256Hex(event.prevHash + '|' + stableStringify(payload));
  }

  /* ----------------------- 密钥:JWK 生成 / 导入 / 签名 / 验签 ----------------------- */
  async function generateKeyPair() {
    const c = webcrypto();
    const pair = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: CRV }, true, ['sign', 'verify']);
    const pubJwk = await c.subtle.exportKey('jwk', pair.publicKey);
    const privJwk = await c.subtle.exportKey('jwk', pair.privateKey);
    delete pubJwk.key_ops; delete privJwk.key_ops; delete privJwk.ext;
    pubJwk.ext = true;
    return { publicJwk: pubJwk, privateJwk: privJwk };
  }
  async function importPublic(jwk) {
    return webcrypto().subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: CRV }, false, ['verify']);
  }
  async function importPrivate(jwk) {
    return webcrypto().subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: CRV }, false, ['sign']);
  }
  async function sign(privateJwk, message) {
    const c = webcrypto();
    const key = await importPrivate(privateJwk);
    const raw = await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te().encode(message));
    return bytesToHex(raw); // WebCrypto 输出 IEEE P1363 定长原始签名,跨平台一致
  }
  async function verifySignature(publicJwk, message, sigHex) {
    try {
      const key = await importPublic(publicJwk);
      return webcrypto().subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, hexToBytes(sigHex), te().encode(message)
      );
    } catch (_) {
      return false;
    }
  }

  /** 信封的待签名规范化字符串:剥离 sig(及其仅传输用字段)后稳定序列化 */
  function signingData(envelope) {
    const copy = { ...envelope };
    delete copy.sig;
    return stableStringify(copy);
  }
  async function signEnvelope(envelope, privateJwk) {
    envelope.sig = await sign(privateJwk, signingData(envelope));
    return envelope;
  }

  /* ----------------------- 选择性披露承诺 -----------------------
   * 未披露字段:commit = sha256(nonce + '|' + key + '|' + stable(value)),nonce 只在签发方留存;
   * 证明里只出现 commit,第三方既不知道 nonce 也无法枚举命中(企业身份/估值/融资额低熵也安全)。
   * 完整快照另加证明级随机盐做 stateDigest,防止「完整状态组合」被整体字典确认。
   */
  async function fieldCommit(nonce, key, value) {
    return sha256Hex(nonce + '|' + key + '|' + stableStringify(value));
  }
  async function stateDigest(salt, snapshotStable) {
    return sha256Hex(salt + '|' + snapshotStable);
  }

  /* ----------------------------- 证明字段目录 -----------------------------
   * key:   快照内字段路径;name:中文名;defaultDisclosed:是否默认披露;
   * sensitive: 属于需求明确要求「不可推导」的敏感面(身份/估值/融资额)。
   */
  const FIELD_CATALOG = [
    { key: 'receiptId', name: '仓单号', group: '仓单', defaultDisclosed: true, always: true },
    { key: 'receiptStatus', name: '仓单状态', group: '仓单', defaultDisclosed: true },
    { key: 'receiptVersion', name: '仓单版本', group: '仓单', defaultDisclosed: true },
    { key: 'qty', name: '在库数量(吨)', group: '仓单', defaultDisclosed: true },
    { key: 'interval', name: '库内数量区间', group: '仓单', defaultDisclosed: false },
    { key: 'inspectionBatchId', name: '检验批号', group: '仓单', defaultDisclosed: false },
    { key: 'warehouseName', name: '仓储企业名称', group: '仓储', defaultDisclosed: true },
    { key: 'locationName', name: '库位', group: '仓储', defaultDisclosed: true },
    { key: 'commodityName', name: '品类', group: '仓储', defaultDisclosed: true },
    { key: 'gradeName', name: '品级', group: '仓储', defaultDisclosed: true },
    { key: 'holderName', name: '货主企业名称', group: '身份', defaultDisclosed: false, sensitive: true },
    { key: 'holderId', name: '货主企业代码', group: '身份', defaultDisclosed: false, sensitive: true },
    { key: 'pledgeId', name: '质押号', group: '质押', defaultDisclosed: false },
    { key: 'pledgeExists', name: '是否存在质押', group: '质押', defaultDisclosed: true },
    { key: 'pledgeStatus', name: '质押状态', group: '质押', defaultDisclosed: true },
    { key: 'pledgeFinancerName', name: '质权人名称', group: '质押', defaultDisclosed: false, sensitive: true },
    { key: 'pledgorName', name: '出质企业名称', group: '质押', defaultDisclosed: false, sensitive: true },
    { key: 'registrationNo', name: '质押登记回执号', group: '质押', defaultDisclosed: true },
    { key: 'rightsVersion', name: '质权版本', group: '质押', defaultDisclosed: false },
    { key: 'receiptVersionLocked', name: '质押锁定仓单版本', group: '质押', defaultDisclosed: false },
    { key: 'valuationBatchId', name: '估值批次号', group: '估值融资', defaultDisclosed: false },
    { key: 'valuationPrice', name: '锁定单价(元/吨)', group: '估值融资', defaultDisclosed: false, sensitive: true },
    { key: 'collateralValue', name: '担保物估值(元)', group: '估值融资', defaultDisclosed: false, sensitive: true },
    { key: 'loanAmount', name: '融资额(元)', group: '估值融资', defaultDisclosed: false, sensitive: true },
    { key: 'exposure', name: '当前融资敞口(元)', group: '估值融资', defaultDisclosed: false, sensitive: true },
    { key: 'ltvCap', name: '可贷上限(元)', group: '估值融资', defaultDisclosed: false, sensitive: true },
    { key: 'issuedAtDate', name: '签发当日状态时点', group: '状态', defaultDisclosed: true }
  ];
  const ALWAYS_DISCLOSED = FIELD_CATALOG.filter((f) => f.always).map((f) => f.key);

  /** 支持的核验用途(purpose);签发与验真两侧使用同一字典 */
  const PURPOSES = [
    { code: 'DUE_DILIGENCE', name: '交易对手尽调' },
    { code: 'TRADE_CONFIRM', name: '贸易背景核实' },
    { code: 'INSURANCE', name: '保险投保/理赔' },
    { code: 'COURT_EVIDENCE', name: '司法举证' },
    { code: 'REGULATORY_CHECK', name: '监管检查' },
    { code: 'OTHER', name: '其他一次性用途' }
  ];

  /**
   * 离线验真:纯本地、只读、无网络。
   * @param {object} envelope 证明信封(JSON 或字符串)
   * @param {object} opts { anchors: 信任锚数组 [{kid, jwk, status}], purpose, now }
   * @returns {Promise<{valid:boolean, code?:string, checks:object, claims?:object}>}
   *   注意:次数剩余与撤销状态属签发方在线台账,离线无法判定;valid 仅表示
   *   「签名真实 + 链锚自洽 + 在有效期内 + 用途相符 + 正文未篡改」。
   */
  async function verifyOffline(input, opts = {}) {
    const checks = {
      parsed: false, version: false, algorithm: false, anchorTrusted: false,
      signature: false, chainAnchor: false, period: false, purpose: false, tamper: true
    };
    const fail = (code) => ({ valid: false, code, checks });
    let env;
    try {
      env = typeof input === 'string' ? JSON.parse(input) : input;
    } catch (_) {
      return fail('CERT_MALFORMED');
    }
    if (!env || typeof env !== 'object') return fail('CERT_MALFORMED');
    checks.parsed = true;
    const c = env.claims;
    if (!c || typeof c !== 'object') return fail('CERT_MALFORMED');
    if (env.v !== CERT_VERSION) return fail('CERT_VERSION_UNSUPPORTED');
    checks.version = true;
    if (env.alg !== ALG) return fail('ALGORITHM_UNSUPPORTED');
    checks.algorithm = true;
    if (!env.kid || typeof env.sig !== 'string') return fail('CERT_MALFORMED');

    // 信任锚:必须命中且密钥未被应急吊销(轮换的旧密钥仍受信,旧证明按签发规则继续验真)
    const anchors = opts.anchors || [];
    const anchor = anchors.find((a) => a.kid === env.kid);
    if (!anchor) return fail('KEY_NOT_TRUSTED');
    if (anchor.status === 'REVOKED') return fail('KEY_REVOKED');
    checks.anchorTrusted = true;

    // 签名 = 正文完整性/来源证明;正文任一字节被篡改都会在此失败
    const sigOk = await verifySignature(anchor.jwk, signingData(env), env.sig);
    if (!sigOk) return fail('PAYLOAD_TAMPERED');
    checks.signature = true;
    checks.tamper = true;

    // 链头/签发时状态:按平台链式规则重算锚点哈希,并核对锚点记录的状态承诺与正文一致。
    // 锚点事件刻意不带 receiptId/pledgeId/actorId:全局权利链对所有页面可见,
    // 「哪张仓单/哪家机构」只保留在披露正文(持证人选择性披露)与签发方台账中,不上公开链。
    const anchorEvent = {
      seq: c.ap, ts: c.at_t, type: 'CERT_ISSUED',
      receiptId: null, pledgeId: null, actorId: null,
      payload: {
        certId: c.id, keyId: env.kid,
        issuedState: c.sd, purpose: c.pu, maxUses: c.mu,
        disclosedFields: c.dl, fieldCommitCount: (c.h || []).length,
        issuer: 'PLATFORM'
      },
      prevHash: c.ph
    };
    const recomputed = await chainHashOf(anchorEvent);
    if (recomputed !== c.ah) return fail('CHAIN_ANCHOR_MISMATCH');
    checks.chainAnchor = true;
    // 锚点载荷中的状态承诺必须与信封正文一致(防止把真实签名配到别的锚点上)
    if (!c.sd || c.sd.length !== 64) return fail('CHAIN_ANCHOR_MISMATCH');

    const now = opts.now || Date.now();
    if (!(typeof c.iat === 'number' && typeof c.exp === 'number' && c.iat <= c.exp))
      return fail('PERIOD_MALFORMED');
    if (now < c.iat) return fail('NOT_EFFECTIVE_YET');
    if (now > c.exp) return fail('CERT_EXPIRED');
    checks.period = true;

    if (opts.purpose) {
      if (opts.purpose !== c.pu) return fail('PURPOSE_MISMATCH');
    }
    checks.purpose = true;

    // 敏感字段不可推导的结构保证:敏感面字段若非显式披露,信封正文中不得出现其明文
    const disclosed = new Set(c.dl || []);
    const leak = FIELD_CATALOG.filter(
      (f) => f.sensitive && !disclosed.has(f.key) && c.d && Object.prototype.hasOwnProperty.call(c.d, f.key)
    );
    if (leak.length) return fail('SENSITIVE_LEAK');

    return {
      valid: true,
      checks,
      claims: c,
      anchor: { kid: anchor.kid, status: anchor.status },
      offlineCaveats: {
        revocation: 'UNKNOWN', // 撤销属在线台账,离线不可知
        remainingUses: c.mu == null ? null : 'UNKNOWN'
      }
    };
  }

  return {
    ALG, KTY, CRV, CERT_VERSION,
    FIELD_CATALOG, ALWAYS_DISCLOSED, PURPOSES,
    stableStringify, sha256Hex, chainHashOf,
    generateKeyPair, importPublic, signEnvelope, verifySignature, signingData,
    fieldCommit, stateDigest, randomHex,
    bytesToHex, hexToBytes, base64ToBytes,
    verifyOffline
  };
});
