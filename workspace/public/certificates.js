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
let lastDelegations = [];
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
    await Promise.all([loadCerts(), loadKeys(), loadVerifications(), loadDelegations()]);
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
      <td class="small">${c.maxUses == null ? '不限' : `${c.usedCount}/${c.maxUses}<div class="muted">预占 ${c.reservedCount || 0} · 可分 ${c.delegatableRemaining == null ? '∞' : c.delegatableRemaining}</div>`}</td>
      <td class="mono small">${esc(c.keyId)}<div class="muted">${esc(c.keyStatus || '')}</div></td>
      <td>${st}${c.revokeReason ? `<div class="small tag-bad">${esc(c.revokeReason)}</div>` : ''}</td>
      <td><div class="row-actions">
        <button class="ghost" onclick='viewCert("${c.id}")'>查看/下载/二维码</button>
        ${c.status === 'ACTIVE' && c.maxUses != null ? `<button class="ghost" onclick='openDelegate("${c.id}")'>委托额度</button>` : ''}
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
    toast('证明已撤销,其全部下级委托已同步停止', 'success');
    await Promise.all([loadCerts(), loadVerifications(), loadDelegations()]);
  } catch (e) { toast('撤销失败:' + e.message, 'error'); }
};
document.getElementById('btn-refresh-certs').onclick = async () => {
  STATE = await getState(); renderReceiptOptions();
  await Promise.all([loadCerts(), loadKeys(), loadVerifications(), loadDelegations()]);
};

