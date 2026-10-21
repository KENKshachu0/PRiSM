# PRiSM Next 部署与生产环境指南

PRiSM Next 的统一平台支持多店铺，Worker 同时提供 API 与 React 页面；独立单店 runtime 保留供兼容 API 使用。系统包含以下部分：
1. **后端 API 服务**：提供无状态的 REST API 与游戏机 WebSocket 联线（基于 Hono 框架，支持本地 Bun + SQLite 单机部署或云端 Cloudflare Worker + D1 数据库部署）。
2. **管理与玩家前端**：`packages/prism-web` 的 React 网页，由 Vite 构建，统一平台 Worker 同时托管前端资源与 API。店铺后台入口为 `/merchant`。
3. **机器人插件 (Koishi / AstrBot)**：独立运行的聊天机器人客户端，通过网络调用后端的 Integration API 对接店铺业务。

---

## 1. 部署前置条件

### 0022 整数计费升级注意事项

金额从 REAL 元变为 INTEGER 分，券票保持自然整数，不能让旧代码与新数据库混用。统一平台的 `deploy:beta` 自动提供维护窗口和数据库写入屏障，保护首次从旧 stable 升级以及后续部署；独立兼容 API 的 `deploy:worker` 仍须自行停止旧写入并备份。详见下面的自动维护部署及 [计费整数与单位约定](money.md)。

本地 `dev:local` 会在升级前生成 `.before-integer-money-*.sqlite` 备份并在事务内执行 0022；直接调用 `initializeSqliteSchema` 遇到旧金额 schema 会拒绝启动，防止误读。升级后核对金额、券票数量、JSON 定价和外键；回滚必须同时协调数据库与代码。

在进行任何部署之前，请确保您的宿主机环境已安装：
- **Bun**：版本 1.3 或以上。
- **Wrangler**（云端部署需要）：版本 4.x。

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
2. **准备统一平台**：构建 React 静态资源，生成本地配置，并自动应用本地 D1 迁移。
3. **启动 API 与 React**：Wrangler Worker 默认监听 `8787`，Vite 热更新服务器监听 `5173`；管理入口为 `http://127.0.0.1:5173/merchant`。可用 `PORT`、`WEB_PORT` 改端口，代理和允许来源同步更新。
4. **启动机器人**：在工作目录下自动调用 `uv` 启动您的 AstrBot 实例。

在终端中按下 `Ctrl+C` 将优雅地一并杀掉所有开启的子服务进程。

---

## 2. 后端服务部署 (Backend API Server)

后端服务可根据场馆的网络和硬件条件选择以下两种部署模式之一：

### A. 独立兼容 API (Local SQLite)
保留给 SQLite 回归验证和既有 API 集成。此入口不托管 React，也不提供独立管理后台；开发完整平台请使用 `dev:all`。独立 API 的首次安装仍可通过 setup 接口完成 OOBE。

1. **启动服务**：
   ```bash
   bun run dev:local
   ```
2. **说明**：
   - 默认数据库文件生成在根目录下的 `./prism.sqlite`。
   - 如需自定义数据库路径，请设置环境变量 `PRISM_SQLITE_PATH`。请对该文件进行定期备份。
   - 本地程序启动时会自动初始化并升级 SQLite 架构（与测试所用 schema 一致）。
   - 默认监听端口为 `8787`。

