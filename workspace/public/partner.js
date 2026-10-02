/* partner.js —— 合作机构受托查验工作台页面脚本
 *
 * 只能看到/消费本机构(granteeId)被委托的授权;查验带一次性业务流水 nonce,
 * 相同流水重放返回第一次裁决;越权/错误场景/过期/收回/级联停止/耗尽均为确定拒绝码且不扣次。
 */
'use strict';
const { api, getState, getJson, toast, fmtTime, esc, renderTopbar } = EWR;
const C = window.EWR_CERT;

let STATE = null;
let myDelegations = [];

document.getElementById('topbar').innerHTML = renderTopbar('partner');

function purposeName(code) {
  const p = C.PURPOSES.find((x) => x.code === code);
  return p ? p.name : code;
}

async function init() {
  STATE = await getState();
  // 合作机构 = 平台内全部金融机构(本页不做签发,只做受托查验)
  const fins = STATE.parties.filter((p) => p.type === 'financer');
  document.getElementById('p-grantee').innerHTML = fins
    .map((p) => `<option value="${p.id}">${esc(p.name)}(${p.id})</option>`).join('');
  document.getElementById('c-purpose').innerHTML = C.PURPOSES.map((p) => `<option value="${p.code}">${p.name}</option>`).join('');
  document.getElementById('p-grantee').onchange = loadMyDelegations;
  document.getElementById('btn-load-dl').onclick = loadMyDelegations;
  document.getElementById('btn-refresh-dl').onclick = loadMyDelegations;
  document.getElementById('btn-consume').onclick = doConsume;
  document.getElementById('btn-load-vf').onclick = loadMyVerifications;
  await Promise.all([loadMyDelegations(), loadMyVerifications()]);
}

function dlStatusBadge(d) {
  const map = {
    ACTIVE: ['green', '可用'], HALTED: ['red', '已停止'], RECLAIMED: ['gray', '已收回'],
    EXPIRED: ['gray', '已过期'], PENDING_START: ['blue', '未到生效时间'], EXHAUSTED: ['amber', '已用罄']
  };
  const [cls, text] = map[d.effectiveStatus] || ['gray', d.effectiveStatus];
  return `<span class="badge ${cls}">${text}</span>`;
}

