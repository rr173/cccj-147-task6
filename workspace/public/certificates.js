/* certificates.js —— 权利证明中心页面脚本
 *
 * 在线签发/核验走平台 API;离线验真在浏览器本地用 EWR_CERT.verifyOffline 完成
 * (与离线验真器单文件同一套密码学核心),下载/扫码/文件三种分发方式齐备。
 */
'use strict';
const {
  api, getState, getJson, toast, badge, fmtTime, esc, openModal, renderTopbar, ewrQrSvg, ewrDownloadText
} = EWR;
const C = window.EWR_CERT;
const QR = window.EWR_QR;

let STATE = null;
let showAllCerts = false;
let lastCerts = [];
let lastDelegs = [];
const SENSITIVE_DEFAULT = ['receiptId', 'receiptStatus', 'receiptVersion', 'qty',
  'warehouseName', 'locationName', 'commodityName', 'gradeName', 'pledgeExists', 'pledgeStatus', 'issuedAtDate'];

document.getElementById('topbar').innerHTML = renderTopbar('cert');

function purposeName(code) {
  const p = C.PURPOSES.find((x) => x.code === code);
  return p ? p.name : code;
}

async function init() {
  STATE = await getState();
  // 签发主体:监管方 + 全部金融机构
  const actors = STATE.parties.filter((p) => p.type === 'regulator' || p.type === 'financer');
  document.getElementById('is-actor').innerHTML = actors
    .map((p) => `<option value="${p.id}">${esc(p.name)}(${p.type === 'regulator' ? '监管方' : '融资方'})</option>`).join('');
  // 默认选融资方
  const fin = actors.find((p) => p.type === 'financer');
  if (fin) document.getElementById('is-actor').value = fin.id;
  renderReceiptOptions();
  // 用途
  document.getElementById('is-purpose').innerHTML =
    C.PURPOSES.map((p) => `<option value="${p.code}">${p.name}</option>`).join('');
  document.getElementById('vf-purpose').innerHTML =
    '<option value="">(不校验用途)</option>' + C.PURPOSES.map((p) => `<option value="${p.code}">${p.name}</option>`).join('');
  renderFieldPicker();
  document.getElementById('is-actor').onchange = renderReceiptOptions;
  await Promise.all([loadCerts(), loadKeys(), loadVerifications(), loadDelegations()]);
}

function renderReceiptOptions() {
  const actorId = document.getElementById('is-actor').value;
  const actor = STATE.parties.find((p) => p.id === actorId);
  const valid = STATE.receipts.filter((r) => r.status === 'ACTIVE' || r.status === 'DELIVERED_PARTIAL');
  let list = valid;
  if (actor && actor.type === 'financer') {
    // 融资方只能签自己持有的存续质押仓单
    list = valid.filter((r) => r.activePledge && r.activePledge.financerId === actorId);
  }
  document.getElementById('is-receipt').innerHTML = list.length
    ? list.map((r) => `<option value="${r.id}">${r.id} · ${esc(r.locationName)} · ${esc(r.gradeName)} · ${EWR.fmtNum(r.qty)}吨${r.activePledge ? ' · 质押 ' + esc(r.activePledge.id) : ''}</option>`).join('')
    : '<option value="">(该主体暂无可签发的仓单;监管方可签任意有效仓单)</option>';
}

function renderFieldPicker() {
  const groups = {};
  C.FIELD_CATALOG.forEach((f) => { (groups[f.group] ||= []).push(f); });
  document.getElementById('is-fields').innerHTML = Object.entries(groups).map(([g, fs]) => `
    <div class="scenario" style="min-width:230px">
      <b>${esc(g)}</b>
      <div class="hr" style="margin:6px 0"></div>
      ${fs.map((f) => `
        <label class="small" style="display:flex;gap:6px;align-items:center;margin:3px 0;${f.always ? 'opacity:.65' : ''}">
          <input type="checkbox" style="width:auto" data-field="${f.key}" ${f.defaultDisclosed || f.always ? 'checked' : ''} ${f.always ? 'disabled' : ''}>
          ${esc(f.name)}${f.sensitive ? ' <span class="tag-bad">敏感</span>' : ''}${f.always ? ' <span class="muted">(必披露)</span>' : ''}
        </label>`).join('')}
    </div>`).join('');
}

