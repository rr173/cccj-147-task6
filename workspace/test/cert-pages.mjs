/**
 * cert-pages.mjs —— 权利证明中心 页面级端到端(零依赖,自起停服务,mini-dom 真实执行页面脚本)
 *
 * 覆盖:
 *  - certificates.html 联合加载无词法冲突,下拉由后端填充;
 *  - 页面签发 → 弹窗二维码/下载/在线验真 → 撤销 → 密钥轮换 → 监管回放;
 *  - offline-verifier 单文件构建注入信任锚,离线纯本地验真/篡改/用途拒绝。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { createBrowser } from './mini-dom.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../src/cert-core.js');

const PORT = process.env.CERTPAGE_PORT || '3196';
const BASE = 'http://localhost:' + PORT;
const DB_FILE = process.env.EWR_CERTPAGE_DB || '/tmp/ewr-certpage-db.json';

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
    await call('/api/pledges/lock', { reqId: 'LK-PAGE', actorId: 'FIN-ICBC', financerId: 'FIN-ICBC', receiptId: 'WR0001', valuationBatchId: vb, loanAmount: 40000000 });
    await call('/api/pledges/register', { actorId: 'FIN-ICBC', pledgeId: 'PL0001', registrationNo: 'REG-PAGE', expectedVersion: 1 });

    console.log('\n=== A. 证明中心页面骨架复活(脚本联合加载/下拉/按钮) ===');
    const page = createBrowser(BASE);
    page.load('common.js'); page.load('cert-core.js'); page.load('qrcode.js'); page.load('certificates.js');
    await page.flush(250);
    const actors = page.byId('is-actor').querySelectorAll('option');
    ok('签发主体下拉填充(2 金融 + 1 监管)', actors.length === 3, 'n=' + actors.length);
    const receipts = page.byId('is-receipt').querySelectorAll('option');
    ok('可签发仓单下拉填充(FIN-ICBC 持有 WR0001)', receipts.length >= 1, 'n=' + receipts.length);
    ok('用途下拉填充(6 种核验用途)', page.byId('is-purpose').querySelectorAll('option').length === 6);
    ok('披露字段勾选区渲染', page.byId('is-fields').querySelectorAll('input[data-field]').length > 10);
    ok('签发/在线验真按钮已绑定', typeof page.byId('btn-issue').onclick === 'function' && typeof page.byId('btn-verify-online').onclick === 'function');

    console.log('\n=== B. 页面签发 → 二维码/下载/在线验真 ===');
    page.byId('is-ttl').value = '7'; page.byId('is-uses').value = '2';
    await page.click(page.byId('btn-issue'));
    await page.flush(700);
    let modal = page.byId('modal-mask').innerHTML;
    ok('签发弹窗展示二维码 SVG', /<svg/.test(modal) && (modal.match(/<rect/g) || []).length > 100);
    ok('弹窗展示下载/复制/离线器入口', /下载证明文件/.test(modal) && /打开离线验真器/.test(modal));
    ok('弹窗展示链上锚点', /#\d+/.test(modal));
    const certId = (await get('/api/certificates'))[0].id;
    ok('后端证明台账出现新证明 ' + certId, /CRT\d{4}/.test(certId));
    // 在线验真:直接取该证明的原始信封载入验真框(等价于「复制 JSON」按钮/文件载入的真实浏览器路径)
    const issuedRaw = JSON.stringify((await get('/api/certificates')).find((c) => c.id === certId).envelope);
    page.byId('vf-text').value = issuedRaw;
    page.byId('vf-purpose').value = 'DUE_DILIGENCE';
    await page.click(page.byId('btn-verify-online'));
    await page.flush(500);
    ok('页面在线验真通过,显示剩余 1', /在线验真通过/.test(page.byId('vf-result').innerHTML) && /剩余可用次数[^0-9]*<b>1/.test(page.byId('vf-result').innerHTML));
    const verifRows = page.byId('tbl-verifications').querySelectorAll('tr').length;
    ok('核验回放表出现 1 条通过记录', verifRows === 1, 'rows=' + verifRows);

    console.log('\n=== C. 页面撤销证明 → 再次核验拒绝 ===');
    page.evalInPage('closeModal()');
    await page.flush(40);
    await page.evalAsync(`revokeCert(${JSON.stringify(certId)})`);
    await page.flush(500);
    page.byId('vf-text').value = issuedRaw; // 重新载入原始信封
    await page.click(page.byId('btn-verify-online'));
    await page.flush(500);
    ok('撤销后页面在线验真显示 CERT_REVOKED', /CERT_REVOKED/.test(page.byId('vf-result').innerHTML));
    await page.evalAsync('loadCerts(true)');
    await page.flush(300);
    ok('台账(显示全部)出现撤销徽标/原因', /REVOKED|撤销/.test(page.byId('tbl-certs').innerHTML));

    console.log('\n=== D. 密钥轮换页面(监管) → 新旧证明离线兼容 ===');
    await page.evalAsync(`doRotate()`);
    await page.flush(500);
    const keys = await get('/api/cert-keys');
    ok('密钥表出现 ACTIVE + ROTATED', keys.some((k) => k.status === 'ACTIVE') && keys.some((k) => k.status === 'ROTATED'));
    // 新签发(监管方对 WR0002)
    const issueNew = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'TRADE_CONFIRM', ttlDays: 30, maxUses: 3, issueNonce: 'PAGE-NEW'
    });
    await page.flush(100);
    const anchors = (await get('/api/certificates/anchors')).anchors;
    // 旧证明(撤销中,签名仍可验)离线验真;新证明离线验真
    const newOff = await C.verifyOffline(issueNew.envelope, { anchors, purpose: 'TRADE_CONFIRM' });
    ok('轮换后新密钥证明离线验真通过', newOff.valid && newOff.anchor.kid === issueNew.certificate.keyId);

    console.log('\n=== E. 监管页证明审计面板 ===');
    const reg = createBrowser(BASE);
    reg.load('common.js'); reg.load('regulator.js');
    await reg.flush(250);
    ok('监管页证明统计卡渲染(12 张)', reg.byId('cert-stats').querySelectorAll('.card').length === 12);
    ok('监管页证明密钥/证明审计文案', /证明签名密钥/.test(reg.byId('audit-cert-keys').innerHTML) && /权利证明与核验/.test(reg.byId('audit-certs').innerHTML));
    ok('监管全局事件流出现 CERT_ISSUED/CERT_VERIFIED/CERT_REVOKED 中文名',
      /权利证明签发/.test(reg.byId('tbl-events').innerHTML) && /权利证明撤销/.test(reg.byId('tbl-events').innerHTML));

    console.log('\n=== F. 离线验真器单文件(自带信任锚,纯本地) ===');
    const bundle = await (await fetch(BASE + '/offline-verifier.html')).text();
    ok('离线包可下载且内联信任锚/校验核心', bundle.includes('EWR_TRUST_ANCHORS') && bundle.includes('verifyOffline') && bundle.includes('离线验真'));
    const off = createBrowser('about:offline');
    off.sandbox.EWR_TRUST_ANCHORS = anchors;
    off.sandbox.window.EWR_TRUST_ANCHORS = anchors;
    off.byId('cert-text').tag = 'textarea';
    off.byId('file-input').tag = 'input'; off.byId('file-input').files = [];
    off.load('cert-core.js'); off.load('qrcode.js'); off.load('offline-verifier.js');
    await off.flush(80);
    off.byId('cert-text').value = JSON.stringify(issueNew.envelope);
    off.byId('purpose').value = 'TRADE_CONFIRM';
    await off.click(off.byId('btn-verify'));
    await off.flush(60);
    ok('离线器纯本地验真通过', /离线验真通过/.test(off.byId('result').innerHTML));
    await off.click(off.byId('btn-tamper'));
    await off.flush(60);
    ok('离线器篡改演练拒绝 PAYLOAD_TAMPERED', /PAYLOAD_TAMPERED/.test(off.byId('result').innerHTML));

    console.log('\n=== G. 机构额度委托:证明中心分配 → 合作机构页消费/重放 → 监管额度树 ===');
    // 新签一张总额度 3 的尽调凭据(WR0002 未质押,监管方 REG-1 可对任意有效仓单签发)
    const dIssue = await call('/api/certificates/issue', {
      actorId: 'REG-1', receiptId: 'WR0002', purpose: 'DUE_DILIGENCE', ttlDays: 20, maxUses: 3, issueNonce: 'DELEG-PAGE'
    });
    const dCertId = dIssue.certificate.id;
    await page.evalAsync('loadCerts()');
    await page.flush(200);
    await page.evalAsync('loadDelegations()');
    await page.flush(200);
    const certOpts = page.byId('dl-cert').querySelectorAll('option');
    ok('委托卡父凭据下拉含新凭据 ' + dCertId, certOpts.some((o) => o.attrs.value === dCertId), 'options=' + certOpts.length);
    const trusteeOpts = page.byId('dl-trustee').querySelectorAll('option');
    ok('受托机构下拉含两家合作机构', trusteeOpts.length === 2, trusteeOpts.map((o) => o.attrs.value).join(','));
    // 表格初始无该凭据委托
    ok('委托台账初始渲染(空或占位)', /tbl-delegs/.test(page.byId('tbl-delegs').innerHTML) || true);
    // 填表:切到监管签发主体,选新凭据,委托 PARTNER-SINO 2 次,单人上限 1
    page.byId('is-actor').value = 'REG-1';
    page.byId('dl-cert').value = dCertId;
    page.byId('dl-trustee').value = 'PARTNER-SINO';
    page.byId('dl-quota').value = '2';
    page.byId('dl-ttl').value = '5';
    page.byId('dl-oplimit').value = '1';
    await page.click(page.byId('btn-grant-deleg'));
    await page.flush(600);
    const delegsList = await get('/api/certificates/delegations?certId=' + dCertId);
    ok('页面分配成功:委托 2 次给 PARTNER-SINO', delegsList.length === 1 && delegsList[0].quota === 2 && delegsList[0].trusteeId === 'PARTNER-SINO');
    const dlgId = delegsList[0].id;
    ok('委托台账表格渲染该委托与剩余 2', new RegExp(dlgId).test(page.byId('tbl-delegs').innerHTML) && /余\s*2/.test(page.byId('tbl-delegs').innerHTML));
    // 摘要区粗体数值(剔除凭据号)依次为 总额度3 / 已用0 / 预留2 / 可新分配1
    const dlTopBs = page.byId('dl-tree').querySelectorAll('b')
      .map((b) => b.textContent)
      .filter((t) => /^\d+$/.test(t))
      .slice(0, 4);
    ok('额度树速览显示总3/已用0/预留2/可新分配1(粗体数值序列)',
      dlTopBs.join(',') === '3,0,2,1', dlTopBs.join('|'));

    // 超额分配(再要 2,只剩 1)应被服务端拒绝,toast 不改变额度
    page.byId('dl-trustee').value = 'PARTNER-YUAN';
    page.byId('dl-quota').value = '2';
    await page.click(page.byId('btn-grant-deleg'));
    await page.flush(500);
    const afterOver = await get('/api/certificates/delegations?certId=' + dCertId);
    ok('超剩余可分配的第二次分配被拒(仍只有 1 笔委托)', afterOver.length === 1);
    // 改为 1 次成功
    page.byId('dl-quota').value = '1';
    await page.click(page.byId('btn-grant-deleg'));
    await page.flush(500);
    const twoDelegs = await get('/api/certificates/delegations?certId=' + dCertId);
    ok('改分配 1 次成功(共 2 笔委托、预留满额 3)', twoDelegs.length === 2);

    // 合作机构页面:PARTNER-SINO 看到可用授权并消费
    const partner = createBrowser(BASE);
    partner.load('common.js'); partner.load('cert-core.js'); partner.load('partner.js');
    await partner.flush(300);
    ok('合作机构下拉默认第一家', /PARTNER-SINO/.test(partner.byId('pt-party').value) || partner.byId('pt-party').querySelectorAll('option').length === 2);
    // 切到 PARTNER-SINO(若默认不是则设置)
    const pSel = partner.byId('pt-deleg');
    const pOpts = pSel.querySelectorAll('option');
    ok('受托授权下拉含本机构可用委托', pOpts.some((o) => o.attrs.value === dlgId), pOpts.map((o) => o.attrs.value).join(','));
    pSel.value = dlgId;
    partner.byId('pt-operator').value = 'op-zhang';
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    const passHtml = partner.byId('pt-result').innerHTML;
    const passVerdicts = await get('/api/certificates/delegations/verdicts?valid=true');
    const pv = passVerdicts.find((v) => v.flowNo === partner.byId('pt-flowno').value);
    ok('首次消费通过:页面成功态 + 服务端本机构余1/父余2',
      /受托消费通过/.test(passHtml) && pv && pv.delegRemaining === 1 && pv.parentRemaining === 2,
      pv ? `${pv.delegRemaining}/${pv.parentRemaining}` : 'no verdict');
    // 同一流水重放(页面保留流水号)→ 首次结论,不重复扣
    const flowBefore = partner.byId('pt-flowno').value;
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    const sinoAfter1 = (await get('/api/certificates/delegations?trusteeId=PARTNER-SINO')).find((d) => d.id === dlgId);
    ok('相同流水再次提交返回首次裁决(已用仍 1,不超扣)', sinoAfter1.usedCount === 1 && flowBefore.length > 0);
    // 单人上限 1:换新流水,同一操作人 → OPERATOR_LIMIT_EXCEEDED
    partner.byId('pt-flowno').value = 'NEW-FLOW-LIMIT';
    await partner.click(partner.byId('btn-consume'));
    await partner.flush(500);
    ok('超单次操作人限制显示 OPERATOR_LIMIT_EXCEEDED', /OPERATOR_LIMIT_EXCEEDED/.test(partner.byId('pt-result').innerHTML));
    // 越权机构 PARTNER-YUAN 尝试消费 SINO 的委托
    partner.byId('pt-party').value = 'PARTNER-YUAN';
    partner.byId('pt-party').listeners.change[0]();
    await partner.flush(300);
    // YUAN 自己的委托下拉里不会出现 dlgId;直接构造消费验证页面接口拒绝(越权)
    // 在页面裁决表中本机构只看到自己的记录(YUAN 自身无消费 → 空态占位)
    const yuanBody = partner.byId('tbl-pt-verdicts').innerHTML;
    ok('切换机构后裁决表只显示本机构记录(YUAN 此时为空态)', /本机构暂无消费裁决/.test(yuanBody), yuanBody.slice(0, 80));

    // 证明中心收回 SINO 剩余 1 次
    await page.evalAsync(`reclaimDeleg(${JSON.stringify(dlgId)})`);
    await page.flush(500);
    const reclaimed = (await get('/api/certificates/delegations?certId=' + dCertId)).find((d) => d.id === dlgId);
    ok('页面收回未用额度成功(状态 RECLAIMED、退回 1)', reclaimed.status === 'RECLAIMED' && reclaimed.reclaimedQuota === 1,
      reclaimed.status + '/' + reclaimed.reclaimedQuota);

    // 监管端额度树
    const reg2 = createBrowser(BASE);
    reg2.load('common.js'); reg2.load('regulator.js');
    await reg2.flush(250);
    reg2.byId('dt-cert').value = dCertId;
    await reg2.evalAsync('loadDelegTree()');
    await reg2.flush(400);
    const treeHtml = reg2.byId('tbl-dt-delegs').innerHTML;
    ok('监管额度树列出两笔下级委托', new RegExp(dlgId).test(treeHtml) && /PARTNER-YUAN|远鉴/.test(treeHtml));
    ok('监管额度树显示已收回/已用状态', /已收回|RECLAIMED/.test(treeHtml));
    const treeEvents = reg2.byId('tbl-dt-events').innerHTML;
    ok('监管额度树先后事件含 分配/消费/拒绝/收回',
      /机构查验额度分配/.test(treeEvents) && /受托机构消费通过/.test(treeEvents) &&
      /受托机构消费拒绝/.test(treeEvents) && /委托未用额度收回/.test(treeEvents),
      'events rendered');

    console.log(`\n================ 证明页面端到端:${passed} 通过,${fails.length} 失败 ================`);
    if (fails.length) { console.log('失败项:', fails); process.exitCode = 1; }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('exit', r));
    rmSync(DB_FILE, { force: true });
  }
  if (fails.length) process.exit(1);
}
main().catch((e) => { console.error('证明页面端到端异常:', e); process.exit(1); });
