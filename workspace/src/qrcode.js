/**
 * qrcode.js —— 零依赖 QR 码编码器(UMD,浏览器 / Node 通用)
 *
 * 仅实现本平台扫证所需子集:
 *  - byte 模式(UTF-8 字节),自动选择能容纳的最小版本(1–40);
 *  - 纠错等级 L(证明是机读文本,以容量优先;签名保证篡改即失效,不依赖纠错);
 *  - 完整规范:寻像图形/定时/对齐图形、8 种掩膜择优、格式信息、版本信息、Reed-Solomon。
 * 返回 0/1 模块矩阵,渲染(SVG/Canvas)交由页面完成。
 *
 * 参考:ISO/IEC 18004 二维码规范 Annex A/B(GF(256), 本原多项式 0x11D)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EWR_QR = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ----------------------------- GF(256) 与 Reed-Solomon ----------------------------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], EXP[i]); // 乘 x
        next[j + 1] ^= poly[j];            // 乘常数项
      }
      poly = next;
    }
    return poly;
  }
  function rsRemainder(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      for (let i = 0; i < ecLen - 1; i++) res[i] = res[i + 1] ^ gfMul(gen[i], factor);
      res[ecLen - 1] = gfMul(gen[ecLen - 1], factor);
    }
    return res;
  }

  /* ------------------- 纠错级 L 的块结构:[每组块数, 每组数据码字数] ×2 组 -------------------
   * 每组 EC 码字数对所有块相同(EC_PER_BLOCK)。顺序对应版本 1..40。
   */
  const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 30, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const BLOCKS_L = [
    [1, 19, 0, 0], [1, 34, 0, 0], [1, 55, 0, 0], [1, 80, 0, 0], [1, 108, 0, 0],
    [4, 25, 0, 0], [2, 78, 0, 0], [2, 97, 0, 0], [2, 116, 0, 0], [2, 68, 2, 69],
    [4, 81, 0, 0], [2, 92, 2, 93], [4, 107, 0, 0], [3, 115, 1, 116], [5, 87, 1, 88],
    [5, 98, 1, 99], [1, 107, 5, 108], [5, 120, 1, 121], [3, 113, 4, 114], [3, 107, 5, 108],
    [4, 116, 4, 117], [2, 111, 7, 112], [4, 123, 5, 124], [6, 119, 4, 120], [8, 106, 4, 107],
    [10, 114, 2, 115], [8, 122, 4, 123], [3, 117, 10, 118], [7, 116, 7, 117], [5, 115, 10, 116],
    [2, 114, 14, 115], [15, 114, 2, 115], [7, 113, 11, 114], [15, 113, 4, 114], [4, 120, 15, 121],
    [10, 120, 10, 121], [17, 120, 4, 121], [14, 120, 8, 121], [14, 114, 10, 115], [1, 114, 24, 115]
  ];
  /** 各版本 byte 模式可容纳的 UTF-8 字节数(扣掉 4 位模式指示 + 8/16 位字符计数) */
  function byteCapacity(version) {
    const [n1, d1, n2, d2] = BLOCKS_L[version - 1];
    const dataCodewords = n1 * d1 + n2 * d2;
    const ccBits = version <= 9 ? 8 : 16;
    return Math.floor((dataCodewords * 8 - 4 - ccBits) / 8);
  }

  const ALIGN_POS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ];

  function utf8Bytes(text) {
    const enc = new TextEncoder();
    return Array.from(enc.encode(text));
  }

  /** 组装数据位:模式 0100 + 字符计数 + 数据字节 + 终止符 + 填充 */
  function buildDataBits(bytes, version, dataCodewords) {
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(0b0100, 4); // byte 模式
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const totalBits = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0); // 终止符
    while (bits.length % 8) bits.push(0); // 补齐字节
    const padBytes = dataCodewords - bits.length / 8;
    for (let i = 0; i < padBytes; i++) bits.push(...(i % 2 === 0 ? [1, 1, 1, 0, 1, 1, 0, 0] : [0, 0, 0, 1, 0, 0, 0, 1]));
    return bits;
  }

  /** 分块 RS 编码并按列交错 */
  function interleave(dataBits, version) {
    const [n1, d1, n2, d2] = BLOCKS_L[version - 1];
    const ecLen = EC_PER_BLOCK[version - 1];
    const bytes = [];
    for (let i = 0; i < dataBits.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | dataBits[i + k];
      bytes.push(v);
    }
    const blocks = [];
    let off = 0;
    for (let i = 0; i < n1; i++) { blocks.push({ data: bytes.slice(off, off + d1) }); off += d1; }
    for (let i = 0; i < n2; i++) { blocks.push({ data: bytes.slice(off, off + d2) }); off += d2; }
    blocks.forEach((b) => { b.ec = rsRemainder(b.data, ecLen); });
    const maxData = Math.max(d1, d2);
    const out = [];
    for (let k = 0; k < maxData; k++)
      for (const b of blocks) if (k < b.data.length) out.push(b.data[k]);
    for (let k = 0; k < ecLen; k++)
      for (const b of blocks) out.push(b.ec[k]);
    const bits = [];
    for (const b of out) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    return bits;
  }

  /* -------------------------------- 矩阵构建 --------------------------------
   * m:  -1=未置(数据区) 0/1=已置; fn=1 的模块为功能图形(寻像/对齐/定时/暗格/
   *     格式/版本区),掩膜只作用于数据模块,功能图形永不参与掩膜。
   */
  function newMatrix(size) {
    return {
      size,
      m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)),
      fn: Array.from({ length: size }, () => new Uint8Array(size))
    };
  }
  const setMod = (M, r, c, v, isFn = 0) => {
    if (r >= 0 && r < M.size && c >= 0 && c < M.size) {
      M.m[r][c] = v;
      if (isFn) M.fn[r][c] = 1;
    }
  };

  function drawFinder(M, r0, c0) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= M.size || c >= M.size) continue;
      if (dr === -1 || dr === 7 || dc === -1 || dc === 7) setMod(M, r, c, 0, 1); // 分隔符
      else if (dr === 0 || dr === 6 || dc === 0 || dc === 6) setMod(M, r, c, 1, 1);
      else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) setMod(M, r, c, 1, 1);
      else setMod(M, r, c, 0, 1);
    }
  }
  function drawAlignment(M, cy, cx) {
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const edge = Math.max(Math.abs(dr), Math.abs(dc));
      setMod(M, cy + dr, cx + dc, edge !== 1 ? 1 : 0, 1);
    }
  }
  function placeFunctionPatterns(version) {
    const size = version * 4 + 17;
    const M = newMatrix(size);
    drawFinder(M, 0, 0);
    drawFinder(M, 0, size - 7);
    drawFinder(M, size - 7, 0);
    // 对齐图形(跳过与三个寻像图形冲突的三个角)
    const pos = ALIGN_POS[version - 1];
    for (const cy of pos) for (const cx of pos) {
      const conflict =
        (cy === pos[0] && cx === pos[0]) ||
        (cy === pos[0] && cx === pos[pos.length - 1]) ||
        (cy === pos[pos.length - 1] && cx === pos[0]);
      if (!conflict) drawAlignment(M, cy, cx);
    }
    // 定时图形
    for (let i = 0; i < size; i++) {
      if (!M.fn[6][i]) setMod(M, 6, i, i % 2 === 0 ? 1 : 0, 1);
      if (!M.fn[i][6]) setMod(M, i, 6, i % 2 === 0 ? 1 : 0, 1);
    }
    // 暗格(最后画,覆盖左下寻像分隔符在 (4V+9,8) 的占格)
    setMod(M, 4 * version + 9, 8, 1, 1);
    return M;
  }
  /** 预留格式信息区域(掩码评选时数据不得写入) */
  function reserveFormat(M) {
    const n = M.size;
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { M.fn[i][8] = 1; M.fn[8][i] = 1; }
    }
    for (let i = n - 8; i < n; i++) M.fn[8][i] = 1;
    for (let i = n - 7; i < n; i++) M.fn[i][8] = 1;
  }
  function reserveVersion(M, version) {
    if (version < 7) return;
    const n = M.size;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      M.fn[i][n - 11 + j] = 1;
      M.fn[n - 11 + j][i] = 1;
    }
  }
  function placeDataBits(M, bits) {
    const n = M.size;
    let bi = 0;
    let x = n - 1;
    let goingUp = true;
    while (x > 0) {
      if (x === 6) x = 5; // 定时列永不承载数据
      for (let k = 0; k < n; k++) {
        const y = goingUp ? n - 1 - k : k;
        for (let dx = 0; dx < 2; dx++) {
          const xx = x - dx;
          if (!M.fn[y][xx] && bi < bits.length) M.m[y][xx] = bits[bi++];
        }
      }
      x -= 2;
      goingUp = !goingUp;
    }
    return bi;
  }

  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];
  function applyMask(base, maskIdx) {
    const n = base.size;
    const out = newMatrix(n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const v = base.m[r][c];
      out.fn[r][c] = base.fn[r][c];
      if (base.fn[r][c]) out.m[r][c] = v; // 功能图形不掩膜
      else if (v === -1) out.m[r][c] = 0; // 数据区理论上应全部填满,未填位置兜底为 0
      else out.m[r][c] = MASK_FNS[maskIdx](r, c) ? v ^ 1 : v;
    }
    return out;
  }
  function penalty(M) {
    const n = M.size;
    let p = 0;
    const lineRuns = (line) => {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
    };
    for (let r = 0; r < n; r++) lineRuns(Array.from(M.m[r]));
    for (let c = 0; c < n; c++) lineRuns(Array.from({ length: n }, (_, r) => M.m[r][c]));
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = M.m[r][c];
      const cells = [M.m[r][c + 1], M.m[r + 1][c], M.m[r + 1][c + 1]];
      if (cells.every((x) => x === v)) p += 3;
    }
    const finderLike = (line) => {
      // N1:与寻像图形相似的 11 模块图样 1011101 前后各 4 个浅色
      for (let i = 0; i + 11 <= line.length; i++) {
        const pat = [1, 0, 1, 1, 1, 0, 1];
        let hit = true;
        for (let k = 0; k < 7; k++) if (line[i + 4 + k] !== pat[k]) hit = false;
        if (!hit) continue;
        const before = i >= 4 && line.slice(i - 4, i).every((x) => x === 0);
        const after = i + 15 <= line.length && line.slice(i + 11, i + 15).every((x) => x === 0);
        if (before || after) p += 40;
      }
    };
    for (let r = 0; r < n; r++) finderLike(Array.from(M.m[r]));
    for (let c = 0; c < n; c++) finderLike(Array.from({ length: n }, (_, r) => M.m[r][c]));
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (M.m[r][c] === 1) dark++;
    p += Math.floor(Math.abs(dark * 200 - n * n * 100) / (n * n)) * 10;
    return p;
  }

  /* ------------------------------ BCH:格式 / 版本 ------------------------------ */
  function formatBits(maskIdx) {
    const data = (0b01 << 3) | maskIdx; // 纠错级 L = 01
    let g = data << 10;
    const gen = 0b10100110111;
    for (let i = 14; i >= 10; i--) if (g & (1 << i)) g ^= gen << (i - 10);
    return ((data << 10) | g) ^ 0b101010000010010;
  }
  function drawFormat(M, maskIdx) {
    const n = M.size;
    const bits = formatBits(maskIdx);
    const darkR = M.size - 8; // 暗格行:v1 时 13,即 4V+9
    const at = (r, c, i) => {
      if (r === darkR && c === 8) return; // (4V+9,8) 是暗格,不是格式位
      M.m[r][c] = (bits >> i) & 1;
    };
    for (let i = 0; i <= 5; i++) at(8, i, i);
    at(8, 7, 6); at(8, 8, 7); at(7, 8, 8);
    for (let i = 9; i < 15; i++) at(14 - i, 8, i);
    for (let i = 0; i < 8; i++) at(n - 1 - i, 8, i);
    for (let i = 0; i < 8; i++) at(8, n - 8 + i, i + 7);
  }
  function versionBits(version) {
    let g = version << 12;
    const gen = 0x1f25;
    for (let i = 17; i >= 12; i--) if (g & (1 << i)) g ^= gen << (i - 12);
    return (version << 12) | g;
  }
  function drawVersion(M, version) {
    if (version < 7) return;
    const n = M.size;
    const bits = versionBits(version);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      const bit = (bits >> (17 - (i * 3 + j))) & 1;
      M.m[i][n - 11 + j] = bit;
      M.m[n - 11 + j][i] = bit;
    }
  }

  /**
   * 编码文本为 QR 模块矩阵。
   * @returns {{version:number,size:number,mask:number,matrix:number[][]}}
   * @throws {{code:'QR_TOO_LARGE', bytes:number, max:number}} 超过 v40-L 容量
   */
  function encode(text) {
    const bytes = utf8Bytes(text);
    let version = 0;
    for (let v = 1; v <= 40; v++) if (bytes.length <= byteCapacity(v)) { version = v; break; }
    if (!version) {
      const err = new Error('内容超过 QR v40-L 容量上限,请改用证明文件验真');
      err.code = 'QR_TOO_LARGE'; err.bytes = bytes.length; err.max = byteCapacity(40);
      throw err;
    }
    const [n1, d1, n2, d2] = BLOCKS_L[version - 1];
    const dataCodewords = n1 * d1 + n2 * d2;
    const bits = interleave(buildDataBits(bytes, version, dataCodewords), version);

    const base = placeFunctionPatterns(version);
    reserveFormat(base);
    reserveVersion(base, version);
    placeDataBits(base, bits);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const cand = applyMask(base, mask);
      drawFormat(cand, mask);
      drawVersion(cand, version);
      const score = penalty(cand);
      if (!best || score < best.score) best = { mask, score, m: cand };
    }
    const n = base.size;
    const matrix = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) row.push(best.m.m[r][c] === 1 ? 1 : 0);
      matrix.push(row);
    }
    return { version, size: n, mask: best.mask, matrix };
  }

  return { encode, byteCapacity, MAX_VERSION: 40 };
});
