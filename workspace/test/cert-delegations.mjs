/**
 * cert-delegations.mjs —— 机构级查验额度委托(不变量 C7)端到端测试
 *
 * 零依赖,自起停服务(独立临时数据文件)。覆盖:
 *  委托预占/超额/越权、受托消费(本机构隔离/操作人白名单/业务场景/时间窗)、
 *  双层额度不超扣、相同业务流水首裁、收回未用额度旧授权立即失效、
 *  凭据作废与密钥应急吊销级联停止、上级额度耗尽、并发争抢、审批与收回同时到达单终态、
 *  委托/消费/收回/拒绝全部入链、SIGKILL 重启后额度与裁决不回退、监管额度树对账。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

const PORT = process.env.CERTDL_PORT || '3199';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_CERTDL_DB || '/tmp/ewr-certdl-db.json';

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
    const e = new Error(json.error.message); e.code = json.error.code; e.http = res.status; throw e;
  }
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const certById = async (id) => (await get('/api/certificates')).find((c) => c.id === id);
const nonce = () => 'N-' + Math.random().toString(36).slice(2, 12);
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
/** 受托消费:业务拒绝是 200 + {valid:false,code} 裁决(便于失败 nonce 留存) */
const consume = (body) => call('/api/certificates/delegations/consume', body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function issueCert(over = {}) {
  const r = await call('/api/certificates/issue', {
    actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE',
    ttlDays: 30, maxUses: 10, issueNonce: nonce(), ...over
  });
  return r.certificate;
}
async function delegate(certId, over = {}) {
  return call('/api/certificates/delegate', {
    actorId: 'REG-1', certId, granteeId: 'FIN-CMB', quota: 2,
    scenario: 'DUE_DILIGENCE', operatorIds: ['OP-1', 'OP-2'],
    startsAt: Date.now(), expiresAt: Date.now() + 86400000,
    delegateNonce: nonce(), ...over
  });
}

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  let srv = startServer();
  try {
    if (!(await waitReady())) throw new Error('服务启动超时');
    await call('/api/admin/reset');
    const vb = (await get('/api/state')).valuationBatches[0].id;
    await call('/api/pledges/lock', { reqId: 'LK-DL', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
    await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: 'PL0001', registrationNo: 'REG-DL', expectedVersion: 1 });

    console.log('\n=== 1. 委托:预占额度 + 超额/越权/非法参数拒绝 ===');
    const certA = await issueCert({ actorId: 'FIN-ICBC', receiptId: 'WR0001', maxUses: 10 });
    const dA = await delegate(certA.id, { quota: 3 });
    ok('委托成功返回 ACTIVE 授权,配额 3 剩余 3', dA.delegation.status === 'ACTIVE' && dA.delegation.quota === 3 && dA.delegation.remaining === 3);
    let cv = await certById(certA.id);
    ok('父凭据预占 3、可分配 7、总余 10(已用 0,remaining 不扣预占)', cv.reservedCount === 3 && cv.delegatableRemaining === 7 && cv.remaining === 10);

    const over = await delegate(certA.id, { quota: 8 });
    ok('委托 8 超过可分配 7 → DELEGATION_QUOTA_EXCEEDED(200 裁决)', over.rejected && over.code === 'DELEGATION_QUOTA_EXCEEDED');
    const ok2 = await delegate(certA.id, { quota: 7 });
    ok('恰可再委托 7(多机构)', ok2.delegation && ok2.delegation.quota === 7);
    const over2 = await delegate(certA.id, { quota: 1, granteeId: 'FIN-CMB' });
    ok('总池已分尽,再委托 1 → DELEGATION_QUOTA_EXCEEDED', over2.rejected && over2.code === 'DELEGATION_QUOTA_EXCEEDED');

    const nonHolder = await delegate(certA.id, { actorId: 'FIN-CMB', granteeId: 'FIN-ICBC', quota: 1 });
    ok('非持有方(FIN-CMB)委托 → FORBIDDEN 且留拒绝痕', nonHolder.rejected && nonHolder.code === 'FORBIDDEN');
    const badGrant = await delegate(certA.id, { granteeId: 'ENT-HONGTAI', quota: 1 });
    ok('受托方不是金融机构 → BAD_GRANTEE', badGrant.rejected && badGrant.code === 'BAD_GRANTEE');
    let noOp = null;
    try { await call('/api/certificates/delegate', { actorId: 'REG-1', certId: certA.id, granteeId: 'FIN-CMB', quota: 1, delegateNonce: nonce() }); }
    catch (e) { noOp = e; }
    ok('缺操作人白名单 → 400 OPERATOR_REQUIRED 且守卫补登审计', noOp && noOp.http === 400 && noOp.code === 'OPERATOR_REQUIRED');
    const auditAfterDenials = await get('/api/certificates/delegations/audit?certId=' + certA.id);
    ok('拒绝动作(超额/越权/参数)全部进入审计台账',
      auditAfterDenials.some((a) => a.reasonCode === 'DELEGATION_QUOTA_EXCEEDED') &&
      auditAfterDenials.some((a) => a.reasonCode === 'FORBIDDEN') &&
      auditAfterDenials.some((a) => a.reasonCode === 'OPERATOR_REQUIRED'));
    ok('每条拒绝审计都已上链(eventSeq 非空)', auditAfterDenials.filter((a) => a.outcome === 'REJECTED').every((a) => a.eventSeq > 0));

    console.log('\n=== 2. 委托幂等:相同 delegateNonce 返回首次授权 ===');
    // 用一张新凭据做干净的幂等演示
    const certI = await issueCert({ maxUses: 5 });
    const i1 = await delegate(certI.id, { quota: 2, delegateNonce: 'IDEM-DL-1' });
    const i2 = await delegate(certI.id, { quota: 2, delegateNonce: 'IDEM-DL-1' });
    ok('相同 delegateNonce 重放返回同一授权,不二次预占', i2.replayed && i2.delegation.id === i1.delegation.id);
    const certIview = (await get('/api/certificates')).find((c) => c.id === certI.id);
    ok('幂等重放不重复预占(仍为 2)', certIview.reservedCount === 2);

    console.log('\n=== 3. 受托消费:机构隔离 / 操作人 / 场景 / 时间窗 ===');
    const certB = await issueCert({ maxUses: 6 });
    const dB = await delegate(certB.id, { quota: 3, scenario: 'TRADE_CONFIRM' });
    const bid = dB.delegation.id;
    const wrongGrantee = await consume({ delegationId: bid, granteeId: 'FIN-ICBC', operatorId: 'OP-1', purpose: 'TRADE_CONFIRM', nonce: nonce() });
    ok('越权机构(非受托方)消费 → FORBIDDEN 不扣次', !wrongGrantee.valid && wrongGrantee.code === 'FORBIDDEN');
    const wrongOp = await consume({ delegationId: bid, granteeId: 'FIN-CMB', operatorId: 'OP-X', purpose: 'TRADE_CONFIRM', nonce: nonce() });
    ok('非白名单操作人 → OPERATOR_FORBIDDEN', !wrongOp.valid && wrongOp.code === 'OPERATOR_FORBIDDEN', wrongOp.code);
    const missOp = await consume({ delegationId: bid, granteeId: 'FIN-CMB', purpose: 'TRADE_CONFIRM', nonce: nonce() });
    ok('缺操作人 → OPERATOR_FORBIDDEN', !missOp.valid && missOp.code === 'OPERATOR_FORBIDDEN');
    const wrongScene = await consume({ delegationId: bid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'INSURANCE', nonce: nonce() });
    ok('错误业务场景 → SCENARIO_MISMATCH', !wrongScene.valid && wrongScene.code === 'SCENARIO_MISMATCH');
    const pass1 = await consume({ delegationId: bid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'TRADE_CONFIRM', nonce: 'B-N1' });
    ok('合规消费通过:授权余 2、父已用 1、父余 5',
      pass1.valid && pass1.verdict.delegationRemaining === 2 && pass1.verdict.remaining === 5 && pass1.verdict.usedCount === 1);
    const failBefore = (await get('/api/certificates')).find((c) => c.id === certB.id).usedCount;
    ok('各类失败均未扣次(父已用仍 1)', failBefore === 1);
    const repl = await consume({ delegationId: bid, granteeId: 'FIN-CMB', operatorId: 'OP-2', purpose: 'TRADE_CONFIRM', nonce: 'B-N1' });
    ok('相同业务流水重放:replayed 返回首裁(哪怕换操作人),不二次扣', repl.replayed && repl.verdict.delegationRemaining === 2);
    // 越权机构持同一流水重放也只返回首裁,不泄露额外操作
    const replayOther = await consume({ delegationId: bid, granteeId: 'FIN-ICBC', operatorId: 'OP-1', purpose: 'TRADE_CONFIRM', nonce: 'B-N1' });
    ok('他机构持相同流水重放仍只返回首次通过结论(幂等不区分请求方,但不产生第二扣)', replayOther.replayed);

    // 时间窗:未生效 / 已过期
    const certW = await issueCert({ maxUses: 4 });
    const future = await delegate(certW.id, { quota: 1, startsAt: Date.now() + 3600000, expiresAt: Date.now() + 7200000 });
    const notYet = await consume({ delegationId: future.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('未到生效时间 → DELEGATION_NOT_STARTED', !notYet.valid && notYet.code === 'DELEGATION_NOT_STARTED');
    const short = await delegate(certW.id, { quota: 1, startsAt: Date.now(), expiresAt: Date.now() + 300 });
    await sleep(400);
    const expired = await consume({ delegationId: short.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('过期授权 → DELEGATION_EXPIRED', !expired.valid && expired.code === 'DELEGATION_EXPIRED');
    const wView = (await get('/api/certificates/delegations?certId=' + certW.id)).find((d) => d.id === short.delegation.id);
    ok('合作机构视图实时标注 EXPIRED 且 usableNow=false', wView.effectiveStatus === 'EXPIRED' && wView.usableNow === false);

    console.log('\n=== 4. 双层额度不超扣:受托机构只能消费自己的额度 ===');
    // 用独立凭据做干净的双层账:certX 总额 10
    const certX = await issueCert({ maxUses: 10 });
    const dxA = await delegate(certX.id, { quota: 3, granteeId: 'FIN-CMB' });
    const dxB = await delegate(certX.id, { quota: 2, granteeId: 'FIN-ICBC' });
    let xView = await certById(certX.id);
    ok('委托 3+2 后:已用 0、预占 5、可分 5', xView.usedCount === 0 && xView.reservedCount === 5 && xView.delegatableRemaining === 5);
    const overX = await delegate(certX.id, { quota: 6, granteeId: 'FIN-CMB' });
    ok('再委托 6 > 可分 5 → DELEGATION_QUOTA_EXCEEDED', overX.rejected && overX.code === 'DELEGATION_QUOTA_EXCEEDED', overX.code);

    // FIN-CMB 用满自己的 3 次
    const xa1 = await consume({ delegationId: dxA.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    await consume({ delegationId: dxA.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    const xa3 = await consume({ delegationId: dxA.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-2', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('FIN-CMB 三次用满:授权余 0、父已用 3', xa3.valid && xa3.verdict.delegationRemaining === 0 && xa3.verdict.usedCount === 3);
    const xa4 = await consume({ delegationId: dxA.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('第 4 次超过本机构配额 → DELEGATION_EXHAUSTED(不看总池还有多少)', !xa4.valid && xa4.code === 'DELEGATION_EXHAUSTED');
    // FIN-ICBC 消费自己的额度,与 FIN-CMB 互不占用
    const xb1 = await consume({ delegationId: dxB.delegation.id, granteeId: 'FIN-ICBC', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('另一机构消费自己额度不受影响(授权余 1、父已用 4)', xb1.valid && xb1.verdict.delegationRemaining === 1 && xb1.verdict.usedCount === 4);
    xView = await certById(certX.id);
    ok('父已用 4、预占(dxB余1)1、可分 5', xView.usedCount === 4 && xView.reservedCount === 1 && xView.delegatableRemaining === 5);

    // 直接核验只能用未预占池(可分 5):连续 5 次成功,第 6 次拒绝
    for (let i = 0; i < 5; i++) {
      const dv = await call('/api/certificates/verify', { certId: certX.id, purpose: 'DUE_DILIGENCE', nonce: nonce() });
      ok('直接核验第 ' + (i + 1) + ' 次成功', dv.valid);
    }
    const dvExhaust = await call('/api/certificates/verify', { certId: certX.id, purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('未预占池耗尽:直接核验 USES_EXHAUSTED(dxB 的 1 次预占仍保留给受托方)', !dvExhaust.valid && dvExhaust.code === 'USES_EXHAUSTED');
    // FIN-ICBC 最后一次受托消费成功,父用满 10
    const xb2 = await consume({ delegationId: dxB.delegation.id, granteeId: 'FIN-ICBC', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('受托最后一次预占消费成功,父用满 10', xb2.valid && xb2.verdict.usedCount === 10 && xb2.verdict.delegationRemaining === 0);
    xView = await certById(certX.id);
    ok('父 usedCount 恰 10、预占 0(全部用罄,无超扣)', xView.usedCount === 10 && xView.reservedCount === 0);

    // 独立凭据演示:直接池 1 + 受托池 3
    const certD = await issueCert({ maxUses: 4 });
    await delegate(certD.id, { quota: 3 });
    const dd1 = await call('/api/certificates/verify', { certId: certD.id, purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('未预占池 1 次:直接核验通过,总余 3(含预占)', dd1.valid && dd1.verdict.remaining === 3);
    const dd2 = await call('/api/certificates/verify', { certId: certD.id, purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('未预占池耗尽:直接核验 USES_EXHAUSTED(受托额度仍在)', !dd2.valid && dd2.code === 'USES_EXHAUSTED');
    const dD = (await get('/api/certificates/delegations?certId=' + certD.id)).find((d) => d.certId === certD.id && d.granteeId === 'FIN-CMB' && d.quota === 3);
    const dc = await consume({ delegationId: dD.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('受托消费预占额度仍成功(父已用 2、授权余 2)', dc.valid && dc.verdict.usedCount === 2 && dc.verdict.delegationRemaining === 2);

    console.log('\n=== 5. 收回:仅退未用预占,旧授权立即失效 ===');
    const certE = await issueCert({ maxUses: 5 });
    const dE = await delegate(certE.id, { quota: 3 });
    await consume({ delegationId: dE.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    const eBefore = (await get('/api/certificates')).find((c) => c.id === certE.id);
    ok('收回前:已用 1、预占 2、可分 2', eBefore.usedCount === 1 && eBefore.reservedCount === 2 && eBefore.delegatableRemaining === 2);
    const rec = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: dE.delegation.id, reclaimNonce: nonce(), reason: '合作终止' });
    ok('收回返回退回未用预占 2', rec.returned === 2 && rec.delegation.status === 'RECLAIMED');
    const eAfter = (await get('/api/certificates')).find((c) => c.id === certE.id);
    ok('收回后:已用 1、预占 0、可分恢复 4', eAfter.usedCount === 1 && eAfter.reservedCount === 0 && eAfter.delegatableRemaining === 4);
    const oldUse = await consume({ delegationId: dE.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('旧授权立即不能继续使用 → DELEGATION_RECLAIMED', !oldUse.valid && oldUse.code === 'DELEGATION_RECLAIMED');
    // 收回释放的 2 次可再次委托/直接核验
    const dE2 = await delegate(certE.id, { quota: 2 });
    ok('收回释放的额度可再次委托', !!dE2.delegation);
    const rn = nonce();
    const r1 = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: dE2.delegation.id, reclaimNonce: rn });
    const r2 = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: dE2.delegation.id, reclaimNonce: rn });
    ok('相同 reclaimNonce 重放不重复退回', r2.replayed && r1.returned === 2 && (await get('/api/certificates')).find((c) => c.id === certE.id).reservedCount === 0);

    console.log('\n=== 6. 审批(消费)与收回同时到达:只形成一个终态 ===');
    const certF = await issueCert({ maxUses: 4 });
    const dF = await delegate(certF.id, { quota: 2 });
    const fid = dF.delegation.id;
    const raceResults = await Promise.all([
      consume({ delegationId: fid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: 'RACE-CONSUME' }).catch((e) => ({ threw: e.code })),
      call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: fid, reclaimNonce: 'RACE-RECLAIM' }).catch((e) => ({ threw: e.code }))
    ]);
    const fAfter = (await get('/api/certificates/delegations?certId=' + certF.id))[0];
    const consumeWon = raceResults[0].valid === true;
    ok('并发后授权为单一终态', ['ACTIVE', 'RECLAIMED'].includes(fAfter.status), fAfter.status);
    if (consumeWon) {
      ok('消费先到:通过且随后收回终结(只 1 次扣减)', raceResults[1].returned === 1 && fAfter.status === 'RECLAIMED');
    } else {
      ok('收回先到:消费得到 DELEGATION_RECLAIMED,授权 RECLAIMED 无扣减',
        raceResults[0].code === 'DELEGATION_RECLAIMED' && fAfter.status === 'RECLAIMED');
    }
    const certFview = (await get('/api/certificates')).find((c) => c.id === certF.id);
    ok('无论谁先到,已用+预占 ≤ 总额(无超扣)', certFview.usedCount + certFview.reservedCount <= 4);
    // 终态后再消费/再收回不产生第二状态
    const after = await consume({ delegationId: fid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('终态后消费被拒', !after.valid);
    const recAgain = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: fid, reclaimNonce: nonce() });
    ok('对已收回授权再次收回返回 alreadyTerminal,不二次退回', recAgain.alreadyTerminal === true && recAgain.returned === 0);

    console.log('\n=== 7. 级联停止:凭据作废 / 密钥应急吊销 ===');
    const certG = await issueCert({ maxUses: 4 });
    const dG = await delegate(certG.id, { quota: 2 });
    await call('/api/certificates/revoke', { actorId: 'REG-1', certId: certG.id, reason: '凭据作废演练' });
    const gView = (await get('/api/certificates/delegations?certId=' + certG.id))[0];
    ok('凭据作废后授权转 HALTED', gView.status === 'HALTED' && gView.usableNow === false);
    const gConsume = await consume({ delegationId: dG.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('HALTED 授权消费 → DELEGATION_HALTED', !gConsume.valid && gConsume.code === 'DELEGATION_HALTED');
    const gTree = await get('/api/certificates/quota-tree?certId=' + certG.id);
    ok('额度树包含 CERT_DELEGATION_HALTED 事件', gTree.events.some((e) => e.type === 'CERT_DELEGATION_HALTED'));

    // 已收回授权不受级联影响(保持 RECLAIMED 单终态):certE 在第 5 节被收回,certG 作废不影响它
    const eStillReclaimed = (await get('/api/certificates/delegations?certId=' + certE.id))[0];
    ok('已收回授权不被其他凭据级联改写(仍 RECLAIMED)', eStillReclaimed.status === 'RECLAIMED');
    // 同凭据内:先收回一笔、再作废凭据,已收回的那笔保持 RECLAIMED 不被改成 HALTED
    const certG2 = await issueCert({ maxUses: 5 });
    const reclaimFirst = await delegate(certG2.id, { quota: 2 });
    await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: reclaimFirst.delegation.id, reclaimNonce: nonce() });
    const haltSecond = await delegate(certG2.id, { quota: 1 });
    await call('/api/certificates/revoke', { actorId: 'REG-1', certId: certG2.id, reason: '混合终态演练' });
    const g2rows = await get('/api/certificates/delegations?certId=' + certG2.id);
    ok('同凭据:RECLAIMED 授权保持 RECLAIMED、ACTIVE 授权转 HALTED(单一终态不互相覆盖)',
      g2rows.find((d) => d.id === reclaimFirst.delegation.id).status === 'RECLAIMED' &&
      g2rows.find((d) => d.id === haltSecond.delegation.id).status === 'HALTED');

    // 密钥应急吊销:用一把「仅 certH 使用」的密钥,避免波及此前所有凭据(它们用更早的 ACTIVE)。
    // 轮换两次:① 旧 ACTIVE(此前凭据所用)→ROTATED,产生 victim 密钥;② certH 用 victim 签发;
    // 再轮换产生 certH2 用的新 ACTIVE;吊销 victim 只级联 certH。
    await call('/api/cert-keys/rotate', { actorId: 'REG-1' });           // 旧 ACTIVE → ROTATED,victim → ACTIVE
    const certH = await issueCert({ maxUses: 4 });                       // certH 用 victim
    const victimKid = certH.keyId;
    await call('/api/cert-keys/rotate', { actorId: 'REG-1' });           // victim → ROTATED,新 ACTIVE 产生
    const certH2 = await issueCert({ maxUses: 4 });                      // certH2 用新 ACTIVE
    const dH = await delegate(certH.id, { quota: 2 });
    const dH2 = await delegate(certH2.id, { quota: 2 });
    ok('certH 与 certH2 使用不同密钥(吊销隔离前提)', certH2.keyId !== victimKid);
    await call('/api/cert-keys/revoke', { actorId: 'REG-1', keyId: victimKid });
    const hView = (await get('/api/certificates/delegations?certId=' + certH.id))[0];
    const h2View = (await get('/api/certificates/delegations?certId=' + certH2.id))[0];
    ok('被吊销密钥签发凭据的授权 HALTED', hView.status === 'HALTED');
    ok('其他(新)密钥签发凭据的授权仍 ACTIVE(不误伤)', h2View.status === 'ACTIVE' && h2View.usableNow);
    const hConsume = await consume({ delegationId: dH.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('密钥吊销后消费拒绝(顺带密钥闸 KEY/DELEGATION_HALTED)', !hConsume.valid);
    // 级联停止后仍可收回吗?明确返回 HALTED 拒绝(终态唯一)
    const recHalted = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: dH.delegation.id, reclaimNonce: nonce() });
    ok('对 HALTED 授权收回被拒 DELEGATION_HALTED(终态不被改写)', recHalted.rejected && recHalted.code === 'DELEGATION_HALTED');

    console.log('\n=== 8. 并发争抢额度:同授权多请求 + 不同授权抢总池,均不超扣 ===');
    const certJ = await issueCert({ maxUses: 3 });
    const dJ = await delegate(certJ.id, { quota: 3 });
    const jid = dJ.delegation.id;
    const jrs = await Promise.all(['J1', 'J2', 'J3', 'J4', 'J5'].map((n) =>
      consume({ delegationId: jid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: n })
        .catch((e) => ({ threw: e.code }))));
    ok('5 个不同流水并发抢 3 次:恰 3 成功', jrs.filter((r) => r.valid).length === 3, JSON.stringify(jrs.map((r) => r.code)));
    ok('另 2 笔 DELEGATION_EXHAUSTED', jrs.filter((r) => !r.valid && r.code === 'DELEGATION_EXHAUSTED').length === 2);
    const jView = (await get('/api/certificates')).find((c) => c.id === certJ.id);
    ok('父凭据 usedCount 恰 3(无超扣)', jView.usedCount === 3);
    // 相同流水并发:全部返回同一首裁,只扣一次
    const same = await Promise.all(['S1', 'S1', 'S1'].map(() =>
      consume({ delegationId: jid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: 'SAME-X' })
        .catch((e) => ({ threw: e.code }))));
    ok('同流水并发三笔:0 新增扣减(均耗尽或重放),计数仍 3',
      same.every((r) => r.replayed || r.code === 'DELEGATION_EXHAUSTED') && (await get('/api/certificates')).find((c) => c.id === certJ.id).usedCount === 3);

    console.log('\n=== 9. 失败后重试 / 篡改信封:首裁确定,失败不扣次 ===');
    const certK = await issueCert({ maxUses: 3 });
    const dK = await delegate(certK.id, { quota: 2 });
    const kn = nonce();
    const f1 = await consume({ delegationId: dK.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-X', purpose: 'DUE_DILIGENCE', nonce: kn });
    const f2 = await consume({ delegationId: dK.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: kn });
    ok('先失败(错操作人)后用同流水重试:仍返回首次失败结论', !f1.valid && f2.replayed && f2.code === 'OPERATOR_FORBIDDEN');
    // 携带篡改信封:密码学闸先于扣次
    const env = (await get('/api/certificates')).find((c) => c.id === certK.id).envelope;
    const tam = JSON.parse(JSON.stringify(env)); tam.claims.d.qty = 42;
    const tamRes = await consume({ delegationId: dK.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce(), envelope: tam });
    ok('篡改信封消费 → PAYLOAD_TAMPERED 不扣次', !tamRes.valid && tamRes.code === 'PAYLOAD_TAMPERED');
    const goodEnv = await consume({ delegationId: dK.delegation.id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce(), envelope: env });
    ok('携带原始信封的合规消费通过', goodEnv.valid);
    const kAfter = (await get('/api/certificates')).find((c) => c.id === certK.id);
    ok('全部失败未扣次 + 一次成功 = 父已用 1', kAfter.usedCount === 1, 'used=' + kAfter.usedCount);

    console.log('\n=== 10. 监管额度树:父级凭据视角完整对账 + 先后事件 ===');
    // certD:总额 4,直接 1 + 受托 1 = 已用 2,受托授权(3-1)=预占 2
    const treeD = await get('/api/certificates/quota-tree?certId=' + certD.id);
    ok('额度树(certD):总额 4 / 已用 2 / 预占 2',
      treeD.parent.maxUses === 4 && treeD.parent.usedCount === 2 && treeD.parent.reservedCount === 2, JSON.stringify(treeD.parent));
    ok('额度树对账 withinLimit 且各授权已用合计 1',
      treeD.reconciliation.withinLimit && treeD.reconciliation.sumDelegationUsed === 1);

    // certX:两机构(dxA 3、dxB 2)全部用罄,另直接核验 5,合计 10
    const tree = await get('/api/certificates/quota-tree?certId=' + certX.id);
    ok('certX 额度树:总额 10 / 已用 10 / 预占 0(两机构各自用罄)',
      tree.parent.maxUses === 10 && tree.parent.usedCount === 10 && tree.parent.reservedCount === 0, JSON.stringify(tree.parent));
    ok('额度树包含两笔受托授权', tree.delegations.length === 2);
    ok('对账 withinLimit 且各授权已用合计 5(dxA 3 + dxB 2)',
      tree.reconciliation.withinLimit && tree.reconciliation.sumDelegationUsed === 5,
      'sum=' + tree.reconciliation.sumDelegationUsed);
    const seqList = tree.events.map((e) => e.seq);
    ok('事件严格按链上序号升序', seqList.every((x, i) => i === 0 || x > seqList[i - 1]));
    ok('事件含 委托 + 受托消费',
      tree.events.some((e) => e.type === 'CERT_QUOTA_DELEGATED') &&
      tree.events.some((e) => e.type === 'CERT_DELEGATED_VERIFIED'));
    ok('委托/消费/拒绝全部有审计留痕(certX 有 DELEGATION_EXHAUSTED 拒绝)',
      (await get('/api/certificates/delegations/audit?certId=' + certX.id)).some((a) => a.outcome === 'REJECTED'));
    const audit = await get('/api/certificates/audit');
    ok('审计汇总:委托/消费/拒绝计数与无超扣', audit.chain.ok && audit.delegations.total > 0 && audit.delegations.overbooked.length === 0 && audit.delegations.auditDenied > 0);
    // 合作机构视图只看到自己的授权
    const cmbOnly = await get('/api/certificates/delegations?granteeId=FIN-CMB&usable=true');
    ok('合作机构 usable 视图只含当前可用授权', cmbOnly.every((d) => d.usableNow && d.granteeId === 'FIN-CMB') && cmbOnly.length >= 1);

    console.log('\n=== 11. SIGKILL 断电恢复:额度、授权状态、首次裁决不回退 ===');
    const certP = await issueCert({ maxUses: 4 });
    const dP = await delegate(certP.id, { quota: 3, delegateNonce: 'PERSIST-DL' });
    const pid = dP.delegation.id;
    const pn = 'PERSIST-DL-N1';
    const p1 = await consume({ delegationId: pid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: pn });
    ok('断电前受托消费成功:授权余 2 / 父余 3', p1.valid && p1.verdict.delegationRemaining === 2 && p1.verdict.remaining === 3);
    // 再做一笔失败裁决(错误场景),验证失败结论也持久
    const pfn = 'PERSIST-DL-FAIL';
    await consume({ delegationId: pid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'INSURANCE', nonce: pfn });
    const beforeHead = (await get('/api/state')).audit.chain.head;

    srv.kill('SIGKILL');
    await new Promise((r) => srv.on('exit', r));
    srv = startServer();
    if (!(await waitReady())) throw new Error('服务重启超时');

    const pCert = (await get('/api/certificates')).find((c) => c.id === certP.id);
    const pDel = (await get('/api/certificates/delegations?certId=' + certP.id)).find((d) => d.id === pid);
    ok('重启后父已用 1、授权已用 1、剩余 2(不回退)', pCert.usedCount === 1 && pDel.usedCount === 1 && pDel.remaining === 2);
    ok('重启后预占恢复(可分配 = 4-1-2 = 1)', pCert.reservedCount === 2 && pCert.delegatableRemaining === 1);
    const pReplay = await consume({ delegationId: pid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: pn });
    ok('重启后成功流水重放:返回首次通过,计数不变', pReplay.replayed && pReplay.valid && pReplay.verdict.delegationRemaining === 2);
    const pFailReplay = await consume({ delegationId: pid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'INSURANCE', nonce: pfn });
    ok('重启后失败流水重放:仍返回首次失败 SCENARIO_MISMATCH', pFailReplay.replayed && pFailReplay.code === 'SCENARIO_MISMATCH');
    // 重启后收回,退回 2
    const pRec = await call('/api/certificates/delegations/reclaim', { actorId: 'REG-1', delegationId: pid, reclaimNonce: 'PERSIST-REC' });
    ok('重启后收回成功,退回 2,授权 RECLAIMED', pRec.returned === 2 && pRec.delegation.status === 'RECLAIMED');
    const afterHead = (await get('/api/state')).audit.chain.head;
    ok('重启后链头在新事务后继续衔接且验签通过(断点前 head 为其后缀)', (await get('/api/state')).audit.chain.ok && afterHead !== beforeHead);
    const pOldUse = await consume({ delegationId: pid, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: nonce() });
    ok('重启+收回后旧授权仍不可用', !pOldUse.valid && pOldUse.code === 'DELEGATION_RECLAIMED');
    // 断电前的委托 nonce 重放:返回同一授权,不二次预占
    const pDelReplay = await delegate(certP.id, { quota: 3, delegateNonce: 'PERSIST-DL' });
    ok('重启后委托 nonce 重放返回原授权(RECLAIMED),不新建', pDelReplay.replayed && pDelReplay.delegation.id === pid);

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
