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

/* ============================ 机构级查验额度委托(C7) ============================
 * 持有方把凭据总次数中的一部分分配给指定合作机构(partner),并限定业务场景、
 * 起止时间与单次操作人;受托机构只能消费自己的额度。
 *  - DELEG_ACTIVE:生效中;DELEG_RECLAIMED:持有方收回未用额度,旧授权立即失效;
 *    DELEG_STOPPED:凭据撤销/密钥应急吊销/上级额度耗尽时级联停止;
 *    DELEG_EXHAUSTED:受托额度恰好用完(终态)。
 *  - 预留不变量:usedCount(凭据总账) + Σ ACTIVE 委托剩余 ≥ 0 方向上,
 *    签发总额度 maxUses ≥ 凭据已用量 + Σ ACTIVE(quota-usedCount),
 *    委托、消费全部经 FIFO 串行事务裁决,总额度/各机构额度均不超扣。
 *  - 消费携带业务流水 flowNo:相同流水再次提交返回第一次裁决(成功/拒绝都持久化)。
 */
const DELEG_ACTIVE = 'ACTIVE';
const DELEG_RECLAIMED = 'RECLAIMED';
const DELEG_STOPPED = 'STOPPED';
const DELEG_EXHAUSTED = 'EXHAUSTED';

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
    // 凭据作废:全部下级有效委托同事务同步停止,旧授权立即不能继续使用
    stopDelegations(s, tx, certId, 'CERT_REVOKED', { at: cert.revokedAt, by: actorId });
    return { alreadyRevoked: false, certificate: certView(s, cert) };
  });
}

/* ============================ 在线核验(确定性 + nonce 幂等) ============================
 * 返回 {valid, verdict, code?, ...}。成功(valid)才扣次数并记 CERT_VERIFIED;
 * 失败不扣次数、但结论按 nonce 留存(失败重试返回同一失败结论)。
 */

/**
 * 公共信封校验:解析 → 版本/算法 → 信任锚密钥三态 → 签名 → 链锚重算 → 有效期/用途。
 * 普通在线核验与受托机构消费共用同一套确定性前置检查。
 * 注意:不校验撤销与剩余次数(调用方按场景判定,如级联停止原因映射)。
 * @returns {Promise<{ok:true, cert:object, envelope:object, certId:string, now:number}>|
 *           {ok:false, code:string, detail:string, certId:?string}>}
 */
async function authenticateEnvelope(s, input) {
  let envelope = null;
  let cert = null;
  if (input.envelope != null) {
    try {
      envelope = typeof input.envelope === 'string' ? JSON.parse(input.envelope) : input.envelope;
    } catch (_) {
      return { ok: false, certId: null, code: 'CERT_MALFORMED', detail: '证明不是合法 JSON' };
    }
    const cid = envelope && envelope.claims && envelope.claims.id;
    cert = s.certificates.find((c) => c.id === cid) || null;
  } else if (input.certId) {
    cert = s.certificates.find((c) => c.id === input.certId);
    if (!cert) return { ok: false, certId: input.certId, code: 'CERT_NOT_FOUND', detail: `证明 ${input.certId} 不存在于签发方台账` };
    envelope = cert.envelope;
  } else {
    return { ok: false, certId: null, code: 'CERT_OR_ENVELOPE_REQUIRED', detail: '必须提供证明信封或证明编号' };
  }

  const now = Date.now();
  const certId = envelope.claims ? envelope.claims.id : null;
  const fail = (code, detail) => ({ ok: false, certId, code, detail, now });

  if (!envelope || !envelope.claims || envelope.v !== certCore.CERT_VERSION)
    return fail('CERT_MALFORMED', '证明信封结构或版本不合法');
  if (envelope.alg !== certCore.ALG) return fail('ALGORITHM_UNSUPPORTED', '签名算法不受信');

  // 信任锚:轮换的旧密钥仍可验真,被应急吊销的密钥拒绝
  const key = s.certKeys.find((k) => k.id === envelope.kid);
  if (!key) return fail('KEY_NOT_TRUSTED', `未知签名密钥 ${envelope.kid}`);
  if (key.status === KEY_REVOKED) return fail('KEY_REVOKED', '签名密钥已被应急吊销');

  const sigOk = await certCore.verifySignature(key.jwkPublic, certCore.signingData(envelope), envelope.sig);
  if (!sigOk) return fail('PAYLOAD_TAMPERED', '签名校验失败:证明正文被篡改或签名无效');

  // 链锚:重算锚点哈希,并与实际链上事件逐字段一致(签发时状态 + 链头)。
  const c = envelope.claims;
  const anchorEvent = s.events.find((e) => e.seq === c.ap);
  if (!anchorEvent || anchorEvent.type !== 'CERT_ISSUED' || anchorEvent.payload.certId !== certId)
    return fail('CHAIN_ANCHOR_MISMATCH', '证明锚点事件在链上不存在或不匹配');
  const recomputed = await certCore.chainHashOf({
    seq: c.ap, ts: c.at_t, type: 'CERT_ISSUED',
    receiptId: null, pledgeId: null, actorId: null, payload: anchorEvent.payload, prevHash: c.ph
  });
  if (recomputed !== c.ah || anchorEvent.hash !== c.ah)
    return fail('CHAIN_ANCHOR_MISMATCH', '锚点哈希与链上事件不一致(签发时状态被改或链断裂)');
  if (anchorEvent.payload.issuedState !== c.sd)
    return fail('CHAIN_ANCHOR_MISMATCH', '签发时状态承诺与正文不一致');

  if (now < c.iat) return fail('NOT_EFFECTIVE_YET', '证明尚未生效');
  if (now > c.exp) return fail('CERT_EXPIRED', `证明已于 ${new Date(c.exp).toLocaleString()} 过期`);
  if (input.purpose && input.purpose !== c.pu)
    return fail('PURPOSE_MISMATCH', `核验用途不符:证明限定 ${c.pu},本次声明 ${input.purpose}`);

  // 必须命中签发方台账中的同一份证明(防止用真实签名+不同正文拼装)
  if (!cert) return fail('CERT_NOT_FOUND', '证明未经本签发方登记(可能为伪造或他方证明)');
  if (cert.envelope.sig !== envelope.sig || cert.snapshotStateDigest !== c.sd)
    return fail('PAYLOAD_TAMPERED', '证明正文与签发方留存不一致');

  return { ok: true, cert, envelope, certId, now };
}

