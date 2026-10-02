/**
 * cert-delegation-pages.mjs —— 机构级查验额度委托 页面级端到端
 * (零依赖,自起停服务,mini-dom 真实执行页面脚本)
 *
 * 覆盖:
 *  - 权利证明中心:证明行「委托额度」弹窗 → 提交预占 → 委托台账渲染 → 收回;
 *  - 合作机构页:可用授权列表、白名单/场景/越权拒绝、受托查验扣次、相同流水首裁;
 *  - 监管页:按父凭据加载额度树(父额度 + 各机构节点 + 先后事件)。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { createBrowser } from './mini-dom.mjs';

const PORT = process.env.CERTDLPAGE_PORT || '3195';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_CERTDLPAGE_DB || '/tmp/ewr-certdlpage-db.json';

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
  if (!json.ok) { const e = new Error(json.error.message); e.code = json.error.code; throw e; }
  return json.data;
}
const get = async (p) => (await (await fetch(BASE + p)).json()).data;
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/audit')).ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

async function main() {
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  const srv = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT, EWR_DB_FILE: DB_FILE },
    stdio: 'ignore'
  });
  try {
    if (!(await waitReady())) throw new Error('服务启动超时');
    await call('/api/admin/reset');
    const vb = (await get('/api/state')).valuationBatches[0].id;
    await call('/api/pledges/lock', { reqId: 'LK-PG', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
    await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: 'PL0001', registrationNo: 'REG-PG', expectedVersion: 1 });
    // 准备一张限额凭据 + 一个直接后端委托(供合作机构页消费)
    const cert = await call('/api/certificates/issue', {
      actorId: 'FIN-ICBC', receiptId: 'WR0001', purpose: 'DUE_DILIGENCE', ttlDays: 7, maxUses: 6, issueNonce: 'PAGE-CERT'
    });
    const certId = cert.certificate.id;
    const backendDl = await call('/api/certificates/delegate', {
      actorId: 'FIN-ICBC', certId, granteeId: 'FIN-CMB', quota: 2, scenario: 'DUE_DILIGENCE',
      operatorIds: ['OP-1', 'OP-2'], delegateNonce: 'PAGE-DL'
    });
    const backendDlId = backendDl.delegation.id;

    console.log('\n=== A. 权利证明中心:委托弹窗 → 提交 → 台账 → 收回 ===');
    const page = createBrowser(BASE);
    page.load('common.js'); page.load('cert-core.js'); page.load('qrcode.js'); page.load('certificates.js');
    await page.flush(300);
    // 证明行含「委托额度」按钮(限次且 ACTIVE)
    const certRowHtml = page.byId('tbl-certs').innerHTML;
    ok('证明台账出现「委托额度」按钮', certRowHtml.includes('openDelegate(&quot;' + certId + '&quot;)'), certRowHtml.slice(0, 200));
    // 打开委托弹窗并填表
    await page.evalAsync(`openDelegate(${JSON.stringify(certId)})`);
    await page.flush(40);
    ok('委托弹窗渲染(受托机构/次数/场景/时间/操作人)',
      /确认委托/.test(page.byId('modal-mask').innerHTML) && page.byId('dl-grantee') && page.byId('dl-operators'));
    page.byId('dl-grantee').value = 'FIN-CMB';
    page.byId('dl-quota').value = '3';
    page.byId('dl-operators').value = 'OP-7, OP-8';
    await page.evalAsync(`doDelegate(${JSON.stringify(certId)})`);
    await page.flush(500);
    const certsNow = await get('/api/certificates');
    const newDl = (await get('/api/certificates/delegations?certId=' + certId)).find((d) => d.quota === 3 && d.operatorIds.includes('OP-7'));
    ok('页面委托成功:新增配额 3、操作人 OP-7/8 的授权', !!newDl && newDl.granteeId === 'FIN-CMB');
    const cview = certsNow.find((c) => c.id === certId);
    ok('父凭据预占 = 2(后端)+3(页面)=5、可分 1', cview.reservedCount === 5 && cview.delegatableRemaining === 1, JSON.stringify({ r: cview.reservedCount, f: cview.delegatableRemaining }));
    // 委托台账渲染两笔
    await page.flush(100);
    const dlRows = page.byId('tbl-delegations').querySelectorAll('tbody tr');
    ok('委托台账渲染 2 行(含配额与受托机构)', dlRows.length === 2 && /FIN-CMB|远航/.test(page.byId('tbl-delegations').innerHTML));
    // 超额委托被拒(可分仅 1,弹窗里再提 3)
    await page.evalAsync(`openDelegate(${JSON.stringify(certId)})`);
    await page.flush(40);
    page.byId('dl-grantee').value = 'FIN-CMB';
    page.byId('dl-quota').value = '3';
    page.byId('dl-operators').value = 'OP-9';
    await page.evalAsync(`doDelegate(${JSON.stringify(certId)})`);
    await page.flush(500);
    const noExtra = (await get('/api/certificates/delegations?certId=' + certId)).filter((d) => d.operatorIds.includes('OP-9'));
    ok('超额委托未产生授权(DELEGATION_QUOTA_EXCEEDED)', noExtra.length === 0);
    // 页面收回后端那笔(配额 2)
    await page.evalAsync(`reclaimDelegation(${JSON.stringify(backendDlId)})`);
    await page.flush(500);
    const reclaimed = (await get('/api/certificates/delegations?certId=' + certId)).find((d) => d.id === backendDlId);
    ok('页面收回成功:授权 RECLAIMED、退回未用 2', reclaimed.status === 'RECLAIMED');
    const cview2 = (await get('/api/certificates')).find((c) => c.id === certId);
    ok('收回后预占降为 3、可分恢复 3', cview2.reservedCount === 3 && cview2.delegatableRemaining === 3);

    console.log('\n=== B. 合作机构页:可用授权 / 拒绝 / 受托查验 / 流水首裁 ===');
    // 先给 FIN-CMB 准备一笔干净的可消费授权(配额 2,场景 DUE_DILIGENCE)
    const cert2 = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 7, maxUses: 4, issueNonce: 'PAGE-CERT-2'
    });
    const cert2Id = cert2.certificate.id;
    const dl2 = await call('/api/certificates/delegate', {
      actorId: 'REG-1', certId: cert2Id, granteeId: 'FIN-CMB', quota: 2, scenario: 'DUE_DILIGENCE',
      operatorIds: ['OP-1'], delegateNonce: 'PAGE-DL-2'
    });
    const dl2Id = dl2.delegation.id;

    const partner = createBrowser(BASE);
    partner.load('common.js'); partner.load('cert-core.js'); partner.load('partner.js');
    await partner.flush(300);
    ok('合作机构下拉填充(金融机构)', partner.byId('p-grantee').querySelectorAll('option').length === 2);
    // 显式选 FIN-CMB 并等待列表加载
    partner.evalInPage(`document.getElementById('p-grantee').value='FIN-CMB'`);
    ok('下拉可切到 FIN-CMB', partner.byId('p-grantee').value === 'FIN-CMB', partner.byId('p-grantee').value);
    await partner.evalAsync('loadMyDelegations()');
    await partner.flush(100);
    const dlHtml = partner.document.querySelector('#tbl-dl tbody').innerHTML;
    ok('授权列表展示本机构授权与「查验」按钮', dlHtml.includes(dl2Id) && dlHtml.includes('查验'), dlHtml.slice(0, 200));

    // 错误操作人 → 拒绝
    partner.byId('c-delegation').value = dl2Id;
    partner.byId('c-purpose').value = 'DUE_DILIGENCE';
    partner.byId('p-operator').value = 'OP-X';
    // 固定业务流水,验证首裁:先在页面提交一次失败,再用同流水以正确操作人提交
    partner.evalInPage(`document.getElementById('c-envelope').value=''`);
    // 直接调用后端绑定的 doConsume 不便固定 nonce,改为通过 evalAsync 直接打 API 模拟页面 fetch 路径
    const deny = await call('/api/certificates/delegations/consume', {
      delegationId: dl2Id, granteeId: 'FIN-CMB', operatorId: 'OP-X', purpose: 'DUE_DILIGENCE', nonce: 'PAGE-VF-1'
    });
    ok('错误操作人拒绝 OPERATOR_FORBIDDEN 不扣次', !deny.valid && deny.code === 'OPERATOR_FORBIDDEN');
    const replay = await call('/api/certificates/delegations/consume', {
      delegationId: dl2Id, granteeId: 'FIN-CMB', operatorId: 'OP-1', purpose: 'DUE_DILIGENCE', nonce: 'PAGE-VF-1'
    });
    ok('相同流水换正确操作人仍返回首次失败结论', replay.replayed && replay.code === 'OPERATOR_FORBIDDEN');

    // 页面按钮路径真实扣次:点「查验」带入授权,设置合法操作人后提交
    await partner.evalAsync(`fillConsume(${JSON.stringify(dl2Id)},"DUE_DILIGENCE")`);
    await partner.flush(30);
    partner.byId('p-operator').value = 'OP-1';
    // 让本次 nonce 可预测:临时把 EWR.genReqId 固定(mini-dom 内直接改 window)
    partner.evalInPage(`EWR.genReqId = () => 'PAGE-VF-OK'`);
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    const resultHtml = partner.byId('c-result').innerHTML;
    ok('页面受托查验通过(含授权号与通过标记)', /受托查验通过/.test(resultHtml) && resultHtml.includes(dl2Id), resultHtml.slice(0, 200));
    const dl2Mid = (await get('/api/certificates/delegations?certId=' + cert2Id)).find((d) => d.id === dl2Id);
    ok('查验后后端授权剩余恰为 1', dl2Mid.usedCount === 1 && dl2Mid.remaining === 1);
    const vfRows = partner.document.querySelectorAll('#tbl-vf tbody tr');
    ok('本机构查验回放出现记录', vfRows.length >= 2); // 1 失败(OP-X)+ 1 成功
    // 再点一次(新 nonce)扣到 0
    partner.evalInPage(`EWR.genReqId = () => 'PAGE-VF-OK2'`);
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    // 第三次应耗尽
    partner.evalInPage(`EWR.genReqId = () => 'PAGE-VF-OK3'`);
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    ok('第三次页面查验显示 DELEGATION_EXHAUSTED', /DELEGATION_EXHAUSTED/.test(partner.byId('c-result').innerHTML));
    const dl2After = (await get('/api/certificates/delegations?certId=' + cert2Id)).find((d) => d.id === dl2Id);
    ok('授权恰用 2 次、父凭据恰用 2(无超扣)', dl2After.usedCount === 2 && (await get('/api/certificates')).find((c) => c.id === cert2Id).usedCount === 2);

    // 越权机构视角看不到/不能用:切到 FIN-ICBC
    partner.byId('p-grantee').value = 'FIN-ICBC';
    await partner.evalAsync('loadMyDelegations()');
    await partner.flush(300);
    ok('FIN-ICBC 视角不含 FIN-CMB 的授权 ' + dl2Id, !partner.document.querySelector('#tbl-dl tbody').innerHTML.includes(dl2Id));

    console.log('\n=== C. 监管页:按父凭据加载额度树 ===');
    const reg = createBrowser(BASE);
    reg.load('common.js'); reg.load('regulator.js');
    await reg.flush(300);
    reg.byId('qt-cert').value = cert2Id;
    await reg.evalAsync('loadQuotaTree()');
    await reg.flush(400);
    const summary = reg.byId('qt-summary').innerHTML;
    ok('额度树父额度卡渲染(总额/已用/预占/对账)', /总额度 4/.test(summary) && /无超扣|≤/.test(summary));
    const qtRows = reg.byId('tbl-qt').querySelectorAll('tbody tr');
    ok('额度树展示受托机构节点', qtRows.length >= 1 && new RegExp(dl2Id).test(reg.byId('tbl-qt').innerHTML));
    const evRows = reg.byId('tbl-qt-events').querySelectorAll('tbody tr');
    ok('额度树展示先后事件(委托/消费)', evRows.length >= 2 && /查验额度委托/.test(reg.byId('tbl-qt-events').innerHTML));
    // 全局事件流含委托事件中文名
    ok('监管全局事件流出现委托/受托消费中文名',
      /查验额度委托/.test(reg.byId('tbl-events').innerHTML) && /受托机构查验通过/.test(reg.byId('tbl-events').innerHTML));
    // 证明审计面板含委托对账
    ok('证明审计面板展示机构委托统计与无超扣', /机构委托/.test(reg.byId('audit-certs').innerHTML) && /无超扣/.test(reg.byId('audit-certs').innerHTML));

    console.log(`\n================ 委托页面端到端:${passed} 通过,${fails.length} 失败 ================`);
    if (fails.length) { console.log('失败项:', fails); process.exitCode = 1; }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    rmSync(DB_FILE, { force: true });
  }
  if (fails.length) process.exit(1);
}
main().catch((e) => { console.error('委托页面端到端异常:', e); process.exit(1); });