### B. 独立兼容 API 云端部署 (Cloudflare Worker & D1)
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
   初始 D1 架构迁移脚本位于 `migrations/0001_initial.sql`。`migrations/0012_canonical_device_targets.sql` 会把历史设施批量目标 `device_id = 'all'` 迁移为 `NULL`，并允许新的批量命令不伪造设备 ID。`migrations/0013_player_checkouts.sql` 新增统一结账批次并关联每条 session settlement，报表据此保留跨 session 抵扣后的最终金额；迁移会为旧结算生成兼容批次。`migrations/0014_hinata_io_executor.sql` 扩展 Hinata IO 执行器约束，并保留设备状态按上报时间查询所需的索引。`migrations/0023_remote_entry.sql` 曾为 `shop_billing_settings` 增加 `remote_entry_enabled`，`migrations/0024_drop_remote_entry.sql` 又在同一次未发布的改动中移除它——无设备入场不再支持，入场只能由扫码 ticket 授权。

   **迁移内触发器的限制**：远程迁移经由 D1 `/query` 接口应用，其服务端拆分器按 `BEGIN`/`END` 配对划分 `CREATE TRIGGER` 体，但不识别 `CASE` 表达式结尾的 `END`。触发器体内一旦出现 `CASE`，拆分器会把触发器从中间截断，SQLite 报 `incomplete input: SQLITE_ERROR [code: 7500]` 并中止部署。条件抛错请用 `SELECT RAISE(ABORT,'...') WHERE <条件>`，不要用 `SELECT CASE WHEN ... THEN RAISE(...) END`；同时保持 `BEGIN` 大写，小写 `begin` 同样无法被识别。本地 sqlite3、wrangler 客户端拆分器和 `d1 execute --file` 都不会复现该错误，只有远程应用迁移才会暴露。`0028_pricing_versions.sql` 曾因此无法部署。`bun test packages/storage-sql/test/d1-migration-splitter.test.ts` 会按服务端拆分方式回放全部迁移并守住这条约束。

3. **部署 Worker**：
   ```bash
   bun run deploy:worker
   ```
   快捷指令会先根据当前部署者的环境变量生成 Wrangler 配置，再应用所有未执行的远程 D1 迁移，最后读取根目录 `package.json` 的 SemVer 并将该版本及当前 Git 短提交号注入 Worker。迁移失败时命令会停止，不会上传 Worker；线上可通过 `GET /version` 核对实际运行版本。不要直接调用裸 `wrangler deploy`，否则会绕过配置生成、迁移和版本注入。
   部署完成后，您将获得一个类似 `https://prism-api.your-subdomain.workers.dev` 的 API 接口域名。

### C. 独立兼容 API 自动构建（Cloudflare Workers Builds）

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

## 3. React 统一平台部署

管理职能全部位于 `packages/prism-web`，不再需要 Flutter SDK、独立 UI 子模块或 `build/web` 静态目录。

### 构建与部署

```bash
bun run build:web
bun run check:server # (亦可使用兼容别名 check:platform)
bun run deploy:beta
```

构建产物位于 `packages/prism-web/dist/`。`deploy:beta` 构建 React、生成 `--platform` 配置，然后调用 `scripts/deploy-platform.ts` 自动维护部署，注入根 SemVer 和 Git 提交号。脚本使用配置中的 `D1_DATABASE_ID` 和 `APP_ORIGIN`，名称中的 beta 不代表它只操作测试数据库。API 与网页使用同一 origin，SPA 路由由 ASSETS binding 回退。

`wrangler.jsonc` 把 Worker 固定放在东京（`placement.region: "aws:ap-northeast-1"`），也就是 D1（APAC）附近，而不是访客最近的边缘节点。一个请求要顺序查询多次数据库，国内访问常被分到 AMS、LHR、PDX 等远端节点，在那里运行时每次查询都跨洲往返，服务端处理时间会从约 100 ms 变成 2 秒左右。请求仍从访客最近的节点进入（`cf-ray` 里的节点不变），再经 Cloudflare 内网转到东京执行；响应头 `cf-placement` 显示实际执行位置。静态资源仍由边缘直接返回，Durable Object 不受这个设置影响。曾试过智能放置（`mode: "smart"`），状态显示 SUCCESS 但两小时后 AMS/LHR 的请求仍在本地执行，因此改为固定区域。

### 自动维护部署

脚本先编译三个部署阶段，再开始改变线上服务；也可在生成生产平台配置后运行 `bun run scripts/deploy-platform.ts --dry-run`，仅编译三个阶段，不请求线上接口或执行迁移。