async function verifyCertificateOnline(input) {
  const nonce = input.nonce;
  if (!nonce) throw new DomainError('VERIFY_NONCE_REQUIRED', '核验请求必须携带一次性 nonce(失败重试携带同一 nonce,不重复扣次)');
  const purpose = input.purpose;
  if (!purpose) throw new DomainError('PURPOSE_REQUIRED', '核验方必须声明核验用途');

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

    const auth = await authenticateEnvelope(s, { ...input, purpose });
    if (!auth.ok)
      return recordVerdict(s, tx, { nonce, purpose, certId: auth.certId, valid: false, code: auth.code, detail: auth.detail, now: auth.now || Date.now() });
    const { cert, now } = auth;
    if (cert.status === CERT_REVOKED)
      return recordVerdict(s, tx, { nonce, purpose, certId: cert.id, valid: false, code: 'CERT_REVOKED', detail: `证明已被撤销:${cert.revokeReason || ''}(@${cert.revokedAt})`, now });
    if (cert.maxUses != null && cert.usedCount >= cert.maxUses) {
      // 上级额度耗尽(含持有方直接核验耗尽):全部下级授权同步停止
      stopDelegations(s, tx, cert.id, 'PARENT_EXHAUSTED', { at: now, by: null });
      return recordVerdict(s, tx, { nonce, purpose, certId: cert.id, valid: false, code: 'USES_EXHAUSTED', detail: `可用次数已耗尽(${cert.usedCount}/${cert.maxUses}),下级授权同步停止`, now });
    }

    // 全部通过 → 同一事务扣次(并发由 FIFO 串行裁决)
    cert.usedCount += 1;
    const remaining = cert.maxUses == null ? null : cert.maxUses - cert.usedCount;
    // 恰在最后一扣到达边界:预留不变量保证此时有效委托剩余为 0(持有方直用耗尽除外),
    // 统一把仍残留的 ACTIVE 下级委托级联停止,做到「上级额度耗尽 → 全部下级同步停止」。
    if (cert.maxUses != null && cert.usedCount >= cert.maxUses)
      stopDelegations(s, tx, cert.id, 'PARENT_EXHAUSTED', { at: now, by: null });
    const ev = tx.appendEvent('CERT_VERIFIED', {
      payload: { certId: cert.id, purpose, nonce, usedCount: cert.usedCount, remaining }
    });
    const verdict = {
      id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
      nonce, certId: cert.id, purpose, actorId: input.verifierId || null,
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
    // 密钥紧急停用:该密钥签发的全部凭据之有效委托同步停止(在线消费立即拒绝)
    for (const cert of s.certificates) {
      if (cert.keyId === keyId && cert.status === CERT_ACTIVE) {
        stopDelegations(s, tx, cert.id, 'KEY_REVOKED', { at: key.revokedAt, by: actorId, keyId });
      }
    }
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

/* ============================ 机构级查验额度委托 ============================ */

/** 某凭据当前各有效(ACTIVE)委托的剩余预留额度之和 */
function activeReserved(s, certId) {
  return s.certDelegations
    .filter((d) => d.certId === certId && d.status === DELEG_ACTIVE)
    .reduce((sum, d) => sum + (d.quota - d.usedCount), 0);
}

/**
 * 级联停止某凭据全部 ACTIVE 下级委托(凭据撤销/密钥吊销/上级额度耗尽)。
 * 已收回/已耗尽/已停止的终态委托不回写,已消耗次数原样保留。
 */
function stopDelegations(s, tx, certId, reason, extra = {}) {
  const at = extra.at || Date.now();
  const stopped = [];
  for (const d of s.certDelegations) {
    if (d.certId !== certId || d.status !== DELEG_ACTIVE) continue;
    d.status = DELEG_STOPPED;
    d.stoppedAt = at;
    d.stopReason = reason;
    d.stoppedBy = extra.by || null;
    stopped.push(d.id);
  }
  if (stopped.length) {
    tx.appendEvent('CERT_DELEG_STOPPED', {
      ts: at,
      payload: {
        certId, reason, by: extra.by || null, keyId: extra.keyId || null,
        delegationIds: stopped, count: stopped.length
      }
    });
  }
  return stopped;
}

/**
 * 分配(委托)额度:持有方把总次数中的一部分交给指定合作机构。
 * 同事务校验:主体权限、凭据有效可委托、受托方是合作机构、场景与凭据一致、
 * 时间窗合法(不超出凭据有效期)、单次操作人限制合法、预留后总额度不超扣。
 */
function grantDelegation(input) {
  const actorId = input.actorId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '分配主体必填(凭据持有方或监管方)');
  const certId = input.certId;
  if (!certId) throw new DomainError('CERT_ID_REQUIRED', '必须指定父级权利凭据');
  const trusteeId = input.trusteeId;
  if (!trusteeId) throw new DomainError('TRUSTEE_REQUIRED', '必须指定受托合作机构');
  const scenario = input.scenario;
  if (!certCore.PURPOSES.some((p) => p.code === scenario))
    throw new DomainError('BAD_SCENE', '业务场景不合法');

  let quota = Number(input.quota);
  if (!(Number.isInteger(quota) && quota > 0))
    throw new DomainError('BAD_QUOTA', '委托额度必须为正整数');

  let startsAt = input.startsAt ? Number(input.startsAt) : Date.now();
  let endsAt = input.endsAt ? Number(input.endsAt) : null;
  if (!endsAt && input.ttlDays != null && Number(input.ttlDays) > 0)
    endsAt = startsAt + Math.round(Number(input.ttlDays)) * 86400000;
  if (!(endsAt > startsAt)) throw new DomainError('BAD_WINDOW', '委托起止时间不合法(止必须晚于起)');

  // 单次操作人限制:可空(不限制);否则正整数上限;可同时给允许名单
  let perOperatorLimit = input.perOperatorLimit === undefined || input.perOperatorLimit === null || input.perOperatorLimit === ''
    ? null : Number(input.perOperatorLimit);
  if (perOperatorLimit != null && !(Number.isInteger(perOperatorLimit) && perOperatorLimit > 0))
    throw new DomainError('BAD_OPERATOR_LIMIT', '单次操作人限制必须为正整数或留空');
  const operatorAllowlist = Array.isArray(input.operatorAllowlist)
    ? input.operatorAllowlist.map((x) => String(x)).filter(Boolean) : [];

  return transact((s, tx) => {
    // 分配幂等:相同委托请求号(reqId)返回首次授权
    const reqKey = input.reqId ? 'cert-deleg-grant:' + input.reqId : null;
    if (reqKey && s.idempotency[reqKey]) {
      const first = s.certDelegations.find((d) => d.id === s.idempotency[reqKey].delegationId);
      if (!first) throw new DomainError('INTERNAL', '幂等记录指向的委托不存在');
      if (actorId !== first.grantedBy)
        throw new DomainError('FORBIDDEN', `仅原分配方 ${first.grantedBy} 可重放该委托请求`);
      return { replayed: true, delegation: delegationView(s, first) };
    }

    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || !['financer', 'regulator'].includes(actor.type))
      throw new DomainError('FORBIDDEN', '仅凭据持有方(融资方)或监管方可分配查验额度');
    const cert = s.certificates.find((c) => c.id === certId);
    if (!cert) throw new DomainError('CERT_NOT_FOUND', `证明 ${certId} 不存在`);
    if (cert.issuedBy !== actorId && actor.type !== 'regulator')
      throw new DomainError('FORBIDDEN', `仅原签发持有方 ${cert.issuedBy} 或监管方可委托该凭据额度`);
    if (cert.status === CERT_REVOKED)
      throw new DomainError('CERT_REVOKED', '凭据已作废,不能再分配额度');
    const now = Date.now();
    if (cert.expiresAt <= now)
      throw new DomainError('CERT_EXPIRED', '凭据已过期,不能再分配额度');

    const trustee = s.parties.find((p) => p.id === trusteeId);
    if (!trustee || trustee.type !== 'partner')
      throw new DomainError('TRUSTEE_NOT_PARTNER', '受托方必须是已登记的合作机构(partner)');
    if (trusteeId === actorId)
      throw new DomainError('BAD_TRUSTEE', '不能向持有方自身分配受托额度');
    if (scenario !== cert.purpose)
      throw new DomainError('DELEG_SCENE_MISMATCH', `业务场景必须与凭据用途一致:凭据限定 ${cert.purpose}`);
    if (startsAt < now - 60000) throw new DomainError('BAD_WINDOW', '委托开始时间不能早于当前时刻');
    if (endsAt > cert.expiresAt)
      throw new DomainError('BAD_WINDOW', '委托截止时间不能晚于凭据有效期');

    // 总额度不变量:已用量 + 各 ACTIVE 委托剩余预留 + 本次额度 ≤ 总额度
    if (cert.maxUses != null) {
      const available = cert.maxUses - cert.usedCount - activeReserved(s, certId);
      if (quota > available)
        throw new DomainError('PARENT_QUOTA_EXCEEDED',
          `上级可委托额度不足:凭据 ${certId} 剩余可分配 ${available}(总额 ${cert.maxUses}/已用 ${cert.usedCount})`,
          { available, requested: quota });
    }

    const id = tx.nextId('delegation', 'DLG');
    const deleg = {
      id,
      certId,
      grantedBy: actorId,
      trusteeId,
      scenario,
      quota,
      usedCount: 0,
      startsAt,
      endsAt,
      perOperatorLimit,
      operatorAllowlist,
      status: DELEG_ACTIVE,
      grantedAt: now,
      reclaimedAt: null,
      reclaimedBy: null,
      reclaimedQuota: null,
      stoppedAt: null,
      stopReason: null,
      stoppedBy: null
    };
    s.certDelegations.push(deleg);
    tx.appendEvent('CERT_DELEG_GRANTED', {
      payload: {
        delegationId: id, certId, by: actorId, trusteeId, scenario, quota,
        startsAt, endsAt, perOperatorLimit,
        allowOperators: operatorAllowlist, at: now
      }
    });
    if (reqKey) s.idempotency[reqKey] = { delegationId: id, at: now };
    return { replayed: false, delegation: delegationView(s, deleg) };
  });
}

