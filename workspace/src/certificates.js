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

/* ======================== 机构级查验额度委托(不变量 C7) ========================
 * 持有方(凭据签发方)或监管方可把凭据总次数中的一部分委托给指定合作机构,
 * 并限定业务场景、起止时间、单次操作人白名单。额度采用「委托即预占」模型:
 *   freePool(cert) = maxUses − usedCount(已消费) − Σ ACTIVE 授权 reservedRemaining(已预占未用)
 * 直接核验与新委托都只能从 freePool 扣取;受托机构消费在同一事务内同时
 *   ① 扣本授权 usedCount(不得超过其 quota) ② 扣父凭据 usedCount(总池不得超扣)。
 * 收回仅退回「未用预占」,授权即刻 RECLAIMED,旧授权消费请求立即被拒。
 * 凭据作废 / 密钥应急吊销 → 全部下级授权在同一事务转 HALTED,同步停止。
 */
const DL_ACTIVE = 'ACTIVE';     // 委托生效中(窗口/场景/操作人/剩余额度在消费时实时判定)
const DL_HALTED = 'HALTED';     // 上级凭据作废或签名密钥应急吊销,级联停止
const DL_RECLAIMED = 'RECLAIMED'; // 持有方收回(仅退回未用预占,旧授权立即不可继续使用)
const DL_TERMINAL = new Set([DL_HALTED, DL_RECLAIMED]);

/* 委托授权某时刻的实时可用性:返回 {usable, code, detail}(仅判定,不改状态) */
function delegationUsability(s, d, cert, now) {
  if (d.status === DL_RECLAIMED)
    return { usable: false, code: 'DELEGATION_RECLAIMED', detail: `授权 ${d.id} 未用额度已被收回,旧授权立即失效` };
  if (d.status === DL_HALTED)
    return { usable: false, code: 'DELEGATION_HALTED', detail: d.haltReason === 'KEY_REVOKED'
      ? `授权 ${d.id} 的上级签名密钥已被应急吊销,下级授权同步停止`
      : `授权 ${d.id} 的上级凭据已作废,下级授权同步停止` };
  if (now < d.startsAt)
    return { usable: false, code: 'DELEGATION_NOT_STARTED', detail: `授权 ${d.id} 尚未到生效时间` };
  if (now > d.expiresAt)
    return { usable: false, code: 'DELEGATION_EXPIRED', detail: `授权 ${d.id} 已于 ${new Date(d.expiresAt).toLocaleString()} 到期` };
  if (d.usedCount >= d.quota)
    return { usable: false, code: 'DELEGATION_EXHAUSTED', detail: `本机构授权次数已耗尽(${d.usedCount}/${d.quota})` };
  // 上级凭据池:本授权消费的是「自己已预占」的额度,对账时要把自身剩余预占剔除;
  // 其余 ACTIVE 授权的预占 + 已用不得超过总额(预占模型下不应触发,属并发/篡改的纵深防线)
  if (cert.maxUses != null) {
    const reservedOthers = poolReserved(s, cert) - Math.max(0, d.quota - d.usedCount);
    if (cert.usedCount + reservedOthers >= cert.maxUses)
      return { usable: false, code: 'PARENT_QUOTA_EXHAUSTED', detail: `上级凭据 ${cert.id} 总额度已分配/耗尽(${cert.usedCount}/${cert.maxUses})` };
  }
  return { usable: true };
}

/** 凭据总池中「已预占但尚未被消费/收回」的次数(即各 ACTIVE 授权的剩余配额之和) */
function poolReserved(s, cert) {
  return s.certDelegations
    .filter((d) => d.certId === cert.id && d.status === DL_ACTIVE)
    .reduce((n, d) => n + Math.max(0, d.quota - d.usedCount), 0);
}
/** 凭据总池当前仍可直接核验或继续委托的次数(不限次凭据返回 null) */
function freePool(s, cert) {
  if (cert.maxUses == null) return null;
  return Math.max(0, cert.maxUses - cert.usedCount - poolReserved(s, cert));
}

/** 委托/收回/消费/拒绝审计台账:成功与拒绝均落盘并上同一哈希链 */
function logDelegationAudit(s, tx, fields) {
  const rec = {
    id: tx.nextId('certDelegationLog', 'DLA'),
    seq: s.certDelegationAudit.length + 1,
    at: fields.at || Date.now(),
    kind: fields.kind, // DELEGATE | DELEGATE_DENIED | RECLAIM | RECLAIM_DENIED | CONSUME | CONSUME_DENIED
    action: fields.action, // delegate | reclaim | delegateConsume
    actorId: fields.actorId || null,
    certId: fields.certId || null,
    delegationId: fields.delegationId || null,
    granteeId: fields.granteeId || null,
    outcome: fields.outcome, // SUCCESS | REJECTED
    reasonCode: fields.reasonCode || null,
    reason: fields.reason || null,
    nonce: fields.nonce || null,
    purpose: fields.purpose || null,
    request: fields.request || null,
    ref: fields.ref || null,
    eventSeq: null
  };
  const ev = tx.appendEvent('CERT_DELEGATION_AUDIT', {
    actorId: rec.actorId,
    payload: {
      logId: rec.id, kind: rec.kind, action: rec.action, certId: rec.certId,
      delegationId: rec.delegationId, granteeId: rec.granteeId,
      outcome: rec.outcome, reasonCode: rec.reasonCode, nonce: rec.nonce
    }
  });
  rec.eventSeq = ev.seq;
  s.certDelegationAudit.push(rec);
  return rec;
}

