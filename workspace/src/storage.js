/**
 * storage.js —— 零依赖持久化 + 串行事务层
 *
 * 设计要点:
 *  1. 所有写操作经单一 FIFO 队列串行执行,天然消除「多家机构并发质押」的竞态;
 *  2. 事务开始时做深拷贝快照,域逻辑在副本上运行;只有不抛异常才整体提交,
 *     因而「拆分中途故障」不会留下半截仓单(原子性);
 *  3. 每次成功提交同步落盘(data/db.json),宕机后状态完整恢复;
 *  4. 权利链 events 为 append-only,每条包含 prevHash,见 chainHash/verifyChain。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
// 允许通过 EWR_DB_FILE 指定独立数据文件(重启恢复回归测试使用临时库,互不干扰)
const DB_FILE = process.env.EWR_DB_FILE
  ? path.resolve(process.env.EWR_DB_FILE)
  : path.join(DATA_DIR, 'db.json');

/** 稳定 JSON:键排序,保证同一载荷哈希一致 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** 域异常:携带业务错误码,HTTP 层映射为 4xx */
class DomainError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.extra = extra;
  }
}

function freshState() {
  return {
    seq: { receipt: 0, event: 0, batch: 0, pledge: 0, valuation: 0, release: 0, delivery: 0, operation: 0, transfer: 0, certKey: 0, certificate: 0, delegation: 0 },
    commodities: [], // {id,name,unit}
    grades: [],      // {id,commodityId,name,basePrice}
    locations: [],   // {id,warehouseId,name,capacity,commodityId}
    parties: [],     // {id,type,name} type: financer|enterprise|warehouse|regulator
    receipts: [],    // 仓单(含全部历史版本的当前投影,版本链见 events)
    pledges: [],     // 质押/担保
    valuationBatches: [], // 估值批次(市场价格快照)
    inspectionBatches: [], // 检验批
    releases: [],    // 放行单
    deliveries: [],  // 出库记录
    supplements: [], // 补充担保要求
    transfers: [],   // 质权转让申请(PENDING/WITHDRAWN/EFFECTIVE/REJECTED,双方确认后生效)
    certKeys: [],    // 证明签名密钥(ACTIVE/ROTATED/REVOKED;轮换后旧密钥仍为旧证明提供验真信任锚)
    certificates: [], // 对外权利证明记录(含签发正文、用途、次数、撤销状态)
    certificateVerifications: [], // 在线核验结论(按 nonce 幂等,成功扣次/失败不扣,并发确定)
    certDelegations: [], // 机构级查验额度委托(ACTIVE/RECLAIMED/STOPPED/EXHAUSTED;受托机构只能消费自己的额度)
    certDelegationVerdicts: [], // 受托机构消费裁决(按业务流水 flowNo 幂等;成功扣次/失败留痕,并发确定)
    operationRecords: [], // 融资方操作会话留痕(成功/冲突/拒绝,与业务事务同提交;失败单独留痕)
    idempotency: {}, // key -> 回执对象
    events: []       // append-only 权利链
  };
}

let state = freshState();

/* ----------------------------- 哈希工具 ----------------------------- */
const crypto = require('crypto');
function chainHash(event) {
  const payload = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    receiptId: event.receiptId || null,
    pledgeId: event.pledgeId || null,
    actorId: event.actorId || null,
    payload: event.payload || {}
  };
  return crypto
    .createHash('sha256')
    .update(event.prevHash + '|' + stableStringify(payload))
    .digest('hex');
}

/* ----------------------------- 加载/落盘 ----------------------------- */
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE); // 原子替换
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = Object.assign(freshState(), parsed);
    if (!state.idempotency) state.idempotency = {};
    if (!Array.isArray(state.operationRecords)) state.operationRecords = [];
    if (!Array.isArray(state.transfers)) state.transfers = [];
    if (!Array.isArray(state.certKeys)) state.certKeys = [];
    if (!Array.isArray(state.certificates)) state.certificates = [];
    if (!Array.isArray(state.certificateVerifications)) state.certificateVerifications = [];
    if (!Array.isArray(state.certDelegations)) state.certDelegations = [];
    if (!Array.isArray(state.certDelegationVerdicts)) state.certDelegationVerdicts = [];
    if (!state.seq.operation) state.seq.operation = state.operationRecords.length;
    if (!state.seq.transfer) state.seq.transfer = state.transfers.length;
    if (!state.seq.certKey) state.seq.certKey = state.certKeys.length;
    if (!state.seq.certificate) state.seq.certificate = state.certificates.length;
    if (!state.seq.delegation) state.seq.delegation = state.certDelegations.length;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = freshState();
  }
}

