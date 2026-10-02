/* partner.js —— 合作机构受托查验台页面脚本
 *
 * 数据全部来自服务端权威台账:可用授权、消费裁决、剩余额度。
 * 关键不变量由服务端强制(本页只如实呈现):
 *  - 受托机构只能消费自己的额度(越权机构 DELEG_FORBIDDEN);
 *  - 业务场景必须与委托一致(DELEG_SCENE_MISMATCH);
 *  - 时间窗之外拒绝(NOT_STARTED / DELEG_EXPIRED);
 *  - 收回 / 级联停止 / 父额度耗尽立即拒绝;
 *  - 相同业务流水号重放返回第一次裁决,不重复扣次。
 */
'use strict';
const { api, getState, getJson, toast, fmtTime, esc, renderTopbar, genReqId } = EWR;
const C = window.EWR_CERT;

let STATE = null;
let partyId = null;
let myDelegs = [];

document.getElementById('topbar').innerHTML = renderTopbar('partner');

function purposeName(code) {
  const p = C.PURPOSES.find((x) => x.code === code);
  return p ? p.name : code;
}
const DELEG_STATUS = {
  ACTIVE: ['green', '生效中'], PENDING_START: ['blue', '待生效'], EXPIRED: ['gray', '已过期'],
  RECLAIMED: ['gray', '已收回'], STOPPED: ['red', '已级联停止'], EXHAUSTED: ['amber', '额度用完']
};

async function init() {
  STATE = await getState();
  const partners = STATE.parties.filter((p) => p.type === 'partner');
  const sel = document.getElementById('pt-party');
  sel.innerHTML = partners.map((p) => `<option value="${p.id}">${esc(p.name)}(${p.id})</option>`).join('')
    || '<option value="">(种子数据中无合作机构)</option>';
  partyId = sel.value;
  sel.addEventListener('change', async () => {
    partyId = sel.value;
    document.getElementById('pt-flowno').value = '';
    await Promise.all([loadDelegs(), loadPtVerdicts()]);
  });
  document.getElementById('pt-deleg').addEventListener('change', fillDelegMeta);
  await Promise.all([loadDelegs(), loadPtVerdicts()]);
}