/**
 * 业务事务回滚后,独立事务补登委托/收回拒绝留痕(与有效状态完全隔离,
 * 不读写任何额度),保证「拒绝动作」也进入持久化与审计链。
 */
function logDelegationDeny(fields) {
  return transact((s, tx) => logDelegationAudit(s, tx, { ...fields, outcome: 'REJECTED' }));
}

/** 级联停止一张凭据的全部下级授权(凭据作废时在同一事务调用) */
function haltDelegationsOfCert(s, tx, cert, reasonCode, by) {
  const now = Date.now();
  const rows = s.certDelegations.filter((d) => d.certId === cert.id && d.status === DL_ACTIVE);
  for (const d of rows) {
    d.status = DL_HALTED;
    d.haltedAt = now;
    d.haltReason = reasonCode;
    d.haltBy = by || null;
    tx.appendEvent('CERT_DELEGATION_HALTED', {
      actorId: by || 'SYSTEM',
      payload: { delegationId: d.id, certId: cert.id, granteeId: d.granteeId, reason: reasonCode, unusedQuota: d.quota - d.usedCount }
    });
  }
  return rows;
}

/** 级联停止一把密钥签发的全部凭据的下级授权(密钥应急吊销时在同一事务调用) */
function haltDelegationsOfKey(s, tx, keyId, by) {
  const halted = [];
  for (const cert of s.certificates.filter((c) => c.keyId === keyId && c.status === CERT_ACTIVE)) {
    halted.push(...haltDelegationsOfCert(s, tx, cert, 'KEY_REVOKED', by));
  }
  return halted;
}

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
    // 凭据作废:全部下级授权在同一事务同步停止(HALTED),旧授权立即不能继续查验
    haltDelegationsOfCert(s, tx, cert, 'CERT_REVOKED', actorId);
    return { alreadyRevoked: false, certificate: certView(s, cert) };
  });
}

/* ============================ 在线核验(确定性 + nonce 幂等) ============================
 * 返回 {valid, verdict, code?, ...}。成功(valid)才扣次数并记 CERT_VERIFIED;
 * 失败不扣次数、但结论按 nonce 留存(失败重试返回同一失败结论)。
 */

/**
 * 信封真实性闸(直接核验与委托消费共用):
 * 版本/算法 → 信任锚(应急吊销拒绝、轮换仍受信)→ 签名 → 链锚重算 → 与签发方台账逐字节一致。
 * 任一步失败返回 {ok:false,code,detail};通过返回 {ok:true,claims}。
 */
async function checkEnvelopeAuthenticity(s, envelope, cert) {
  if (!envelope || !envelope.claims || envelope.v !== certCore.CERT_VERSION)
    return { ok: false, code: 'CERT_MALFORMED', detail: '证明信封结构或版本不合法' };
  const c = envelope.claims;
  if (envelope.alg !== certCore.ALG) return { ok: false, code: 'ALGORITHM_UNSUPPORTED', detail: '签名算法不受信' };

  // 信任锚:轮换的旧密钥仍可验真,被应急吊销的密钥拒绝
  const key = s.certKeys.find((k) => k.id === envelope.kid);
  if (!key) return { ok: false, code: 'KEY_NOT_TRUSTED', detail: `未知签名密钥 ${envelope.kid}` };
  if (key.status === KEY_REVOKED) return { ok: false, code: 'KEY_REVOKED', detail: '签名密钥已被应急吊销' };

  const sigOk = await certCore.verifySignature(key.jwkPublic, certCore.signingData(envelope), envelope.sig);
  if (!sigOk) return { ok: false, code: 'PAYLOAD_TAMPERED', detail: '签名校验失败:证明正文被篡改或签名无效' };

  // 链锚:重算锚点哈希,并与实际链上事件逐字段一致(签发时状态 + 链头)。
  const anchorEvent = s.events.find((e) => e.seq === c.ap);
  if (!anchorEvent || anchorEvent.type !== 'CERT_ISSUED' || anchorEvent.payload.certId !== c.id)
    return { ok: false, code: 'CHAIN_ANCHOR_MISMATCH', detail: '证明锚点事件在链上不存在或不匹配' };
  const recomputed = await certCore.chainHashOf({
    seq: c.ap, ts: c.at_t, type: 'CERT_ISSUED',
    receiptId: null, pledgeId: null, actorId: null, payload: anchorEvent.payload, prevHash: c.ph
  });
  if (recomputed !== c.ah || anchorEvent.hash !== c.ah)
    return { ok: false, code: 'CHAIN_ANCHOR_MISMATCH', detail: '锚点哈希与链上事件不一致(签发时状态被改或链断裂)' };
  if (anchorEvent.payload.issuedState !== c.sd)
    return { ok: false, code: 'CHAIN_ANCHOR_MISMATCH', detail: '签发时状态承诺与正文不一致' };

  // 必须命中签发方台账中的同一份证明(防止用真实签名+不同正文拼装)
  if (!cert) return { ok: false, code: 'CERT_NOT_FOUND', detail: '证明未经本签发方登记(可能为伪造或他方证明)' };
  if (cert.envelope.sig !== envelope.sig || cert.snapshotStateDigest !== c.sd)
    return { ok: false, code: 'PAYLOAD_TAMPERED', detail: '证明正文与签发方留存不一致' };
  return { ok: true, claims: c };
}

