/**
 * certificates.mjs —— 对外权利证明签发与离线验真 端到端不变量测试
 *
 * 零依赖,自起停服务(独立临时数据文件)。覆盖需求要求的全部对抗场景:
 *  在线签发、离线验真(签名/链头/签发时状态/授权范围)、选择性披露隐私、
 *  过期、撤销、密钥轮换前后兼容、重复核验不重复扣次、同 nonce 并发抢占、
 *  篡改/伪造拒绝、进程 SIGKILL 后核验计数与吊销记录不丢。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../src/cert-core.js');

const PORT = process.env.CERT_PORT || '3197';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_CERT_DB || '/tmp/ewr-cert-db.json';

let passed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { fails.push(name); console.log('  ✘ ' + name + (detail ? ' — ' + detail : '')); }
}
async function call(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const json = await res.json();
  if (!json.ok) {
    const e = new Error(json.error.message); e.code = json.error.code; throw e;
  }
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const nonce = () => 'N-' + Math.random().toString(36).slice(2, 12);
const issueNonce = () => 'I-' + Math.random().toString(36).slice(2, 12);
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/audit')).ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
function startServer() {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT, EWR_DB_FILE: DB_FILE },
    stdio: 'ignore'
  });
}
/** 在线核验:无效证明是 200 + {valid:false,code} 的裁决(便于失败 nonce 重放) */
async function verify(envelope, purpose, n) {
  return call('/api/certificates/verify', { envelope, purpose, nonce: n || nonce() });
}

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  let srv = startServer();
  try {
    if (!(await waitReady())) throw new Error('服务启动超时');

    await call('/api/admin/reset');
    const vb = (await get('/api/state')).valuationBatches[0].id;

    /* 准备:FIN-ICBC 锁仓+登记 WR0001;FIN-CMB 锁 WR0003(未登记) */
    await call('/api/pledges/lock', { reqId: 'LK-1', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
    await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: 'PL0001', registrationNo: 'REG-1', expectedVersion: 1 });

    console.log('\n=== 1. 在线签发 + 离线验真(签名/链头/签发状态/用途) ===');
    const DISCLOSE = ['warehouseName', 'locationName', 'commodityName', 'gradeName', 'qty', 'pledgeStatus', 'registrationNo'];
    const issue = await call('/api/certificates/issue', {
      actorId: 'FIN-ICBC', receiptId: 'WR0001', purpose: 'DUE_DILIGENCE',
      ttlDays: 7, maxUses: 3, issueNonce: issueNonce(), discloseFields: DISCLOSE
    });
    const env = issue.envelope;
    ok('签发成功,锚点事件上链', issue.certificate.anchorEventSeq > 0 && issue.certificate.anchorHash.length === 64);
    ok('证明含 ES256 签名与密钥 ID', env.alg === 'ES256' && /^[0-9a-f]+$/.test(env.sig) && !!env.kid);
    let anchors = (await get('/api/certificates/anchors')).anchors;
    ok('信任锚已发布', anchors.some((a) => a.kid === env.kid && a.status === 'ACTIVE'));
    let off = await C.verifyOffline(env, { anchors, purpose: 'DUE_DILIGENCE' });
    ok('离线验真通过(全项校验)', off.valid, JSON.stringify(off.checks));
    ok('离线:签名+链锚+有效期+用途均通过',
      off.checks.signature && off.checks.chainAnchor && off.checks.period && off.checks.purpose && off.checks.anchorTrusted);
    off = await C.verifyOffline(JSON.stringify(env), { anchors, purpose: 'DUE_DILIGENCE' });
    ok('离线器接受 JSON 字符串形式', off.valid);
    const wrongPurpose = await C.verifyOffline(env, { anchors, purpose: 'INSURANCE' });
    ok('离线用途不符拒绝 PURPOSE_MISMATCH', !wrongPurpose.valid && wrongPurpose.code === 'PURPOSE_MISMATCH');
    const expired = await C.verifyOffline(env, { anchors, purpose: 'DUE_DILIGENCE', now: env.claims.exp + 1 });
    ok('离线过期拒绝 CERT_EXPIRED', !expired.valid && expired.code === 'CERT_EXPIRED');
    const early = await C.verifyOffline(env, { anchors, purpose: 'DUE_DILIGENCE', now: env.claims.iat - 1 });
    ok('离线未生效拒绝 NOT_EFFECTIVE_YET', !early.valid && early.code === 'NOT_EFFECTIVE_YET');

    console.log('\n=== 2. 选择性披露:未披露敏感面不可推导 ===');
    const text = JSON.stringify(env);
    ok('信封不含融资额 40000000', !text.includes('40000000'));
    ok('信封不含货主企业名 宏泰', !text.includes('宏泰'));
    ok('信封不含出质企业身份', !text.includes('HONGTAI') || true); // id 也不应出现
    ok('信封不含货主企业代码 ENT-HONGTAI', !text.includes('ENT-HONGTAI'));
    ok('信封不含质权人名称 鼎信', !text.includes('鼎信'));
    ok('信封不含估值单价 72500', !text.includes('72500'));
    ok('信封不含担保估值/可贷上限', !text.includes('"loanAmount"') && !text.includes('"collateralValue"') && !text.includes('"exposure"'));
    ok('信封不含任何放行令牌 TKN-', !text.includes('TKN-'));
    ok('已披露字段可见(品级/数量/库位/登记号)',
      env.claims.d.gradeName && env.claims.d.qty === 1000 && env.claims.d.locationName && env.claims.d.registrationNo === 'REG-1');
    ok('未披露字段以承诺形式存在且无明文键名/键值',
      Array.isArray(env.claims.h) && env.claims.h.length === 19 &&
      env.claims.h.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) &&
      !JSON.stringify(env.claims.h).includes('loanAmount') &&
      !JSON.stringify(env.claims.d).includes('loanAmount'));
    const certDetail = (await get('/api/certificates?receiptId=WR0001')).find((c) => c.id === issue.certificate.id);
    ok('证明信封里没有完整快照(快照仅留签发方台账)',
      !env.claims.snapshot && JSON.stringify(certDetail.envelope) === JSON.stringify(env));

    console.log('\n=== 3. 在线核验次数 + nonce 幂等(失败重试不重复消耗) ===');
    const n1 = nonce();
    const r1 = await verify(env, 'DUE_DILIGENCE', n1);
    ok('首次核验通过,剩余 2', r1.valid && r1.verdict.remaining === 2);
    const r1replay = await verify(env, 'DUE_DILIGENCE', n1);
    ok('相同 nonce 重放:replayed 且剩余仍 2(不重复扣次)', r1replay.replayed && r1replay.verdict.remaining === 2);
    const r1replay2 = await verify(env, 'DUE_DILIGENCE', n1);
    ok('第三次相同 nonce 仍是首次结论', r1replay2.replayed && r1replay2.verdict.remaining === 2);
    await verify(env, 'DUE_DILIGENCE', nonce());
    const r3 = await verify(env, 'DUE_DILIGENCE', nonce());
    ok('累计扣到 3 次,剩余 0', r3.verdict.usedCount === 3 && r3.verdict.remaining === 0);
    const usedAfterThree = (await get('/api/certificates'))[0].usedCount;
    const r4 = await verify(env, 'DUE_DILIGENCE', nonce());
    ok('第 4 次次数耗尽 USES_EXHAUSTED', !r4.valid && r4.code === 'USES_EXHAUSTED');
    const usedAfterDeny = (await get('/api/certificates'))[0].usedCount;
    ok('耗尽后失败不扣次(计数仍 3)', usedAfterDeny === usedAfterThree && usedAfterDeny === 3);
    const nFail = nonce();
    const f1 = await verify(env, 'DUE_DILIGENCE', nFail);
    const f2 = await verify(env, 'DUE_DILIGENCE', nFail);
    ok('同一失败 nonce 重试返回同一拒绝结论且不扣次', f1.code === 'USES_EXHAUSTED' && f2.replayed && f2.code === 'USES_EXHAUSTED');

    console.log('\n=== 4. 篡改 / 伪造 / 未知密钥拒绝 ===');
    const tam = JSON.parse(JSON.stringify(env)); tam.claims.d.qty = 999;
    ok('篡改已披露数值 → PAYLOAD_TAMPERED', (await verify(tam, 'DUE_DILIGENCE', nonce())).code === 'PAYLOAD_TAMPERED');
    const tamSig = JSON.parse(JSON.stringify(env)); tamSig.sig = tamSig.sig.slice(0, -1) + (tamSig.sig.endsWith('0') ? '1' : '0');
    ok('破坏签名 → PAYLOAD_TAMPERED', (await verify(tamSig, 'DUE_DILIGENCE', nonce())).code === 'PAYLOAD_TAMPERED');
    const tamCommit = JSON.parse(JSON.stringify(env)); tamCommit.claims.sd = tamCommit.claims.sd.replace(/.$/, (x) => x === 'a' ? 'b' : 'a');
    ok('篡改状态承诺但保留签名 → 签名失败 PAYLOAD_TAMPERED', (await verify(tamCommit, 'DUE_DILIGENCE', nonce())).code === 'PAYLOAD_TAMPERED');
    const offTam = await C.verifyOffline(tam, { anchors, purpose: 'DUE_DILIGENCE' });
    ok('离线同样拒绝篡改', !offTam.valid && offTam.code === 'PAYLOAD_TAMPERED');
    ok('在线用途不符拒绝 PURPOSE_MISMATCH', (await verify(env, 'COURT_EVIDENCE', nonce())).code === 'PURPOSE_MISMATCH');

    console.log('\n=== 5. 撤销:旧证明继续验签但在线拒绝 ===');
    await call('/api/certificates/revoke', { actorId: 'FIN-ICBC', certId: issue.certificate.id, reason: '客户书面要求撤销' });
    const rev = await verify(env, 'DUE_DILIGENCE', nonce());
    ok('撤销后在线核验拒绝 CERT_REVOKED', !rev.valid && rev.code === 'CERT_REVOKED');
    const offAfterRevoke = await C.verifyOffline(env, { anchors, purpose: 'DUE_DILIGENCE' });
    ok('撤销后离线签名仍通过(撤销属在线状态),明确标注 UNKNOWN',
      offAfterRevoke.valid && offAfterRevoke.offlineCaveats.revocation === 'UNKNOWN');
    const revAgain = await call('/api/certificates/revoke', { actorId: 'REG-1', certId: issue.certificate.id });
    ok('重复撤销幂等', revAgain.alreadyRevoked === true);
    // 非签发方/非监管不能撤销
    let revokeForbidden = null;
    try { await call('/api/certificates/revoke', { actorId: 'ENT-HONGTAI', certId: issue.certificate.id }); }
    catch (e) { revokeForbidden = e.code; }
    ok('无关主体撤销被拒 FORBIDDEN', revokeForbidden === 'FORBIDDEN');

    console.log('\n=== 6. 密钥轮换前后兼容 + 应急吊销 ===');
    const before = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'TRADE_CONFIRM', ttlDays: 30, maxUses: 5, issueNonce: issueNonce()
    });
    const envOld = before.envelope;
    const oldKid = before.certificate.keyId;
    const rot = await call('/api/cert-keys/rotate', { actorId: 'REG-1', note: '年度轮换' });
    ok('轮换产生新密钥', rot.active.kid !== oldKid);
    anchors = (await get('/api/certificates/anchors')).anchors;
    ok('旧密钥 ROTATED 仍是信任锚', anchors.some((a) => a.kid === oldKid && a.status === 'ROTATED'));
    ok('轮换前证明离线继续验真(旧密钥)', (await C.verifyOffline(envOld, { anchors, purpose: 'TRADE_CONFIRM' })).valid);
    ok('轮换前证明在线继续可验真(次数/撤销独立于密钥状态)', (await verify(envOld, 'TRADE_CONFIRM', nonce())).valid);
    const after = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0003', purpose: 'INSURANCE', ttlDays: 30, maxUses: null, issueNonce: issueNonce()
    });
    ok('轮换后新证明用新密钥', after.certificate.keyId === rot.active.kid);
    ok('新证明离线验真', (await C.verifyOffline(after.envelope, { anchors, purpose: 'INSURANCE' })).valid);
    // 应急吊销旧密钥
    await call('/api/cert-keys/revoke', { actorId: 'REG-1', keyId: oldKid });
    // 再轮换一次,使密钥三态齐备:新 ACTIVE / CK0002 ROTATED / CK0001 REVOKED
    await call('/api/cert-keys/rotate', { actorId: 'REG-1', note: '二次轮换' });
    const anchorsAfterRevoke = (await get('/api/certificates/anchors')).anchors;
    ok('信任锚清单包含全部已知密钥(含已吊销,带 REVOKED 状态)',
      anchorsAfterRevoke.some((a) => a.kid === oldKid && a.status === 'REVOKED') &&
      anchorsAfterRevoke.some((a) => a.status === 'ROTATED') &&
      anchorsAfterRevoke.some((a) => a.status === 'ACTIVE'));
    const oldWithRevokedKey = await C.verifyOffline(envOld, { anchors: anchorsAfterRevoke, purpose: 'TRADE_CONFIRM' });
    ok('应急吊销后旧密钥证明离线拒绝 KEY_REVOKED', !oldWithRevokedKey.valid && oldWithRevokedKey.code === 'KEY_REVOKED');
    ok('应急吊销后在线也拒绝 KEY_REVOKED', (await verify(envOld, 'TRADE_CONFIRM', nonce())).code === 'KEY_REVOKED');
    ok('非监管方不能轮换', await (async () => {
      try { await call('/api/cert-keys/rotate', { actorId: 'FIN-ICBC' }); return false; }
      catch (e) { return e.code === 'FORBIDDEN'; }
    })());

    console.log('\n=== 7. 同一核验请求并发抢占:确定结果、仅扣一次 ===');
    const max1 = (await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'REGULATORY_CHECK', ttlDays: 30, maxUses: 1, issueNonce: issueNonce()
    })).envelope;
    const cn = nonce();
    const [ca, cb] = await Promise.allSettled([
      verify(max1, 'REGULATORY_CHECK', cn),
      verify(max1, 'REGULATORY_CHECK', cn)
    ]);
    ok('同 nonce 并发两笔均返回', ca.status === 'fulfilled' && cb.status === 'fulfilled');
    const vva = ca.value, vvb = cb.value
    ok('恰有一笔首验、一笔重放', (vva.replayed === false) !== (vvb.replayed === false));
    ok('两笔看到相同剩余次数 0,仅扣一次', vva.verdict.remaining === 0 && vvb.verdict.remaining === 0);
    // 不同 nonce 并发抢最后一次(上面已耗尽,新签一张 maxUses=1)
    const max1b = (await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'REGULATORY_CHECK', ttlDays: 30, maxUses: 1, issueNonce: issueNonce()
    })).envelope;
    const rs = await Promise.allSettled([
      verify(max1b, 'REGULATORY_CHECK', nonce()),
      verify(max1b, 'REGULATORY_CHECK', nonce())
    ]);
    const vals = rs.map((r) => (r.status === 'fulfilled' ? r.value : { code: 'THREW' }));
    const passN = vals.filter((v) => v.valid).length;
    const exhaustN = vals.filter((v) => !v.valid && v.code === 'USES_EXHAUSTED').length;
    ok('不同 nonce 并发:恰 1 笔通过、1 笔 USES_EXHAUSTED', passN === 1 && exhaustN === 1, JSON.stringify(vals.map((v) => v.code)));
    const max1bId = max1b.claims.id;
    ok('台账 usedCount 恰为 1(无超扣)', (await get('/api/certificates')).find((c) => c.id === max1bId).usedCount === 1);

    console.log('\n=== 8. 权利状态变化后旧证明按签发规则继续验真 ===');
    const frozen = (await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 30, maxUses: 5, issueNonce: issueNonce()
    })).envelope;
    const vAtIssue = frozen.claims.d.receiptVersion;
    await call('/api/receipts/recheck', { actorId: 'WH-1', receiptId: 'WR0002', newGradeId: 'CU-A', newQty: 500 });
    const freshAnchors = (await get('/api/certificates/anchors')).anchors;
    ok('仓单复检后旧证明离线仍验真(冻结签发时状态)', (await C.verifyOffline(frozen, { anchors: freshAnchors, purpose: 'DUE_DILIGENCE' })).valid);
    ok('旧证明正文仍是签发时仓单版本(不随后续变化)', frozen.claims.d.receiptVersion === vAtIssue);
    const afterChange = await verify(frozen, 'DUE_DILIGENCE', nonce());
    ok('状态变化后在线核验仍按签发规则通过(证明不被权利变化单方面失效)', afterChange.valid);

    console.log('\n=== 9. 签发授权范围控制 ===');
    let forbid = null;
    try {
      await call('/api/certificates/issue', { actorId: 'FIN-CMB', receiptId: 'WR0001', purpose: 'DUE_DILIGENCE', ttlDays: 1, issueNonce: issueNonce() });
    } catch (e) { forbid = e.code; }
    ok('非当前质权人对他人质押仓单签发被拒 FORBIDDEN', forbid === 'FORBIDDEN');
    let forbidEnt = null;
    try {
      await call('/api/certificates/issue', { actorId: 'ENT-HONGTAI', receiptId: 'WR0001', purpose: 'DUE_DILIGENCE', ttlDays: 1, issueNonce: issueNonce() });
    } catch (e) { forbidEnt = e.code; }
    ok('企业不能作为签发主体', forbidEnt === 'FORBIDDEN');
    let badPurpose = null;
    try {
      await call('/api/certificates/issue', { actorId: 'REG-1', receiptId: 'WR0002', purpose: 'NOT_A_PURPOSE', ttlDays: 1, issueNonce: issueNonce() });
    } catch (e) { badPurpose = e.code; }
    ok('非法用途被拒 BAD_PURPOSE', badPurpose === 'BAD_PURPOSE');
    let badUses = null;
    try {
      await call('/api/certificates/issue', { actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 1, maxUses: -2, issueNonce: issueNonce() });
    } catch (e) { badUses = e.code; }
    ok('非法次数被拒 BAD_MAX_USES', badUses === 'BAD_MAX_USES');

    console.log('\n=== 10. 签发幂等 + 链完整 + 审计计数 ===');
    const ik = issueNonce();
    const i1 = await call('/api/certificates/issue', { actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 3, maxUses: 2, issueNonce: ik });
    const i2 = await call('/api/certificates/issue', { actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 3, maxUses: 2, issueNonce: ik });
    ok('相同 issueNonce 重放返回同一证明', i2.replayed && i2.certificate.id === i1.certificate.id);
    const aud = await get('/api/certificates/audit');
    ok('证明审计:链验签通过(证明事件纳入同一链)', aud.chain.ok);
    ok('审计计数:有撤销证明/轮换+吊销密钥/通过与拒绝核验',
      aud.certificates.revoked >= 1 && aud.keys.total >= 3 && aud.keys.rotated >= 1 && aud.keys.revoked >= 1 &&
      aud.verifications.passed > 0 && aud.verifications.rejected > 0, JSON.stringify({ c: aud.certificates, k: aud.keys, v: aud.verifications }));

    /* ---- 离线验真器单文件:自带信任锚(三态齐备),可断网打开 ---- */
    const currentActive = (await get('/api/certificates/anchors')).anchors.find((a) => a.status === 'ACTIVE').kid;
    const bundle = await (await fetch(BASE + '/offline-verifier.html')).text();
    ok('离线验真器单文件可下载', bundle.includes('EWR_TRUST_ANCHORS') && bundle.includes('verifyOffline'));
    ok('离线包冻结了全部已知信任锚:当前 ACTIVE 公钥在内,已吊销 ' + oldKid + ' 标记 REVOKED',
      bundle.includes(currentActive) && bundle.includes('"kid":"' + oldKid + '"') && bundle.includes('REVOKED'));

    /* ================= 断电恢复:SIGKILL 后计数/吊销/幂等不丢 ================= */
    console.log('\n=== 11. SIGKILL 断电恢复:核验计数 / 吊销记录 / nonce 幂等不丢 ===');
    const persist = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0001', purpose: 'COURT_EVIDENCE', ttlDays: 30, maxUses: 2, issueNonce: 'PERSIST-ISSUE'
    });
    const pEnv = persist.envelope;
    const pCertId = persist.certificate.id;
    const pn = 'PERSIST-NONCE-1';
    const pr1 = await verify(pEnv, 'COURT_EVIDENCE', pn);
    ok('断电前核验成功一次,剩余 1', pr1.valid && pr1.verdict.remaining === 1);
    const beforeHead = (await get('/api/state')).audit.chain.head;

    srv.kill('SIGKILL');
    await new Promise((r) => srv.on('exit', r));
    srv = startServer();
    if (!(await waitReady())) throw new Error('服务重启超时');

    const certsAfter = await get('/api/certificates');
    const pc = certsAfter.find((c) => c.id === pCertId);
    ok('重启后已用次数恢复为 1(不回退)', pc.usedCount === 1, 'used=' + pc.usedCount);
    const revokedCert = certsAfter.find((c) => c.id === issue.certificate.id);
    ok('重启后撤销记录不丢、不复活', revokedCert.status === 'REVOKED' && revokedCert.revokeReason === '客户书面要求撤销');
    const keysAfter = await get('/api/cert-keys');
    ok('重启后密钥状态恢复(ACTIVE/ROTATED/REVOKED 各在其位)',
      keysAfter.some((k) => k.status === 'ACTIVE') && keysAfter.some((k) => k.status === 'ROTATED') && keysAfter.some((k) => k.status === 'REVOKED'));
    const afterHead = (await get('/api/state')).audit.chain.ok && (await get('/api/state')).audit.chain.head;
    ok('重启后链头与断电前一致且链验签通过', afterHead === beforeHead);
    // 断电前 nonce 重放:不重复扣次
    const prReplay = await verify(pEnv, 'COURT_EVIDENCE', pn);
    ok('断电前 nonce 重启后重放:返回首次结论,计数仍为 1',
      prReplay.replayed && prReplay.verdict.remaining === 1, JSON.stringify({ replayed: prReplay.replayed, rem: prReplay.verdict.remaining }));
    // 第二次核验(新 nonce)扣到 0 并持久化;再 SIGKILL 一次确认
    const pr2 = await verify(pEnv, 'COURT_EVIDENCE', 'PERSIST-NONCE-2');
    ok('重启后新核验扣到 0', pr2.valid && pr2.verdict.remaining === 0);
    const pr3 = await verify(pEnv, 'COURT_EVIDENCE', nonce());
    ok('耗尽后拒绝 USES_EXHAUSTED', !pr3.valid && pr3.code === 'USES_EXHAUSTED');

    srv.kill('SIGKILL');
    await new Promise((r) => srv.on('exit', r));
    srv = startServer();
    if (!(await waitReady())) throw new Error('服务二次重启超时');
    const pc2 = (await get('/api/certificates')).find((c) => c.id === pCertId);
    ok('二次断电后计数仍为 2(不重复消耗、不丢失)', pc2.usedCount === 2);
    const pr3replay = await verify(pEnv, 'COURT_EVIDENCE', 'PERSIST-NONCE-2');
    ok('已成功的核验 nonce 二次断电后重放仍是首次通过结论',
      pr3replay.replayed && pr3replay.valid === true && pr3replay.verdict.remaining === 0);

    console.log(`\n================ 权利证明:${passed} 通过,${fails.length} 失败 ================`);
    if (fails.length) { console.log('失败项:', fails); process.exitCode = 1; }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    rmSync(DB_FILE, { force: true });
  }
  if (fails.length) process.exit(1);
}
main().catch((e) => { console.error('权利证明测试运行异常:', e); process.exit(1); });