1. 发布独立维护 Worker，网页、API、OAuth 回调及新设备连接均返回不可缓存的 HTTP 503 和 `Retry-After: 30`；页面显示「正在升级，请稍后重试」。不依赖旧 stable 认识维护开关。
2. 通过仅部署脚本可认证的控制接口，原子安装 D1 写入屏障。旧版本已进入执行阶段的请求和后台任务也不能继续修改业务表；无需把固定等待时长当作排空证明。LiveBilling Durable Object 的名称、存储和待处理 visit 保留，alarm 延后 30 秒，不读取业务库或推送状态。
3. 屏障生效后获取 D1 Time Travel 恢复书签，并在构建日志及 `.wrangler/platform-deploy-*/recovery.json` 记录。请保留构建日志。没有获取到书签则停止，不开始迁移。
4. 按文件名和数字前缀顺序执行未应用 SQL。沿用 Wrangler 的 `d1_migrations` 表和完整文件名，因此两个 0029 都会执行，已执行的文件跳过。SQL、重建表的屏障及迁移记录在同一个 D1 batch 内提交；失败整批回滚，之前成功的文件仍保留。部署流水线不再直接运行 `wrangler d1 migrations apply`，避免绕过屏障。
5. 发布处于 verify 阶段的正式 Worker，继续返回维护响应。执行一次性 UTC 计费转换和位置时区补齐，检查完成标记、当前及历史方案的 UTC 状态、外键及真实 API 健康响应。数据转换失败保持屏障，重复部署不会再次偏移。
6. 发布 live 阶段的正式 Worker，数据库仍关闭业务写入；仅在此前验证成功时解除屏障，再检查公开健康接口及预期提交号。公开 GET 与已确认的控制 POST 可能暂时命中不同部署阶段，因此每 2 秒重试、最多等待 180 秒；只有 HTTP 成功、`data.ok=true` 且 `x-prism-revision` 等于本次完整提交号才确认恢复。超时日志显示最后 HTTP 状态和提交号是否匹配，不记录响应内容。计时方案同时有 UTC 写入约束，迟到的旧代码不能重新发布本地时钟。

屏障使用主 D1 控制行，不依赖 KV 的传播延迟。部署写入许可只在一个原子 batch 内打开并关闭，业务请求不能看到中间许可。控制接口校验每次部署随机生成的令牌和当前数据库所有者，普通账号、Bot 及其他部署不能借此写库；令牌不放在命令行或日志中。Worker 保留的仅为令牌哈希。数据库表的写入屏障只在维护期间拦截，恢复后正常业务可继续写入。

任意阶段失败都不自动解除维护或回滚数据库。若已经恢复后公开健康检查失败，脚本尝试重新阻止业务；如果网络故障使维护状态无法确认，明确报告而不声称恢复成功。重跑同一流程即可接管失败部署并跳过已完成迁移。并行部署可能因所有者变化安全中止，请为同一 Worker 串行运行构建。

恢复操作须使用日志中的目标数据库和书签；不要仅回滚 Worker 到旧 stable，因为表结构可能已升级。书签是在屏障启用后取得的，恢复该数据库仍保留维护屏障。通常先修复并重新运行 `deploy:beta`；确需恢复旧版时，由管理员恢复对应 D1 书签和匹配的 Worker，再确认兼容性并明确解除 `prism_deployment_gate` 的维护状态。脚本不会自动恢复数据库或删除业务记录。

Cloudflare 构建身份需有当前 Worker 的部署权限、目标 D1 权限及 Time Travel info 权限；无须手工配置维护令牌或新增 KV namespace。

统一平台配置在 `.env.example` 中，必需构建变量为 `D1_DATABASE_ID`、`CLOUDFLARE_ACCOUNT_ID`、`APP_ORIGIN`、`MUNET_CLIENT_ID` 和 `APPLE_TEAM_ID`。OAuth 客户端密钥、会话密钥和 URL 加密密钥等真实凭据放在 Cloudflare Secrets，不写入仓库。

Cloudflare Workers Builds 的 Build command 使用 `bun run build:web`（检测到官方 `WORKERS_CI=1` 时，先验证构建变量并生成统一配置，再构建 React），Deploy command 使用 `bun run deploy:beta`；默认预览命令可继续使用 `bunx wrangler versions upload`。日常亦可使用统一指令 `bun run deploy:worker` 构建前端并发布统一 Worker。

### 登录与配置

打开部署域名的 `/merchant`，通过平台登录后创建或选择店铺，在 React 设置页面维护位置、成员、设备及「接入凭证」。时区根据店铺位置自动设置；计费区间的编辑与展示使用该时区，业务执行统一 UTC。创建店铺时可选计费模式并初始化余额资产和入场方案；旧店铺也可通过设置中的转换向导启用计费。