/**
 * 凭据在线状态闸。
 * 直接第三方核验时校验用途(必须命中凭据限定用途);受托机构消费时用途以「委托场景」为准
 * (持有方在委托中显式授权的场景即该机构的查验范围),故 checkPurpose:false。
 */
function checkCertificateOnline(c, cert, purpose, now, opts = {}) {
  if (now < c.iat) return { ok: false, code: 'NOT_EFFECTIVE_YET', detail: '证明尚未生效' };
  if (now > c.exp) return { ok: false, code: 'CERT_EXPIRED', detail: `证明已于 ${new Date(c.exp).toLocaleString()} 过期` };
  if (opts.checkPurpose !== false && purpose !== c.pu)
    return { ok: false, code: 'PURPOSE_MISMATCH', detail: `核验用途不符:证明限定 ${c.pu},本次声明 ${purpose}` };
  if (cert.status === CERT_REVOKED)
    return { ok: false, code: 'CERT_REVOKED', detail: `证明已被撤销:${cert.revokeReason || ''}(@${cert.revokedAt})` };
  return { ok: true };
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

    const auth = await checkEnvelopeAuthenticity(s, envelope, cert);
    if (!auth.ok) return deny(auth.code, auth.detail);
    const c = auth.claims;
    const online = checkCertificateOnline(c, cert, purpose, now);
    if (!online.ok) return deny(online.code, online.detail);
    // 直接核验只能消费「未委托预占」的剩余总池(委托预占的次数属于各受托机构)
    if (cert.maxUses != null && cert.usedCount + poolReserved(s, cert) >= cert.maxUses)
      return deny('USES_EXHAUSTED', `可用次数已耗尽或已全部委托预占(已用 ${cert.usedCount}/${cert.maxUses},预占 ${poolReserved(s, cert)})`);

    // 全部通过 → 同一事务扣次(并发由 FIFO 串行裁决)
    cert.usedCount += 1;
    const remaining = cert.maxUses == null ? null : cert.maxUses - cert.usedCount;
    const ev = tx.appendEvent('CERT_VERIFIED', {
      payload: { certId, purpose, nonce, usedCount: cert.usedCount, remaining }
    });
    const verdict = {
      id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
      nonce, certId, purpose, actorId: input.verifierId || null,
      delegationId: null, granteeId: null,
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

/* ======================== 机构级额度委托:委托 / 收回 / 受托消费 ======================== */

/**
 * 委托:持有方(签发方)或监管方把凭据总次数的一部分预占给指定合作机构。
 * 幂等:同一 delegateNonce 返回首次授权;只有签发方/监管方可委托;
 * 受托机构必须是平台内金融机构;委托次数只能从当前「未预占」的总池中划出。
 */
function delegateQuota(input) {
  const actorId = input.actorId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '委托主体必填(凭据签发方或监管方)');
  const certId = input.certId;
  if (!certId) throw new DomainError('CERT_ID_REQUIRED', '凭据编号必填');
  const granteeId = input.granteeId;
  if (!granteeId) throw new DomainError('GRANTEE_REQUIRED', '受托合作机构必填');
  let quota = Number(input.quota);
  if (!(Number.isInteger(quota) && quota > 0))
    throw new DomainError('BAD_DELEGATION_QUOTA', '委托次数必须为正整数');
  const operatorIds = [...new Set(input.operatorIds || [])].map(String).filter(Boolean);
  if (!operatorIds.length)
    throw new DomainError('OPERATOR_REQUIRED', '必须设置至少一个允许发起单次操作的操作人');

  return transact((s, tx) => {
    const idemKey = input.delegateNonce ? 'cert-delegate:' + input.delegateNonce : null;
    const reqSnapshot = reqOf(input, ['certId', 'granteeId', 'quota', 'scenario', 'startsAt', 'expiresAt', 'operatorIds']);
    if (idemKey) {
      const hit = s.certDelegationAudit.find((a) => a.nonce === input.delegateNonce && a.kind === 'DELEGATE');
      if (hit) {
        const first = s.certDelegations.find((d) => d.id === hit.delegationId);
        if (first && actorId !== first.issuedBy && actorId !== first.createdBy) {
          const replayActor = s.parties.find((p) => p.id === actorId);
          if (!replayActor || replayActor.type !== 'regulator')
            throw new DomainError('FORBIDDEN', `仅原委托方 ${first.issuedBy} 可重放该委托请求`);
        }
        return { replayed: true, delegation: first ? delegationView(s, first) : null };
      }
    }
    const now = Date.now();
    const cert = s.certificates.find((c) => c.id === certId);
    const denyAll = (code, reason) =>
      denyDelegate(s, tx, { input, actorId, certId, granteeId, nonce: input.delegateNonce || null, code, reason, reqSnapshot, at: now });

    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || !['financer', 'regulator'].includes(actor.type))
      return denyAll('FORBIDDEN', '仅凭据签发方(金融机构)或监管方可委托查验额度');
    if (!cert) return denyAll('CERT_NOT_FOUND', `凭据 ${certId} 不存在于签发方台账`);
    if (actor.type === 'financer' && cert.issuedBy !== actorId)
      return denyAll('FORBIDDEN', `仅凭据签发方 ${cert.issuedBy} 可对外委托其查验额度,${actorId} 不是持有方`);
    const grantee = s.parties.find((p) => p.id === granteeId);
    if (!grantee || grantee.type !== 'financer')
      return denyAll('BAD_GRANTEE', `受托机构 ${granteeId} 不存在或不是合作金融机构`);
    if (granteeId === cert.issuedBy)
      return denyAll('BAD_GRANTEE', '受托机构不能是凭据签发方本人(本人可直接核验)');
    if (cert.status === CERT_REVOKED)
      return denyAll('CERT_REVOKED', `凭据 ${certId} 已作废,不能新增委托`);
    const scenario = input.scenario || cert.purpose;
    if (!certCore.PURPOSES.some((p) => p.code === scenario))
      return denyAll('BAD_PURPOSE', `业务场景 ${scenario} 不合法`);

    let startsAt = input.startsAt ? Number(input.startsAt) : now;
    let expiresAt = input.expiresAt ? Number(input.expiresAt) : cert.expiresAt;
    if (!(Number.isFinite(startsAt) && Number.isFinite(expiresAt)) || expiresAt <= startsAt)
      return denyAll('BAD_DELEGATION_WINDOW', '委托起止时间不合法(结束必须晚于开始)');
    if (expiresAt > cert.expiresAt)
      return denyAll('WINDOW_EXCEEDS_CERT', `委托结束时间不得晚于凭据到期时间 ${cert.expiresAt}`);
    if (expiresAt <= now)
      return denyAll('DELEGATION_EXPIRED', '委托结束时间已过,不能新增授权');

    if (cert.maxUses == null)
      return denyAll('PARENT_UNLIMITED', '不限次凭据无需委托额度(受托机构可直接使用凭据)');
    const avail = freePool(s, cert);
    if (quota > avail)
      return denyAll('DELEGATION_QUOTA_EXCEEDED',
        `委托 ${quota} 次超过上级凭据可分配余量 ${avail}(总额 ${cert.maxUses},已用 ${cert.usedCount},其他授权已预占 ${poolReserved(s, cert)})`);

    const id = tx.nextId('certDelegation', 'DL');
    const d = {
      id,
      certId,
      issuedBy: cert.issuedBy,
      granteeId,
      scenario,
      startsAt,
      expiresAt,
      operatorIds,
      quota,
      usedCount: 0,
      status: DL_ACTIVE,
      createdAt: now,
      createdBy: actorId,
      reclaimedAt: null,
      reclaimedBy: null,
      haltedAt: null,
      haltReason: null,
      haltBy: null,
      note: input.note || null
    };
    s.certDelegations.push(d);

    tx.appendEvent('CERT_QUOTA_DELEGATED', {
      actorId,
      payload: {
        delegationId: id, certId, granteeId, scenario,
        startsAt, expiresAt, operatorIds, quota,
        parentMaxUses: cert.maxUses, parentUsedCount: cert.usedCount,
        parentReservedAfter: poolReserved(s, cert)
      }
    });
    logDelegationAudit(s, tx, {
      kind: 'DELEGATE', action: 'delegate', actorId, certId, delegationId: id, granteeId,
      outcome: 'SUCCESS', nonce: input.delegateNonce || null, purpose: scenario,
      request: reqSnapshot, at: now,
      ref: { delegationId: id, quota, remaining: quota, status: DL_ACTIVE }
    });
    return { replayed: false, delegation: delegationView(s, d) };
  });
}