/**
 * 受托机构消费自己的受托额度。
 * 确定性:相同业务流水 flowNo 再次提交(断网/失败重试)返回第一次裁决;
 * 成功才在同一事务同时扣「委托额度」与「父凭据总账」,并发由 FIFO 裁决,
 * 机构额度与父总额度均不可能超扣。拒绝(越权/错场景/过期/已收回/已停止/
 * 父额度耗尽/操作人超限)结论持久化并记 CERT_DELEG_DENIED,不扣任何额度。
 */
function consumeDelegation(input) {
  const flowNo = input.flowNo;
  if (!flowNo) throw new DomainError('FLOW_NO_REQUIRED', '受托消费必须携带业务流水号(失败重试携带同一流水,返回首次裁决)');
  const delegationId = input.delegationId;
  if (!delegationId) throw new DomainError('DELEG_ID_REQUIRED', '必须指定委托授权号');
  const trusteeId = input.trusteeId;
  if (!trusteeId) throw new DomainError('ACTOR_REQUIRED', '必须指定消费的合作机构');
  const scenario = input.scenario;
  if (!scenario) throw new DomainError('PURPOSE_REQUIRED', '消费必须声明业务场景');
  const operatorId = input.operatorId == null ? null : String(input.operatorId);
  if (!operatorId) throw new DomainError('OPERATOR_REQUIRED', '受托消费必须指定单次操作人');

  return transact(async (s, tx) => {
    // 业务流水幂等:同一流水只能有一个裁决(不论成功/拒绝、不论哪个机构/委托)
    const prev = s.certDelegationVerdicts.find((v) => v.flowNo === flowNo);
    if (prev) {
      return {
        replayed: true,
        valid: prev.valid,
        code: prev.code || null,
        verdict: prev,
        note: '相同业务流水再次提交:返回第一次裁决,额度不重复消耗'
      };
    }

    const now = Date.now();
    const deny = (code, detail, extra = {}) =>
      recordDelegVerdict(s, tx, {
        flowNo, delegationId, certId: extra.certId || null, trusteeId, scenario, operatorId,
        valid: false, code, detail, now
      });

    const deleg = s.certDelegations.find((d) => d.id === delegationId);
    if (!deleg) return deny('DELEG_NOT_FOUND', `委托授权 ${delegationId} 不存在`);
    const cert = s.certificates.find((c) => c.id === deleg.certId);

    // 越权机构:只有受托方自己能消费自己的额度
    if (trusteeId !== deleg.trusteeId)
      return deny('DELEG_FORBIDDEN', `机构 ${trusteeId} 不是委托 ${delegationId} 的受托方,无权消费`, { certId: deleg.certId });

    // 终态:收回后旧授权立即不能继续使用;级联停止;已耗尽
    if (deleg.status === DELEG_RECLAIMED)
      return deny('DELEG_RECLAIMED', '该委托未用额度已被持有方收回,旧授权立即失效', { certId: deleg.certId });
    if (deleg.status === DELEG_STOPPED)
      return deny('DELEG_STOPPED', `委托已随上级 ${deleg.stopReason || '状态变化'} 同步停止`, { certId: deleg.certId });
    if (deleg.status === DELEG_EXHAUSTED)
      return deny('DELEG_EXHAUSTED', `受托额度已耗尽(${deleg.usedCount}/${deleg.quota})`, { certId: deleg.certId });

    // 时间窗:未开始/已过期
    if (now < deleg.startsAt)
      return deny('DELEG_NOT_STARTED', '委托授权尚未到生效时间', { certId: deleg.certId });
    if (now > deleg.endsAt)
      return deny('DELEG_EXPIRED', `委托授权已于 ${new Date(deleg.endsAt).toLocaleString()} 截止`, { certId: deleg.certId });

    // 错误业务场景
    if (scenario !== deleg.scenario)
      return deny('DELEG_SCENE_MISMATCH', `业务场景不符:委托限定 ${deleg.scenario},本次声明 ${scenario}`, { certId: deleg.certId });

    // 单次操作人:允许名单 + 单人累计上限
    if (deleg.operatorAllowlist.length && !deleg.operatorAllowlist.includes(operatorId))
      return deny('OPERATOR_NOT_ALLOWED', `操作人 ${operatorId} 不在该委托允许名单内`, { certId: deleg.certId });
    if (deleg.perOperatorLimit != null) {
      const usedByOp = s.certDelegationVerdicts
        .filter((v) => v.valid && v.delegationId === deleg.id && v.operatorId === operatorId).length;
      if (usedByOp >= deleg.perOperatorLimit)
        return deny('OPERATOR_LIMIT_EXCEEDED',
          `操作人 ${operatorId} 已用 ${usedByOp}/${deleg.perOperatorLimit} 次,超出单次操作人限制`, { certId: deleg.certId });
    }

    // 凭据本体:信封密码学/链锚/有效期/用途公共校验(与普通在线核验同一套)
    const auth = await authenticateEnvelope(s, {
      envelope: input.envelope,
      certId: input.certId || deleg.certId,
      purpose: deleg.scenario
    });
    if (!auth.ok) return deny(auth.code, auth.detail, { certId: auth.certId || deleg.certId });
    if (auth.cert.id !== deleg.certId)
      return deny('DELEG_CERT_MISMATCH', '提交的凭据与该委托的父级凭据不是同一份', { certId: auth.certId });

    // 凭据撤销 / 密钥吊销(authenticateEnvelope 已挡 KEY_REVOKED;撤销此处判定)
    if (auth.cert.status === CERT_REVOKED)
      return deny('CERT_REVOKED', `父凭据已作废:${auth.cert.revokeReason || ''}`, { certId: auth.cert.id });

    // 上级额度:父凭据总额度不能超扣。恰在边界耗尽时,级联停止全部 ACTIVE 下级委托。
    if (auth.cert.maxUses != null && auth.cert.usedCount >= auth.cert.maxUses) {
      stopDelegations(s, tx, auth.cert.id, 'PARENT_EXHAUSTED', { at: now, by: null });
      // 当前委托可能刚被停止;保持拒绝裁决
      return deny('PARENT_QUOTA_EXHAUSTED',
        `上级凭据额度已耗尽(${auth.cert.usedCount}/${auth.cert.maxUses}),全部下级授权同步停止`, { certId: auth.cert.id });
    }
    // 受托机构只能消费自己的额度
    if (deleg.usedCount >= deleg.quota)
      return deny('DELEG_EXHAUSTED', `本机构受托额度已耗尽(${deleg.usedCount}/${deleg.quota})`, { certId: deleg.certId });

    /* ---- 全部通过:同一事务扣两本账(委托 + 父凭据总账),FIFO 保证不超扣 ---- */
    deleg.usedCount += 1;
    auth.cert.usedCount += 1;
    if (deleg.usedCount >= deleg.quota) {
      deleg.status = DELEG_EXHAUSTED;
      deleg.exhaustedAt = now;
    }
    const parentRemaining = auth.cert.maxUses == null ? null : auth.cert.maxUses - auth.cert.usedCount;
    const delegRemaining = deleg.quota - deleg.usedCount;
    const ev = tx.appendEvent('CERT_DELEG_VERIFIED', {
      payload: {
        flowNo, delegationId: deleg.id, certId: auth.cert.id,
        trusteeId, operatorId, scenario,
        delegUsed: deleg.usedCount, delegRemaining,
        parentUsed: auth.cert.usedCount, parentRemaining,
        exhausted: deleg.status === DELEG_EXHAUSTED
      }
    });
    const rec = {
      id: 'DV' + String(s.certDelegationVerdicts.length + 1).padStart(4, '0'),
      flowNo,
      delegationId: deleg.id,
      certId: auth.cert.id,
      trusteeId,
      grantedBy: deleg.grantedBy,
      scenario,
      operatorId,
      valid: true,
      code: null,
      detail: '受托消费通过',
      at: now,
      eventSeq: ev.seq,
      delegUsedCount: deleg.usedCount,
      delegRemaining,
      parentUsedCount: auth.cert.usedCount,
      parentRemaining
    };
    s.certDelegationVerdicts.push(rec);
    return { replayed: false, valid: true, verdict: rec, delegation: delegationView(s, deleg) };
  });
}

