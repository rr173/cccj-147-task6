/**
 * server.js —— HTTP 服务(零依赖,Node 原生 http)
 * 静态托管 public/,并提供 /api/* JSON 接口。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load, DomainError, getState } = require('./storage');
const domain = require('./domain');
const certs = require('./certificates');
const certCore = require('./cert-core');
const { seed } = require('./seed');

load();

/* ---------- 融资方操作守卫:业务事务回滚后,独立事务补登失败留痕 ----------
 * 成功/重放留痕已在业务事务内写入(原子);到达这里的只有被拒绝的请求。
 * 留痕与有效状态隔离:并发冲突、陈旧版本、非当前质权人请求全部可追溯,但不改变台账。
 */
const REQ_FIELDS = {
  lock: ['reqId', 'receiptId', 'financerId', 'pledgorId', 'valuationBatchId', 'loanAmount'],
  register: ['pledgeId', 'registrationNo', 'expectedVersion', 'valuationBatchId', 'registrar'],
  cancel: ['pledgeId', 'actorId'],
  supplement: ['pledgeId', 'amount', 'actorId'],
  repay: ['pledgeId', 'amount', 'actorId'],
  release: ['reqId', 'pledgeId', 'qty'],
  transferApply: ['reqId', 'pledgeId', 'actorId', 'toFinancerId', 'expectedRightsVersion', 'note'],
  transferConfirm: ['reqId', 'transferId', 'pledgeId', 'actorId', 'side', 'expectedRightsVersion'],
  transferWithdraw: ['reqId', 'transferId', 'pledgeId', 'actorId']
};

function guard(action, fn) {
  return async (body, query) => {
    try {
      return await fn(body, query);
    } catch (e) {
      if (e instanceof DomainError) {
        const input = body || {};
        let receiptId = input.receiptId || null;
        let pledgeId = input.pledgeId || null;
        if (!receiptId && pledgeId) {
          const p = getState().pledges.find((x) => x.id === pledgeId);
          if (p) receiptId = p.receiptId;
        }
        if (input.transferId) {
          const t = getState().transfers.find((x) => x.id === input.transferId);
          if (t) { pledgeId = pledgeId || t.pledgeId; if (!receiptId) receiptId = t.receiptId; }
        }
        const idempotencyKey = domain.IDEMPOTENCY_KEY_OF[action]
          ? domain.IDEMPOTENCY_KEY_OF[action](input)
          : null;
        const request = {};
        for (const f of REQ_FIELDS[action] || []) if (input[f] !== undefined) request[f] = input[f];
        try {
          await domain.logRejection({
            action,
            actorId: input.actorId || null,
            sessionId: input.sessionId || null,
            receiptId,
            pledgeId,
            idempotencyKey,
            reasonCode: e.code,
            reason: e.message,
            request
          });
        } catch (logErr) {
          console.error('[audit log failure]', logErr); // 审计写入异常不得掩盖原始业务错误
        }
      }
      throw e;
    }
  };
}

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

/* ---------- 委托/收回参数级拒绝守卫:业务事务回滚后独立事务补登拒绝台账 ----------
 * 业务规则拒绝(越权/超额/状态冲突)在事务内以 200 裁决返回且已上链;
 * 到达这里的只有必填参数缺失等在开事务前抛出的 DomainError,同样必须留痕。
 */
