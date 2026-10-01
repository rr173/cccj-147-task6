/**
 * certificates.js —— 对外权利证明签发 / 离线验真配套的服务端领域模块
 *
 * 不变量:
 *  C1 证明是自包含签名信封(claims + sig),签发内容在同一事务生成、上链(CERT_ISSUED)、
 *     落盘;签名/上链中途失败整体回滚,不存在「无锚点证明」。
 *  C2 证明是「签发时点」的权利快照,冻结 receiptVersion/状态/承诺:权利随后变化、密钥轮换,
 *     旧证明按签发规则继续验真(轮换旧密钥 ROTATED 仍是信任锚)。撤销是唯一内容层面的失效。
 *  C3 在线核验结论确定:同一 nonce 重放(失败重试/断网重试)返回首次结论,成功扣次仅一次;
 *     已撤销 USES_EXHAUSTED、过期、PURPOSE_MISMATCH、正文 PAYLOAD_TAMPERED 一律拒绝;
 *     所有前置检查通过后才在同一事务扣减次数,失败永不消耗次数。
 *  C4 并发同一核验请求由 storage FIFO 串行事务裁决:第一笔成功扣次,其余看到扣减后的计数
 *     或幂等表中的首次结论,结果唯一确定。
 *  C5 撤销记录、密钥、核验计数与结论全部随业务事务落盘;进程重启后不丢、计数不回退、
 *     吊销不复活。
 *  C6 选择性披露隐私:未披露身份/估值/融资额以逐字段随机盐承诺形式存在,盐仅留存于签发方
 *     记录(不进证明、不进链事件);放行令牌不进入快照,无法从证明推导。
 */
'use strict';
const { transact, DomainError, getState, verifyChain } = require('./storage');
const certCore = require('./cert-core');

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const ACTIVE_PLEDGE_STATUS = ['LOCKED', 'REGISTERED', 'SUPPLEMENTING'];
const VALID_RECEIPT_STATUS = ['ACTIVE', 'DELIVERED_PARTIAL'];

const CERT_ACTIVE = 'ACTIVE'; // 未撤销,有效期与次数在线核验时实时判定
const CERT_REVOKED = 'REVOKED';
const KEY_ACTIVE = 'ACTIVE';
const KEY_ROTATED = 'ROTATED';
const KEY_REVOKED = 'REVOKED';

/* ============================ 权利快照(完整,含未披露) ============================ */
function buildSnapshot(s, receiptId) {
  const r = s.receipts.find((x) => x.id === receiptId);
  if (!r) throw new DomainError('RECEIPT_NOT_FOUND', `仓单 ${receiptId} 不存在`);
  const grade = s.grades.find((g) => g.id === r.gradeId);
  const loc = s.locations.find((l) => l.id === r.locationId);
  const wh = s.parties.find((p) => p.id === r.warehouseId);
  const holder = s.parties.find((p) => p.id === r.holderId);
  const commodity = s.commodities.find((c) => c.id === r.commodityId);
  const pledge = s.pledges.find((p) => p.receiptId === r.id && ACTIVE_PLEDGE_STATUS.includes(p.status)) || null;
  const qty = round3(r.endQty - r.startQty);
  let price = null;
  if (pledge) {
    const batch = s.valuationBatches.find((b) => b.id === pledge.valuationBatchId);
    if (batch && batch.prices[r.gradeId] != null) price = batch.prices[r.gradeId];
  }
  return {
    receiptId: r.id,
    receiptStatus: r.status,
    receiptVersion: r.version,
    qty,
    interval: [round3(r.startQty), round3(r.endQty)],
    inspectionBatchId: r.inspectionBatchId,
    warehouseName: wh ? wh.name : r.warehouseId,
    locationName: loc ? loc.name : r.locationId,
    commodityName: commodity ? commodity.name : r.commodityId,
    gradeName: grade ? grade.name : r.gradeId,
    holderName: holder ? holder.name : r.holderId,
    holderId: r.holderId,
    pledgeExists: !!pledge,
    pledgeId: pledge ? pledge.id : null,
    pledgeStatus: pledge ? pledge.status : null,
    pledgeFinancerName: pledge ? (s.parties.find((p) => p.id === pledge.financerId) || {}).name || pledge.financerId : null,
    pledgorName: pledge ? (s.parties.find((p) => p.id === pledge.pledgorId) || {}).name || pledge.pledgorId : null,
    registrationNo: pledge && pledge.registration ? pledge.registration.registrationNo : null,
    rightsVersion: pledge ? pledge.rightsVersion || 1 : null,
    receiptVersionLocked: pledge ? pledge.receiptVersion : null,
    valuationBatchId: pledge ? pledge.valuationBatchId : null,
    valuationPrice: price,
    collateralValue: pledge ? pledge.currentValue : null,
    loanAmount: pledge ? pledge.loanAmount : null,
    exposure: pledge ? round3(pledge.loanAmount - (pledge.coveredAmount || 0)) : null,
    ltvCap: pledge ? pledge.ltvCap : null,
    issuedAtDate: null // 签发时填充(yyyy-mm-dd,仅日期粒度)
  };
}