window.quickSelectSensitive = () => {
  document.querySelectorAll('#is-fields input[data-field]').forEach((cb) => {
    if (cb.disabled) return;
    cb.checked = SENSITIVE_DEFAULT.includes(cb.dataset.field);
  });
  toast('已只勾选最小披露集:企业身份/估值/融资额全部封存为承诺', 'info', 5000);
};

/* -------------------------------- 签发 -------------------------------- */
document.getElementById('btn-issue').onclick = async () => {
  const actorId = document.getElementById('is-actor').value;
  const receiptId = document.getElementById('is-receipt').value;
  const purpose = document.getElementById('is-purpose').value;
  const ttlDays = Number(document.getElementById('is-ttl').value);
  const usesRaw = document.getElementById('is-uses').value.trim();
  const maxUses = usesRaw === '' || usesRaw === '0' ? null : Number(usesRaw);
  const discloseFields = Array.from(document.querySelectorAll('#is-fields input[data-field]:checked'))
    .map((cb) => cb.dataset.field);
  if (!receiptId) return toast('请选择可签发的仓单', 'error');
  try {
    const res = await api('/api/certificates/issue', {
      actorId, receiptId, purpose, ttlDays, maxUses,
      issueNonce: EWR.genReqId('CERTISSUE'),
      discloseFields
    });
    toast(`证明已签发 ${res.certificate.id},锚点已上链 #${res.certificate.anchorEventSeq}`, 'success', 6000);
    await showCertificate(res);
    await Promise.all([loadCerts(), loadKeys(), loadVerifications()]);
    STATE = await getState();
    renderReceiptOptions();
  } catch (e) {
    toast('签发被拒:' + e.message, 'error', 9000);
  }
};

async function showCertificate(res) {
  const text = JSON.stringify(res.envelope, null, 2);
  const compact = JSON.stringify(res.envelope);
  let qr = '';
  let qrNote = '';
  try {
    const m = QR.encode(compact);
    qr = ewrQrSvg(m.matrix, { px: 220 });
    qrNote = `<div class="small muted">QR v${m.version} · 扫码文本即完整证明(${compact.length} 字节)</div>`;
  } catch (e) {
    qrNote = `<div class="banner warn" style="margin:0">证明较大超过二维码容量,请使用文件下载/粘贴方式验真。</div>`;
  }
  const c = res.certificate;
  openModal(`
    <h2>权利证明 ${esc(c.id)}</h2>
    <dl class="kv">
      <dt>用途</dt><dd>${esc(purposeName(c.purpose))}</dd>
      <dt>有效期</dt><dd>${fmtTime(c.issuedAt)} → ${fmtTime(c.expiresAt)}</dd>
      <dt>可用次数</dt><dd>${c.maxUses == null ? '不限次' : c.maxUses + ' 次'}</dd>
      <dt>披露字段</dt><dd>${c.discloseFields.map((f) => `<span class="badge blue">${esc(f)}</span>`).join(' ')}</dd>
      <dt>链上锚点</dt><dd class="mono small">#${c.anchorEventSeq} · ${esc(c.anchorHash.slice(0, 28))}…</dd>
    </dl>
    <div class="grid cols-2" style="margin-top:8px">
      <div class="scenario" style="text-align:center"><div id="qr-svg">${qr}</div>${qrNote}</div>
      <div class="scenario">
        <b>分发给第三方</b>
        <div class="hr"></div>
        <div class="row-actions" style="flex-direction:column">
          <button class="primary" onclick='downloadCert(${JSON.stringify(c.id)})'>⬇ 下载证明文件(.ewr-cert.json)</button>
          <button onclick='copyCert()'>复制证明 JSON 到剪贴板</button>
          <a class="btn" href="/offline-verifier.html" target="_blank" style="text-align:center">打开离线验真器(断网)</a>
          <button class="ghost" onclick="downloadVerifier()">下载离线验真器单文件</button>
        </div>
      </div>
    </div>
    <h3>证明信封(可复制给第三方)</h3>
    <textarea id="cert-full" rows="10" style="width:100%;font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(text)}</textarea>
  `);
}