function cguard(action, fn) {
  return async (body, query) => {
    try {
      return await fn(body, query);
    } catch (e) {
      if (e instanceof DomainError) {
        const input = body || {};
        try {
          await certs.logDelegationDeny({
            kind: action === 'reclaim' ? 'RECLAIM_DENIED' : 'DELEGATE_DENIED',
            action,
            actorId: input.actorId || null,
            certId: input.certId || null,
            delegationId: input.delegationId || null,
            granteeId: input.granteeId || null,
            reasonCode: e.code,
            reason: e.message,
            nonce: input.delegateNonce || input.reclaimNonce || null,
            request: input
          });
        } catch (logErr) {
          console.error('[delegation audit log failure]', logErr);
        }
      }
      throw e;
    }
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new DomainError('BODY_TOO_LARGE', '请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new DomainError('BAD_JSON', 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------- 离线验真器单文件构建 -------------------
 * 把 cert-core.js / qrcode.js / offline-verifier.js 与当前信任锚公钥内联进一个 HTML,
 * 第三方下载后可在完全断网环境打开验真;信任锚随包冻结(轮换后的旧密钥仍在其中,
 * 保证旧证明继续可验;密钥被应急吊销则不会出现在新包的信任锚中)。
 */
function buildOfflineBundle() {
  const certCoreSrc = fs.readFileSync(path.join(__dirname, 'cert-core.js'), 'utf8');
  const qrSrc = fs.readFileSync(path.join(__dirname, 'qrcode.js'), 'utf8');
  const verifierJs = fs.readFileSync(path.join(PUBLIC, 'offline-verifier.js'), 'utf8');
  const anchors = certs.trustAnchors(getState());
  const styles = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const body = fs.readFileSync(path.join(PUBLIC, 'offline-verifier.partial.html'), 'utf8');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>权利证明离线验真器(断网可用)</title>
<style>${styles}</style>
</head>
<body>
<main style="max-width:980px">
${body}
</main>
<script>
/* 离线包信任锚:构建于 ${new Date().toISOString()},共 ${anchors.length} 把公钥 */
window.EWR_TRUST_ANCHORS = ${JSON.stringify(anchors)};
</script>
<script>
${certCoreSrc}
</script>
<script>
${qrSrc}
</script>
<script>
${verifierJs}
</script>
</body>
</html>`;
}

/* ------------------------------- API 路由 ------------------------------- */
const routes = {
  'GET /api/state': async () => domain.query(),
  'GET /api/audit': async () => domain.auditSnapshot(),
  'GET /api/session': async (body, query) => domain.sessionView(query.get('sessionId')),
  'GET /api/operations': async (body, query) =>
    domain.queryOperations({
      receiptId: query.get('receiptId') || undefined,
      pledgeId: query.get('pledgeId') || undefined,
      actorId: query.get('actorId') || undefined,
      sessionId: query.get('sessionId') || undefined,
      action: query.get('action') || undefined,
      outcome: query.get('outcome') || undefined
    }),
  'GET /api/transfers': async (body, query) =>
    domain.queryTransfers({
      pledgeId: query.get('pledgeId') || undefined,
      receiptId: query.get('receiptId') || undefined,
      partyId: query.get('partyId') || undefined,
      status: query.get('status') || undefined
    }),
  'GET /api/receipt': async (body, query) => {
    const id = query.get('id');
    if (!id) throw new DomainError('ID_REQUIRED', '缺少 id');
    return domain.receiptTimeline(id);
  },
  'POST /api/valuation-batch': (b) => domain.createValuationBatch(b.actorId, b.note, b.prices),
  'POST /api/receipts/register': (b) => domain.registerReceipt(b),
  'POST /api/receipts/split': (b) => domain.splitReceipt(b),
  'POST /api/receipts/merge': (b) => domain.mergeReceipts(b),
  'POST /api/receipts/recheck': (b) => domain.recheck(b),
  'POST /api/receipts/deliver': (b) => domain.deliver(b),
  'POST /api/pledges/lock': guard('lock', (b) => domain.lockPledge(b)),
  'POST /api/pledges/cancel': guard('cancel', (b) => domain.cancelPledge(b)),
  'POST /api/pledges/register': guard('register', (b) => domain.registerPledge(b)),
  'POST /api/pledges/supplement': guard('supplement', (b) => domain.supplementCollateral(b)),
  'POST /api/pledges/repay': guard('repay', (b) => domain.repayPledge(b)),
  'POST /api/pledges/release': guard('release', (b) => domain.releasePledge(b)),
  'POST /api/pledges/transfers/apply': guard('transferApply', (b) => domain.applyTransfer(b)),
  'POST /api/pledges/transfers/confirm': guard('transferConfirm', (b) => domain.confirmTransfer(b)),
  'POST /api/pledges/transfers/withdraw': guard('transferWithdraw', (b) => domain.withdrawTransfer(b)),
  /* ----------------------- 对外权利证明:签发 / 撤销 / 在线核验 ----------------------- */
  'POST /api/certificates/issue': (b) => certs.issueCertificate(b),
  'POST /api/certificates/revoke': (b) => certs.revokeCertificate(b),
  'POST /api/certificates/verify': (b) => certs.verifyCertificateOnline(b),
  /* ---------------- 机构级查验额度委托:委托 / 收回 / 受托消费(C7) ----------------
   * 业务校验拒绝在事务内以 200 裁决返回并已上链;到达守卫的只有参数级 DomainError,
   * 由独立事务补登 DELEGATE_DENIED/RECLAIM_DENIED,保证「拒绝动作」也进入持久化与审计链。
   */
  'POST /api/certificates/delegate': cguard('delegate', (b) => certs.delegateQuota(b)),
  'POST /api/certificates/delegations/reclaim': cguard('reclaim', (b) => certs.reclaimDelegation(b)),
  'POST /api/certificates/delegations/consume': (b) => certs.consumeDelegated(b),
  'GET /api/certificates/delegations': (b, q) =>
    certs.queryDelegations({
      certId: q.get('certId') || undefined,
      granteeId: q.get('granteeId') || undefined,
      issuedBy: q.get('issuedBy') || undefined,
      status: q.get('status') || undefined,
      usable: q.get('usable') || undefined
    }),
  'GET /api/certificates/delegations/audit': (b, q) =>
    certs.queryDelegationAudit({
      certId: q.get('certId') || undefined,
      delegationId: q.get('delegationId') || undefined,
      granteeId: q.get('granteeId') || undefined,
      actorId: q.get('actorId') || undefined,
      kind: q.get('kind') || undefined,
      outcome: q.get('outcome') || undefined
    }),
  'GET /api/certificates/quota-tree': (b, q) => {
    const id = q.get('certId');
    if (!id) throw new DomainError('CERT_ID_REQUIRED', '缺少 certId');
    return certs.quotaTree(id);
  },
  'GET /api/certificates': (b, q) =>
    certs.queryCertificates({
      receiptId: q.get('receiptId') || undefined,
      issuedBy: q.get('issuedBy') || undefined,
      purpose: q.get('purpose') || undefined,
      status: q.get('status') || undefined
    }),
  'GET /api/certificates/verifications': (b, q) =>
    certs.queryVerifications({
      certId: q.get('certId') || undefined,
      purpose: q.get('purpose') || undefined,
      valid: q.get('valid') || undefined,
      delegationId: q.get('delegationId') || undefined,
      granteeId: q.get('granteeId') || undefined
    }),
  'GET /api/certificates/audit': () => certs.certificateAudit(),
  'GET /api/certificates/anchors': () => ({ anchors: certs.trustAnchors(), at: Date.now() }),
  /* ----------------------- 签名密钥管理(监管方) ----------------------- */
  'POST /api/cert-keys/rotate': (b) => certs.rotateKey(b),
  'POST /api/cert-keys/revoke': (b) => certs.revokeKey(b),
  'GET /api/cert-keys': () => certs.listKeys(),
  'POST /api/admin/reset': async () => {
    seed();
    return { ok: true, message: '已重置为演示数据' };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) throw new DomainError('NOT_FOUND', `无此接口:${key}`);
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await handler(body, url.searchParams);
      return sendJson(res, 200, { ok: true, data: result });
    }

    // 静态文件
    // 浏览器需直接加载同一份密码学/QR 源码(与离线验真器、Node 端严格同源)
    if (url.pathname === '/cert-core.js' || url.pathname === '/qrcode.js') {
      const buf = fs.readFileSync(path.join(__dirname, url.pathname));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(buf);
    }
    // 离线验真器:单文件、自带信任锚公钥,可在断网环境打开(也可下载到 U 盘)
    if (url.pathname === '/offline-verifier.html') {
      const buf = buildOfflineBundle();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(buf);
    }
    if (url.pathname === '/offline-verifier.download') {
      const buf = buildOfflineBundle();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="ewr-offline-verifier.html"'
      });
      return res.end(buf);
    }
    let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC, 'index.html');
    const ext = path.extname(filePath);
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    return res.end(buf);
  } catch (e) {
    if (e instanceof DomainError) {
      return sendJson(res, 400, { ok: false, error: { code: e.code, message: e.message, extra: e.extra } });
    }
    console.error('[server error]', e);
    return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: e.message } });
  }
});

server.listen(PORT, () => {
  console.log(`大宗商品电子仓单登记与质押协同平台已启动: http://localhost:${PORT}`);
  console.log('  仓库端   /warehouse.html   融资方端 /financier.html   监管端 /regulator.html');
});