async function loadMyDelegations() {
  const granteeId = document.getElementById('p-grantee').value;
  myDelegations = await getJson('/api/certificates/delegations?granteeId=' + encodeURIComponent(granteeId));
  const tb = document.querySelector('#tbl-dl tbody');
  tb.innerHTML = myDelegations.map((d) => `<tr>
    <td><b>${d.id}</b></td>
    <td class="mono small">${d.certId}</td>
    <td class="small">${esc(d.issuedByName)}<div class="muted mono">${esc(d.issuedBy)}</div></td>
    <td class="small">${esc(d.scenarioName)}<div class="muted mono">${esc(d.scenario)}</div></td>
    <td class="small">${fmtTime(d.startsAt)}<br><span class="muted">至 ${fmtTime(d.expiresAt)}</span></td>
    <td><b>${d.usedCount}/${d.quota}</b><div class="muted">余 ${d.remaining}</div></td>
    <td class="small mono">${d.operatorIds.map((o) => esc(o)).join('、')}</td>
    <td>${dlStatusBadge(d)}${d.unusableCode && d.status === 'ACTIVE' ? `<div class="small tag-bad">${esc(d.unusableCode)}</div>` : ''}</td>
    <td>${d.usableNow
      ? `<button class="primary" data-consume-dl="${d.id}" data-consume-scenario="${d.scenario}">查验</button>`
      : '<span class="muted small">不可用</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="muted">本机构暂无受托授权</td></tr>';
}

// 事件委托:点击「查验」按钮带入授权号与场景(避免在 HTML 内嵌复杂表达式)
const dlTbody = document.querySelector('#tbl-dl tbody');
dlTbody.addEventListener('click', (e) => {
  const el = e.target && e.target.closest ? e.target.closest('[data-consume-dl]') : null;
  if (el) fillConsume(el.getAttribute('data-consume-dl'), el.getAttribute('data-consume-scenario'));
});

window.fillConsume = (delegationId, scenario) => {
  document.getElementById('c-delegation').value = delegationId;
  document.getElementById('c-purpose').value = scenario;
  if (!document.getElementById('p-operator').value.trim()) {
    const d = myDelegations.find((x) => x.id === delegationId);
    if (d && d.operatorIds.length === 1) document.getElementById('p-operator').value = d.operatorIds[0];
  }
  toast(`已带入授权 ${delegationId} 与场景 ${purposeName(scenario)},确认操作人后提交`, 'info', 4000);
};

async function doConsume() {
  const granteeId = document.getElementById('p-grantee').value;
  const operatorId = document.getElementById('p-operator').value.trim();
  const delegationId = document.getElementById('c-delegation').value.trim();
  const purpose = document.getElementById('c-purpose').value;
  const envRaw = document.getElementById('c-envelope').value.trim();
  if (!delegationId) return toast('请填写授权号(或在授权行点「查验」)', 'error');
  if (!operatorId) return toast('请填写本次操作人(须在授权白名单内)', 'error');
  const body = {
    delegationId, granteeId, operatorId, purpose,
    nonce: EWR.genReqId('DLVF') // 一次性业务流水:失败重试请复用同一 nonce
  };
  if (envRaw) {
    try { body.envelope = JSON.parse(envRaw); } catch (_) { return toast('证明信封不是合法 JSON', 'error'); }
  }
  try {
    const r = await api('/api/certificates/delegations/consume', body);
    renderConsumeResult(r);
    await Promise.all([loadMyDelegations(), loadMyVerifications()]);
  } catch (e) {
    toast('查验请求失败:' + e.message, 'error', 8000);
  }
}

function renderConsumeResult(r) {
  const box = document.getElementById('c-result');
  if (r.replayed) {
    box.innerHTML = `<div class="banner warn"><b>↻ 相同业务流水重放:返回第一次裁决</b>
      <div class="small">首次结论:${r.valid ? '通过' : '拒绝 ' + esc(r.code)};额度未重复消耗。流水号 ${esc(r.verdict.nonce)}</div></div>`;
    return;
  }
  if (!r.valid) {
    box.innerHTML = `<div class="banner warn"><b>✘ 查验拒绝 · ${esc(r.code)}</b><div class="hr"></div>${esc(r.detail || '')}
      <div class="small muted" style="margin-top:6px">本次失败未消耗授权额度;同一业务流水重试将返回本结论。</div></div>`;
    return;
  }
  const v = r.verdict;
  box.innerHTML = `<div class="banner ok"><b>✔ 受托查验通过</b>
    <div class="small" style="margin-top:4px">授权 ${esc(v.delegationId)} 剩余 <b>${v.delegationRemaining}</b> 次;
    父凭据累计已用 ${v.usedCount}${v.remaining == null ? '' : '(总余 ' + v.remaining + ')'};操作人 ${esc(v.operatorId)}</div>
    <div class="small muted">查验编号 ${esc(v.id)} · 链事件 #${v.eventSeq || '—'} · 流水 ${esc(v.nonce)}</div></div>`;
}

async function loadMyVerifications() {
  const granteeId = document.getElementById('p-grantee').value;
  const list = await getJson('/api/certificates/verifications?granteeId=' + encodeURIComponent(granteeId));
  const tb = document.querySelector('#tbl-vf tbody');
  tb.innerHTML = list.map((v) => `<tr>
    <td class="small">${fmtTime(v.at)}</td>
    <td class="mono small">${esc(v.delegationId || '—')}</td>
    <td class="small">${esc(purposeName(v.purpose))}</td>
    <td>${v.valid ? '<span class="badge green">通过</span>' : '<span class="badge red">拒绝</span>'}</td>
    <td class="small">${v.code ? `<b class="${v.valid ? '' : 'tag-bad'}">${esc(v.code)}</b><br>` : ''}<span class="muted">${esc(v.detail || '')}</span></td>
    <td class="small">${v.delegationRemaining != null ? '授权余 ' + v.delegationRemaining : '—'}${v.remaining != null ? `<div class="muted">父余 ${v.remaining}</div>` : ''}</td>
    <td class="mono small">${esc(v.nonce)}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">本机构暂无查验记录</td></tr>';
}

init();
