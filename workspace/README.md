# 大宗商品电子仓单登记与质押协同平台

零外部依赖(Node.js ≥18 原生 http + 文件持久化 + SHA-256 哈希链)的电子仓单协同平台,
覆盖**仓库端、融资方端、监管查询、权利证明中心**四类工作台。

## 运行

```bash
npm start                 # 启动: http://localhost:3000
# 或指定端口 PORT=4000 node src/server.js

npm test                  # 端到端不变量测试(112 项,需先启动服务)
npm run test:restart      # 服务进程 SIGKILL→重启恢复回归(28 项,自起停服务与临时库)
npm run test:e2e          # 三页串联端到端(88 项,自起停服务;真实执行页面脚本)
npm run test:cert         # 权利证明签发/离线验真 全对抗场景 + 断电恢复(73 项)
npm run test:deleg        # 机构级查验额度委托 全对抗场景 + 断电恢复(57 项)
npm run test:cert-pages   # 权利证明中心 / 合作机构受托台 / 离线验真器 页面级端到端(39 项)
npm run test:all          # 以上六套依次运行
```

> 重启恢复测试通过环境变量 `EWR_DB_FILE` 使用独立临时数据文件(默认 `/tmp/ewr-restart-db.json`),
> 权利证明测试用 `EWR_CERT_DB`、页面测试用 `EWR_CERTPAGE_DB`;端口可用 `RESTART_PORT` 覆盖。

首次启动自动载入 `src/seed.js` 演示数据;数据落盘于 `data/db.json`,任一工作台可点「重置演示数据」。