/**
 * 在签发事务外准备签名密钥材料,避免在事务内嵌套 transact 造成 FIFO 自死锁。
 * 已有 ACTIVE 密钥则直接复用;否则在事务外用 WebCrypto 预生成密钥对,
 * 由调用方在签发事务内做双重检查并插入(FIFO 串行保证并发首发只建一把)。
 */
function prepareActiveKeyMaterial() {
  const existing = getState().certKeys.find((k) => k.status === KEY_ACTIVE);
  if (existing) return Promise.resolve({ existing: true, pair: null });
  return certCore.generateKeyPair().then((pair) => ({ existing: false, pair }));
}
/** 在签发事务内确保 ACTIVE 密钥落库;返回 draft 上的密钥对象(可能伴随 CERT_KEY_CREATED 事件) */
function materializeActiveKey(s, tx, prepared) {
  const cur = s.certKeys.find((k) => k.status === KEY_ACTIVE);
  if (cur) return cur;
  if (prepared.existing || !prepared.pair) throw new DomainError('INTERNAL', '签名密钥材料缺失');
  const id = tx.nextId('certKey', 'CK');
  const key = {
    id,
    jwkPublic: prepared.pair.publicJwk,
    jwkPrivate: prepared.pair.privateJwk,
    status: KEY_ACTIVE,
    createdAt: Date.now(),
    rotatedAt: null,
    revokedAt: null,
    note: '证明签名密钥(P-256)'
  };
  s.certKeys.push(key);
  tx.appendEvent('CERT_KEY_CREATED', { payload: { keyId: id } });
  return key;
}

function publicKeyView(k) {
  return { kid: k.id, jwk: k.jwkPublic, status: k.status, createdAt: k.createdAt };
}
/**
 * 信任锚清单:返回全部已知密钥并带状态。
 * 离线器据此区分:ACTIVE/ROTATED → 验真通过(旧证明按签发规则继续);
 * REVOKED(疑似私钥泄露)→ KEY_REVOKED 拒绝;不在清单 → KEY_NOT_TRUSTED。
 */
function trustAnchors(s) {
  return (s || getState()).certKeys.map(publicKeyView);
}