window.downloadCert = async (id) => {
  const cert = lastCerts.find((c) => c.id === id);
  if (!cert) return toast('未找到证明', 'error');
  ewrDownloadText(id + '.ewr-cert.json', JSON.stringify(cert.envelope, null, 2));
  toast('证明文件已下载', 'success');
};
window.copyCert = () => {
  const txt = document.getElementById('cert-full').value;
  navigator.clipboard.writeText(txt).then(
    () => toast('证明 JSON 已复制', 'success'),
    () => toast('复制失败,请手动选择文本', 'error')
  );
};
window.downloadVerifier = () => { window.open('/offline-verifier.download', '_blank'); };
window.openOffline = () => window.open('/offline-verifier.html', '_blank');

/* -------------------------------- 证明台账 -------------------------------- */
async function loadCerts(showAll) {
  if (showAll === true) showAllCerts = !showAllCerts;
  lastCerts = await getJson('/api/certificates');
  const now = Date.now();
  let list = lastCerts;
  if (!showAllCerts) list = list.filter((c) => c.status === 'ACTIVE' && c.expiresAt > now);
  const tb = document.querySelector('#tbl-certs tbody');
  tb.innerHTML = list.map((c) => {
    const st = c.status === 'REVOKED' ? badge('REVOKED')
      : c.expiresAt <= now ? '<span class="badge gray">已过期</span>'
      : c.maxUses != null && c.usedCount >= c.maxUses ? '<span class="badge amber">次数耗尽</span>'
      : '<span class="badge green">有效</span>';
    return `<tr>
      <td><b>${c.id}</b><div class="small muted mono">#${c.anchorEventSeq}</div></td>
      <td class="small">${c.receiptId}<div class="muted">${esc(c.issuedByName)}</div></td>
      <td class="small">${esc(purposeName(c.purpose))}<div class="muted mono">${esc(c.purpose)}</div></td>
      <td class="small">${fmtTime(c.issuedAt)}<br><span class="muted">至 ${fmtTime(c.expiresAt)}</span></td>
      <td>${c.maxUses == null ? '不限' : c.usedCount + '/' + c.maxUses}</td>
      <td class="mono small">${esc(c.keyId)}<div class="muted">${esc(c.keyStatus || '')}</div></td>
      <td>${st}${c.revokeReason ? `<div class="small tag-bad">${esc(c.revokeReason)}</div>` : ''}</td>
      <td><div class="row-actions">
        <button class="ghost" onclick='viewCert("${c.id}")'>查看/下载/二维码</button>
        ${c.status === 'ACTIVE' ? `<button class="danger" onclick='revokeCert("${c.id}")'>撤销</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无证明</td></tr>';
}
window.viewCert = (id) => {
  const cert = lastCerts.find((c) => c.id === id);
  if (cert) showCertificate({ certificate: cert, envelope: cert.envelope });
};
window.revokeCert = async (id) => {
  if (!confirm('撤销后该证明在线核验将立即被拒绝(离线验真器仍只能判签名,需联网获知撤销)。确认撤销?')) return;
  const reason = prompt('撤销原因(可选)', '签发方撤销') || '签发方撤销';
  const actorId = document.getElementById('is-actor').value || 'REG-1';
  try {
    await api('/api/certificates/revoke', { actorId, certId: id, reason });
    toast('证明已撤销,其全部下级委托已同步停止', 'success', 7000);
    await Promise.all([loadCerts(), loadVerifications(), loadDelegations()]);
  } catch (e) { toast('撤销失败:' + e.message, 'error'); }
};
document.getElementById('btn-refresh-certs').onclick = async () => {
  STATE = await getState(); renderReceiptOptions();
  await Promise.all([loadCerts(), loadKeys(), loadVerifications(), loadDelegations()]);
};

/* ========================= 机构级查验额度委托 ========================= */
const DELEG_STATUS = {
  ACTIVE: ['green', '生效中'], PENDING_START: ['blue', '待生效'], EXPIRED: ['gray', '已过期'],
  RECLAIMED: ['gray', '已收回'], STOPPED: ['red', '已级联停止'], EXHAUSTED: ['amber', '额度用完']
};

function renderDelegForm() {
  const certSel = document.getElementById('dl-cert');
  const now = Date.now();
  const valid = lastCerts.filter((c) => c.status === 'ACTIVE' && c.expiresAt > now);
  certSel.innerHTML = valid.length
    ? valid.map((c) => `<option value="${c.id}">${c.id} · ${esc(purposeName(c.purpose))} · ${c.maxUses == null ? '不限次' : '总' + c.maxUses + ' 余可分配' + c.delegation.allocatable} · ${esc(c.issuedByName)}</option>`).join('')
    : '<option value="">(暂无有效凭据;请先签发)</option>';
  const trustees = STATE.parties.filter((p) => p.type === 'partner');
  document.getElementById('dl-trustee').innerHTML = trustees.length
    ? trustees.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">(无合作机构)</option>';
  renderDelegTree();
  document.getElementById('dl-cert').addEventListener('change', renderDelegTree);
}

async function loadDelegations() {
  lastDelegs = await getJson('/api/certificates/delegations');
  renderDelegForm();
  const tb = document.querySelector('#tbl-delegs tbody');
  tb.innerHTML = lastDelegs.map((d) => {
    const [cls, text] = DELEG_STATUS[d.liveStatus] || DELEG_STATUS[d.status] || ['gray', d.status];
    return `<tr>
      <td><b>${d.id}</b><div class="small muted">${esc(d.grantedByName)}</div></td>
      <td class="small mono">${d.certId}<div>${esc(purposeName(d.scenario))}</div></td>
      <td class="small">${esc(d.trusteeName)}<div class="muted mono">${esc(d.trusteeId)}</div></td>
      <td><b>${d.usedCount}/${d.quota}</b><div class="small muted">余 ${d.remaining}</div></td>
      <td class="small">${fmtTime(d.startsAt)}<br><span class="muted">至 ${fmtTime(d.endsAt)}</span></td>
      <td class="small">${d.perOperatorLimit == null ? '不限单人' : '单人≤' + d.perOperatorLimit}<div class="muted">${d.operatorAllowlist && d.operatorAllowlist.length ? '名单:' + esc(d.operatorAllowlist.join(',')) : '无名单'}</div></td>
      <td><span class="badge ${cls}">${text}</span>${d.stopReason ? `<div class="small tag-bad">${esc(d.stopReason)}</div>` : ''}${d.reclaimedQuota != null ? `<div class="small muted">收回 ${d.reclaimedQuota}</div>` : ''}</td>
      <td>${d.status === 'ACTIVE' ? `<button class="danger" onclick='reclaimDeleg("${d.id}")'>收回未用额度</button>` : '<span class="muted small">终态</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">暂无委托;在上方为有效凭据分配额度。</td></tr>';
}

async function renderDelegTree() {
  const certId = document.getElementById('dl-cert').value;
  const box = document.getElementById('dl-tree');
  const avail = document.getElementById('dl-available');
  if (!certId) { box.innerHTML = '<span class="muted">无有效凭据</span>'; avail.textContent = ''; return; }
  const tree = await getJson('/api/certificates/delegation-tree?certId=' + certId);
  const t = tree.totals;
  avail.textContent = t.allocatable == null
    ? '不限次凭据,可继续分配'
    : `当前剩余可分配 ${t.allocatable}(总 ${t.maxUses}/已用 ${t.used}/有效委托预留 ${t.activeReserved})`;
  box.innerHTML = `
    <div>凭据 <b class="mono">${certId}</b> · ${esc(purposeName(tree.certificate.purpose))}</div>
    <div class="hr" style="margin:6px 0"></div>
    <div>总额度 <b>${t.maxUses == null ? '∞' : t.maxUses}</b> · 已用 <b>${t.used}</b>
      (持有方直用 ${t.directUsed} / 受托消费 ${t.delegatedUsed})</div>
    <div>有效委托剩余预留 <b>${t.activeReserved}</b> · 仍可新分配 <b>${t.allocatable == null ? '∞' : t.allocatable}</b></div>
    <div class="hr" style="margin:6px 0"></div>
    ${tree.delegations.length ? tree.delegations.map((d) => `
      <div class="small" style="margin:2px 0">
        <span class="mono">${d.id}</span> → ${esc(d.trusteeName)}:
        <b>${d.usedCount}/${d.quota}</b>(余 ${d.remaining}) · ${esc(DELEG_STATUS[d.liveStatus] ? DELEG_STATUS[d.liveStatus][1] : d.status)}
      </div>`).join('') : '<div class="muted small">尚无下级委托</div>'}`;
}

document.getElementById('btn-grant-deleg').onclick = async () => {
  const certId = document.getElementById('dl-cert').value;
  const trusteeId = document.getElementById('dl-trustee').value;
  const quota = Number(document.getElementById('dl-quota').value);
  const ttlDays = Number(document.getElementById('dl-ttl').value);
  const opLimitRaw = document.getElementById('dl-oplimit').value.trim();
  const perOperatorLimit = opLimitRaw === '' ? null : Number(opLimitRaw);
  const operatorAllowlist = document.getElementById('dl-allowops').value
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!certId) return toast('请选择有效父级凭据', 'error');
  if (!trusteeId) return toast('请选择受托合作机构', 'error');
  const cert = lastCerts.find((c) => c.id === certId);
  try {
    const r = await api('/api/certificates/delegations/grant', {
      actorId: document.getElementById('is-actor').value,
      certId, trusteeId, scenario: cert.purpose,
      quota, ttlDays, perOperatorLimit, operatorAllowlist,
      reqId: EWR.genReqId('DLGGRANT')
    });
    toast(`委托 ${r.delegation.id} 已分配给 ${r.delegation.trusteeName}:额度 ${r.delegation.quota},已上链`, 'success', 6000);
    document.getElementById('dl-quota').value = '1';
    await Promise.all([loadCerts(), loadDelegations(), loadVerifications()]);
  } catch (e) { toast('分配被拒:' + e.message, 'error', 9000); }
};
window.reclaimDeleg = async (id) => {
  if (!confirm('收回该委托的未用额度?收回后旧授权立即失效,受托机构无法继续消费(已消耗次数不回收)。')) return;
  try {
    const r = await api('/api/certificates/delegations/reclaim', {
      actorId: document.getElementById('is-actor').value || 'REG-1',
      delegationId: id,
      reqId: EWR.genReqId('DLGRECLAIM')
    });
    toast(`已收回 ${r.returned} 次未用额度并退回凭据池,旧授权已失效`, 'success', 6000);
    await Promise.all([loadCerts(), loadDelegations(), loadVerifications()]);
  } catch (e) { toast('收回失败:' + e.message, 'error'); }
};
document.getElementById('btn-refresh-delegs').onclick = async () => {
  await Promise.all([loadCerts(), loadDelegations(), loadVerifications()]);
};

/* -------------------------------- 密钥管理 -------------------------------- */
async function loadKeys() {
  const keys = await getJson('/api/cert-keys');
  const tb = document.querySelector('#tbl-keys tbody');
  const map = { ACTIVE: ['green', '当前签名密钥'], ROTATED: ['amber', '已轮换(旧证明仍受信)'], REVOKED: ['red', '已应急吊销'] };
  tb.innerHTML = keys.map((k) => {
    const [cls, text] = map[k.status] || ['gray', k.status];
    return `<tr>
      <td class="mono"><b>${k.kid}</b></td>
      <td><span class="badge ${cls}">${text}</span></td>
      <td class="small">${fmtTime(k.createdAt)}</td>
      <td class="small muted">${k.rotatedAt ? '轮换 ' + fmtTime(k.rotatedAt) : ''}${k.revokedAt ? '吊销 ' + fmtTime(k.revokedAt) : ''}</td>
      <td>${k.issuedCount}</td>
      <td class="mono small">${esc((k.jwk.x || '').slice(0, 16))}…</td>
      <td>${k.status !== 'REVOKED' ? `<button class="danger" onclick='revokeKey("${k.kid}")'>应急吊销</button>` : '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">尚无密钥(首次签发时自动创建)</td></tr>';
}
window.doRotate = async () => {
  if (!confirm('轮换签名密钥?轮换后新证明用新密钥;旧密钥保留为信任锚,轮换前证明继续可验真。')) return;
  try {
    const r = await api('/api/cert-keys/rotate', { actorId: 'REG-1', note: '页面手动轮换' });
    toast(`已轮换:${r.previous ? r.previous.kid + ' → ' : ''}${r.active.kid}。旧证明继续可验真。`, 'success', 7000);
    await loadKeys();
  } catch (e) { toast('轮换失败:' + e.message, 'error'); }
};
window.revokeKey = async (kid) => {
  if (!confirm(`应急吊销 ${kid}?该密钥签发的全部证明将立即不再受信(区别于正常轮换)!`)) return;
  try {
    await api('/api/cert-keys/revoke', { actorId: 'REG-1', keyId: kid });
    toast(`密钥 ${kid} 已应急吊销,其签发凭据的全部下级委托同步停止`, 'success', 7000);
    await Promise.all([loadKeys(), loadCerts(), loadDelegations()]);
  } catch (e) { toast('吊销失败:' + e.message, 'error'); }
};

/* -------------------------------- 在线验真 -------------------------------- */
document.getElementById('vf-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById('vf-text').value = await f.text();
});
document.getElementById('btn-verify-online').onclick = async () => {
  const raw = document.getElementById('vf-text').value.trim();
  const purpose = document.getElementById('vf-purpose').value;
  if (!raw) return toast('请先载入或粘贴证明', 'error');
  if (!purpose) return toast('在线核验必须声明本次核验用途', 'error');
  let envelope;
  try { envelope = JSON.parse(raw); } catch (_) { return renderVerify(null, { valid: false, code: 'CERT_MALFORMED', detail: '证明不是合法 JSON' }); }
  try {
    const r = await api('/api/certificates/verify', {
      envelope, purpose,
      nonce: EWR.genReqId('VF'),
      verifierId: 'THIRD-PARTY'
    });
    renderVerify(envelope, r);
    loadVerifications();
  } catch (e) {
    toast('核验请求失败:' + e.message, 'error');
  }
};

function renderVerify(env, r) {
  const box = document.getElementById('vf-result');
  if (!r.valid) {
    box.innerHTML = `<div class="banner warn"><b>✘ 验真拒绝 · ${esc(r.code)}</b><div class="hr"></div>${esc(r.detail || '')}
      <div class="small muted" style="margin-top:6px">${r.replayed ? '相同 nonce 重放,返回首次结论' : '本次失败未消耗可用次数'}</div></div>`;
    return;
  }
  const c = env.claims;
  const rows = (c.dl || []).map((k) => `<tr><td>${esc(k)}</td><td><b>${esc(fmtClaim(k, c.d[k]))}</b></td></tr>`).join('');
  box.innerHTML = `
    <div class="banner ok"><b>✔ 在线验真通过</b>
      <div class="small" style="margin-top:4px">签名/链头/签发状态/有效期/用途/正文均通过;证明未撤销。本次剩余可用次数:<b>${r.verdict.remaining == null ? '不限' : r.verdict.remaining}</b></div></div>
    <table style="font-size:12px"><tbody>${rows}</tbody></table>
    <div class="small muted">证明编号 ${esc(c.id)} · 核验编号 ${esc(r.verdict.id)} · 链事件 #${r.verdict.eventSeq || '—'}</div>`;
}
function fmtClaim(k, v) {
  if (v == null) return '—';
  if (Array.isArray(v)) return '[' + v.join(', ') + ')';
  if (k === 'pledgeExists') return v ? '存在质押' : '无质押';
  return String(v);
}

/* -------------------------------- 核验回放 -------------------------------- */
async function loadVerifications() {
  const q = new URLSearchParams();
  const cert = document.getElementById('rv-cert').value.trim();
  const valid = document.getElementById('rv-valid').value;
  if (cert) q.set('certId', cert);
  if (valid) q.set('valid', valid);
  const list = await getJson('/api/certificates/verifications?' + q.toString());
  const tb = document.querySelector('#tbl-verifications tbody');
  tb.innerHTML = list.map((v) => `<tr>
    <td class="mono small">${esc(v.id)}</td>
    <td class="small">${fmtTime(v.at)}</td>
    <td class="mono small">${esc(v.certId || '—')}</td>
    <td class="small">${esc(purposeName(v.purpose))}</td>
    <td>${v.valid ? '<span class="badge green">通过</span>' : '<span class="badge red">拒绝</span>'}</td>
    <td class="small">${v.code ? `<b class="${v.valid ? '' : 'tag-bad'}">${esc(v.code)}</b><br>` : ''}<span class="muted">${esc(v.detail || '')}</span></td>
    <td class="small">${v.usedCount != null ? v.usedCount + '(余 ' + (v.remaining == null ? '∞' : v.remaining) + ')' : '—'}${v.nonce ? `<div class="muted mono">${esc(v.nonce)}</div>` : ''}</td>
    <td class="mono small">#${v.eventSeq || '—'}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="muted">暂无核验记录</td></tr>';
}
document.getElementById('rv-cert').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadVerifications(); });

init();