独立兼容 API 的 `/admin` 仅显示 React 平台的开发／部署提示，不再要求构建另一个 UI。

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
2. **平台身份来源**：`provider` 配置已移除，插件对每条消息读取 `session.platform` 和 `session.userId`；同一个实例可同时接入 OneBot、Telegram 等适配器。旧店如需改标识，请由店主在 React「设置 → 玩家与身份 → 平台身份转换」预览后确认。升级 SQL 不自动转换身份。

3. **在 Koishi 中注册与初始化**：
   在您的 Koishi 配置中启用 `koishi-plugin-prism` 插件（Koishi 控制台会读取其 `Config` Schema），或在自定义插件入口中引入并使用 `applyPrismKoishiPlugin`。示例代码如下：
   ```typescript
   import { Context, Schema } from 'koishi';
   import { applyPrismKoishiPlugin } from 'koishi-plugin-prism';

   export const name = 'prism-next';

   export interface Config {
     baseUrl: string;
     integrationToken: string;
     autoRegister: boolean;
     defaultDoorDeviceId: string;
     enableStaffCommands?: boolean;
   }

   export const Config: Schema<Config> = Schema.object({
     baseUrl: Schema.string().required().description('PRiSM API Base URL'),
     integrationToken: Schema.string().required().description('Integration API Token'),
     autoRegister: Schema.boolean().default(true).description('Auto register player on first command'),
     defaultDoorDeviceId: Schema.string().required().description('Default door device name or alias'),
     enableStaffCommands: Schema.boolean().default(false).description('Enable staff admin commands'),
   });

   export function apply(ctx: Context, config: Config) {
     applyPrismKoishiPlugin(ctx, {
       baseUrl: config.baseUrl,
       integrationToken: config.integrationToken,
       autoRegister: config.autoRegister,
       defaultScanProvider: "aime",
       currencyName: "余额",
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
- **机台直连**：HINATA IO 机台连接 `GET /io/ws`，携带设备看板签发的 `Authorization: Bearer <deviceToken>`；令牌按设备单独签发和轮换。部署需要 `MACHINE_RELAY` Durable Object 绑定（迁移 tag `machine-relay-v1`）。

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
- [ ] `door.open`、`power.on`、`power.off` 只对绑定了门锁／电源能力的设备可用，未绑定时返回 `DEVICE_ACTION_UNSUPPORTED`。
- [ ] 玩家投币冷却（Coin Cooldown）机制已生效，高频出币请求被正确拦截。
- [ ] 直连机台用设备令牌连接 `/io/ws` 成功，错误或已轮换的令牌返回 401。
- [ ] 机台连接后设备看板显示「已连接」，设备日志出现「机台已连接」；断开后显示「机台已断开」。
- [ ] 网页刷卡后机台收到卡片，设备日志中刷卡请求、结果与机台回报的「卡片已送入游戏」对应同一操作。

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

## 平台身份结构升级

发布此版前应用 `migrations/0030_platform_identity_bindings.sql`，新版 React 与 Koishi 插件使用 `platform-binding` API。迁移保留原标识及玩家绑定，店主决定是否批量转换，例如 `qq → onebot`；转换不会调整余额或账单。强制绑定开关位于 React「设置 → 玩家与身份」，默认开启。新 API 与适配器来源的具体约定见 [API 文档](api.md#店铺绑定要求与身份转换)。

限流由 `wrangler.jsonc` 的 Workers Rate Limiting bindings 提供，无需新建限流 KV。发布包含 `0031_platform_retention.sql` 过期索引和小时 Cron；live phase 静态 Assets 绕过 D1 gate，API/DO 仍受维护保护。namespace_id 预留、CPU 预算和 retention 运维约定见 [扫码性能与请求预算](scan-performance.md)。

### Workers Builds 上传占位 D1 配置的排查

如果日志中 Web 构建成功，但 `versions upload` 只有 DB binding、提示 Worker 名称从 `prism-api` 覆盖为目标名称，并以 10021 报 D1 database_id 无效，说明上传使用了根目录的兼容 API 模板。`build:web` 现在在 Workers Builds 中自动先生成统一平台配置与 `.wrangler/deploy/config.json` 重定向；本地及 GitHub CI 的纯 Web 构建不需要 Cloudflare 构建变量。显式执行 `generate-wrangler-config.ts --platform` 仍可用。

在目标 Worker 的 Settings > Build > Variables and Secrets 中填写真实的 `D1_DATABASE_ID`（D1 数据库页面的 UUID）及上文五项必需变量；运行时 Variables & Secrets 不会提供构建变量。生成器会拒绝空值、非法 UUID 和远程部署的全零占位 UUID，失败时不会继续构建或上传。`WORKER_NAME` 未设置时采用 Workers Builds 提供的目标名称，本地仍默认 `prism-api`；显式设置时须与目标 Worker 一致。真实 ID 或凭据无需提交到仓库。默认 `versions upload` 仅上传版本，生产发布仍走 `deploy:beta` 的维护、迁移和验证流程。

### 防止 PR 构建修改运行中的 Worker

`deploy:beta` 与直接运行 `scripts/deploy-platform.ts` 都会在任何发布操作之前检查 Workers Builds 分支：`WORKERS_CI=1` 时，`WORKERS_CI_BRANCH` 必须等于 `PRISM_DEPLOY_BRANCH`（默认 `main`）。非生产分支或缺少分支信息会立即失败，不构建、不发布维护 Worker，也不执行 D1 迁移。生产分支另有名称时，在构建变量中明确设置 `PRISM_DEPLOY_BRANCH`。本地发布流程不受 Workers Builds 分支检查影响。

Cloudflare 中生产 Deploy command 使用 `bun run deploy:beta`；关闭预览构建，或使用独立预览命令与隔离资源。预览命令不可填写 `deploy:beta` 或 `wrangler deploy`；旧版上传预览流程可使用 `bunx wrangler versions upload`，新版 Worker Previews 使用 Cloudflare 控制台指定的 `wrangler preview` 命令。已有 PR 构建失败不能只看 GitHub 测试是否通过，应检查对应的 Workers Builds check。

如果站点持续返回 `503 MAINTENANCE`，先检查失败构建日志及当前发布阶段；分支保护只能避免后续误发布，不能解除已有维护状态。确认并修复失败步骤后，从生产分支重新运行完整部署流程；不要将修改数据库维护行或只回滚 Worker 当作通用恢复方式。

### 上传成功后控制请求返回 404

Wrangler 报告上传/发布成功后，部署脚本会使用本次随机令牌调用只读 `probe`，确认自定义域名正在执行预期提交及阶段；此探测不读写 D1。确认后才执行 `begin`、迁移和恢复操作。404、临时网络错误及可重试 HTTP 状态使用最多三分钟的有界重试，每次网络请求最多十秒；认证后明确的 SQL/所有权错误立即失败。错误日志不打印令牌或任意响应体。

`Deployment begin failed (404)` 表示控制请求在认证处被拒绝（或尚未到达预期 Worker），发生于本次数据库迁移之前；不能把它等同于 D1 UUID 错误。检查域名路由与部署绑定是否指向预期 Worker。`resume` 对已验证、同一部署所有者的重复请求返回成功，避免首次成功但响应丢失后重新关闭业务。上述改动仍保留维护期间的写入保护，不自动关闭未知部署的维护状态。

恢复请求的 409 会区分阶段未就绪（可重试）、部署所有者变化、缺少验证和维护状态不符（立即失败）。部署日志只输出固定错误码，不丢弃可诊断的原因，也不打印任意响应体。并行构建或重试旧提交可能覆盖正在执行的发布；恢复时使用最新修复提交，且同一 Worker 只运行一个完整部署任务。

### 首次安装凭据与机器 WebSocket 令牌

统一服务端的旧版单店初始化入口 `POST /rpc/setup/install`（以及 `/api/v1/setup/install`）现在必须提供一次性部署级安装令牌，避免未认证的外部请求抢占空白数据库。

- 部署变量 `PRISM_BOOTSTRAP_TOKEN_HASH`：安装令牌原文的 SHA-256 十六进制摘要。未配置时初始化接口返回 HTTP 503。
- 请求头 `X-PRiSM-Bootstrap-Token`：部署时生成的高强度随机令牌原文；摘要不应与令牌原文放在同一配置文件中。
- 初始化完成后应移除该部署变量，并保证旧安装接口不能再次创建 owner。
- 云端环境请使用 Cloudflare Secrets 配置此变量，不要将原文或摘要提交到 Git 仓库。

机器 WebSocket `/rpc/machine/ws` 已移除，`role: "machine"` 的 API 令牌不再有用途。HINATA IO 机台在设备看板设为直连后获得自己的设备令牌。