/* ============================ 签发证明 ============================ */
async function issueCertificate(input) {
  const actorId = input.actorId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '签发主体必填(融资方或监管方)');
  const receiptId = input.receiptId;
  if (!receiptId) throw new DomainError('RECEIPT_ID_REQUIRED', '必须选择一项仓储权利(仓单当前摘要)');
  const purpose = input.purpose;
  if (!certCore.PURPOSES.some((p) => p.code === purpose))
    throw new DomainError('BAD_PURPOSE', '核验用途不合法');
  let ttlDays = Number(input.ttlDays);
  const expiresAt = input.expiresAt ? Number(input.expiresAt) : null;
  if (!(ttlDays > 0) && !(expiresAt > Date.now()))
    throw new DomainError('BAD_VALIDITY', '有效期必须为正(天数或未来到期时刻)');
  let maxUses = input.maxUses === undefined || input.maxUses === '' ? 1 : input.maxUses;
  if (maxUses === null) {
    maxUses = null; // 显式 null:不限次
  } else {
    maxUses = Number(maxUses);
    if (!(Number.isInteger(maxUses) && maxUses > 0))
      throw new DomainError('BAD_MAX_USES', '可用次数必须为正整数,或显式为 null 表示不限次');
  }
  // 签发幂等:同一 issueNonce 返回首次证明
  const issueKey = input.issueNonce ? 'cert-issue:' + input.issueNonce : null;

  // 密钥材料在事务外用 WebCrypto 预生成(禁止在事务内再开事务,否则 FIFO 自死锁)
  const prepared = await prepareActiveKeyMaterial();

  return transact(async (s, tx) => {
    if (issueKey && s.idempotency[issueKey]) {
      const firstId = s.idempotency[issueKey].certId;
      const first = s.certificates.find((c) => c.id === firstId);
      if (!first) throw new DomainError('CERT_NOT_FOUND', '幂等记录指向的证明不存在');
      if (actorId !== first.issuedBy)
        throw new DomainError('FORBIDDEN', `仅原签发方 ${first.issuedBy} 可重放该签发请求`);
      return { replayed: true, certificate: certView(s, first), envelope: first.envelope };
    }

    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || !['financer', 'regulator'].includes(actor.type))
      throw new DomainError('FORBIDDEN', '仅融资方(金融机构)或监管方可对外签发权利证明');
    const r = s.receipts.find((x) => x.id === receiptId);
    if (!r) throw new DomainError('RECEIPT_NOT_FOUND', `仓单 ${receiptId} 不存在`);
    if (!VALID_RECEIPT_STATUS.includes(r.status))
      throw new DomainError('RECEIPT_NOT_VALID', `仓单 ${receiptId} 当前 ${r.status},不可对外出具权利证明`);
    // 融资方只能对自己持有的存续质押仓单签发;监管方可对任意有效仓单签发
    if (actor.type === 'financer') {
      const p = s.pledges.find((x) => x.receiptId === receiptId && ACTIVE_PLEDGE_STATUS.includes(x.status));
      if (!p || p.financerId !== actorId)
        throw new DomainError('FORBIDDEN', `融资方 ${actorId} 不是仓单 ${receiptId} 的当前质权人,无权对外签发该权利证明`);
    }

    // 披露字段白名单(始终披露的目录字段强制在内)
    const validKeys = new Set(certCore.FIELD_CATALOG.map((f) => f.key));
    const disclosed = Array.from(new Set([...certCore.ALWAYS_DISCLOSED, ...(input.discloseFields || [])]
      .filter((k) => validKeys.has(k))));

    const now = Date.now();
    const snapshot = buildSnapshot(s, receiptId);
    snapshot.issuedAtDate = new Date(now).toISOString().slice(0, 10);
    const exp = expiresAt || now + Math.round(ttlDays) * 86400000;

    // 未披露字段:逐字段随机盐承诺;证明级随机盐做完整快照承诺
    const salt = certCore.randomHex(16);
    const hidden = [];
    for (const key of Object.keys(snapshot)) {
      if (disclosed.includes(key)) continue;
      const nonce = certCore.randomHex(16);
      hidden.push({ key, nonce, commit: await certCore.fieldCommit(nonce, key, snapshot[key]) });
    }
    const snapshotStable = certCore.stableStringify(snapshot);
    const sd = await certCore.stateDigest(salt, snapshotStable);

    // 全平台首次签发:在本事务内先落地 CERT_KEY_CREATED,其下一条事件才是本证明的锚点;
    // 因而锚点序号必须在密钥落库后计算。
    const key = materializeActiveKey(s, tx, prepared);

    const anchorSeq = s.seq.event + 1;
    const prevHash = s.events.length ? s.events[s.events.length - 1].hash : 'GENESIS';
    const anchorTs = now;

    const certId = tx.nextId('certificate', 'CRT');

    const disclosedPayload = {};
    for (const k of disclosed) disclosedPayload[k] = snapshot[k];

    const anchorPayload = {
      certId,
      keyId: key.id,
      issuedState: sd,
      purpose,
      maxUses,
      disclosedFields: disclosed,
      fieldCommitCount: hidden.length,
      issuer: 'PLATFORM'
    };

    const { chainHashOf } = certCore;

    const claims = {
      id: certId,
      iat: now,
      exp,
      pu: purpose,
      mu: maxUses,
      dl: disclosed,
      d: disclosedPayload,
      // 未披露字段只放承诺哈希(连字段名也不出现,避免键名本身暗示存在贷款/身份);
      // 字段名→盐的对应仅留签发方台账 secrets,监管争议时可离线复核
      h: hidden.map((x) => x.commit),
      sd,
      ap: anchorSeq,
      ah: null, // 先算锚点哈希再回填
      ph: prevHash,
      at_t: anchorTs
    };
    const provisionalEvent = {
      seq: anchorSeq,
      ts: anchorTs,
      type: 'CERT_ISSUED',
      receiptId: null,
      pledgeId: null,
      actorId: null,
      payload: anchorPayload,
      prevHash
    };
    claims.ah = await chainHashOf(provisionalEvent);

    const envelope = { v: certCore.CERT_VERSION, alg: certCore.ALG, kid: key.id, claims };
    await certCore.signEnvelope(envelope, key.jwkPrivate);

    // 以同一时间戳把锚点事件真正写入链:链上事件必须与签名时逐字段一致,
    // 这样第三方离线按 (seq,ts,payload,prevHash) 重算的哈希才能与 claims.ah 相等。
    const ev = tx.appendEvent('CERT_ISSUED', { ts: anchorTs, payload: anchorPayload });
    if (ev.seq !== anchorSeq || ev.hash !== claims.ah)
      throw new DomainError('CERT_ANCHOR_INCONSISTENT', '证明锚点哈希与链上事件不一致,事务中止');
    // 后续事件(如 CERT_VERIFIED/CERT_REVOKED)的 prevHash 自动引用 ev.hash,链不断裂

    const cert = {
      id: certId,
      receiptId,
      pledgeId: snapshot.pledgeId,
      issuedBy: actorId,
      issuedAt: now,
      expiresAt: exp,
      purpose,
      maxUses,
      usedCount: 0,
      status: CERT_ACTIVE,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      keyId: key.id,
      discloseFields: disclosed,
      // 签发方留存的隐私盐(不进证明/不进链/不下发给第三方),供监管争议时核验字段承诺
      secrets: { stateSalt: salt, fieldNonces: hidden.map((x) => ({ key: x.key, nonce: x.nonce })) },
      snapshot, // 内部完整快照(仅供授权方/监管回放,不在证明信封中)
      snapshotStateDigest: sd,
      anchorEventSeq: ev.seq,
      anchorHash: ev.hash,
      envelope
    };
    s.certificates.push(cert);
    if (issueKey) s.idempotency[issueKey] = { certId, at: now };

    return { replayed: false, certificate: certView(s, cert), envelope };
  });
}