| 页面 | 地址 | 角色 |
|---|---|---|
| 仓库端 | `/warehouse.html` | 按库位+检验批登记、拆分/合并、复检、凭放行出库 |
| 融资方端 | `/financier.html` | 质押锁定/登记、补充担保、还款、放行、**质权转让与交接(双方确认)**;**可恢复会话、操作步骤回放**;并发/晚到/重放演练 |
| 权利证明中心 | `/certificates.html` | 签发/下载/二维码/在线验真/密钥/回放;**机构查验额度的分配与收回、额度树速览** |
| 合作机构台 | `/partner.html` | 受托机构查看可用授权并按场景/操作人/业务流水消费,回放本机构裁决 |
| 监管查询 | `/regulator.html` | 区间重叠/重复融资/提前宣称/**质权转让交接**审计、哈希链验签、权属穿透、**融资方操作审计回放、证明额度委托树** |

## 五条强制业务不变量

- **I1 实物区间不重叠** — 同一库位内有效仓单的 `[startQty,endQty)` 两两相交检测,登记/拆分/合并/复检/出库每个事务提交前强制执行。
- **I2 版本锁定** — 质押锁定仓单 `version`、估值批次 `valuationBatchId`、权利人 `financerId`;旧版本晚到登记返回 `STALE_RECEIPT_VERSION` 拒绝。
- **I3 排他占有** — 一份仓单任一时刻至多一笔存续质押(`LOCKED/REGISTERED/SUPPLEMENTING`),第二家机构(含并发)得到 `ALREADY_PLEDGED`。
- **I4 登记生效** — 登记回执到达前恒为「已锁定·未登记」,`canPubliclyClaimEffective=false`,页面明确标注不得宣称担保生效。
- **I5 复检不抹押** — 复检生成新检验批、版本+1,只重估受影响仓单的质押;覆盖不足转 `SUPPLEMENTING` 并生成补充担保要求,原质押不删除。
- **I6 放行前置出库** — 有有效质押时出库必须携带**当前质权人**签发的放行令牌;未清偿只能按放行数量部分出库,令牌核销。
- **I8 质权转让双方确认** — 存续中已登记质押可发起转让;同一质押同时至多一笔待确认转让,申请锁定当时质权版本(`rightsVersion`)。原质权人与受让机构**必须分别确认同一申请**:任一方撤回、同一方重复确认、非参与方确认、基于旧质权版本的申请/确认晚到,均不改变当前权利人。第二方确认时过**生效闸口**(质押仍存续 + 敞口未清偿 + 无生效放行单)才在同一事务切换 `financerId`(权利版本 +1、原登记凭证不动、旧放行单作废);闸口不过则申请记 `REJECTED` 并给出明确原因。切换后旧质权人的登记/还款/补充/放行一律 `FORBIDDEN`,新质权人沿用原质押继续处理。

## 对抗场景的实现位置

| 风险 | 机制 |
|---|---|
| 多家机构并发质押 | `storage.js` 写操作 FIFO 串行队列 + `domain.js activePledgeOf` 排他校验,失败方留 `CONFLICT/ALREADY_PLEDGED` 操作痕迹 |
| 旧版仓单晚到 | `registerPledge()` 比对 `expectedVersion` 与仓单当前版本,拒绝留 `CONFLICT/STALE_RECEIPT_VERSION` 痕迹,质押不被抹除 |
| 非当前质权人请求 | 登记/放行(含幂等重放)校验 `actorId === pledge.financerId`,拒绝留 `REJECTED/FORBIDDEN` 痕迹 |
| 并发发起两笔转让 | 写事务 FIFO + 每质押至多一笔 PENDING 转让,第二笔 `TRANSFER_ALREADY_PENDING` 留痕,无双重权利人 |
| 重复确认 / 非参与方确认 | 同一方二次确认 `ALREADY_CONFIRMED`;非转让双方 `FORBIDDEN`;相同确认 `reqId` 重放返回首次结论 |
| 旧质权版本晚到 | 申请/确认携带 `expectedRightsVersion`,与当前 `rightsVersion` 不符一律 `STALE_PLEDGE_VERSION`,权利人不变 |
| 双方确认时已清偿/已有放行单 | 第二方确认的生效闸口在同一事务判定:`PLEDGE_SETTLED` / `RELEASE_EXISTS` → 申请落 `REJECTED`,不切换、不重复生效 |
| 转让进行中刷新/宕机 | 申请与双方确认进度、幂等表、操作留痕全部随盘持久化;重启后凭同一申请号恢复 PENDING 进度并可继续交接 |
| 拆分中途故障 | `transact()` 写时复制深拷贝,`simulateCrash` 抛错整体回滚,无半截子单 |
| 相同登记回执重放 | 登记回执号 / 锁仓 reqId / 放行 reqId 均走 `idempotency` 表,重放返回 `replayed:true` 同一结果(同一登记回执号、同一放行令牌) |
| 浏览器刷新 / 服务重启 | 每个写请求带 `sessionId`,成功/冲突/拒绝均落 `operationRecords` 并随盘持久化;`GET /api/session` 重建台账、操作步骤与原始回执 |
| 重复提交 / 断网重试 | 前端发送前把幂等键持久化为 PENDING 草稿;重建时按幂等键核对,核对不到只能「同键重发」,无幂等键步骤只按台账核对、绝不自动补发 |
| 权利链篡改 | append-only 事件,每条 `hash = sha256(prevHash + 稳定序列化载荷)`,`verifyChain()` 重算全链;操作留痕亦为链上 `ATTEMPT_LOGGED` 事件,监管页一键验签 |

## 可恢复融资方会话(I7)与操作审计

- **I7a 会话由服务端权威重建** — `sessionId` 存浏览器 localStorage;`GET /api/session?sessionId=` 返回
  当前台账(质押/仓单/放行单/补充要求)、按序操作步骤(SUCCESS / CONFLICT / REJECTED + 实际原因)、
  原始回执(锁仓版本与估值批次、**登记回执号**、**放行令牌**)。刷新页面或进程重启后工作台不依赖浏览器内存。
- **I7b 失败必留痕且不改变有效状态** — 成功/冲突(重放)留痕与业务事务原子提交;业务事务回滚后由
  独立事务补登拒绝记录,留痕不读写任何业务状态。并发冲突、陈旧版本、非当前质权人请求全部可按
  仓单/质押/主体/会话/结果在监管页回放。
- **I7c 重试不产生第二笔** — 锁仓 `reqId`、登记回执号、放行 `reqId` 在发送前生成并持久化;
  任何刷新/重启后的重试都携带同一幂等键,服务端返回首次产物(同一质押、同一登记结果、同一令牌)。
  非原请求方持相同键重放按 `FORBIDDEN` 拒绝。

## 对外权利证明模块(不变量 C1–C6)

融资方或监管方选取一项仓储权利的**当前摘要**,生成自包含、ECDSA P-256 签名的对外证明;第三方在**断网环境**仅凭
离线包内置信任锚即可验真。

- **C1 自包含签名信封 + 链上锚点** — 证明为扁平 JSON 信封 `{v,alg,kid,claims,sig}`,正文与签名在同一事务
  生成、落盘、上链(`CERT_ISSUED` 锚点),签名/上链中途失败整体回滚,不存在无锚点证明。
- **C2 旧证明按签发规则继续验真** — 证明冻结签发时点的仓单版本/状态/状态承诺;仓单随后复检、质权转让、
  密钥正常轮换(`ROTATED` 旧密钥仍是信任锚)都不影响旧证明;撤销是内容层面唯一的在线失效。
- **C3 在线核验结论确定** — 核验必带一次性 `nonce`:成功才在同一事务扣次并记 `CERT_VERIFIED`;
  过期、用途不符、已撤销、次数耗尽、篡改、密钥吊销等失败返回确定拒绝码且**不扣次数**;
  同一 nonce 重放(断网/失败重试)返回首次结论。
- **C4 并发抢占确定** — 同一核验请求(同 nonce)与「抢最后一次」(不同 nonce)由 FIFO 串行事务裁决:
  恰一笔成功扣次,其余看到扣减后计数或幂等首次结论,无超扣。
- **C5 断电恢复不丢** — 密钥、撤销记录、已用次数、核验结论与链全部随业务事务原子落盘;
  SIGKILL 重启后计数不回退、吊销不复活、旧 nonce 重放仍返回首次结论。
- **C6 选择性披露隐私** — 未披露字段只以「逐字段随机盐承诺」出现(盐仅留签发方台账,不进证明/链/离线包),
  连字段名也不出现在证明中;放行令牌**不进入快照**,无法从证明推导企业身份、估值、融资额或放行令牌。

离线验真器校验:签名、链头/签发时状态锚点(按与平台一致的链式规则重算锚点哈希)、有效期、核验用途、正文篡改;
撤销状态与剩余次数属签发方在线台账,离线不可知,页面明确标注 `UNKNOWN`,不臆断为有效。

密钥三态:`ACTIVE`(当前签发)/ `ROTATED`(正常轮换,旧证明继续受信)/ `REVOKED`(疑似私钥泄露应急吊销,
其签发证明立即拒绝)。

## 机构级查验额度委托(不变量 C7)

持有方(凭据签发融资方或监管方)可把一张凭据**总次数中的一部分**分配给指定**合作机构**(partner),
并限定**业务场景、起止时间、单次操作人上限与允许名单**;受托机构只能消费自己的受托额度。

- **额度不超扣** — 分配即预留:`maxUses ≥ 凭据已用量 + Σ 各生效委托剩余预留`;受托消费在同一 FIFO 事务
  同时扣「委托额度」与「父凭据总账」,机构额度与父总额度在并发下都不超扣。收回的未用额度立即回池可再分配。
- **受托只能消费自己的** — 越权机构 `DELEG_FORBIDDEN`、场景不符 `DELEG_SCENE_MISMATCH`、
  时间窗外 `DELEG_NOT_STARTED/DELEG_EXPIRED`、操作人超限/不在名单 `OPERATOR_LIMIT_EXCEEDED/OPERATOR_NOT_ALLOWED`。
- **业务流水唯一裁决** — 每次消费携带唯一 `flowNo`,成功扣次/拒绝留痕都持久化;相同流水再次提交
  (断网、失败重试)恒返回第一次裁决,不重复扣次、不产生第二个终态。
- **收回即失效** — 收回未用额度后委托落 `RECLAIMED`,旧授权立即不能继续使用(已消耗次数不回收);
  收回与消费同时到达由 FIFO 裁决,只形成一个终态(RECLAIMED 拒消费 / EXHAUSTED 拒收回)。
- **级联停止** — 凭据作废、密钥紧急停用或**上级额度耗尽**(含持有方直接核验耗尽)时,全部生效中下级
  授权在同一事务转 `STOPPED`(原因 `CERT_REVOKED`/`KEY_REVOKED`/`PARENT_EXHAUSTED`),消费立即拒绝。
- **可审计/可恢复** — 分配 `CERT_DELEG_GRANTED`、消费 `CERT_DELEG_VERIFIED`、拒绝 `CERT_DELEG_DENIED`、
  收回 `CERT_DELEG_RECLAIMED`、级联停止 `CERT_DELEG_STOPPED` 全部进同一条 SHA-256 哈希链并原子落盘;
  SIGKILL 重启后额度、裁决、终态不回退。
- **监管视图** — 按父级凭据查看完整额度树(总账 → 各机构委托 → 已用/剩余/预留/可分配)与严格按链序的先后事件。

## 目录

```
src/storage.js  持久化 + 严格 FIFO 串行事务(支持 async mutator;整段「快照→执行→提交」串行,读走队列尾一致快照)+ 哈希链
src/domain.js   仓单/质押/复检/出库领域逻辑、操作留痕、会话重建与审计查询
src/cert-core.js  证明密码学核心:ES256 签名/验证、字段承诺、链锚重算、离线 verifyOffline(Node/浏览器同源 UMD)
src/certificates.js 证明签发/在线核验/撤销/密钥轮换/监管查询 + 机构查验额度委托(分配/消费/收回/级联停止/额度树)
src/qrcode.js   零依赖 QR 编码器(byte 模式 v1–40,纠错 L,RS+8 掩膜择优;Node/浏览器同源 UMD)
src/seed.js     演示数据(含两家合作机构 partner)
src/server.js   HTTP API、失败留痕守卫、静态托管、离线验真器单文件构建(内联信任锚)
public/certificates.html / certificates.js  权利证明中心(签发/下载/二维码/在线验真/**额度委托分配与收回**/密钥/回放)
public/partner.html / partner.js           合作机构受托查验台(可用授权、受托消费、流水重放、裁决回放)
public/offline-verifier.partial.html + offline-verifier.js  第三方离线验真页(构建为单文件)
public/         其余工作台(原生 HTML/JS;common.js 以 IIFE 隔离,只暴露 window.EWR)
test/smoke.mjs              112 项端到端不变量测试
test/restart-recovery.mjs    28 项进程重启恢复测试(自起停临时服务)
test/e2e-flow.mjs            88 项三页串联端到端(仓库建单→锁定/登记/清偿/授权→出库→监管)
test/certificates.mjs       73 项证明签发/离线验真/对抗/断电恢复(自起停临时服务)
test/delegation.mjs          57 项机构额度委托:越权/错场景/过期/操作人/流水幂等/并发争抢/收回/级联/断电恢复
test/cert-pages.mjs          39 项证明中心/合作机构受托台/离线验真器页面级端到端
test/mini-dom.mjs           e2e 使用的零依赖极简 DOM 垫片(在 Node 中真实加载 common.js+页面脚本)
```

## 主要 API

`POST /api/receipts/register|split|merge|recheck|deliver`
`POST /api/pledges/lock|cancel|register|supplement|repay|release`
`POST /api/pledges/transfers/apply|confirm|withdraw` · `GET /api/transfers`
`POST /api/valuation-batch` · `GET /api/state` · `GET /api/audit` · `GET /api/receipt?id=` · `POST /api/admin/reset`

对外权利证明:
- `POST /api/certificates/issue` — `{actorId, receiptId, purpose, ttlDays|expiresAt, maxUses(null=不限), discloseFields[], issueNonce}`,
  融资方仅可对自己持有的存续质押仓单签发,监管方可对任意有效仓单签发;返回证明信封与台账视图;
- `POST /api/certificates/verify` — 在线核验 `{envelope|certId, purpose, nonce, verifierId}`;无效证明返回 HTTP 200 +
  `{valid:false,code}` 裁决(便于失败 nonce 留存与重试),成功才扣次;
- `POST /api/certificates/revoke` — 原签发方或监管方撤销,重复撤销幂等;
- `GET  /api/certificates?receiptId=&issuedBy=&purpose=&status=` 与 `GET /api/certificates/verifications`(监管回放);
- `GET  /api/certificates/anchors` — 全部已知密钥信任锚(含 REVOKED 标记,离线器据此精确拒绝);
  `GET /api/certificates/audit` — 证明/核验/密钥计数 + 链验签;
- `POST /api/cert-keys/rotate` / `POST /api/cert-keys/revoke`(仅监管方) · `GET /api/cert-keys`;

机构级查验额度委托:
- `POST /api/certificates/delegations/grant` — 持有方/监管方分配:`{actorId,certId,trusteeId,scenario,quota,ttlDays|startsAt+endsAt,perOperatorLimit?,operatorAllowlist?[],reqId}`;
  场景须等于凭据用途,时间窗不得超出凭据有效期,`已用 + 各生效委托剩余预留 + quota ≤ maxUses`,否则 `PARENT_QUOTA_EXCEEDED`;
- `POST /api/certificates/delegations/consume` — 受托机构消费:`{delegationId,trusteeId,scenario,operatorId,flowNo,envelope?}`;
  成功同事务扣委托与父凭据两本账;越权/错场景/过期/收回/级联停止/操作人限制均返回 200 + `{valid:false,code}`,失败不扣次;**相同 `flowNo` 重放返回第一次裁决**;
- `POST /api/certificates/delegations/reclaim` — 持有方/监管方收回未用额度:`{actorId,delegationId,reqId}`,返回 `returned`,旧授权立即失效;
- `GET  /api/certificates/delegations?certId=&trusteeId=&grantedBy=&status=`(合作机构页按 trusteeId 展示可用授权);
  `GET /api/certificates/delegations/verdicts?certId=&delegationId=&trusteeId=&valid=`(消费裁决回放);
- `GET  /api/certificates/delegation-tree?certId=` — 监管端按父级凭据返回完整额度树(totals + 各委托 + 严格按链序事件)。

- `GET  /offline-verifier.html`(在线打开,注入当前信任锚)/ `/offline-verifier.download`(附件下载单文件)。

会话与审计:
- `GET /api/session?sessionId=` — 重建融资方会话:台账(含**转让单**)+ 按序步骤(成功/冲突/拒绝原因)+ 原始回执;
- `GET /api/operations?receiptId=&pledgeId=&actorId=&sessionId=&outcome=&action=` — 操作留痕多条件查询,按发生顺序返回(支持 `transferApply/transferConfirm/transferWithdraw`);
- 六个 `/api/pledges/*` 与三个 `/api/pledges/transfers/*` 写接口均可携带 `sessionId`;锁仓/登记/放行/转让申请/确认/撤回的幂等键(`reqId`/`registrationNo`)在服务端去重,重放返回首次结果。

质权转让接口:
- `POST /api/pledges/transfers/apply` — 当前质权人发起:`{pledgeId,toFinancerId,expectedRightsVersion,reqId,actorId}`,返回 PENDING 申请(锁定质权版本);
- `POST /api/pledges/transfers/confirm` — 一方确认:`{transferId,actorId,side,expectedRightsVersion,reqId}`;第二方确认时同事务过闸口,返回 `effective:true` 或 `{effective:false,rejectCode}`(申请落 REJECTED);
- `POST /api/pledges/transfers/withdraw` — 任一方撤回:`{transferId,actorId,reqId}`,撤回后权利人不变,可重新发起。

`GET /api/receipt?id=` 的时间线另含 `operations[]`(按仓单的操作顺序、登记回执号、放行令牌与失败原因)。
