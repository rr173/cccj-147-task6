/**
 * * delegation.mjs —— 机构级查验额度委托 端到端不变量测试
 *
 * 零依赖,自起停服务(独立临时数据文件)。覆盖需求的全部对抗场景:
 *  分配预留不超扣、受托机构只能消费自己的额度(越权机构拒绝)、错误业务场景拒绝、
 *  过期/未生效授权拒绝、单次操作人限制、相同业务流水返回第一次裁决(成功/失败)、
 *  并发争抢(同流水重放 + 抢最后一次)、失败后重试不扣次、收回未用额度旧授权立即失效、
 *  凭据撤销/密钥应急吊销/上级额度耗尽级联停止、审批与收回同时到达只形成一个终态、
 *  SIGKILL 重启后额度/裁决不回退、完整额度树与先后事件、哈希链验签。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

const PORT = process.env.DELEG_PORT || '3195';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_DELEG_DB || '/tmp/ewr-deleg-db.json';

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
    const e = new Error(json.error.message); e.code = json.error.code; e.extra = json.error.extra; throw e;
  }
  return json.data;
}
/** 消费类裁决:业务拒绝返回 200 {valid:false,code};参数类错误为 400,统一折成 {valid:false,code} */
async function consume(body) {
  const res = await fetch(BASE + '/api/certificates/delegations/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) return { valid: false, code: json.error.code, detail: json.error.message };
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const flow = () => 'FL-' + Math.random().toString(36).slice(2, 12);
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
async function issueCert(maxUses, purpose = 'DUE_DILIGENCE', nonce) {
  return call('/api/certificates/issue', {
    actorId: 'FIN-ICBC', receiptId: 'WR0001', purpose,
    ttlDays: 30, maxUses, issueNonce: nonce || 'ISS-' + Math.random().toString(36).slice(2, 10)
  });
}
async function grant(certId, trusteeId, quota, extra = {}) {
  return call('/api/certificates/delegations/grant', {
    actorId: 'FIN-ICBC', certId, trusteeId,
    scenario: extra.scenario || 'DUE_DILIGENCE',
    quota, ttlDays: extra.ttlDays || 10,
    startsAt: extra.startsAt, endsAt: extra.endsAt,
    perOperatorLimit: extra.perOperatorLimit,
    operatorAllowlist: extra.operatorAllowlist,
    reqId: extra.reqId || 'GR-' + Math.random().toString(36).slice(2, 10)
  });
}

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  let srv = startServer();
  try {
    if (!(await waitReady())) throw new Error('服务启动超时');
    await call('/api/admin/reset');
    const vb = (await get('/api/state')).valuationBatches[0].id;
    await call('/api/pledges/lock', { reqId: 'LK-D1', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
    await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: 'PL0001', registrationNo: 'REG-D1', expectedVersion: 1 });
    const partners = (await get('/api/state')).parties.filter((p) => p.type === 'partner');
    ok('种子含两家合作机构', partners.length >= 2, partners.map((p) => p.id).join(','));
    const SINO = partners[0].id, YUAN = partners[1].id;

    console.log('\n=== 1. 分配:预留额度 + 总额度不超扣 ===');
    const c1 = (await issueCert(5)).certificate.id;
    const g1 = await grant(c1, SINO, 3, { reqId: 'G1' });
    ok('委托 3 次成功', g1.delegation.id && g1.delegation.remaining === 3);
    let over = null;
    try { await grant(c1, YUAN, 3, { reqId: 'G2' }); } catch (e) { over = e.code; }
    ok('再委托 3 超剩余可分配 2 → PARENT_QUOTA_EXCEEDED', over === 'PARENT_QUOTA_EXCEEDED', over);
    const g2 = await grant(c1, YUAN, 2, { reqId: 'G3' });
    ok('改委托 2 成功(5 = 3 + 2 全额预留)', g2.delegation.remaining === 2);
    const c1View = (await get('/api/certificates?certId=' + c1))[0];
    ok('凭据视图:已用 0 / 预留 5 / 可新分配 0',
      c1View.usedCount === 0 && c1View.delegation.activeReserved === 5 && c1View.delegation.allocatable === 0,
      JSON.stringify(c1View.delegation));
    // 分配幂等
    const g1re = await grant(c1, SINO, 3, { reqId: 'G1' });
    ok('相同委托 reqId 重放返回同一委托', g1re.replayed && g1re.delegation.id === g1.delegation.id);
    let badScene = null;
    try { await grant(c1, SINO, 1, { scenario: 'INSURANCE', reqId: 'G4' }); } catch (e) { badScene = e.code; }
    ok('分配场景与凭据用途不一致 → DELEG_SCENE_MISMATCH(分配侧)', badScene === 'DELEG_SCENE_MISMATCH', badScene);
    let nonPartner = null;
    try { await grant(c1, 'ENT-HONGTAI', 1, { reqId: 'G5' }); } catch (e) { nonPartner = e.code; }
    ok('受托方不是合作机构 → TRUSTEE_NOT_PARTNER', nonPartner === 'TRUSTEE_NOT_PARTNER', nonPartner);
    let foreign = null;
    try {
      await call('/api/certificates/delegations/grant', {
        actorId: 'FIN-CMB', certId: c1, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', quota: 1, ttlDays: 2, reqId: 'G6'
      });
    } catch (e) { foreign = e.code; }
    ok('非持有方分配他人凭据 → FORBIDDEN', foreign === 'FORBIDDEN', foreign);

    console.log('\n=== 2. 受托消费:越权机构 / 错误场景 / 操作人限制 ===');
    const env1 = (await get('/api/certificates?certId=' + c1))[0].envelope;
    const D1 = g1.delegation.id, D2 = g2.delegation.id;
    const forb = await consume({ envelope: env1, flowNo: flow(), delegationId: D1, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', operatorId: 'op1' });
    ok('越权机构(YUAN 消费 SINO 的委托)→ DELEG_FORBIDDEN', !forb.valid && forb.code === 'DELEG_FORBIDDEN', forb.code);
    const scene = await consume({ envelope: env1, flowNo: flow(), delegationId: D1, trusteeId: SINO, scenario: 'INSURANCE', operatorId: 'op1' });
    ok('错误业务场景 → DELEG_SCENE_MISMATCH', !scene.valid && scene.code === 'DELEG_SCENE_MISMATCH', scene.code);
    // 给 SINO 的委托加单人上限 1(新凭据新委托,避免总额冲突)
    const c2 = (await issueCert(2)).certificate.id;
    const env2 = (await get('/api/certificates?certId=' + c2))[0].envelope;
    const dOp = (await grant(c2, SINO, 2, { perOperatorLimit: 1, operatorAllowlist: ['opA', 'opB'], reqId: 'GOP' })).delegation.id;
    const opA1 = await consume({ envelope: env2, flowNo: flow(), delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opA' });
    ok('允许名单内 opA 首次消费通过', opA1.valid);
    const opA2 = await consume({ envelope: env2, flowNo: flow(), delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opA' });
    ok('同一操作人超单人上限 → OPERATOR_LIMIT_EXCEEDED', !opA2.valid && opA2.code === 'OPERATOR_LIMIT_EXCEEDED', opA2.code);
    const opX = await consume({ envelope: env2, flowNo: flow(), delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opX' });
    ok('不在允许名单 → OPERATOR_NOT_ALLOWED', !opX.valid && opX.code === 'OPERATOR_NOT_ALLOWED', opX.code);
    const noOp = await consume({ envelope: env2, flowNo: flow(), delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE' });
    ok('缺少单次操作人 → OPERATOR_REQUIRED', noOp && noOp.code === 'OPERATOR_REQUIRED', noOp && noOp.code);

    console.log('\n=== 3. 相同业务流水:成功与失败都只裁决一次 ===');
    const fn = flow();
    const a = await consume({ envelope: env2, flowNo: fn, delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opB' });
    ok('opB 消费成功(委托 2/2 耗尽)', a.valid && a.verdict.delegRemaining === 0 && a.delegation.status === 'EXHAUSTED');
    const aRe1 = await consume({ envelope: env2, flowNo: fn, delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opB' });
    ok('相同成功流水重放 → replayed 首次结论,额度不变', aRe1.replayed && aRe1.valid && aRe1.verdict.delegRemaining === 0);
    const aRe2 = await consume({ envelope: env2, flowNo: fn, delegationId: dOp, trusteeId: YUAN, scenario: 'INSURANCE', operatorId: 'zzz' });
    ok('换机构/场景重放同一流水仍返回首次通过裁决(流水幂等优先)', aRe2.replayed && aRe2.valid === true);
    const ffn = flow();
    const f1 = await consume({ envelope: env2, flowNo: ffn, delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opB' });
    const f2 = await consume({ envelope: env2, flowNo: ffn, delegationId: dOp, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'opB' });
    ok('失败流水(委托已耗尽)重试返回同一拒绝 DELEG_EXHAUSTED 且不扣次',
      !f1.valid && f1.code === 'DELEG_EXHAUSTED' && f2.replayed && f2.code === 'DELEG_EXHAUSTED');

    console.log('\n=== 4. 并发争抢:同流水唯一裁决 + 不同流水抢最后一次不超扣 ===');
    // 同流水并发(对 c1 的 D2,YUAN 有 2,父余 2)
    const sameFlow = flow();
    const [r1, r2] = await Promise.all([
      consume({ envelope: env1, flowNo: sameFlow, delegationId: D2, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', operatorId: 'o1' }),
      consume({ envelope: env1, flowNo: sameFlow, delegationId: D2, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', operatorId: 'o1' })
    ]);
    ok('同流水并发:恰一首判一重放', (r1.replayed === false) !== (r2.replayed === false));
    const firstOf = r1.replayed ? r2.verdict : r1.verdict;
    ok('首判:委托余 1、父余 4(此时 SINO 的 3 尚未消费)', firstOf.delegRemaining === 1 && firstOf.parentRemaining === 4,
      JSON.stringify({ a: r1.verdict && r1.verdict.delegRemaining, b: r2.verdict && r2.verdict.delegRemaining }));
    // 不同流水同时抢:YUAN 还剩 1 次,SINO 还剩 3 次(其预留本就供消费)。
    // 父当前已用 1/5,3 笔并发应全部通过(受托共 4 笔,父余 1),无一笔超总额。
    const rs = await Promise.all([
      consume({ envelope: env1, flowNo: flow(), delegationId: D2, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', operatorId: 'o1' }),
      consume({ envelope: env1, flowNo: flow(), delegationId: D1, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o9' }),
      consume({ envelope: env1, flowNo: flow(), delegationId: D1, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o9' })
    ]);
    const pass = rs.filter((x) => x.valid).length;
    ok('三笔并发全部通过(受托预留额度可被消费),且最终父余 1 无超扣', pass === 3,
      rs.map((x) => x.valid ? 'PASS(父余' + x.verdict.parentRemaining + ',委余' + x.verdict.delegRemaining + ')' : x.code).join(','));
    const c1After = (await get('/api/certificates?certId=' + c1))[0];
    ok('父凭据总账 4/5(已用绝不超过总额)', c1After.usedCount === 4 && c1After.usedCount <= c1After.maxUses, 'used=' + c1After.usedCount + ' race=' + rs.map((x) => x.verdict && x.verdict.parentRemaining).join('/'));

    // 「上级额度耗尽 → 全部下级同步停止」:持有方直接在线核验耗尽最后 1 次父额度
    const dStillActive = await get('/api/certificates/delegations?certId=' + c1);
    ok('父耗尽前仍有 ACTIVE 委托(SINO 余1预留)', dStillActive.some((d) => d.status === 'ACTIVE'));
    await call('/api/certificates/verify', { envelope: env1, purpose: 'DUE_DILIGENCE', nonce: 'DIRECT-0', verifierId: 'HOLDER' });
    const directResp = await call('/api/certificates/verify', { envelope: env1, purpose: 'DUE_DILIGENCE', nonce: 'DIRECT-1', verifierId: 'HOLDER' })
      .then((x) => (x.valid ? 'PASS' : x.code))
      .catch((e) => e.code);
    ok('父额度满后第 6 次直接核验被拒 USES_EXHAUSTED', directResp === 'USES_EXHAUSTED', directResp);
    const c1Full = (await get('/api/certificates?certId=' + c1))[0];
    ok('持有方直用后父凭据 5/5', c1Full.usedCount === 5 && c1Full.remaining === 0);
    const delegsAfter = await get('/api/certificates/delegations?certId=' + c1);
    const activeLeft = delegsAfter.filter((d) => d.status === 'ACTIVE').length;
    ok('上级额度耗尽后无 ACTIVE 下级委托(全部 EXHAUSTED/STOPPED)', activeLeft === 0,
      delegsAfter.map((d) => d.id + ':' + d.status + '/' + (d.stopReason || '')).join(','));
    const stopCascade = delegsAfter.filter((d) => d.status === 'STOPPED' && d.stopReason === 'PARENT_EXHAUSTED');
    ok('被父耗尽级联停止的委托带 PARENT_EXHAUSTED 原因', stopCascade.length >= 1,
      delegsAfter.map((d) => d.id + ':' + d.stopReason).join(','));
    // 再消费必拒(机构额度尚有余,但上级已停)
    const parentDenied = await consume({ envelope: env1, flowNo: flow(), delegationId: D1, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o9' });
    ok('上级耗尽后受托消费得到确定拒绝(STOPPED/PARENT_QUOTA_EXHAUSTED)',
      !parentDenied.valid && (parentDenied.code === 'DELEG_STOPPED' || parentDenied.code === 'PARENT_QUOTA_EXHAUSTED'), parentDenied.code);

    console.log('\n=== 5. 时间窗:未生效 / 已过期授权拒绝 ===');
    const c3 = (await issueCert(3)).certificate.id;
    const env3 = (await get('/api/certificates?certId=' + c3))[0].envelope;
    const dFuture = (await grant(c3, YUAN, 1, { startsAt: Date.now() + 3600000, ttlDays: 2, reqId: 'GF' })).delegation.id;
    const early = await consume({ envelope: env3, flowNo: flow(), delegationId: dFuture, trusteeId: YUAN, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('未到生效时间 → DELEG_NOT_STARTED', !early.valid && early.code === 'DELEG_NOT_STARTED', early.code);
    const dPast = (await grant(c3, SINO, 1, { startsAt: Date.now() - 2000, endsAt: Date.now() + 700, reqId: 'GP' })).delegation.id;
    await new Promise((r) => setTimeout(r, 1100));
    const expired = await consume({ envelope: env3, flowNo: flow(), delegationId: dPast, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('授权已过期 → DELEG_EXPIRED', !expired.valid && expired.code === 'DELEG_EXPIRED', expired.code);
    let badWindow = null;
    try { await grant(c3, SINO, 1, { startsAt: Date.now() - 99999, ttlDays: 1, reqId: 'GBW' }); } catch (e) { badWindow = e.code; }
    ok('开始时间早于当前 → BAD_WINDOW', badWindow === 'BAD_WINDOW', badWindow);

    console.log('\n=== 6. 收回未用额度:旧授权立即失效 + 额度回池 + 幂等 + 与消费同时到达 ===');
    const c4 = (await issueCert(4)).certificate.id;
    const env4 = (await get('/api/certificates?certId=' + c4))[0].envelope;
    const dR = (await grant(c4, SINO, 3, { reqId: 'GR' })).delegation.id;
    const use1 = await consume({ envelope: env4, flowNo: flow(), delegationId: dR, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('收回前消费 1 次', use1.valid && use1.verdict.delegRemaining === 2 && use1.verdict.parentRemaining === 3);
    const rec = await call('/api/certificates/delegations/reclaim', { actorId: 'FIN-ICBC', delegationId: dR, reqId: 'RR1' });
    ok('收回返回未用额度 2(已消耗 1 不回收)', rec.returned === 2 && rec.delegation.status === 'RECLAIMED');
    const afterRec = await consume({ envelope: env4, flowNo: flow(), delegationId: dR, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('收回后旧授权立即不能使用 → DELEG_RECLAIMED', !afterRec.valid && afterRec.code === 'DELEG_RECLAIMED', afterRec.code);
    const recRe = await call('/api/certificates/delegations/reclaim', { actorId: 'FIN-ICBC', delegationId: dR, reqId: 'RR1' });
    ok('相同收回 reqId 重放幂等', recRe.replayed && recRe.delegation.status === 'RECLAIMED');
    const c4v = (await get('/api/certificates?certId=' + c4))[0];
    ok('收回后凭据可分配额度恢复为 3(4 - 已用 1)', c4v.delegation.allocatable === 3, String(c4v.delegation.allocatable));
    const reGrant = await grant(c4, YUAN, 3, { reqId: 'GRG' });
    ok('收回的额度可重新委托给其他机构', !!reGrant.delegation.id);
    let nonGranter = null;
    try { await call('/api/certificates/delegations/reclaim', { actorId: 'FIN-CMB', delegationId: reGrant.delegation.id, reqId: 'RRX' }); }
    catch (e) { nonGranter = e.code; }
    ok('非持有方/非监管收回 → FORBIDDEN', nonGranter === 'FORBIDDEN', nonGranter);

    // 审批(消费)与收回同时到达:FIFO 裁决,只能形成一个终态
    const c5 = (await issueCert(1)).certificate.id;
    const env5 = (await get('/api/certificates?certId=' + c5))[0].envelope;
    const dRace = (await grant(c5, SINO, 1, { reqId: 'GRACE' })).delegation.id;
    const [cr, cc] = await Promise.all([
      call('/api/certificates/delegations/reclaim', { actorId: 'FIN-ICBC', delegationId: dRace, reqId: 'RRACE' })
        .then((x) => ({ kind: 'reclaim', ok: true, s: x.delegation.status }))
        .catch((e) => ({ kind: 'reclaim', ok: false, code: e.code })),
      consume({ envelope: env5, flowNo: 'RACE-FLOW-1', delegationId: dRace, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' })
        .then((x) => ({ kind: 'consume', ok: x.valid, code: x.code, replayed: x.replayed }))
    ]);
    const finalD = (await get('/api/certificates/delegations?certId=' + c5))[0];
    const oneTerminal = (finalD.status === 'RECLAIMED' && (!cc.ok) && cr.ok) ||
      (finalD.status === 'EXHAUSTED' && cc.ok && !cr.ok);
    ok('审批与收回同时到达只形成一个终态(RECLAIMED 拒消费 / EXHAUSTED 拒收回)',
      oneTerminal, JSON.stringify({ cr, cc, final: finalD.status }));

    console.log('\n=== 7. 级联停止:凭据撤销 / 密钥应急吊销 ===');
    // 凭据撤销
    const c6 = (await issueCert(3)).certificate.id;
    const env6 = (await get('/api/certificates?certId=' + c6))[0].envelope;
    const d6a = (await grant(c6, SINO, 1, { reqId: 'G6A' })).delegation.id;
    const d6b = (await grant(c6, YUAN, 1, { reqId: 'G6B' })).delegation.id;
    await call('/api/certificates/revoke', { actorId: 'FIN-ICBC', certId: c6, reason: '客户撤销' });
    const afterRevoke = await get('/api/certificates/delegations?certId=' + c6);
    ok('凭据撤销:两笔下级委托同步 STOPPED/CERT_REVOKED',
      afterRevoke.every((d) => d.status === 'STOPPED' && d.stopReason === 'CERT_REVOKED'),
      afterRevoke.map((d) => d.status + '/' + d.stopReason).join(','));
    const consRevoked = await consume({ envelope: env6, flowNo: flow(), delegationId: d6a, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('撤销后受托消费被拒', !consRevoked.valid && (consRevoked.code === 'DELEG_STOPPED' || consRevoked.code === 'CERT_REVOKED'), consRevoked.code);
    // 密钥应急吊销:其签发全部凭据的委托停止,消费得到 KEY_REVOKED
    const c7 = (await issueCert(2)).certificate.id;
    const env7 = (await get('/api/certificates?certId=' + c7))[0].envelope;
    const kid = env7.kid;
    const d7 = (await grant(c7, SINO, 1, { reqId: 'G7' })).delegation.id;
    await call('/api/cert-keys/revoke', { actorId: 'REG-1', keyId: kid });
    const d7v = (await get('/api/certificates/delegations?certId=' + c7))[0];
    ok('密钥吊销:其签发凭据委托 STOPPED/KEY_REVOKED', d7v.status === 'STOPPED' && d7v.stopReason === 'KEY_REVOKED', d7v.status + '/' + d7v.stopReason);
    const consKey = await consume({ envelope: env7, flowNo: flow(), delegationId: d7, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('密钥吊销后消费拒绝(DELEG_STOPPED/KEY_REVOKED)', !consKey.valid && (consKey.code === 'DELEG_STOPPED' || consKey.code === 'KEY_REVOKED'), consKey.code);

    console.log('\n=== 8. 额度树 + 先后事件 + 拒绝留痕 + 哈希链 ===');
    const tree = await get('/api/certificates/delegation-tree?certId=' + c1);
    ok('额度树根凭据与总账(5/5,可分配 0;持有方直用 1/受托 4)',
      tree.totals.maxUses === 5 && tree.totals.used === 5 && tree.totals.allocatable === 0 &&
      tree.totals.delegatedUsed === 4 && tree.totals.directUsed === 1,
      JSON.stringify(tree.totals));
    ok('额度树含两笔委托', tree.delegations.length === 2);
    const types = tree.events.map((e) => e.type);
    ok('先后事件含 GRANTED/VERIFIED/DENIED/STOPPED 且严格按链序',
      types.includes('CERT_DELEG_GRANTED') && types.includes('CERT_DELEG_VERIFIED') &&
      types.includes('CERT_DELEG_DENIED') && types.includes('CERT_DELEG_STOPPED') &&
      tree.events.every((e, i) => i === 0 || e.seq > tree.events[i - 1].seq),
      types.join(','));
    const denials = await get('/api/certificates/delegations/verdicts?valid=false');
    ok('全部拒绝均持久化(越权/错场景/过期/耗尽/操作人)',
      denials.map((v) => v.code).includes('DELEG_FORBIDDEN') &&
      denials.map((v) => v.code).includes('DELEG_SCENE_MISMATCH') &&
      denials.map((v) => v.code).includes('DELEG_EXPIRED') &&
      denials.map((v) => v.code).includes('OPERATOR_LIMIT_EXCEEDED'),
      denials.map((v) => v.code).join(','));
    const aud = await get('/api/certificates/audit');
    ok('链验签通过(委托事件纳入同一哈希链)', aud.chain.ok);
    ok('审计含委托统计', aud.delegations.total >= 5 && aud.delegations.consumes > 0 && aud.delegations.denied > 0,
      JSON.stringify(aud.delegations));

    console.log('\n=== 9. SIGKILL 重启:额度 / 裁决 / 收回 / 终态不回退 ===');
    const persistIssue = await issueCert(3, 'DUE_DILIGENCE', 'PERSIST-C');
    const pcId = persistIssue.certificate.id;
    const pEnv = persistIssue.envelope;
    const pdId = (await grant(pcId, SINO, 2, { reqId: 'PERSIST-G' })).delegation.id;
    const pfn = 'PERSIST-FLOW-1';
    const pr1 = await consume({ envelope: pEnv, flowNo: pfn, delegationId: pdId, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('断电前受托消费成功(委托余 1/父余 2)', pr1.valid && pr1.verdict.delegRemaining === 1 && pr1.verdict.parentRemaining === 2);
    const headBefore = (await get('/api/state')).audit.chain.head;

    srv.kill('SIGKILL');
    await new Promise((r) => srv.on('exit', r));
    srv = startServer();
    if (!(await waitReady())) throw new Error('服务重启超时');

    const pTree = await get('/api/certificates/delegation-tree?certId=' + pcId);
    ok('重启后委托已用量不回退(1/2)', pTree.totals.delegatedUsed === 1 && pTree.delegations[0].usedCount === 1);
    ok('重启后父凭据总账不回退(1/3)', pTree.certificate.usedCount === 1 && pTree.totals.allocatable === 1);
    const headAfter = (await get('/api/state')).audit.chain.head;
    ok('重启后链头一致且链验签通过', headAfter === headBefore && (await get('/api/certificates/audit')).chain.ok);
    const replayP = await consume({ envelope: pEnv, flowNo: pfn, delegationId: pdId, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('断电前流水重启后重放:首次结论、不重复扣次', replayP.replayed && replayP.valid && replayP.verdict.delegRemaining === 1);
    // 重启后收回,旧授权立即失效
    await call('/api/certificates/delegations/reclaim', { actorId: 'FIN-ICBC', delegationId: pdId, reqId: 'PERSIST-R' });
    const afterRestartRec = await consume({ envelope: pEnv, flowNo: flow(), delegationId: pdId, trusteeId: SINO, scenario: 'DUE_DILIGENCE', operatorId: 'o1' });
    ok('重启后收回生效:旧授权 DELEG_RECLAIMED', !afterRestartRec.valid && afterRestartRec.code === 'DELEG_RECLAIMED');
    // 再 SIGKILL 一次,终态仍在
    srv.kill('SIGKILL');
    await new Promise((r) => srv.on('exit', r));
    srv = startServer();
    if (!(await waitReady())) throw new Error('服务二次重启超时');
    const pDeleg = (await get('/api/certificates/delegations?certId=' + pcId))[0];
    ok('二次断电后委托仍为 RECLAIMED,收回额度 1', pDeleg.status === 'RECLAIMED' && pDeleg.reclaimedQuota === 1);

    console.log(`\n================ 机构额度委托:${passed} 通过,${fails.length} 失败 ================`);
    if (fails.length) { console.log('失败项:', fails); process.exitCode = 1; }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    rmSync(DB_FILE, { force: true });
  }
  if (fails.length) process.exit(1);
}
main().catch((e) => { console.error('机构额度委托测试运行异常:', e); process.exit(1); });