/* ============================ 撤销证明 ============================ */
function revokeCertificate(input) {
  const actorId = input.actorId;
  const certId = input.certId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '撤销主体必填');
  if (!certId) throw new DomainError('CERT_ID_REQUIRED', '证明编号必填');
  return transact((s, tx) => {
    const cert = s.certificates.find((c) => c.id === certId);
    if (!cert) throw new DomainError('CERT_NOT_FOUND', `证明 ${certId} 不存在`);
    const actor = s.parties.find((p) => p.id === actorId);
    const isIssuer = cert.issuedBy === actorId;
    const isRegulator = actor && actor.type === 'regulator';
    if (!isIssuer && !isRegulator)
      throw new DomainError('FORBIDDEN', '仅原签发方或监管方可撤销证明');
    if (cert.status === CERT_REVOKED) {
      // 重复撤销幂等:返回当前结论,不重复上链
      return { alreadyRevoked: true, certificate: certView(s, cert) };
    }
    cert.status = CERT_REVOKED;
    cert.revokedAt = Date.now();
    cert.revokedBy = actorId;
    cert.revokeReason = input.reason || '签发方撤销';
    tx.appendEvent('CERT_REVOKED', {
      payload: { certId, by: actorId, reason: cert.revokeReason, at: cert.revokedAt }
    });
    return { alreadyRevoked: false, certificate: certView(s, cert) };
  });
}

/* ============================ 在线核验(确定性 + nonce 幂等) ============================
 * 返回 {valid, verdict, code?, ...}。成功(valid)才扣次数并记 CERT_VERIFIED;
 * 失败不扣次数、但结论按 nonce 留存(失败重试返回同一失败结论)。
 */