/** 委托拒绝裁决持久化 + 上链(委托/消费/收回/拒绝全部进入现有持久化与审计链) */
function recordDelegVerdict(s, tx, v) {
  const rec = {
    id: 'DV' + String(s.certDelegationVerdicts.length + 1).padStart(4, '0'),
    flowNo: v.flowNo,
    delegationId: v.delegationId,
    certId: v.certId,
    trusteeId: v.trusteeId,
    grantedBy: null,
    scenario: v.scenario,
    operatorId: v.operatorId,
    valid: false,
    code: v.code,
    detail: v.detail,
    at: v.now || Date.now(),
    eventSeq: null,
    delegUsedCount: null,
    delegRemaining: null,
    parentUsedCount: null,
    parentRemaining: null
  };
  const d = s.certDelegations.find((x) => x.id === v.delegationId);
  if (d) rec.grantedBy = d.grantedBy;
  s.certDelegationVerdicts.push(rec);
  tx.appendEvent('CERT_DELEG_DENIED', {
    ts: rec.at,
    payload: {
      flowNo: v.flowNo, delegationId: v.delegationId, certId: v.certId,
      trusteeId: v.trusteeId, operatorId: v.operatorId, scenario: v.scenario,
      code: v.code
    }
  });
  return { replayed: false, valid: false, code: v.code, detail: v.detail, verdict: rec };
}

