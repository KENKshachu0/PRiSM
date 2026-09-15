# PRiSM Next 部署与生产环境指南

PRiSM Next 采用 **完全解耦** 的“单店单部署”架构设计。整个系统包含三个独立的部分：
1. **后端 API 服务**：提供无状态的 REST API 与游戏机 WebSocket 联线（基于 Hono 框架，支持本地 Bun + SQLite 单机部署或云端 Cloudflare Worker + D1 数据库部署）。
2. **管理后台 (Dashboard)**：基于 Flutter Web 开发的静态前端网页（支持 `prism-dashboard` 与 `admin-flutter` 两个版本），与后端完全解耦，需独立构建并以静态资源形式托管。
3. **机器人插件 (Koishi / AstrBot)**：独立运行的聊天机器人客户端，通过网络调用后端的 Integration API 对接店铺业务。

---

## 1. 部署前置条件

### 0022 整数计费升级注意事项

金额从 REAL 元变为 INTEGER 分，券票保持自然整数，不能让旧代码与新数据库混用。首次升级前备份目标库，暂停访问并等待在途写入结束，再执行迁移并部署新 Worker。自动部署脚本按「迁移 → 部署」顺序执行，本身不提供维护窗口。详见 [计费整数与单位约定](money.md)。

本地 `dev:local` 会在升级前生成 `.before-integer-money-*.sqlite` 备份并在事务内执行 0022；直接调用 `initializeSqliteSchema` 遇到旧金额 schema 会拒绝启动，防止误读。升级后核对金额、券票数量、JSON 定价和外键；回滚必须同时协调数据库与代码。

在进行任何部署之前，请确保您的宿主机环境已安装：
- **Bun**：版本 1.3 或以上。
- **Wrangler**（云端部署需要）：版本 4.x。
- **Flutter SDK**（管理后台构建需要）：对应 Dart SDK 及 Flutter 命令行工具。

在 `prism-next` 根目录下安装系统依赖：
```bash
bun install
```

---

## 快捷开发：本地一键并发运行

为了方便本地快速开发调试，项目提供了一键并发启动所有本地服务的开发指令。在根目录下运行：
```bash
bun run dev:all
```
该命令会自动：
1. **关联 AstrBot 机器人插件**：自动在同级目录查找 `prism-astr` 或 `AstrBot` 文件夹，并将 `packages/plugin-prism-next-astrbot` 插件目录以符号链接（symlink）形式挂载到其插件目录中。
2. **启动本地后端 API**：在后台启动本地 API 并监听 `8787` 端口。
3. **托管 Dashboard**：自动检测是否已有编译好的静态资源（如 `packages/prism-dashboard/build/web`）。若存在，会启动一个极简静态 SPA 服务器秒级托管并监听 `5500` 端口；若未编译，将自动通过 Flutter 启动调试 Web 服务器。
4. **启动机器人**：在工作目录下自动调用 `uv` 启动您的 AstrBot 实例。

在终端中按下 `Ctrl+C` 将优雅地一并杀掉所有开启的子服务进程。

---

## 2. 后端服务部署 (Backend API Server)

后端服务可根据场馆的网络和硬件条件选择以下两种部署模式之一：

### A. 本地单机部署 (Local SQLite)
适用于局域网环境、网络连接较弱或不希望依赖 Cloudflare 云端服务的场馆。

1. **启动服务**：
   ```bash
   bun run dev:local
   ```
2. **说明**：
   - 默认数据库文件生成在根目录下的 `./prism.sqlite`。
   - 如需自定义数据库路径，请设置环境变量 `PRISM_SQLITE_PATH`。请对该文件进行定期备份。
   - 本地程序启动时会自动初始化并升级 SQLite 架构（与测试所用 schema 一致）。
   - 默认监听端口为 `8787`。

### B. 云端部署 (Cloudflare Worker & D1)
适用于需要高可用、公网可直接访问的云端场景。