/**
 * 收回:仅签发方/监管方可收回;未用预占退回凭据总池,已用量不退回;
 * 授权即刻 RECLAIMED,旧授权的消费请求立即被拒绝。幂等(同一 reclaimNonce)。
 */
function reclaimDelegation(input) {
  const actorId = input.actorId;
  if (!actorId) throw new DomainError('ACTOR_REQUIRED', '收回主体必填');
  const delegationId = input.delegationId;
  if (!delegationId) throw new DomainError('DELEGATION_ID_REQUIRED', '授权编号必填');
  const idemKey = input.reclaimNonce ? 'cert-reclaim:' + input.reclaimNonce : null;
  const reqSnapshot = reqOf(input, ['delegationId', 'reason']);

  return transact((s, tx) => {
    if (idemKey) {
      const hit = s.certDelegationAudit.find((a) => a.nonce === input.reclaimNonce && a.kind === 'RECLAIM');
      if (hit) {
        const first = s.certDelegations.find((d) => d.id === hit.delegationId);
        if (first && actorId !== first.issuedBy && actorId !== first.reclaimedBy) {
          const actor = s.parties.find((p) => p.id === actorId);
          if (!actor || actor.type !== 'regulator')
            throw new DomainError('FORBIDDEN', `仅原收回方 ${first.reclaimedBy} 可重放该收回请求`);
        }
        return { replayed: true, delegation: first ? delegationView(s, first) : null, returned: 0 };
      }
    }
    const now = Date.now();
    const d = s.certDelegations.find((x) => x.id === delegationId);
    const cert = d ? s.certificates.find((c) => c.id === d.certId) : null;
    const denyAll = (code, reason) =>
      denyDelegate(s, tx, { input, actorId, certId: cert ? cert.id : null, delegationId, granteeId: d ? d.granteeId : null,
        nonce: input.reclaimNonce || null, code, reason, reqSnapshot, at: now, action: 'reclaim',
        deniedKind: 'RECLAIM_DENIED' });

    const actor = s.parties.find((p) => p.id === actorId);
    if (!actor || !['financer', 'regulator'].includes(actor.type))
      return denyAll('FORBIDDEN', '仅凭据签发方(金融机构)或监管方可收回委托额度');
    if (!d) return denyAll('DELEGATION_NOT_FOUND', `授权 ${delegationId} 不存在`);
    if (actor.type === 'financer' && d.issuedBy !== actorId)
      return denyAll('FORBIDDEN', `仅委托方 ${d.issuedBy} 可收回授权 ${delegationId}`);

    // 审批(消费确认)与收回同时到达只能形成一个终态:FIFO 串行下先到者落终态,
    // 后到的收回看到 RECLAIMED/HALTED 明确返回该终态,不再变更任何额度。
    if (d.status === DL_RECLAIMED)
      return { replayed: false, alreadyTerminal: true, delegation: delegationView(s, d), returned: 0 };
    if (d.status === DL_HALTED)
      return denyAll('DELEGATION_HALTED', `授权 ${delegationId} 已因 ${d.haltReason} 停止,无需收回`);

    const returned = d.quota - d.usedCount; // 仅未用预占退回(自动生效:预占计数只统计 ACTIVE 授权)
    d.status = DL_RECLAIMED;
    d.reclaimedAt = now;
    d.reclaimedBy = actorId;
    d.reclaimReason = input.reason || '委托方收回未用额度';

    tx.appendEvent('CERT_QUOTA_RECLAIMED', {
      actorId,
      payload: {
        delegationId, certId: d.certId, granteeId: d.granteeId,
        quota: d.quota, usedCount: d.usedCount, returned,
        parentFreePoolAfter: freePool(s, cert)
      }
    });
    logDelegationAudit(s, tx, {
      kind: 'RECLAIM', action: 'reclaim', actorId, certId: d.certId, delegationId: d.id, granteeId: d.granteeId,
      outcome: 'SUCCESS', nonce: input.reclaimNonce || null, request: reqSnapshot, at: now,
      ref: { delegationId: d.id, status: DL_RECLAIMED, returned, usedCount: d.usedCount }
    });
    return { replayed: false, alreadyTerminal: false, delegation: delegationView(s, d), returned };
  });
}