/**
 * 收回未用额度:持有方(或监管方)收回后委托立即终态 RECLAIMED,
 * 旧授权(含其继续提交的相同流水之外的新请求)立即不能使用;
 * 已消耗次数不回收,未消耗部分重新回到凭据可分配池。
 * 收回与消费同时到达由 FIFO 裁决,只能形成一个终态(收回成功则随后消费必被拒)。
 */
function reclaimDelegation(input) {
  const actorId = input.actorId;
  const delegationId = input.delegationId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '收回主体必填');
  if (!delegationId) throw new DomainError('DELEG_ID_REQUIRED', '必须指定委托授权号');
  return transact((s, tx) => {
    // 收回幂等:相同收回请求号返回首次结论
    const reqKey = input.reqId ? 'cert-deleg-reclaim:' + input.reqId : null;
    if (reqKey && s.idempotency[reqKey]) {
      const first = s.certDelegations.find((d) => d.id === s.idempotency[reqKey].delegationId);
      if (!first) throw new DomainError('INTERNAL', '幂等记录指向的委托不存在');
      return { replayed: true, delegation: delegationView(s, first) };
    }

    const actor = s.parties.find((p) => p.id === actorId);
    const deleg = s.certDelegations.find((d) => d.id === delegationId);
    if (!deleg) throw new DomainError('DELEG_NOT_FOUND', `委托授权 ${delegationId} 不存在`);
    const cert = s.certificates.find((c) => c.id === deleg.certId);
    const isGranter = cert && cert.issuedBy === actorId;
    const isRegulator = actor && actor.type === 'regulator';
    if (!isGranter && !isRegulator)
      throw new DomainError('FORBIDDEN', '仅凭据持有方(原签发方)或监管方可收回委托额度');
    if (deleg.status === DELEG_RECLAIMED)
      return { alreadyReclaimed: true, delegation: delegationView(s, deleg) };
    if (deleg.status !== DELEG_ACTIVE)
      throw new DomainError('DELEG_NOT_ACTIVE', `委托当前 ${deleg.status},仅生效中委托可收回未用额度`);

    const now = Date.now();
    const returned = deleg.quota - deleg.usedCount;
    deleg.status = DELEG_RECLAIMED;
    deleg.reclaimedAt = now;
    deleg.reclaimedBy = actorId;
    deleg.reclaimedQuota = returned;
    tx.appendEvent('CERT_DELEG_RECLAIMED', {
      payload: {
        delegationId: deleg.id, certId: deleg.certId, by: actorId, trusteeId: deleg.trusteeId,
        used: deleg.usedCount, returned, at: now
      }
    });
    if (reqKey) s.idempotency[reqKey] = { delegationId: deleg.id, at: now };
    return { alreadyReclaimed: false, returned, delegation: delegationView(s, deleg) };
  });
}