1. **创建 D1 远程数据库**：
   ```bash
   bun run db:create:d1
   ```
   系统会返回该数据库的元数据。请在本机 `.env` 中将 `database_id` 设置为 `D1_DATABASE_ID`；可从仓库的 `.env.example` 开始填写。数据库名不是 `prism` 时，同时设置 `D1_DATABASE_NAME`。提交到仓库的 `wrangler.jsonc` 只是不含账号信息的公共模板，不要把个人 D1 ID 写回并提交。

   运行以下命令会生成被 Git 忽略的 `wrangler.generated.jsonc`，并配置 Wrangler 官方的生成配置重定向：
   ```bash
   bun run wrangler:config
   ```
   Worker 代码使用的 D1 binding 固定为 `DB`，数据库资源名称和 ID 则由每位部署者独立配置。

2. **验证数据库迁移（本地模拟与远程生产）**：
   - 在本地测试 Worker 行为时，应用本地模拟迁移：
     ```bash
     bun run db:migrate:local
     ```
   - `bun run deploy:worker` 会在上传 Worker 之前自动向远程 D1 应用所有未执行的迁移。如果只想手动预先执行生产迁移，也可以运行：
     ```bash
     bun run db:migrate:remote
     ```
   初始 D1 架构迁移脚本位于 `migrations/0001_initial.sql`。`migrations/0012_canonical_device_targets.sql` 会把历史设施批量目标 `device_id = 'all'` 迁移为 `NULL`，并允许新的批量命令不伪造设备 ID。`migrations/0013_player_checkouts.sql` 新增统一结账批次并关联每条 session settlement，报表据此保留跨 session 抵扣后的最终金额；迁移会为旧结算生成兼容批次。`migrations/0014_hinata_io_executor.sql` 扩展 Hinata IO 执行器约束，并保留设备状态按上报时间查询所需的索引。

3. **部署 Worker**：
   ```bash
   bun run deploy:worker
   ```
   快捷指令会先根据当前部署者的环境变量生成 Wrangler 配置，再应用所有未执行的远程 D1 迁移，最后读取根目录 `package.json` 的 SemVer 并将该版本及当前 Git 短提交号注入 Worker。迁移失败时命令会停止，不会上传 Worker；线上可通过 `GET /version` 核对实际运行版本。不要直接调用裸 `wrangler deploy`，否则会绕过配置生成、迁移和版本注入。
   部署完成后，您将获得一个类似 `https://prism-api.your-subdomain.workers.dev` 的 API 接口域名。

### C. GitHub 自动构建（Cloudflare Workers Builds）

每位部署者都可以 fork 同一个公共仓库，并把自己的 fork 连接到独立的 Cloudflare Worker。进入 Worker 的 **Settings > Build**，配置：

| 项目 | 值 |
| --- | --- |
| Build command | `bun run wrangler:config` |
| Deploy command | `bun run deploy:worker` |
| Non-production branch deploy command | `bunx wrangler versions upload` |
| Root directory | 仓库根目录 |

然后在 **Build Variables and Secrets** 中设置：

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `D1_DATABASE_ID` | 是 | 当前账号的生产 D1 UUID |
| `WORKER_NAME` | 否 | Worker 名称，默认 `prism-api`；建议与控制台中连接的 Worker 名称一致 |
| `D1_DATABASE_NAME` | 否 | D1 资源名，默认 `prism` |
| `D1_PREVIEW_DATABASE_ID` | 否 | 非生产分支预览使用的独立 D1 UUID |

Build variables 只用于生成本次构建的 `wrangler.generated.jsonc`，不会进入 Git 历史，也不是 Worker 运行时变量。`D1_DATABASE_ID` 本身不是访问凭据，但仍可标记为 secret 以减少日志暴露；真正的 API Token 或第三方凭据必须使用 Cloudflare 的运行时 **Variables & Secrets** 或 `wrangler secret` 管理。

`bun run wrangler:config` 同时生成 `.wrangler/deploy/config.json`，因此 Cloudflare 默认的 `wrangler versions upload` 预览命令会自动使用当前项目的生成配置。生产部署命令会在 Worker 上传前自动应用新 `migrations/*.sql`；如果选中的 Workers Builds API token 没有 D1 Edit 权限，构建日志会在迁移步骤失败，需要在 Cloudflare 的 API token 设置中换成允许 D1 写入的用户 token，然后重试构建。

---

## 3. 管理后台部署 (Dashboard / Admin Flutter)

> [!WARNING]
> 后端服务（无论是本地 Bun 还是 Cloudflare Worker）**不托管**管理后台静态资源。访问后端的 `/admin` 路由仅会显示 API 运行状态的提示页。您必须单独构建后台并将其部署为静态 Web 页面。