/**
 * 受托机构消费授权额度(在线查验)。
 * 必填:delegationId、granteeId(须为受托机构本人)、operatorId(须在白名单)、
 * purpose(须与委托场景一致)、nonce(同流水重放返回第一次裁决)。
 * 可选 envelope:携带则同时执行完整密码学/链锚/正文校验;不携带则按签发方台账在线判定。
 * 成功时同一事务同时扣「本授权次数」与「父凭据总次数」,两层均不得超扣。
 */
function consumeDelegated(input) {
  const nonce = input.nonce;
  if (!nonce) throw new DomainError('VERIFY_NONCE_REQUIRED', '受托查验必须携带一次性业务流水 nonce(失败重试携带同一 nonce)');
  const delegationId = input.delegationId;
  if (!delegationId) throw new DomainError('DELEGATION_ID_REQUIRED', '授权编号必填');
  const purpose = input.purpose;
  if (!purpose) throw new DomainError('PURPOSE_REQUIRED', '必须声明本次业务场景');

  return transact(async (s, tx) => {
    const prev = s.certificateVerifications.find((v) => v.nonce === nonce);
    if (prev) {
      return {
        replayed: true,
        valid: prev.valid,
        code: prev.code || null,
        verdict: prev,
        note: '相同业务流水重放:返回第一次裁决,额度不重复消耗'
      };
    }

    const now = Date.now();
    const d = s.certDelegations.find((x) => x.id === delegationId);
    const cert = d ? s.certificates.find((c) => c.id === d.certId) : null;
    const granteeId = input.granteeId || (d ? d.granteeId : null);
    const deny = (code, detail) =>
      recordDelegatedVerdict(s, tx, {
        nonce, purpose, certId: cert ? cert.id : null, delegationId: d ? d.id : delegationId,
        granteeId, actorId: granteeId, code, detail, now, request: reqOf(input,
          ['delegationId', 'granteeId', 'operatorId', 'purpose'])
      });

    if (!d) return deny('DELEGATION_NOT_FOUND', `授权 ${delegationId} 不存在`);
    if (!cert) return deny('CERT_NOT_FOUND', `授权指向的凭据 ${d.certId} 不存在`);

    // 越权机构:只有受托机构本人可消费自己的额度
    if (!input.granteeId || input.granteeId !== d.granteeId)
      return deny('FORBIDDEN', `仅受托机构 ${d.granteeId} 可消费授权 ${delegationId},${input.granteeId || '未知主体'} 无权使用`);
    // 单次操作人限制:操作人必须在委托时设置的白名单内
    if (!input.operatorId || !d.operatorIds.map(String).includes(String(input.operatorId)))
      return deny('OPERATOR_FORBIDDEN', `操作人 ${input.operatorId || '(空)'} 不在授权允许的操作人白名单内`);

    // 授权状态 + 时间窗 + 本授权剩余 + 上级总池
    const usable = delegationUsability(s, d, cert, now);
    if (!usable.usable) return deny(usable.code, usable.detail);

    // 业务场景必须与委托场景一致(错误场景拒绝,不扣次)
    if (purpose !== d.scenario)
      return deny('SCENARIO_MISMATCH', `业务场景不符:本授权限定 ${d.scenario},本次声明 ${purpose}`);

    // 凭据本体闸:可选信封走完整密码学校验;无信封则按签发方台账信封在线判定
    const envelope = input.envelope != null
      ? (typeof input.envelope === 'string' ? safeJson(input.envelope) : input.envelope)
      : cert.envelope;
    if (input.envelope != null && envelope == null)
      return deny('CERT_MALFORMED', '证明不是合法 JSON');
    if (envelope.claims && envelope.claims.id !== cert.id)
      return deny('CERT_NOT_FOUND', `授权 ${delegationId} 仅对应凭据 ${cert.id},信封指向其他证明`);
    const auth = await checkEnvelopeAuthenticity(s, envelope, cert);
    if (!auth.ok) return deny(auth.code, auth.detail);
    // 受托消费的用途以委托场景为准(上面已做 SCENARIO_MISMATCH 闸),此处不套凭据自身用途
    const online = checkCertificateOnline(auth.claims, cert, purpose, now, { checkPurpose: false });
    if (!online.ok) return deny(online.code, online.detail);

    // 全部通过 → 同一事务双层扣次:FIFO 串行裁决并发争抢,本授权与总池均不超扣
    d.usedCount += 1;
    cert.usedCount += 1;
    const remaining = d.quota - d.usedCount;
    const parentRemaining = cert.maxUses == null ? null : cert.maxUses - cert.usedCount;
    const ev = tx.appendEvent('CERT_DELEGATED_VERIFIED', {
      actorId: d.granteeId,
      payload: {
        delegationId: d.id, certId: cert.id, granteeId: d.granteeId, operatorId: String(input.operatorId),
        purpose, nonce, delegationUsedCount: d.usedCount, delegationRemaining: remaining,
        parentUsedCount: cert.usedCount, parentRemaining
      }
    });
    const verdict = {
      id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
      nonce, certId: cert.id, purpose, actorId: d.granteeId,
      delegationId: d.id, granteeId: d.granteeId, operatorId: String(input.operatorId),
      valid: true, code: null, detail: '受托机构查验通过',
      at: now, eventSeq: ev.seq,
      usedCount: cert.usedCount, remaining: parentRemaining,
      delegationUsedCount: d.usedCount, delegationRemaining: remaining
    };
    s.certificateVerifications.push(verdict);
    logDelegationAudit(s, tx, {
      kind: 'CONSUME', action: 'delegateConsume', actorId: d.granteeId, certId: cert.id,
      delegationId: d.id, granteeId: d.granteeId, outcome: 'SUCCESS', nonce, purpose, at: now,
      request: reqOf(input, ['delegationId', 'granteeId', 'operatorId', 'purpose']),
      ref: { delegationRemaining: remaining, parentRemaining, eventSeq: ev.seq }
    });
    return { replayed: false, valid: true, verdict, delegation: delegationView(s, d) };
  });
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

/** 委托/收回被拒:业务事务内直接落拒绝台账并上链(不抛错 → 不回滚,返回 200 裁决) */
function denyDelegate(s, tx, ctx) {
  const action = ctx.action || 'delegate';
  const rec = logDelegationAudit(s, tx, {
    kind: ctx.deniedKind || 'DELEGATE_DENIED',
    action,
    actorId: ctx.actorId,
    certId: ctx.certId || null,
    delegationId: ctx.delegationId || null,
    granteeId: ctx.granteeId || null,
    outcome: 'REJECTED',
    reasonCode: ctx.code,
    reason: ctx.reason,
    nonce: ctx.nonce || null,
    request: ctx.reqSnapshot || null,
    at: ctx.at
  });
  return { rejected: true, code: ctx.code, detail: ctx.reason, auditId: rec.id };
}

/** 受托消费被拒:失败结论按 nonce 持久化(失败重试返回同一结论),并同步进入委托审计链 */
function recordDelegatedVerdict(s, tx, v) {
  const rec = {
    id: 'VF' + String(s.certificateVerifications.length + 1).padStart(4, '0'),
    nonce: v.nonce,
    certId: v.certId,
    purpose: v.purpose,
    actorId: v.actorId || null,
    delegationId: v.delegationId || null,
    granteeId: v.granteeId || null,
    valid: false,
    code: v.code,
    detail: v.detail,
    at: v.now || Date.now(),
    eventSeq: null,
    usedCount: null,
    remaining: null
  };
  s.certificateVerifications.push(rec);
  logDelegationAudit(s, tx, {
    kind: 'CONSUME_DENIED', action: 'delegateConsume', actorId: v.actorId || null,
    certId: v.certId, delegationId: v.delegationId, granteeId: v.granteeId,
    outcome: 'REJECTED', reasonCode: v.code, reason: v.detail, nonce: v.nonce, purpose: v.purpose,
    at: rec.at, request: v.request || null
  });
  return { replayed: false, valid: false, code: v.code, detail: v.detail, verdict: rec };
}

/** 仅保留审计允许落盘的请求字段 */
function reqOf(input, fields) {
  const out = {};
  for (const f of fields) if (input[f] !== undefined) out[f] = input[f];
  return out;
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
    // 密钥紧急停用:该密钥签发凭据的全部下级授权在同一事务同步停止(HALTED)
    const halted = haltDelegationsOfKey(s, tx, keyId, actorId);
    return { alreadyRevoked: false, key: publicKeyView(key), haltedDelegations: halted.map((d) => d.id) };
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
  const reserved = poolReserved(s, cert);
  const free = freePool(s, cert);
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
    reservedCount: reserved, // 已委托给下级机构、尚未消费的预占次数
    delegatableRemaining: free, // 仍可继续委托或直接核验的次数
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

/* ============================ 委托视图 / 额度树 / 审计查询 ============================ */
function delegationView(s, d) {
  const grantee = s.parties.find((p) => p.id === d.granteeId);
  const issuer = s.parties.find((p) => p.id === d.issuedBy);
  const cert = s.certificates.find((c) => c.id === d.certId);
  const now = Date.now();
  const live = delegationUsability(s, d, cert || { maxUses: null, usedCount: 0 }, now);
  let effectiveStatus = d.status;
  if (d.status === DL_ACTIVE) {
    if (now < d.startsAt) effectiveStatus = 'PENDING_START';
    else if (now > d.expiresAt) effectiveStatus = 'EXPIRED';
    else if (d.usedCount >= d.quota) effectiveStatus = 'EXHAUSTED';
  }
  return {
    id: d.id,
    certId: d.certId,
    issuedBy: d.issuedBy,
    issuedByName: issuer ? issuer.name : d.issuedBy,
    granteeId: d.granteeId,
    granteeName: grantee ? grantee.name : d.granteeId,
    scenario: d.scenario,
    scenarioName: (certCore.PURPOSES.find((p) => p.code === d.scenario) || {}).name || d.scenario,
    startsAt: d.startsAt,
    expiresAt: d.expiresAt,
    operatorIds: d.operatorIds,
    quota: d.quota,
    usedCount: d.usedCount,
    remaining: Math.max(0, d.quota - d.usedCount),
    status: d.status, // 持久状态 ACTIVE / HALTED / RECLAIMED
    effectiveStatus, // 叠加时间窗/耗尽后的实时状态
    usableNow: live.usable,
    unusableCode: live.usable ? null : live.code,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    reclaimedAt: d.reclaimedAt,
    reclaimedBy: d.reclaimedBy,
    reclaimReason: d.reclaimReason || null,
    haltedAt: d.haltedAt,
    haltReason: d.haltReason,
    note: d.note,
    certPurpose: cert ? cert.purpose : null,
    certStatus: cert ? cert.status : null,
    certExpiresAt: cert ? cert.expiresAt : null
  };
}

function queryDelegations(filter = {}) {
  const s = getState();
  let list = [...s.certDelegations];
  if (filter.certId) list = list.filter((d) => d.certId === filter.certId);
  if (filter.granteeId) list = list.filter((d) => d.granteeId === filter.granteeId);
  if (filter.issuedBy) list = list.filter((d) => d.issuedBy === filter.issuedBy);
  if (filter.status) list = list.filter((d) => d.status === filter.status);
  if (filter.usable === 'true' || filter.usable === true) {
    const now = Date.now();
    list = list.filter((d) => {
      const cert = s.certificates.find((c) => c.id === d.certId);
      return cert && delegationUsability(s, d, cert, now).usable;
    });
  }
  return list.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).map((d) => delegationView(s, d));
}

function queryDelegationAudit(filter = {}) {
  const s = getState();
  let list = [...s.certDelegationAudit];
  if (filter.certId) list = list.filter((a) => a.certId === filter.certId);
  if (filter.delegationId) list = list.filter((a) => a.delegationId === filter.delegationId);
  if (filter.granteeId) list = list.filter((a) => a.granteeId === filter.granteeId);
  if (filter.actorId) list = list.filter((a) => a.actorId === filter.actorId);
  if (filter.kind) list = list.filter((a) => a.kind === filter.kind);
  if (filter.outcome) list = list.filter((a) => a.outcome === filter.outcome);
  return list.sort((a, b) => a.seq - b.seq).map((a) => ({
    ...a,
    actorName: (s.parties.find((p) => p.id === a.actorId) || {}).name || a.actorId,
    granteeName: (s.parties.find((p) => p.id === a.granteeId) || {}).name || a.granteeId
  }));
}

/**
 * 监管端:按父级凭据查看完整额度树。
 * 父节点(凭据总额/已用/预占/可分配/剩余)→ 各受托机构授权节点(配额/已用/剩余/状态/窗口/操作人)
 * 另附严格按序事件(委托/消费/收回/拒绝/级联停止),并对账「已用 + 预占 ≤ 总额」。
 */
function quotaTree(certId) {
  const s = getState();
  const cert = s.certificates.find((c) => c.id === certId);
  if (!cert) throw new DomainError('CERT_NOT_FOUND', `凭据 ${certId} 不存在`);
  const now = Date.now();
  const nodes = s.certDelegations
    .filter((d) => d.certId === certId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((d) => delegationView(s, d));
  const used = cert.usedCount;
  const reserved = poolReserved(s, cert);
  const eventTypes = new Set([
    'CERT_QUOTA_DELEGATED', 'CERT_DELEGATED_VERIFIED', 'CERT_QUOTA_RECLAIMED',
    'CERT_DELEGATION_HALTED', 'CERT_DELEGATION_AUDIT'
  ]);
  const events = s.events
    .filter((e) => eventTypes.has(e.type) && (e.payload.certId === certId || nodes.some((n) => n.id === e.payload.delegationId)))
    .map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actorId: e.actorId, payload: e.payload, hash: e.hash }))
    .sort((a, b) => a.seq - b.seq);
  const maxUses = cert.maxUses;
  return {
    certId,
    issuedBy: cert.issuedBy,
    issuedByName: (s.parties.find((p) => p.id === cert.issuedBy) || {}).name || cert.issuedBy,
    purpose: cert.purpose,
    expiresAt: cert.expiresAt,
    status: cert.status,
    parent: {
      maxUses,
      usedCount: used,
      reservedCount: reserved,
      delegatableRemaining: freePool(s, cert),
      totalRemaining: maxUses == null ? null : Math.max(0, maxUses - used)
    },

    delegations: nodes,
    events,
    reconciliation: {
      withinLimit: maxUses == null ? true : used + reserved <= maxUses + 1e-6,
      sumDelegationUsed: nodes.reduce((n, d) => n + d.usedCount, 0),
      sumActiveQuotaRemaining: nodes.filter((d) => d.status === DL_ACTIVE).reduce((n, d) => n + d.remaining, 0),
      checkedAt: now
    }
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
  if (filter.delegationId) list = list.filter((v) => v.delegationId === filter.delegationId);
  if (filter.granteeId) list = list.filter((v) => v.granteeId === filter.granteeId);
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
      active: s.certDelegations.filter((d) => d.status === DL_ACTIVE).length,
      halted: s.certDelegations.filter((d) => d.status === DL_HALTED).length,
      reclaimed: s.certDelegations.filter((d) => d.status === DL_RECLAIMED).length,
      consumed: s.certDelegations.reduce((n, d) => n + d.usedCount, 0),
      reserved: s.certificates.reduce((n, c) => n + poolReserved(s, c), 0),
      auditTotal: s.certDelegationAudit.length,
      auditDenied: s.certDelegationAudit.filter((a) => a.outcome !== 'SUCCESS').length,
      // 对账:任一凭据「已用 + 活跃预占」不得超过其总次数(并发超扣会在此暴露)
      overbooked: s.certificates
        .filter((c) => c.maxUses != null && c.usedCount + poolReserved(s, c) > c.maxUses + 1e-6)
        .map((c) => ({ certId: c.id, maxUses: c.maxUses, usedCount: c.usedCount, reserved: poolReserved(s, c) }))
    }
  };
}

module.exports = {
  issueCertificate,
  revokeCertificate,
  verifyCertificateOnline,
  delegateQuota,
  reclaimDelegation,
  consumeDelegated,
  queryDelegations,
  queryDelegationAudit,
  quotaTree,
  rotateKey,
  revokeKey,
  listKeys,
  trustAnchors,
  queryCertificates,
  queryVerifications,
  certificateAudit,
  logDelegationDeny,
  buildSnapshot
};