/* --------------------------- 机构级额度委托 --------------------------- */
async function loadDelegations() {
  lastDelegations = await getJson('/api/certificates/delegations');
  const tb = document.querySelector('#tbl-delegations tbody');
  const statusMap = {
    ACTIVE: ['green', '生效中'], HALTED: ['red', '已级联停止'], RECLAIMED: ['gray', '已收回'],
    EXPIRED: ['gray', '已过期'], PENDING_START: ['blue', '未到生效时间'], EXHAUSTED: ['amber', '本机构已用罄']
  };
  tb.innerHTML = lastDelegations.map((d) => {
    const [cls, text] = statusMap[d.effectiveStatus] || ['gray', d.effectiveStatus];
    const note = d.status === 'HALTED' ? `上级${d.haltReason === 'KEY_REVOKED' ? '密钥应急吊销' : '凭据作废'}`
      : d.status === 'RECLAIMED' ? (d.reclaimReason || '已收回')
      : d.unusableCode === 'DELEGATION_EXPIRED' ? '已过期' : '';
    return `<tr>
      <td><b>${d.id}</b></td>
      <td class="small mono">${d.certId}<div class="muted">${esc(d.issuedByName)}</div></td>
      <td class="small">${esc(d.granteeName)}<div class="muted mono">${esc(d.granteeId)}</div></td>
      <td class="small">${esc(d.scenarioName)}<div class="muted mono">${esc(d.scenario)}</div></td>
      <td class="small">${fmtTime(d.startsAt)}<br><span class="muted">至 ${fmtTime(d.expiresAt)}</span></td>
      <td><b>${d.usedCount}/${d.quota}</b><div class="muted">余 ${d.remaining}</div></td>
      <td class="small mono">${d.operatorIds.map((o) => esc(o)).join('、')}</td>
      <td><span class="badge ${cls}">${text}</span>${note ? `<div class="small tag-bad">${esc(note)}</div>` : ''}</td>
      <td><div class="row-actions">
        ${d.status === 'ACTIVE' ? `<button class="danger" onclick='reclaimDelegation("${d.id}")'>收回未用额度</button>` : '—'}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">暂无机构委托(在上方证明台账点「委托额度」)</td></tr>';
}
document.getElementById('btn-refresh-dl').onclick = loadDelegations;

window.openDelegate = (certId) => {
  const cert = lastCerts.find((c) => c.id === certId);
  if (!cert) return toast('未找到证明', 'error');
  const grantees = STATE.parties.filter((p) => p.type === 'financer' && p.id !== cert.issuedBy);
  const purposes = C.PURPOSES.map((p) => `<option value="${p.code}"${p.code === cert.purpose ? ' selected' : ''}>${p.name}</option>`).join('');
  const defaultEnd = new Date(cert.expiresAt).toISOString().slice(0, 16);
  openModal(`
    <h2>向合作机构委托查验额度 · ${cert.id}</h2>
    <p class="small muted">总额度 ${cert.maxUses} 次 · 已用 ${cert.usedCount} · 已预占 ${cert.reservedCount || 0} ·
      当前可再分配 <b>${cert.delegatableRemaining}</b> 次。委托即从总额预占,受托机构只能消费自己的额度。</p>
    <div class="form-row">
      <label class="fld">受托合作机构
        <select id="dl-grantee">${grantees.map((p) => `<option value="${p.id}">${esc(p.name)}(${p.id})</option>`).join('')}</select>
      </label>
      <label class="fld">委托次数(正整数)
        <input id="dl-quota" type="number" min="1" max="${cert.delegatableRemaining}" value="1">
      </label>
      <label class="fld">业务场景
        <select id="dl-scenario">${purposes}</select>
      </label>
    </div>
    <div class="form-row">
      <label class="fld">生效时间
        <input id="dl-start" type="datetime-local">
      </label>
      <label class="fld">截止时间(不得晚于凭据到期)
        <input id="dl-end" type="datetime-local" value="${defaultEnd}">
      </label>
    </div>
    <label class="fld">单次操作人白名单(逗号分隔,每次查验必须命中其中之一)
      <input id="dl-operators" placeholder="如 OP-001,OP-002">
    </label>
    <div class="hr"></div>
    <div class="row-actions">
      <button class="primary" onclick='doDelegate("${certId}")'>确认委托(预占额度)</button>
      <button class="ghost" onclick="closeModal()">取消</button>
    </div>`);
};

window.doDelegate = async (certId) => {
  const granteeId = document.getElementById('dl-grantee').value;
  const quota = Number(document.getElementById('dl-quota').value);
  const scenario = document.getElementById('dl-scenario').value;
  const startRaw = document.getElementById('dl-start').value;
  const endRaw = document.getElementById('dl-end').value;
  const operatorIds = document.getElementById('dl-operators').value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!operatorIds.length) return toast('必须填写至少一个操作人', 'error');
  try {
    const r = await api('/api/certificates/delegate', {
      actorId: document.getElementById('is-actor').value,
      certId, granteeId, quota, scenario,
      startsAt: startRaw ? new Date(startRaw).getTime() : undefined,
      expiresAt: endRaw ? new Date(endRaw).getTime() : undefined,
      operatorIds,
      delegateNonce: EWR.genReqId('DL')
    });
    if (r.rejected) { closeModal(); return toast('委托被拒:' + r.detail + '(' + r.code + ')', 'error', 9000); }
    closeModal();
    toast(`授权 ${r.delegation.id} 已生效:向 ${r.delegation.granteeName} 预占 ${r.delegation.quota} 次,已上链`, 'success', 7000);
    await Promise.all([loadCerts(), loadDelegations(), loadVerifications()]);
  } catch (e) { toast('委托失败:' + e.message, 'error', 9000); }
};

window.reclaimDelegation = async (id) => {
  if (!confirm(`收回授权 ${id}?仅退回未用预占额度,已用量不退回;旧授权立即不能继续查验。`)) return;
  try {
    const r = await api('/api/certificates/delegations/reclaim', {
      actorId: document.getElementById('is-actor').value,
      delegationId: id,
      reason: '权利证明中心页面收回',
      reclaimNonce: EWR.genReqId('DLREC')
    });
    if (r.rejected) return toast('收回被拒:' + r.detail + '(' + r.code + ')', 'error', 9000);
    toast(`授权 ${id} 已收回,退回未用预占 ${r.returned} 次,旧授权已立即失效`, 'success', 7000);
    await Promise.all([loadCerts(), loadDelegations(), loadVerifications()]);
  } catch (e) { toast('收回失败:' + e.message, 'error', 9000); }
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
    toast(`密钥 ${kid} 已应急吊销`, 'success');
    await Promise.all([loadKeys(), loadCerts()]);
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