系统中存在两个 Flutter 管理后台版本，构建方式如下：

### 步骤 1：构建静态资源
在根目录下运行以下命令之一进行编译：

* **构建新版后台 (`prism-dashboard`)**（推荐）：
  ```bash
  bun run prism-dashboard:build  # 自动注入发布版本与 Dashboard Git 提交号
  ```
  构建生成的静态文件位于：`packages/prism-dashboard/build/web/`。

* **构建老版后台 (`admin-flutter`)**：
  ```bash
  bun run admin-flutter:build  # 实际执行 cd packages/admin-flutter && flutter build web --no-pub
  ```
  构建生成的静态文件位于：`packages/admin-flutter/build/web/`。

### 步骤 2：部署静态资源
将编译生成的 `build/web/` 目录上传至您选择的静态托管服务中，例如：
- Cloudflare Pages
- Vercel / Netlify
- 本地 Nginx / Apache 静态文件服务器

### 步骤 3：配置与使用
1. 使用浏览器打开您部署好的管理后台 URL。
2. 登录界面同时填写 **API Base URL**、账号和密码（API Base URL 如本地的 `http://localhost:8787` 或云端的 Worker 域名）。
   生产环境不会猜测或自动连接 API，服务器地址默认为空；点击「登录」后才会检查后端，已初始化时继续登录，未初始化时原地切换为初始化表单。单个请求最多等待 10 秒。本地 Web 开发默认填写 `http://localhost:8787`。
3. 首次部署时，连接上正确的 API 地址后会自动进入开箱配置向导（OOBE），您需要设置：
   - 首个 owner 级别员工账号及密码。
   - 店铺名称和时区。
   - 店铺本位币资产定义。
   - 自动生成「机器人/店内入口」和「机器软件接入」API Token。

---

## 4. 机器人部署 (Koishi / AstrBot)

机器人与后端 API 独立运行，通常部署在能够访问到后端 API 地址的服务器或小主机上。

### 准备工作：生成接入凭证 (Integration Token)
在配置机器人之前，必须先由店员/管理员登录部署好的 Dashboard：
1. 前往 **接入凭证** / **系统设置** 菜单。
2. 创建一个新的 API Token，角色选择 **「机器人/店内入口」** (`integration` 角色)。
3. 复制生成的 Token。该密钥将用于机器人与后端的身份鉴权，请妥善保管。

---

### A. AstrBot 机器人插件部署

1. **安装插件**：
   将 `packages/plugin-prism-next-astrbot` 目录整体复制或链接到您 AstrBot 实例的插件目录下：
   ```bash
   # 目标位置通常为
   AstrBot/data/plugins/astrbot_plugin_prism_next
   ```
2. **启用与配置**：
   启动 AstrBot，进入 WebUI 管理后台启用该插件，并在插件配置表单中填入以下关键参数：
   - `base_url`：PRiSM Next 后端 API 地址（如 `http://localhost:8787` 或您的 Worker 域名）。
   - `integration_token`：上面步骤中生成的「机器人/店内入口」Token。
   - `provider`：身份识别提供方（默认为 `qq`）。
   - `login_pricing_configs`：配置入场计费方案 ID（可在后台计费页面中复制方案 ID，例如 `pricing-music-standard`）。

---

### B. Koishi 机器人插件部署

Koishi 插件位于独立的 GitHub 仓库 `koishi-plugin-prism`，在本 monorepo 中以 git 子模块形式导入到 `packages/koishi-plugin`。它是一个独立发布的 npm 包（`koishi-plugin-prism`），不参与本 monorepo 的工作区依赖管理。请按以下方式集成到您的 Koishi 实例：

1. **安装插件**：
   在您的 Koishi 项目中安装已发布的插件包，或克隆本仓库并初始化子模块后通过本地路径安装：
   ```bash
   # 方式一：直接安装已发布版本
   npm install koishi-plugin-prism
   # 方式二：随本 monorepo 一起克隆（会拉取子模块）
   git clone --recurse-submodules <prism-next-repo>
   ```