async function verifyCertificateOnline(input) {
  const nonce = input.nonce;
  if (!nonce) throw new DomainError('VERIFY_NONCE_REQUIRED', '核验请求必须携带一次性 nonce(失败重试携带同一 nonce,不重复扣次)');
  const purpose = input.purpose;
  if (!purpose) throw new DomainError('PURPOSE_REQUIRED', '核验方必须声明核验用途');
  const idemKey = 'cert-verify:' + nonce;

  return transact(async (s, tx) => {
    const prev = s.certificateVerifications.find((v) => v.nonce === nonce);
    if (prev) {
      return {
        replayed: true,
        valid: prev.valid,
        code: prev.code || null,
        verdict: prev,
        note: '相同核验请求重放:返回首次结论,次数不重复消耗'
      };
    }

    // 解析信封(可传信封字符串/对象,或仅传 certId)
    let envelope = null;
    let cert = null;
    if (input.envelope != null) {
      try {
        envelope = typeof input.envelope === 'string' ? JSON.parse(input.envelope) : input.envelope;
      } catch (_) {
        return recordVerdict(s, tx, { nonce, purpose, certId: null, valid: false, code: 'CERT_MALFORMED', detail: '证明不是合法 JSON', now: Date.now() });
      }
      const cid = envelope && envelope.claims && envelope.claims.id;
      cert = s.certificates.find((c) => c.id === cid) || null;
    } else if (input.certId) {
      cert = s.certificates.find((c) => c.id === input.certId);
      if (!cert)
        return recordVerdict(s, tx, { nonce, purpose, certId: input.certId, valid: false, code: 'CERT_NOT_FOUND', detail: `证明 ${input.certId} 不存在于签发方台账`, now: Date.now() });
      envelope = cert.envelope;
    } else {
      throw new DomainError('CERT_OR_ENVELOPE_REQUIRED', '必须提供证明信封或证明编号');
    }

    const now = Date.now();
    const certId = envelope.claims ? envelope.claims.id : null;
    const deny = (code, detail) =>
      recordVerdict(s, tx, { nonce, purpose, certId, valid: false, code, detail, now });

    if (!envelope || !envelope.claims || envelope.v !== certCore.CERT_VERSION)
      return deny('CERT_MALFORMED', '证明信封结构或版本不合法');
    const c = envelope.claims;
    if (envelope.alg !== certCore.ALG) return deny('ALGORITHM_UNSUPPORTED', '签名算法不受信');

    // 信任锚:轮换的旧密钥仍可验真,被应急吊销的密钥拒绝
    const key = s.certKeys.find((k) => k.id === envelope.kid);
    if (!key) return deny('KEY_NOT_TRUSTED', `未知签名密钥 ${envelope.kid}`);
    if (key.status === KEY_REVOKED) return deny('KEY_REVOKED', '签名密钥已被应急吊销');

    const sigOk = await certCore.verifySignature(key.jwkPublic, certCore.signingData(envelope), envelope.sig);
    if (!sigOk) return deny('PAYLOAD_TAMPERED', '签名校验失败:证明正文被篡改或签名无效');

    // 链锚:重算锚点哈希,并与实际链上事件逐字段一致(签发时状态 + 链头)。
    // 注意事件按 seq(从1起)编号,数组下标为 seq-1,不能直接用 ap 作下标。
    const anchorEvent = s.events.find((e) => e.seq === c.ap);
    if (!anchorEvent || anchorEvent.type !== 'CERT_ISSUED' || anchorEvent.payload.certId !== certId)
      return deny('CHAIN_ANCHOR_MISMATCH', '证明锚点事件在链上不存在或不匹配');
    const recomputed = await certCore.chainHashOf({
      seq: c.ap, ts: c.at_t, type: 'CERT_ISSUED',
      receiptId: null, pledgeId: null, actorId: null, payload: anchorEvent.payload, prevHash: c.ph
    });
    if (recomputed !== c.ah || anchorEvent.hash !== c.ah)
      return deny('CHAIN_ANCHOR_MISMATCH', '锚点哈希与链上事件不一致(签发时状态被改或链断裂)');
    if (anchorEvent.payload.issuedState !== c.sd)
      return deny('CHAIN_ANCHOR_MISMATCH', '签发时状态承诺与正文不一致');

    if (now < c.iat) return deny('NOT_EFFECTIVE_YET', '证明尚未生效');
    if (now > c.exp) return deny('CERT_EXPIRED', `证明已于 ${new Date(c.exp).toLocaleString()} 过期`);
    if (purpose !== c.pu) return deny('PURPOSE_MISMATCH', `核验用途不符:证明限定 ${c.pu},本次声明 ${purpose}`);

    // 必须命中签发方台账中的同一份证明(防止用真实签名+不同正文拼装)
    if (!cert) return deny('CERT_NOT_FOUND', '证明未经本签发方登记(可能为伪造或他方证明)');
    if (cert.envelope.sig !== envelope.sig || cert.snapshotStateDigest !== c.sd)
      return deny('PAYLOAD_TAMPERED', '证明正文与签发方留存不一致');
    if (cert.status === CERT_REVOKED)
      return deny('CERT_REVOKED', `证明已被撤销:${cert.revokeReason || ''}(@${cert.revokedAt})`);
    if (cert.maxUses != null && cert.usedCount >= cert.maxUses)
      return deny('USES_EXHAUSTED', `可用次数已耗尽(${cert.usedCount}/${cert.maxUses})`);

    // 全部通过 → 同一事务扣次(并发由 FIFO 串行裁决)
    cert.usedCount += 1;
    const remaining = cert.maxUses == null ? null : cert.maxUses - cert.usedCount;
    const ev = tx.appendEvent('CERT_VERIFIED', {
      payload: { certId, purpose, nonce, usedCount: cert.usedCount, remaining }
    });
    const verdict = {
      id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
      nonce, certId, purpose, actorId: input.verifierId || null,
      valid: true, code: null, detail: '验真通过',
      at: now, eventSeq: ev.seq,
      usedCount: cert.usedCount, remaining
    };
    s.certificateVerifications.push(verdict);
    return { replayed: false, valid: true, verdict, certificate: certView(s, cert) };
  });
}