async function loadDelegs() {
  myDelegs = await getJson('/api/certificates/delegations?trusteeId=' + encodeURIComponent(partyId));
  const tb = document.querySelector('#tbl-pt-delegs tbody');
  tb.innerHTML = myDelegs.map((d) => {
    const [cls, text] = DELEG_STATUS[d.liveStatus] || DELEG_STATUS[d.status] || ['gray', d.status];
    return `<tr>
      <td><b>${d.id}</b><div class="small muted">来自 ${esc(d.grantedByName)}</div></td>
      <td class="small mono">${d.certId}<div>${esc(purposeName(d.scenario))}</div></td>
      <td><b>${d.usedCount}/${d.quota}</b><div class="small muted">余 ${d.remaining}</div></td>
      <td class="small">${fmtTime(d.startsAt)}<br><span class="muted">至 ${fmtTime(d.endsAt)}</span></td>
      <td class="small">${d.perOperatorLimit == null ? '单人不限' : '单人≤' + d.perOperatorLimit}<div class="muted">${d.operatorAllowlist && d.operatorAllowlist.length ? '名单:' + esc(d.operatorAllowlist.join(',')) : '无名单'}</div></td>
      <td><span class="badge ${cls}">${text}</span>${d.stopReason ? `<div class="small tag-bad">${esc(d.stopReason)}</div>` : ''}</td>
      <td>${d.liveStatus === 'ACTIVE'
        ? `<button class="primary" onclick='selectDeleg("${d.id}")'>选择消费</button>`
        : '<span class="muted small">不可用</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">本机构暂无受托授权。</td></tr>';
  fillDelegSelect();
}

function fillDelegSelect() {
  const sel = document.getElementById('pt-deleg');
  const usable = myDelegs.filter((d) => d.liveStatus === 'ACTIVE');
  sel.innerHTML = usable.length
    ? usable.map((d) => `<option value="${d.id}">${d.id} · ${esc(purposeName(d.scenario))} · 余 ${d.remaining}/${d.quota}</option>`).join('')
    : '<option value="">(无生效中的授权)</option>';
  fillDelegMeta();
}
function fillDelegMeta() {
  const id = document.getElementById('pt-deleg').value;
  const d = myDelegs.find((x) => x.id === id);
  document.getElementById('pt-scene').value = d ? d.scenario : '';
}
window.selectDeleg = (id) => {
  document.getElementById('pt-deleg').value = id;
  fillDelegMeta();
  window.scrollTo({ top: document.getElementById('btn-consume').getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
};

function newFlowNo() {
  document.getElementById('pt-flowno').value = genReqId('BIZFLOW');
}
document.getElementById('btn-new-flowno').onclick = newFlowNo;

document.getElementById('btn-consume').onclick = async () => {
  const delegationId = document.getElementById('pt-deleg').value;
  const scenario = document.getElementById('pt-scene').value;
  const operatorId = document.getElementById('pt-operator').value.trim();
  let flowNo = document.getElementById('pt-flowno').value.trim();
  if (!delegationId) return toast('没有生效中的受托授权', 'error');
  if (!operatorId) return toast('必须填写单次操作人工号', 'error');
  if (!flowNo) { newFlowNo(); flowNo = document.getElementById('pt-flowno').value; }
  try {
    const r = await api('/api/certificates/delegations/consume', {
      delegationId, trusteeId: partyId, scenario, operatorId, flowNo
    });
    renderResult(r);
    await Promise.all([loadDelegs(), loadPtVerdicts()]);
  } catch (e) {
    toast('消费请求失败:' + e.message, 'error', 9000);
  }
};

function renderResult(r) {
  const box = document.getElementById('pt-result');
  if (!r.valid) {
    box.innerHTML = `<div class="banner warn"><b>✘ 消费被拒 · ${esc(r.code)}</b><div class="hr"></div>${esc(r.detail || '')}
      <div class="small muted" style="margin-top:6px">${r.replayed ? '相同业务流水重放,返回首次裁决' : '本次拒绝未消耗任何额度;已上链留痕'}</div>
      <div class="small mono" style="margin-top:4px">裁决号 ${esc(r.verdict.id)} · 流水 ${esc(r.verdict.flowNo)}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="banner ok"><b>✔ 受托消费通过</b>
    <div class="small" style="margin-top:4px">本机构剩余 <b>${r.verdict.delegRemaining}</b> 次 · 父凭据剩余 <b>${r.verdict.parentRemaining == null ? '不限' : r.verdict.parentRemaining}</b> 次</div>
    <div class="small muted">裁决号 ${esc(r.verdict.id)} · 链事件 #${r.verdict.eventSeq}${r.replayed ? ' · 相同流水重放(首次裁决)' : ''}</div></div>`;
}

async function loadPtVerdicts() {
  const q = new URLSearchParams({ trusteeId: partyId });
  const valid = document.getElementById('pt-valid').value;
  if (valid) q.set('valid', valid);
  const list = await getJson('/api/certificates/delegations/verdicts?' + q.toString());
  const tb = document.querySelector('#tbl-pt-verdicts tbody');
  tb.innerHTML = list.map((v) => `<tr>
    <td class="mono small">${esc(v.id)}</td>
    <td class="small">${fmtTime(v.at)}</td>
    <td class="mono small">${esc(v.flowNo)}</td>
    <td class="mono small">${esc(v.delegationId)}<br>${esc(v.certId || '—')}</td>
    <td class="small">${esc(purposeName(v.scenario))}</td>
    <td class="small">${esc(v.operatorId || '—')}</td>
    <td>${v.valid ? '<span class="badge green">通过</span>' : '<span class="badge red">拒绝</span>'}</td>
    <td class="small">${v.code ? `<b class="${v.valid ? '' : 'tag-bad'}">${esc(v.code)}</b><br>` : ''}<span class="muted">${esc(v.detail || '')}</span></td>
    <td class="small">${v.valid ? `${v.delegUsedCount}(余 ${v.delegRemaining})<div class="muted">父 ${v.parentUsedCount}(余 ${v.parentRemaining == null ? '∞' : v.parentRemaining})</div>` : '—'}</td>
    <td class="mono small">#${v.eventSeq || '—'}</td>
  </tr>`).join('') || '<tr><td colspan="10" class="muted">本机构暂无消费裁决。</td></tr>';
}
document.getElementById('pt-valid').addEventListener('change', loadPtVerdicts);
document.getElementById('btn-pt-refresh').onclick = async () => {
  await Promise.all([loadDelegs(), loadPtVerdicts()]);
  toast('已刷新授权与裁决', 'info');
};

init();