/* ============================ 委托视图 / 查询 ============================ */
function delegationView(s, d) {
  const cert = s.certificates.find((c) => c.id === d.certId);
  const trustee = s.parties.find((p) => p.id === d.trusteeId);
  const granter = s.parties.find((p) => p.id === d.grantedBy);
  const now = Date.now();
  let liveStatus = d.status;
  if (d.status === DELEG_ACTIVE) {
    if (now < d.startsAt) liveStatus = 'PENDING_START';
    else if (now > d.endsAt) liveStatus = 'EXPIRED';
  }
  return {
    id: d.id,
    certId: d.certId,
    certPurpose: cert ? cert.purpose : null,
    certExpiresAt: cert ? cert.expiresAt : null,
    certStatus: cert ? cert.status : null,
    grantedBy: d.grantedBy,
    grantedByName: granter ? granter.name : d.grantedBy,
    trusteeId: d.trusteeId,
    trusteeName: trustee ? trustee.name : d.trusteeId,
    scenario: d.scenario,
    quota: d.quota,
    usedCount: d.usedCount,
    remaining: d.quota - d.usedCount,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    perOperatorLimit: d.perOperatorLimit,
    operatorAllowlist: d.operatorAllowlist,
    status: d.status,
    liveStatus,
    grantedAt: d.grantedAt,
    reclaimedAt: d.reclaimedAt,
    reclaimedBy: d.reclaimedBy,
    reclaimedQuota: d.reclaimedQuota,
    stoppedAt: d.stoppedAt,
    stopReason: d.stopReason,
    stoppedBy: d.stoppedBy,
    exhaustedAt: d.exhaustedAt || null
  };
}

