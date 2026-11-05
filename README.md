# AURVEN

<img src="ui/assets/aurven-mark-web.png" alt="AURVEN" width="72">

- **官网 / Website:** [aurven.site](https://aurven.site)
- **项目代币 / Project token:** [代币信息与税收用途 / Token details and tax use](https://aurven.site/token.html) · [Four.meme 购买入口 / Buy on Four.meme](https://four.meme/zh-TW/token/0x8614876e509c18d7be305a39a4a8d9e69c5effff)
- **BNB Smart Chain CA:** `0x8614876e509c18d7be305a39a4a8d9e69c5effff`

面向 BSC 的实验性哈希签名智能账户。包含中英文界面、可交互三维资金演示、公开证明验证和本地测试钱包流程。

Experimental hash-signature smart accounts for BSC, with a Chinese / English interface, interactive 3D fund-flow simulation, public proof verification and a disposable local wallet demo.

**仅供本地与测试网研究，不用于真实资产。尚未完成独立安全审计，不能据此宣称抗量子安全。**

**Local and testnet research only. Do not use with real assets. No independent security audit or validated quantum-security claim.** See [security checks and limitations](SECURITY.md).

## Quick start / 快速开始

Requires Node.js 22+, Python 3 and Foundry 1.8.1. Solidity 0.8.33 is pinned in foundry.toml. The static website has no package-install or frontend build step.

```sh
git clone https://github.com/AURVENwallet/AURVEN.git
cd AURVEN
forge test
node scripts/check-runtime-pin.mjs
node --test test/*.test.mjs
python -m http.server 8937 --bind 127.0.0.1 --directory ui
```

Open http://127.0.0.1:8937/ . Use **中文 / EN** in the header; the choice persists between pages and reloads. Switching languages preserves form input, proof results and simulation progress. Exported protocol data stays language-independent.

打开页面后，通过页头 **中文 / EN** 切换语言。选择会跨页面和刷新保留；切换不改变表单输入、证明结果或模拟进度。浏览器不保管签名种子。

For the local wallet demo, start a separate local chain, then run the demo in another terminal:

```sh
anvil --host 127.0.0.1 --port 8950 --chain-id 31337 --block-time 5
```

```sh
node scripts/local-demo.mjs
```

The demo creates fresh disposable keys and a new account on your own machine. Open Test Wallet and choose **Load local demo**. Generated keys, journals, receipts and build output are excluded from Git. A fresh clone has no demo record until this script completes. Never expose Anvil to the internet. Host only `ui/`, not the repository root.

干净克隆中不包含运行密钥、交易日志或本地回执。先运行演示脚本，再到测试钱包点击「载入本地演示账户」。演示链仅绑定本机；网站服务根目录仅使用 `ui/`。

## Engineering record / 工程记录

## 最新进展：本地钱包完整流程（2026-11-05）

已用一次性公开测试密钥，在本机 Anvil 完成真实合约交易：创建账户 → 首次换根 → 注入本地测试币 → 签名转账 → 再次换根 → 新密钥转账。网页可载入该账户，读取当前余额、密钥代数与剩余交易叶，展开六笔交易记录、复制地址、导出已核对的回执和新的待签名草稿。修改交易信息会使旧草稿失效；切换账户、网络或 RPC 会清除关联的演示状态。

签名与广播由本地演示脚本执行；浏览器当前只读取账户、核对回执和准备草稿。浏览器加密保管、正式签名入口、恢复流程与 BSC 公共测试网转账仍未完成。

### 运行本地演示

先按下文启动 Anvil（127.0.0.1:8950、chainId 31337）和网页服务。在项目目录执行：

    forge build
    node scripts/pin-contract.mjs
    node scripts/local-demo.mjs
    node --test test/client.test.mjs test/flow.test.mjs test/wallet-core.test.mjs

打开 http://127.0.0.1:8937/wallet.html ，点击“载入本地演示账户”。脚本固定连接本机 Anvil，每次发送前检查链号和客户端类型，不接受外部 RPC 或真实私钥。每次运行都生成新种子、新账户和独立日志，不复用旧运行的叶号。三棵完整 1024 叶树在当前机器各耗时约 13 秒，区块确认时间另计。

`demo-runs/<runId>/PUBLIC-TEST-KEYS.json` 是明文、公开、可丢弃的测试密钥，不能承载真实资产；`reservations.jsonl` 在输出签名前写入并同步到磁盘。`report.json` 保存该次结果，`ui/demo/local-demo.json` 保存最新公开演示记录。旧运行目录予以保留。重启或重置本地链后，网页不会将旧记录当成有效回执，应重新运行演示生成匹配记录。仅将 ui 目录作为静态站点根目录。

### 已验证的结果与边界

- 当前演示账户：`0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0`，余额 0.985 本地测试币，epoch 2，next 1，剩余日常交易叶 959。再次运行会改变账户地址。
- 六笔真实本地交易全部成功。创建、首次换根、注资、转账、再次换根、新密钥转账分别消耗 1,289,035 / 193,282 / 21,067 / 230,650 / 176,296 / 205,971 gas。总计 2,116,301 gas；该次本地总费用为 0.002116301014814107 测试币。这不是 BSC 网络报价或最坏情况上界。
- 篡改证明、更换收款人、重复执行、换根后使用旧签名四项调用均被合约按预期拒绝；两次转账均检查了账户与收款人的余额差额。
- 28 项 Node 测试通过（13 项客户端、7 项资金流动、8 项签名状态与回执检查）。签名状态检查涵盖预留完成前不输出证明、并发重用拒绝、预留失败后本进程继续拒绝该叶、派生域隔离；回执检查涵盖执行失败、重组、地址与费用不匹配。
- 网页逐笔核对交易、成功回执和所在区块，同时读取固定 runtime 代码哈希的账户状态。浏览器验证了载入、复制、折叠记录、两类导出、重新生成草稿与修改后失效。导出文件中的六笔回执和草稿账户已再次核对。
- 本轮未修改 Solidity 或密码学参数；43 项 Solidity 通过记录属于此前的合约回归。没有执行主网或公共测试网部署。

### 模块增量与接下来的验收

`ui/lib/evmwots.js` 新增 BSC 测试网 97 的独立 slot 8，原有网络编号保持不变。`ui/test-wallet-core.js` 为一次性演示提供测试身份派生、按链号 / 地址 / epoch 隔离的活动树派生，以及签名前持久化回调。`scripts/local-demo.mjs` 直接部署 BscTestAccount。`ui/local-demo.js` 校验演示清单、真实回执与区块；`ui/transfer-ui.js` 连接网页状态和导出。

此次覆盖 P0-A 的本地创建与派生部分，以及 P0-C 的本地转账闭环。97 派生槽位已配置并通过域隔离测试，但尚未在公共测试网执行。P0-B 仅完成一次性单进程演示中的签前日志与并发保护：日志尚不是可恢复的钱包数据库，脚本也不恢复旧密钥运行。下一步仍需完成浏览器加密存储、跨标签页单写者锁、断电恢复、未决交易处理及旧备份停签策略，再接入浏览器签名和 BSC 测试网。测试通过不能替代独立安全审计或密码学强度评估。

以下章节保留此前阶段的审查与实现记录；涉及“待完成”的历史描述，以本节为最新状态。

## 审查范围
审查覆盖网络配置、签名与验证路径、账户状态和本地回归。以下记录模块职责、技术限制与开发计划。

## 网络与模块映射
|模块|职责与当前限制|
|---|---|
|src/BscTestAccount.sol|仅允许 BSC 测试网 97 和本地链 31337 构造；本地演示通过直接部署创建账户。|
|ui/lib/evmwots.js、keccak.js、sha256.js|链下派生、签名和证明编码。EVM 验证链使用 Keccak，密钥派生使用 SHA-256。|
|src/Wots.sol|Solidity 验证器。元素 16 字节，16 个消息数字加 2 个校验和数字，每链至多 255 步；树高 10，每根 1024 叶。证明共 448 字节。|
|src/KeyLabAccount.sol、KeyLabFactory.sol|账户摘要绑定 chainId、自身地址、epoch、叶号、截止时间和调用内容；不同操作使用不同标签。KeyLabFactory 创建 KeyLabAccount，不能用于创建 BscTestAccount。|
|ui/test-wallet-core.js、scripts/local-demo.mjs|一次性测试密钥、签前日志和本地账户流程；尚不具备可恢复的浏览器密钥存储。|
|test/|合约回归、签名向量互操作、客户端状态与回执检查。多签与 BscTestAccount 的整合仍待验收。|

## BSC 架构与风险
离线签名端生成专用测试种子 → 原子预留叶号并落盘 → 用实际账户地址及链号计算摘要 → 输出证明与待执行调用 → 无签名种子的中继模拟并提交 → Solidity 重建根并核对 → 推进计数后执行调用。普通中继 EOA 支付 gas；哈希签名保护账户授权，底层共识和中继仍沿用 BSC 机制。

新增 BscTestAccount 仅允许 97、31337 构造；此限制仅作用于该入口。本地流程直接部署该合约。初始 epoch 0 需先签 rekey；日常使用 960 叶，余下 64 叶预留换根。每次换根须使用全新密钥树；历史根检测与恢复后的停签策略仍需在正式客户端实现。

|优先级|故障与控制|
|---|---|
|阻断|同一叶签两个摘要会暴露哈希链材料。签前持久化消耗，失败、重组或超时后也只重播原签名或跳到新叶；首版限制单签名设备，恢复旧备份必须停签。|
|阻断|自定义 128 位截断和有状态方案的量子安全界限待分析。互操作测试不能证明抗量子强度。|
|高|恶意 RPC、链号错误或编码分歧。签前展示收款人、金额、链号，独立读取状态，加入跨链、换目标、过期负例。|
|高|证明验证 gas 随摘要变化，原测试 gas 上限极宽。用真实交易回执衡量验证成本，包含最坏输入；整项 Solidity 测试 gas 包含生成签名的开销。|
|高|种子泄露或叶耗尽可导致失控或锁死。服务器只放静态页面、公开数据和限额中继，种子离线保管；测试轮换、恢复和断电。|
|中|RPC 限流、水龙头不可用、服务被滥用。限制请求、模拟后提交，资源不足时继续本地测试。|

## 零预算执行顺序与验收
1. 本地基线（已完成）。安装开源 Foundry，在本目录运行 forge test；首跑需要下载 solc 0.8.33。43 项通过。包含预签名执行、篡改和重放负例，以及 97 放行和 56 拒绝测试。
2. 客户端。固定 JS 签名实现版本，按实际部署的账户地址计算摘要。用公开测试种子在 97 和 31337 各生成 bootstrap、转账、换根向量；通过账户验证并拒绝跨域重播。
3. 状态存储。实现单写者叶号日志与中断恢复；并行发起两次签名、在落盘后断电、模拟交易回滚，验收标准为同叶不会签两个摘要。
4. 本地联调。在 6 核 8 GB 服务器运行单个 Anvil 和 Node 客户端，直接部署测试账户并执行首次换根、模拟转账、二次换根和重放拒绝。测建树耗时、内存峰值、calldata 和交易 gas；服务器不运行 BSC 全节点。
5. 测试网。检查 RPC 返回 chainId 97，使用独立临时付款账户和免费 tBNB。部署前模拟，记录编译参数、实际代码哈希、地址与回执。完成小额测试币转账、证明篡改拒绝、过期拒绝和换根后旧签名拒绝。水龙头领取失败则保留本地验收，不购买代币。
6. 域名可在上述流程通过后提供只读演示页面。首阶段新增现金支出为零，以已有服务器和域名仍可使用为前提。公共测试网部署、在线签名器和独立安全审计均为后续工作。

## 账户读取与草稿功能（2026-11-05）

### 已完成的增量

- 浏览器验证公开签名向量，展示 11 个节点，支持逐层播放、字节差异高亮和记录下载。
- BSC 黄黑交互界面支持拖动、拆解、视角切换和缩放。
- 离线转账草稿支持精确到 wei 的金额、摘要计算、修改后失效和导出。
- 新增只读 RPC 账户同步。检查链号 97 / 31337、已部署 runtime 的固定代码哈希、同一区块的余额 / epoch / next / pubSeed / root，并在读取末尾复核区块哈希。
- 链上模式每次生成草稿重新读取状态，以区块时间设置十分钟截止时间。epoch 为 0 或 next 达到 960 时提示换根并拒绝草稿生成。离线模式继续保留，明确标记手动状态。
- 草稿记录来源、快照和 leafReserved=false。后续签名入口必须重新验证并原子预留叶号，不能把草稿当作已完成预留。
- 新增 13 项客户端回归测试。金额规范输入、摘要字段绑定、主网拒绝、保留叶拒绝、网络错误、代码版本错误、过期节点、重组和首次换根状态均覆盖。
- 本地 Anvil 部署了本项目测试账户，读取真实合约状态，并核对 JavaScript 摘要与 Solidity execDigest 返回值一致。该账户仅为固定公开参数的状态读取样本，epoch 为 0。
- 43 项 Solidity 回归再次通过。多签和工厂尚未完成 BscTestAccount 入口整合。

### 功能状态与开发计划

| 能力 | 当前状态 | 接下来要做 |
|---|---|---|
| Solidity WOTS 验证与单签账户 | 合约回归通过，BscTestAccount 限制测试网构造 | 参数安全评估、BSC 实际 gas 和兼容性验证 |
| 网络与密钥派生 | 读取与草稿支持 97 / 31337；97 使用独立 slot 8 | 公共测试网互操作、派生版本与迁移规则 |
| 创建账户与首次换根 | 一次性本地演示已完成直接部署与首次换根 | 浏览器创建流程、BSC 测试网部署 |
| 种子生成、助记词与恢复 | 本地演示生成一次性公开测试种子；浏览器保管待实现 | 加密存储、解锁与锁定、备份验证 |
| 一次性密钥预留 | 本地演示有签前落盘与进程内并发保护；网页草稿未预留叶号 | 跨标签页单写者锁、断电与恢复测试 |
| 设备接管与恢复防重用 | 待实现 | 首版单设备，恢复后强制换根，检测旧副本状态 |
| 账户状态与网络校验 | 单 RPC 固定区块读取、runtime 校验 | 第二来源比对、重试、持续状态刷新和异常提示 |
| 交易签名、费用与广播 | 本地脚本已完成签名、模拟、广播；网页核对真实回执 | 浏览器签名入口、BSC 费用策略与公共测试网验收 |
| 未决交易与取消 | 待实现 | 重播同一签名、超时后处理、nonce 与叶号分别管理 |
| 资产页面与代币 | 原生币余额读取、交易草稿和本地转账流程 | BEP-20 余额、转账和收款页 |
| 多签 | 合约与 18 项多签测试存在 | 更新 owner 代码哈希准入并验证 BscTestAccount 兼容，补 UI |
| 浏览器扩展、USB | 当前交付为本地网页 | 钱包核心流程验收后再评估交付形态 |
| Swap / DApp | 待实现 | BSC 路由、授权检查与 DApp 连接方案 |
| 发布与运维 | 本地预览服务器 | 静态资源部署、RPC 配额、版本固定、更新与回滚 |
| 安全评估 | 源码初查和回归，独立审计待完成 | 独立安全审计与密码学强度评估 |

### 已识别的技术限制

1. CHAIN_SLOTS 原先没有 97；本轮已分配独立 slot 8 并验证派生隔离。本地完整签名流程已通过，BSC 公共测试网执行仍待验证。
2. KeyLabFactory 创建 KeyLabAccount；BscTestAccount 的 runtime 和创建码不同。该工厂的地址预测与内嵌 evmcode.js 不能用于部署 BscTestAccount。
3. 多签通过 ACCOUNT_CODEHASH 限定 owner。新子类必须明确纳入本项目多签设计，不能把已有多签测试通过视为兼容验收。
4. 链上 next 只反映已上链使用的叶号。已经签出但未上链的叶号必须由本地持久化记录保护，余额和状态读取不能代替此记录。
5. 浏览器验证中的 3D 方块为交互示意。逐层哈希数据来自真实验证计算，方块几何结构不代表完整的 1024 叶树。
6. 编译配置 gas_limit 极宽，部分测试在测试函数内生成签名，测试 gas 不可当作实际转账费用。

### 接下来按验收条件推进

| 顺序 | 交付 | 验收条件 |
|---|---|---|
| P0-A | BSC 测试网专用派生与账户创建 | 使用公开测试种子完成独立域派生、部署、首次换根；错误链 / 地址 / epoch 拒绝 |
| P0-B | 加密存储与叶号日志 | 两标签页并发、签前断电、广播超时、恢复旧文件后，同一叶不签第二个摘要 |
| P0-C | 本地完整转账 | 创建 → 首次换根 → 余额读取 → 签名 → 模拟 → 广播 → 回执 → 再次换根，全程可复现 |
| P1 | BSC 免费测试网 MVP | 97 网络完成相同流程，记录真实 gas 和部署 runtime；免费水龙头不可用时继续本地验收 |
| P2 | 资产和恢复体验 | 收款页面、BEP-20 测试代币、记录、自动锁定、设备接管 |
| P3 | 多签及扩展包装 | 新账户代码哈希兼容、多签阈值与取消测试，随后再做扩展 / USB 版本 |

继续使用已有服务器与域名、Foundry、Node 和免费测试资源。当前单 RPC 读取依赖所选 RPC 的真实性；代码哈希固定只能检验该来源返回的代码，独立来源比对仍待实现。当前浏览器页面尚不保管种子，也没有交易签名和广播入口。

### 本地复现

在项目目录运行：

    forge build
    node scripts/pin-contract.mjs
    node --test test/client.test.mjs
    forge test
    python -m http.server 8937 --bind 127.0.0.1 --directory ui

单独启动本地链：

    anvil --host 127.0.0.1 --port 8950 --chain-id 31337 --block-time 5

仅在该本地链创建状态读取样本：

    forge create src/BscTestAccount.sol:BscTestAccount --rpc-url http://127.0.0.1:8950 --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast --constructor-args 0x11111111111111111111111111111111 0x22222222222222222222222222222222

复制部署地址，在 UI 选择 Anvil、填入该地址及 http://127.0.0.1:8950，再点“同步账户状态”。预期显示“需要首次换根”。运行只读互操作检查：

    node scripts/check-local.mjs <部署地址>

修改 Solidity、编译器或优化配置后，应重新执行 pin-contract.mjs 并部署相应新字节码。当前运行中的本地样本地址是 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512，固定参数仅用于本地状态读取。




验证可视化：ui/lib/evmwots.js 的 rootFromProof 提供可选 onLevel 回调，用于输出中间节点并驱动验证路径展示。




## Key Lab 协议命名迁移

交付项目目录调整为 bsc-key-lab，合约及测试类型使用 KeyLabAccount、KeyLabFactory、KeyLabMultisig 和 KeyLabMultisigFactory。执行、换根、工厂盐值和密钥派生域统一使用 keylab 前缀。

多签 owner 校验值从当前 KeyLabAccount 编译后的 runtime 自动计算。客户端内嵌创建码、账户 runtime 固定值、Solidity 互操作 fixture 和浏览器公开向量均已重新生成。43 项合约测试、13 项客户端测试通过，浏览器向量的原始证明通过、篡改证明拒绝。

迁移后应使用新部署账户和新生成的签名数据。当前本地样本地址为 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512；此账户仍是 epoch 0 的公开状态读取样本。

完整重新生成顺序：

    forge build
    node scripts/generate-code.mjs
    node scripts/pin-contract.mjs
    node scripts/generate-fixtures.mjs 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f
    forge test
    node --test test/client.test.mjs

generate-fixtures 同时写入合约互操作测试数据和浏览器公开证明样本，包含完整的三棵 1024 叶树，普通桌面环境约需一分钟。


## 第二版网站：精密金库（2026-11-05）

网站现在是五个独立静态页面：index.html 项目介绍、flow.html 资金流动、lab.html 验证实验室、wallet.html 测试钱包、token.html 项目代币。代币页展示合约地址、Four.meme 购买入口及项目方说明的开发与测试税收用途，主导航提供 GitHub 直达链接。导航切换独立网址；页面可以直接访问、刷新、前进和后退。

首页采用石墨黑与 BSC 金黄，包含可拆解金库、授权旅程、一次性密钥说明、开发进度与常见问题。资金流动页展示签名端、智能账户、收款端、手续费账户与网络执行节点。验证实验室使用 11 个三维节点对应实际计算得到的叶节点与 10 层验证路径。

三维场景由本地几何、材质和灯光生成，使用本地固定版本 Three.js 0.187.0，不在运行时访问外部 CDN。框架、晶体、验证层、闸门和轨迹是真实三维网格。支持指针拖动、键盘视角、缩放、对象聚焦、拆合、分阶段播放、时间轴回拖、结果分支、模拟金额与速度调整。手机端将播放控制放在场景下方，说明区单独排列。

资金流动完全是浏览器本地模拟，使用固定初始演示余额和 0.0001 BNB 费用。flow-state.js 为画面与余额提供唯一状态来源：验证拒绝时本金不转移；手续费独立展示；回拖可以恢复初始余额。真实账户状态仅在测试钱包页读取，三维模拟不会签名或广播交易。

减少动态效果模式使用逐步推进；静止场景按需绘制，离开页面停止播放。三维初始化失败时回退为静态说明，证明计算与表单仍可使用。回退与减少动态效果分支已实现，本轮浏览器验收没有模拟 GPU 故障或修改系统动态效果设置。

主要界面文件：

- ui/v2.css：共享视觉规范与响应式布局。
- ui/vault-scene.js：首页金库、资金流动与验证路径的三维场景。
- ui/flow-state.js、ui/flow.js：确定性模拟状态与交互控制。
- ui/app.js：真实公开证明校验与路径展示。
- ui/transfer-ui.js：账户同步与草稿；历史导航后重新匹配状态来源与只读字段。

从本项目目录启动预览：

    python -m http.server 8937 --bind 127.0.0.1 --directory ui

打开 http://127.0.0.1:8937/ 。必须通过 HTTP 服务打开，直接双击 HTML 不适合加载这些模块。

本轮验证：18 项 Node 测试通过（原 13 项客户端测试及新增 5 项资金流动状态测试）；浏览器检查了三维拖动、首页拆合、连续播放、成功到账、无效证明拒绝、原始/篡改公开证明、离线草稿生成及本地账户读取。四页在桌面与 390px 窄屏下检查，未发现横向内容溢出。导航、返回、前进、刷新和页面资源检查通过。

本轮没有修改合约或密码学参数；此前记录的 43 项 Solidity 检查属于此前合约验收。所有界面仍是开发原型，完整签名、持久化叶号预留、广播与 BSC 公共测试网转账继续列为后续工作。

资金流动页已补齐六条方向连接：签名端向 Gas 付款账户交付授权；付款账户向网络提交交易并独立支付费用；网络运行智能账户合约；账户向收款端转出本金；网络向付款账户返回执行回执。网络节点表示同一笔交易的执行过程，不是资金接收地址。授权与调用使用银色虚线，本金使用金色实线，费用使用铜色实线，回执使用灰蓝虚线。点击节点可高亮直接关联，并查看每条连接的传递内容。拓扑定义位于 ui/flow-topology.js；新增时序与回执检查后，7 项资金流动状态测试通过。

## AURVEN 品牌与金属控件（2026-11-05）

四页的名称、页签、页头与页尾统一为 AURVEN。用户选定的折带 A 图标采用透明底的小尺寸版本，完整显示边缘，保留更易辨认的深灰内侧；图标文件位于 ui/assets/aurven-mark-web.png。导航标识不再使用背景放大裁切或混色显示。

ui/aurven-materials.css 将主要操作和选中状态设为金色金属表面，辅助操作设为黑金表面，覆盖导航、播放、缩放、三维节点、步骤、验证层级、选择框、输入框、滑块和折叠说明。控件保留键盘焦点、禁用与只读状态。ui/aurven-materials.js 仅在鼠标移动到按钮时更新反光位置，不运行持续动画；减少动态效果设置会停用跟随反光和位移动效。手机端资金场景的取景与标签位置已调整，避开标题说明。

本轮通过四页本地资源引用检查和相关 JavaScript 语法检查。浏览器验证了桌面及 390px 窄屏布局，无横向内容溢出；金库拆合、模块选择、播放完成、键盘回拖、原始证明通过、篡改证明拒绝、状态来源切换及只读字段、离线草稿生成与导出按钮启用均正常。新增控件样式保留现有账户与密码学逻辑，本轮未执行公共网络签名、广播或资金操作。