2. **在 Koishi 中注册与初始化**：
   在您的 Koishi 配置中启用 `koishi-plugin-prism` 插件（Koishi 控制台会读取其 `Config` Schema），或在自定义插件入口中引入并使用 `applyPrismKoishiPlugin`。示例代码如下：
   ```typescript
   import { Context, Schema } from 'koishi';
   import { applyPrismKoishiPlugin } from 'koishi-plugin-prism';

   export const name = 'prism-next';

   export interface Config {
     baseUrl: string;
     integrationToken: string;
     provider: string;
     autoRegister: boolean;
     defaultDoorDeviceId: string;
     enableStaffCommands?: boolean;
   }

   export const Config: Schema<Config> = Schema.object({
     baseUrl: Schema.string().required().description('PRiSM API Base URL'),
     integrationToken: Schema.string().required().description('Integration API Token'),
     provider: Schema.string().default('qq').description('Identity provider (e.g., qq, aime)'),
     autoRegister: Schema.boolean().default(true).description('Auto register player on first command'),
     defaultDoorDeviceId: Schema.string().required().description('Default door device name or alias'),
     enableStaffCommands: Schema.boolean().default(false).description('Enable staff admin commands'),
   });

   export function apply(ctx: Context, config: Config) {
     applyPrismKoishiPlugin(ctx, {
       baseUrl: config.baseUrl,
       integrationToken: config.integrationToken,
       provider: config.provider,
       autoRegister: config.autoRegister,
       defaultDoorDeviceId: config.defaultDoorDeviceId,
       enableStaffCommands: config.enableStaffCommands,
     });
   }
   ```

---

## 5. 权限与身份隔离 (Auth Boundary)

PRiSM Next 对网络接口实行严格的数据库级 Token 认证拦截：

- **员工端**：通过 `/rpc/admin/login` 进行登录。系统在数据库（SQLite/D1）中匹配加盐哈希的密码，并生成有时效的 `admin_sessions` 记录。
- **玩家端**：通过 `/rpc/player-auth/login/by-identity` 使用已绑定外部身份创建 `player_sessions`。玩家浏览器随后只携带该会话 Token 调用 `/rpc/player/*`；后端从 token hash 解析唯一玩家，不接受 `X-PRiSM-Player-Id` 作为浏览器身份来源。
- **机器人/店内入口**：调用第三方身份解析和后续 integration RPC 时，携带 `Authorization: Bearer <integration-api-token>`。
- **机器软件接入**：投币、Aime 等游戏机软件连接 `GET /rpc/machine/ws` WebSocket，并携带 `Authorization: Bearer <machine-api-token>`。连接后先发送 `hello` 声明 `machineId` 和能力列表；后端不再提供 HTTP 轮询、ACK 或设备状态上报路由。

**角色说明**：
- `owner` 与 `manager` 角色员工具有全部写路由的操作特权。
- `viewer` 角色仅可执行只读查询。
- 系统自动拦截针对最后一名活跃 `owner` 员工账号的禁用或降权请求。
- 遗留的静态 PRiSM 业务环境变量 Token 将被运行时入口忽略；请使用 Dashboard 后台的「接入凭证」菜单代替。

---

## 6. 机器人与机器软件部署规范

- **机器人与机器软件运行位置**：机器人应当部署在店铺控制的服务上；机器软件运行在对应游戏机或可控制游戏机的小主机上。
- **网络调用**：机器人和机器软件通过 API URL 远程或本地调用部署好的 PRiSM API 服务。
- **硬件操作隔离**：Home Assistant 负责电源、空调等设施设备，TTLock 负责配置了 TTLock 映射的门锁；投币、Aime 等游戏机软件能力由机器 WebSocket 通道接入。
- **硬件连接配置**：Home Assistant、TTLock 和 Hinata IO 的连接信息由员工在设备看板配置并保存到 D1 的 `app_settings`，运行时动态读取，不需要把硬件密钥写进 Worker 环境变量或重新部署。Worker 环境变量仅用于指定目标 Worker/D1 数据库等部署资源。

---

## 7. 生产环境预检清单 (Pre-flight Checklist)

在场馆正式投入运营前，请依次确认以下项目：