/** 失败结论也持久化(按 nonce),保证失败重试得到同一结果;失败不扣次数、不记 CERT_VERIFIED 链事件 */
function recordVerdict(s, tx, v) {
  const rec = {
    id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
    nonce: v.nonce,
    certId: v.certId,
    purpose: v.purpose,
    actorId: null,
    valid: false,
    code: v.code,
    detail: v.detail,
    at: v.now || Date.now(),
    eventSeq: null,
    usedCount: null,
    remaining: null
  };
  s.certificateVerifications.push(rec);
  return { replayed: false, valid: false, code: v.code, detail: v.detail, verdict: rec };
}

/* ============================ 密钥管理 ============================ */
function rotateKey(input) {
  const actorId = input.actorId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '操作主体必填');
  return transact(async (s, tx) => {
    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || actor.type !== 'regulator')
      throw new DomainError('FORBIDDEN', '仅监管方可轮换签名密钥');
    const current = s.certKeys.find((k) => k.status === KEY_ACTIVE);
    if (current) {
      current.status = KEY_ROTATED;
      current.rotatedAt = Date.now();
    }
    const pair = await certCore.generateKeyPair();
    const id = tx.nextId('certKey', 'CK');
    const key = {
      id, jwkPublic: pair.publicJwk, jwkPrivate: pair.privateJwk,
      status: KEY_ACTIVE, createdAt: Date.now(), rotatedAt: null, revokedAt: null,
      note: input.note || '轮换后的证明签名密钥'
    };
    s.certKeys.push(key);
    tx.appendEvent('CERT_KEY_ROTATED', { payload: { oldKeyId: current ? current.id : null, newKeyId: id, by: actorId } });
    return { previous: current ? publicKeyView(current) : null, active: publicKeyView(key) };
  });
}

/** 应急吊销密钥(私钥泄露):该密钥签发的所有证明立即不再受信(区别于正常轮换) */
function revokeKey(input) {
  const actorId = input.actorId;
  const keyId = input.keyId;
  return transact((s, tx) => {
    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || actor.type !== 'regulator')
      throw new DomainError('FORBIDDEN', '仅监管方可应急吊销签名密钥');
    const key = s.certKeys.find((k) => k.id === keyId);
    if (!key) throw new DomainError('KEY_NOT_FOUND', `密钥 ${keyId} 不存在`);
    if (key.status === KEY_REVOKED) return { alreadyRevoked: true, key: publicKeyView(key) };
    key.status = KEY_REVOKED;
    key.revokedAt = Date.now();
    tx.appendEvent('CERT_KEY_REVOKED', { payload: { keyId, by: actorId, at: key.revokedAt } });
    return { alreadyRevoked: false, key: publicKeyView(key) };
  });
}