function reset(newState) {
  state = newState;
  persist();
}

/* ----------------------------- 只读访问 ----------------------------- */
function getState() {
  return state;
}
/**
 * 一致性只读:读操作在 FIFO 写队列的【当前尾】之后执行,返回一个已提交快照。
 * 写事务是 async(验签期间多次 await),若 GET 不经闸门直接读 `state`,
 * 可能在一串并发写的提交间隙读到中间投影(例如已看到后提交的计数、却落在前一次落盘视图上)。
 * 经由此函数,读永远对应某一完整提交点,且不会越过调用时已入队的写。
 */
function readState() {
  const gate = chainRun;
  return gate.then(() => state);
}

/* ----------------------------- 串行事务 ----------------------------- */
/**
 * 严格 FIFO 事务闸门。
 * 关键:mutator 可能是 async(证明验签需 WebCrypto,一次事务内有多次 await)。
 * 下一事务的「深拷贝快照」必须在上一事务【提交完成】(state 已替换、已落盘)之后才抓取,
 * 否则后入队请求会在前者 await 挂起期间抢到旧快照、先提交,随后前者用旧状态覆盖,
 * 形成丢失更新(并发扣次丢笔/超扣)。因此这里在 run 体内 await 上一个 run 的 runPromise
 * (而非仅在入队时链接),保证「快照→执行→提交」整段临界区严格串行。
 */
let chainRun = Promise.resolve();

/**
 * 在事务中执行 mutator(FIFO 串行)。
 * @param {(draft:object, ctx:object)=>any|Promise<any>} mutator 在深拷贝上运行;抛错则回滚。
 *        支持 async mutator(证明签名/验真需 WebCrypto 异步原语):
 *        提交(替换 state + 落盘)只发生在 mutator Promise resolve 之后,
 *        因而「签名中途失败」与同步抛错一样整体回滚,不留半截证明。
 * @returns mutator 的返回值
 */
function transact(mutator) {
  const run = chainRun.then(async () => {
    const draft = structuredClone(state);
    const ctx = {
      nextId: (kind, prefix) => {
        draft.seq[kind] = (draft.seq[kind] || 0) + 1;
        return prefix + String(draft.seq[kind]).padStart(4, '0');
      },
      appendEvent: (type, fields = {}) => {
        draft.seq.event += 1;
        const ev = {
          seq: draft.seq.event,
          ts: fields.ts || Date.now(),
          type,
          receiptId: fields.receiptId || null,
          pledgeId: fields.pledgeId || null,
          actorId: fields.actorId || null,
          payload: fields.payload || {},
          prevHash: draft.events.length ? draft.events[draft.events.length - 1].hash : 'GENESIS'
        };
        ev.hash = chainHash(ev);
        draft.events.push(ev);
        return ev;
      }
    };
    const result = await mutator(draft, ctx);
    state = draft;
    persist();
    return result;
  });
  // 闸门推进:等【整个 run(含提交落盘)】结束才放行下一事务;成败都继续
  chainRun = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 校验权利链:重算每条哈希,返回断裂点 */
function verifyChain(s = state) {
  let prev = 'GENESIS';
  for (const ev of s.events) {
    if (ev.prevHash !== prev) {
      return { ok: false, brokenAtSeq: ev.seq, reason: 'prevHash 不衔接' };
    }
    if (chainHash(ev) !== ev.hash) {
      return { ok: false, brokenAtSeq: ev.seq, reason: '载荷哈希不一致(链上内容被篡改)' };
    }
    prev = ev.hash;
  }
  return { ok: true, count: s.events.length, head: prev };
}

module.exports = {
  stableStringify,
  DomainError,
  freshState,
  load,
  reset,
  getState,
  readState,
  transact,
  verifyChain,
  DB_FILE
};