### A. 账户与密钥预检
- [ ] 已经在受控网络下完成了 `/admin` 的 OOBE 引导配置。
- [ ] 设置了足够强度的 owner 密码，并安全离线保存了恢复凭证。
- [ ] 为日常收银/值班人员创建了 `manager` 或 `viewer` 账号，严禁共用 `owner` 账号。
- [ ] 测试了系统确实会自动拦截注销最后一名 `owner` 员工的写指令。
- [ ] 生成的 Integration/Machine 密钥均已正确保存在对应客户端的主机配置中，没有写入任何公开源码或 Git 仓库。
- [ ] 玩家 Web 或自助入口使用 player session 登录流程，没有继续暴露共享 Player API Token，也没有让浏览器提交任意 `X-PRiSM-Player-Id`。
- [ ] 删除了本地所有临时的 `.env` 或 `.dev.vars` 密钥测试文件。

### B. 数据库预检
- [ ] Cloudflare 部署：创建了独立的 D1 实例，并且本地与远程都成功应用了 `migrations/0001_initial.sql`。
- [ ] 本地部署：确认 `PRISM_SQLITE_PATH` 设置在掉电不易失的存储介质上。
- [ ] 备份机制：配置了每日的 SQLite 或 D1 数据自动备份机制。
- [ ] 完成了小额结账空跑测试，并比对流水金额是否符合预期。

### C. 计费方案预检
- [ ] 每一个启用的 `time.priority` 配置下，至少包含一条有效的可用时间规则。
- [ ] 检查并确保工作日、周末、特殊假日以及跨天时间段（按开始日匹配）的计费 timeline 在后台图表预览中没有重叠冲突或非预期的空档。
- [ ] 检查所有启用的 `charge.fixed` 固定收费项目（如门票等）在预览结账时能以正确的标签计入账单。
- [ ] 验证扣减本位代币时，确实是免费余额优先于充值余额。
- [ ] 验证关联启用中免计费 `PricingEffect` 的资产定义，在结账时能够按配置抵扣计时费用（月卡测试）。
- [ ] 验证归档后的资产定义、礼物和计费方案（pricing archive/restore）在归档状态下无法使用，且在恢复后可重新使用。

### D. 设备动作预检
- [ ] 在激活玩家活跃场次的情况下，能够成功调用 `coin` 和 `aime.scan` 游戏机器动作。
- [ ] 在关闭场次或场次未开启的情况下，`coin` 与 `aime.scan` 被系统正确拦截（返回 400 或 403 错误）。
- [ ] `door.open`、`power.on`、`power.off`、`ac.set_temperature` 等设施动作进入设施执行器，不与投币/Aime 机器软件通道混用。
- [ ] 玩家投币冷却（Coin Cooldown）机制已生效，高频出币请求被正确拦截。
- [ ] 机器软件能用 Machine Token 连接 `/rpc/machine/ws`，非 Machine Token 会被拒绝。
- [ ] 机器连接后发送 `hello`，后台记录该机器在线、能力列表和最后心跳时间。
- [ ] 确认机器软件在收到命令后，执行成功时回复 ACK，执行失败或超时能正确使指令状态变更为 `expired`。
- [ ] 机器软件定时发送 `ping` 或状态上报后，前台后台「设备管理」页面中能看见设备绿色的 online 指示灯。

### E. 前台后台系统 (Staff Web) 预检
- [ ] 后台管理面板 `/admin` 在对应 Worker 域名或本地 IP 下能够正常加载。
- [ ] 尝试录入新玩家、赠送资产、生成 CDK 兑换码批次，并且功能无异常。
- [ ] 验证在手动改单（Checkout Override）结账时，系统强行更改为指定价格，并且溢出的价差被正确记录为员工改单流水的备注。

### F. 机器人与迁移核验
- [ ] 机器人配置了正确的 API Token 并且连线正常。
- [ ] 测试了在聊天客户端中输入 `prism.login`、`prism.billing`、`prism.logout` 和 `prism.coin` 回应正确。
- [ ] 如果使用了旧数据迁移，核对导出的 JSON 与导入 SQLite 的表行数完全一致。
- [ ] 迁移导入的旧计费配置默认在后台为 `disabled` 状态，防止旧计费立刻接管生产。

---

## 8. 版本一致性验证

在每次环境变更或代码修改后，务必在本地终端中运行如下命令以确立业务安全：

```bash
bun run typecheck   # 检查 TypeScript 类型约束是否通过
bun test            # 运行所有的单元测试和集成测试
```