function queryDelegations(filter = {}) {
  const s = getState();
  let list = [...s.certDelegations];
  if (filter.certId) list = list.filter((d) => d.certId === filter.certId);
  if (filter.trusteeId) list = list.filter((d) => d.trusteeId === filter.trusteeId);
  if (filter.grantedBy) list = list.filter((d) => d.grantedBy === filter.grantedBy);
  if (filter.status) list = list.filter((d) => d.status === filter.status);
  return list.sort((a, b) => b.grantedAt - a.grantedAt || b.id.localeCompare(a.id)).map((d) => delegationView(s, d));
}

function queryDelegationVerdicts(filter = {}) {
  const s = getState();
  let list = [...s.certDelegationVerdicts];
  if (filter.certId) list = list.filter((v) => v.certId === filter.certId);
  if (filter.delegationId) list = list.filter((v) => v.delegationId === filter.delegationId);
  if (filter.trusteeId) list = list.filter((v) => v.trusteeId === filter.trusteeId);
  if (filter.valid != null && filter.valid !== '')
    list = list.filter((v) => String(v.valid) === String(filter.valid));
  return list.sort((a, b) => (a.eventSeq || 1e12) - (b.eventSeq || 1e12) || a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * 监管端:按父级凭据查看完整额度树(凭据总账 → 各机构委托 → 已用/剩余)
 * 与该凭据相关的先后事件(签发/核验/撤销 + 委托分配/消费/拒绝/收回/停止),严格按链序。
 */
function delegationTree(certId) {
  const s = getState();
  if (!certId) throw new DomainError('CERT_ID_REQUIRED', '必须指定父级凭据编号');
  const cert = s.certificates.find((c) => c.id === certId);
  if (!cert) throw new DomainError('CERT_NOT_FOUND', `证明 ${certId} 不存在`);
  const delegations = s.certDelegations
    .filter((d) => d.certId === certId)
    .sort((a, b) => a.grantedAt - a.grantedAt || a.id.localeCompare(b.id))
    .map((d) => delegationView(s, d));

  const total = cert.maxUses;
  const delegatedUsed = s.certDelegationVerdicts.filter((v) => v.valid && v.certId === certId).length;
  const directUsed = cert.usedCount - delegatedUsed;
  const activeReservedNow = activeReserved(s, certId);
  const events = s.events
    .filter((e) =>
      e.payload && e.payload.certId === certId ||
      (e.type === 'CERT_ISSUED' && e.payload.certId === certId))
    .map((e) => ({
      seq: e.seq, ts: e.ts, type: e.type, actorId: e.actorId,
      trusteeId: (e.payload && e.payload.trusteeId) || null,
      delegationId: (e.payload && (e.payload.delegationId || (e.payload.delegationIds && e.payload.delegationIds[0]))) || null,
      payload: e.payload, hash: e.hash
    }))
    .sort((a, b) => a.seq - b.seq);

  return {
    certificate: certView(s, cert),
    totals: {
      maxUses: total,
      used: cert.usedCount,
      directUsed,
      delegatedUsed,
      activeReserved: activeReservedNow,
      // 仍可新委托/直接消费的额度:总额 - 已用 - 有效委托剩余预留
      allocatable: total == null ? null : total - cert.usedCount - activeReservedNow
    },
    delegations,
    events
  };
}


function certView(s, cert) {
  const actor = s.parties.find((p) => p.id === cert.issuedBy);
  const receipt = s.receipts.find((r) => r.id === cert.receiptId);
  const now = Date.now();
  const validity = cert.expiresAt > now ? 'VALID' : 'EXPIRED';
  const availability = cert.maxUses == null ? 'UNLIMITED'
    : cert.usedCount >= cert.maxUses ? 'EXHAUSTED' : 'AVAILABLE';
  const delegs = s.certDelegations.filter((d) => d.certId === cert.id);
  const activeDelegs = delegs.filter((d) => d.status === DELEG_ACTIVE);
  const delegatedUsed = s.certDelegationVerdicts.filter((v) => v.valid && v.certId === cert.id).length;
  const activeReservedNow = activeDelegs.reduce((sum, d) => sum + (d.quota - d.usedCount), 0);
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
    // 机构级委托额度:受托已用/持有方直用、各有效委托剩余预留、仍可新分配额度
    delegation: {
      totalDelegations: delegs.length,
      activeDelegations: activeDelegs.length,
      delegatedUsed,
      directUsed: cert.usedCount - delegatedUsed,
      activeReserved: activeReservedNow,
      allocatable: cert.maxUses == null ? null : cert.maxUses - cert.usedCount - activeReservedNow
    },
    envelope: cert.envelope
  };
}

function queryCertificates(filter = {}) {
  const s = getState();
  let list = [...s.certificates];
  if (filter.certId) list = list.filter((c) => c.id === filter.certId);
  if (filter.receiptId) list = list.filter((c) => c.receiptId === filter.receiptId);
  if (filter.issuedBy) list = list.filter((c) => c.issuedBy === filter.issuedBy);
  if (filter.purpose) list = list.filter((c) => c.purpose === filter.purpose);
  if (filter.status) list = list.filter((c) => c.status === filter.status);
  return list.sort((a, b) => b.issuedAt - a.issuedAt || b.id.localeCompare(a.id)).map((c) => certView(s, c));
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
    },
    delegations: {
      total: s.certDelegations.length,
      active: s.certDelegations.filter((d) => d.status === DELEG_ACTIVE).length,
      reclaimed: s.certDelegations.filter((d) => d.status === DELEG_RECLAIMED).length,
      stopped: s.certDelegations.filter((d) => d.status === DELEG_STOPPED).length,
      exhausted: s.certDelegations.filter((d) => d.status === DELEG_EXHAUSTED).length,
      consumes: s.certDelegationVerdicts.filter((v) => v.valid).length,
      denied: s.certDelegationVerdicts.filter((v) => !v.valid).length
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
  buildSnapshot,
  // 机构级查验额度委托
  grantDelegation,
  consumeDelegation,
  reclaimDelegation,
  queryDelegations,
  queryDelegationVerdicts,
  delegationTree
};
