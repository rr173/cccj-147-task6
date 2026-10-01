/* offline-verifier.js —— 第三方离线验真页逻辑
 *
 * 纯本地运算,不发起任何网络请求:签名/链锚/有效期/用途/篡改全部在浏览器用
 * 内置信任锚(构建离线包时由服务端注入 window.EWR_TRUST_ANCHORS)重算。
 * 撤销状态与剩余次数属签发方在线台账,离线不可知,页面明确标注,绝不臆断为有效。
 */
'use strict';
(function () {
  const C = window.EWR_CERT;
  const QR = window.EWR_QR;
  const ANCHORS = (window.EWR_TRUST_ANCHORS || []).map((a) => a);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN') : '—';

  function purposeName(code) {
    const p = C.PURPOSES.find((x) => x.code === code);
    return p ? p.name : code;
  }
  function fieldName(key) {
    const f = C.FIELD_CATALOG.find((x) => x.key === key);
    return f ? f.name : key;
  }

  document.getElementById('anchor-count').textContent =
    ANCHORS.length + ' 把(' + ANCHORS.map((a) => a.kid + (a.status === 'ROTATED' ? '·轮换' : '')).join(', ') + ')';

  // 填充核验用途下拉
  document.getElementById('purpose').insertAdjacentHTML(
    'beforeend',
    C.PURPOSES.map((p) => `<option value="${p.code}">${p.name}(${p.code})</option>`).join('')
  );
  let lastEnvelopeText = '';

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await readFile(file);
      document.getElementById('cert-text').value = text;
      await runVerify();
    } catch (err) {
      renderError('文件读取失败:' + err.message);
    }
  });

  document.getElementById('btn-verify').onclick = () => runVerify();
  document.getElementById('btn-clear').onclick = () => {
    document.getElementById('cert-text').value = '';
    document.getElementById('result').innerHTML = '';
    document.getElementById('qr-box').innerHTML = '';
  };
  document.getElementById('btn-tamper').onclick = () => tamperAndShow();

  function renderError(msg) {
    document.getElementById('result').innerHTML =
      `<div class="banner warn">${esc(msg)}</div>`;
  }

  /** 把当前证明正文的某个已披露数值改一个字符(仅本地,用于演示篡改即拒) */
  function tamperAndShow() {
    const raw = document.getElementById('cert-text').value.trim();
    if (!raw) return renderError('请先载入/粘贴一份证明');
    const env = JSON.parse(raw);
    const keys = Object.keys(env.claims.d || {});
    const k = keys.find((x) => typeof env.claims.d[x] === 'string') || keys[0];
    env.claims.d[k] = String(env.claims.d[k]) + '␡';
    document.getElementById('cert-text').value = JSON.stringify(env);
    runVerify();
  }

  async function runVerify() {
    const raw = document.getElementById('cert-text').value.trim();
    if (!raw) return renderError('请粘贴证明 JSON、扫码文本,或选择 .ewr-cert.json 文件');
    const purpose = document.getElementById('purpose').value;
    const result = document.getElementById('result');

    let verdict;
    try {
      verdict = await C.verifyOffline(raw, { anchors: ANCHORS, purpose: purpose || undefined });
    } catch (e) {
      return renderError('验真异常:' + e.message);
    }

    if (!verdict.valid) {
      const explain = REJECT_REASON[verdict.code] || '证明未通过校验';
      result.innerHTML = `
        <div class="banner warn">
          <b>✘ 验真拒绝 · ${esc(verdict.code)}</b><div class="hr"></div>${esc(explain)}
        </div>
        ${checkList(verdict.checks)}`;
      return;
    }

    const c = verdict.claims;
    const disclosedRows = (c.dl || [])
      .map((k) => `<tr><td>${esc(fieldName(k))}</td><td><b>${esc(formatVal(k, c.d[k]))}</b></td></tr>`)
      .join('');
    const hiddenCount = (c.h || []).length;
    result.innerHTML = `
      <div class="banner ok">
        <b>✔ 离线验真通过</b>
        <div class="small" style="margin-top:6px">签名真实 · 链上签发锚点自洽 · 在有效期内 · 用途相符 · 正文未被篡改</div>
      </div>
      <dl class="kv">
        <dt>证明编号</dt><dd class="mono">${esc(c.id)}</dd>
        <dt>签发时间</dt><dd>${fmtTime(c.iat)}</dd>
        <dt>有效期至</dt><dd>${fmtTime(c.exp)}</dd>
        <dt>核验用途</dt><dd>${esc(purposeName(c.pu))} <span class="muted">(${esc(c.pu)})</span></dd>
        <dt>可用次数</dt><dd>${c.mu == null ? '不限次' : '限定 ' + c.mu + ' 次(剩余次数须联网向签发方核验)'}
          <div class="small muted">离线无法获知已用次数,见下方提示</div></dd>
        <dt>签名密钥</dt><dd class="mono">${esc(verdict.anchor.kid)} · ${verdict.anchor.status === 'ROTATED' ? '已轮换(旧密钥仍受信,旧证明按签发规则继续验真)' : '当前密钥'}</dd>
        <dt>链上锚点</dt><dd class="mono small">事件 #${c.ap} · hash ${esc(c.ah.slice(0, 24))}…</dd>
        <dt>签发状态承诺</dt><dd class="mono small">${esc(c.sd.slice(0, 32))}…</dd>
      </dl>
      <h3>披露字段(证明授权你看到的全部内容)</h3>
      <table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>${disclosedRows}</tbody></table>
      <div class="banner" style="margin-top:12px">
        另有 <b>${hiddenCount}</b> 个未披露字段以随机盐承诺形式封存,本证明<b>不含</b>其明文,
        无法据此推导企业身份、估值、融资额;证明中也不存在放行令牌。
      </div>
      <div class="banner warn" style="margin-top:10px">
        ⚠ 离线限制:撤销状态 = <b>${verdict.offlineCaveats.revocation}</b>,剩余次数 = <b>${verdict.offlineCaveats.remainingUses}</b>。
        这两项属签发方在线台账,如需权威结论请在联网时使用「在线核验」。
      </div>
      ${checkList(verdict.checks)}`;
  }

  function checkList(checks) {
    const items = [
      ['parsed', '证明解析'], ['version', '证明版本'], ['algorithm', '签名算法'],
      ['anchorTrusted', '信任锚密钥'], ['signature', '数字签名'], ['chainAnchor', '链头/签发时状态锚点'],
      ['period', '有效期'], ['purpose', '核验用途'], ['tamper', '正文完整性']
    ];
    return `<div class="hr"></div><div class="small muted">校验明细:</div>
      <div class="checks">${items.map(([k, label]) =>
        `<span class="${checks[k] ? 'tag-good' : 'tag-bad'}">${checks[k] ? '✔' : '✘'} ${label}</span>`).join('')}</div>`;
  }

  function formatVal(key, v) {
    if (v == null) return '—';
    if (Array.isArray(v)) return '[' + v.join(', ') + ')';
    if (key === 'pledgeExists') return v ? '存在质押' : '无质押';
    return String(v);
  }

  const REJECT_REASON = {
    CERT_MALFORMED: '证明文件无法解析或结构不完整,请确认文件未损坏。',
    CERT_VERSION_UNSUPPORTED: '证明版本不受支持。',
    ALGORITHM_UNSUPPORTED: '签名算法不在信任列表中。',
    KEY_NOT_TRUSTED: '签名密钥不在本机内置信任锚中:可能来自其他签发方,或密钥尚未随离线包分发。',
    KEY_REVOKED: '签名密钥已被应急吊销(疑似私钥泄露),该密钥签发的证明一律拒绝。',
    PAYLOAD_TAMPERED: '签名校验失败:证明正文被篡改或签名被破坏。任何一个字节改动都会导致此结果。',
    CHAIN_ANCHOR_MISMATCH: '链头/签发时状态锚点重算不一致:证明锚点与哈希链不衔接,签发状态不可信。',
    NOT_EFFECTIVE_YET: '证明尚未到生效时间。',
    CERT_EXPIRED: '证明已超过有效期。',
    PURPOSE_MISMATCH: '核验用途与证明限定的用途不符:该证明不能用于本次核验。',
    SENSITIVE_LEAK: '证明在未披露字段位置出现敏感明文,违反最小披露规则,拒绝采信。'
  };
})();