function listKeys() {
  const s = getState();
  return s.certKeys.map((k) => ({
    ...publicKeyView(k),
    rotatedAt: k.rotatedAt, revokedAt: k.revokedAt, note: k.note,
    issuedCount: s.certificates.filter((c) => c.keyId === k.id).length
  }));
}

/* ============================ 视图 / 查询 ============================ */
function certView(s, cert) {
  const actor = s.parties.find((p) => p.id === cert.issuedBy);
  const receipt = s.receipts.find((r) => r.id === cert.receiptId);
  const now = Date.now();
  const validity = cert.expiresAt > now ? 'VALID' : 'EXPIRED';
  const availability = cert.maxUses == null ? 'UNLIMITED'
    : cert.usedCount >= cert.maxUses ? 'EXHAUSTED' : 'AVAILABLE';
  return {
    id: cert.id,
    receiptId: cert.receiptId,
    receiptStatusNow: receipt ? receipt.status : null,
    receiptVersionNow: receipt ? receipt.version : null,
    issuedBy: cert.issuedBy,
    issuedByName: actor ? actor.name : cert.issuedBy,
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    purpose: cert.purpose,
    maxUses: cert.maxUses,
    usedCount: cert.usedCount,
    remaining: cert.maxUses == null ? null : Math.max(0, cert.maxUses - cert.usedCount),
    status: cert.status,
    revokedAt: cert.revokedAt,
    revokedBy: cert.revokedBy,
    revokeReason: cert.revokeReason,
    keyId: cert.keyId,
    keyStatus: (s.certKeys.find((k) => k.id === cert.keyId) || {}).status || null,
    discloseFields: cert.discloseFields,
    anchorEventSeq: cert.anchorEventSeq,
    anchorHash: cert.anchorHash,
    validityNow: cert.status === CERT_REVOKED ? 'REVOKED' : validity,
    availabilityNow: availability,
    envelope: cert.envelope
  };
}

function queryCertificates(filter = {}) {
  const s = getState();
  let list = [...s.certificates];
  if (filter.receiptId) list = list.filter((c) => c.receiptId === filter.receiptId);
  if (filter.issuedBy) list = list.filter((c) => c.issuedBy === filter.issuedBy);
  if (filter.purpose) list = list.filter((c) => c.purpose === filter.purpose);
  if (filter.status) list = list.filter((c) => c.status === filter.status);
  return list.sort((a, b) => b.issuedAt - a.issuedAt).map((c) => certView(s, c));
}

function queryVerifications(filter = {}) {
  const s = getState();
  let list = [...s.certificateVerifications];
  if (filter.certId) list = list.filter((v) => v.certId === filter.certId);
  if (filter.purpose) list = list.filter((v) => v.purpose === filter.purpose);
  if (filter.valid != null && filter.valid !== '') list = list.filter((v) => String(v.valid) === String(filter.valid));
  return list.sort((a, b) => (a.eventSeq || 1e12) - (b.eventSeq || 1e12) || a.at - b.at);
}

/** 监管汇总:证明/核验/密钥计数 + 链验签 */
function certificateAudit() {
  const s = getState();
  const now = Date.now();
  const chain = verifyChain(s);
  return {
    chain,
    keys: {
      total: s.certKeys.length,
      active: s.certKeys.filter((k) => k.status === KEY_ACTIVE).length,
      rotated: s.certKeys.filter((k) => k.status === KEY_ROTATED).length,
      revoked: s.certKeys.filter((k) => k.status === KEY_REVOKED).length
    },
    certificates: {
      total: s.certificates.length,
      active: s.certificates.filter((c) => c.status === CERT_ACTIVE && c.expiresAt > now).length,
      expired: s.certificates.filter((c) => c.status === CERT_ACTIVE && c.expiresAt <= now).length,
      revoked: s.certificates.filter((c) => c.status === CERT_REVOKED).length,
      exhausted: s.certificates.filter((c) => c.maxUses != null && c.usedCount >= c.maxUses).length
    },
    verifications: {
      total: s.certificateVerifications.length,
      passed: s.certificateVerifications.filter((v) => v.valid).length,
      rejected: s.certificateVerifications.filter((v) => !v.valid).length
    }
  };
}

module.exports = {
  issueCertificate,
  revokeCertificate,
  verifyCertificateOnline,
  rotateKey,
  revokeKey,
  listKeys,
  trustAnchors,
  queryCertificates,
  queryVerifications,
  certificateAudit,
  buildSnapshot
};
