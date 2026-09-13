# 统一平台迁移复盘 · 2026-09-13

本次复盘只覆盖现行 ArcadeLink 数据和 `prism-mmw` 数据。源数据库保持只读；本次没有写入生产 D1。

## 发生的问题

- 店铺、管理员和计费快照的映射没有在导入前形成明确清单，导致导入后需要重新确认归属。
- 合并脚本复制了 `app_settings` 中的 Home Assistant 注册表，但旧注册表不是新的逻辑设备表，结果迁移后设备页显示为 0 台。
- 旧的设备命令、状态和连接记录仍引用 Home Assistant entity ID，不能直接关联新的 `machines.id`。
- 麻将进行中的桌位和玩家席位不在旧设备注册表中，不能靠通用设备合并自动推断，必须单独核对。
- 大型店铺 banner 超过单条 D1 写入限制，需要拆分导入。
- 旧 Worker 仍写入时，快照和生产数据会继续产生差异；部署和迁移不能并行进行。
- 迁移标记和计费表存在外键依赖，重复执行时必须幂等，且每一步都要做外键和完整性检查。
- URL 加密密钥、会话密钥和 MuNET 凭据不属于数据库迁移内容，不能从快照恢复或提交到仓库。

## 已修复

- `scripts/merge-platform.py` 现在把设备注册表数量、逻辑设备数量和待处理映射写入报告，迁移完成后执行 `PRAGMA foreign_key_check` 和 `PRAGMA integrity_check`。
- 合并产生的店铺默认关闭可选位置校验；店主确认设置后再启用。
- 0016/0017 及后续迁移标记改为幂等写入，重复回放不会因重复标记失败。
- `scripts/import-legacy-devices.ts` 将 MMW 的 HA 注册表转换为逻辑设备：绑定信息加密保存，生成稳定的设备 ID/二维码 ID，并把旧命令、状态和连接引用改成新的 `machines.id`。
- 设备导入支持直接修改本地合并库，也支持通过 `--sql-out` 生成供 D1 执行的事务 SQL；按稳定 ID 重跑不会新增重复设备。

## 迁移前必须确认

- 每个计费快照对应哪个已经存在的 ArcadeLink `shops.id`，以及店主和店员对应的全局账号。
- `legacyDeviceRegistries` 报告中的每个店铺是否都已完成逻辑设备导入；麻将桌位、席位和正在计费的会话另行核对。
- 旧 Worker 写入已停止，并已取得最后一份 ArcadeLink 与 `prism-mmw` 快照；如有停机窗口外新增数据，先生成并审核增量清单。
- banner 等大字段采用分块 SQL 导入，并在 D1 中核对字节数或哈希。
- Cloudflare 中继续使用原 `URL_ENCRYPTION_KEY`，另行配置会话、MuNET 和 Bot 集成密钥；这些值只通过 Secret 注入。

## 推荐验收顺序

1. 用明确的 `manifest.json` 运行合并，输出文件使用新路径：

   ```sh
   python3 scripts/merge-platform.py /private/manifest.json /private/platform.sqlite > /private/platform-merge.json
   ```

2. 查看 `legacyDeviceRegistries`。对每个待处理店铺运行逻辑设备导入：

   ```sh
   URL_ENCRYPTION_KEY='从 Cloudflare Secret 注入的值' \
     bun run scripts/import-legacy-devices.ts \
     --sqlite /private/platform.sqlite \
     --shop-id '<ArcadeLink shop id>' \
     --sql-out /private/legacy-devices.sql
   ```

   本地验收可直接使用 `--sqlite` 的修改结果；生产 D1 则在冻结写入后执行生成的 SQL。

3. 检查设备、命令引用和数据库完整性：

   ```sh
   sqlite3 /private/platform.sqlite \
     'SELECT shop_id, COUNT(*) FROM machines GROUP BY shop_id; PRAGMA foreign_key_check; PRAGMA integrity_check;'
   ```

4. 核对 ArcadeLink 用户、店铺、卡片、会话、计费余额和历史记录数量，再做设备二维码、HA/IO、TTLock、Bot 和结账验收。保留两个源快照作为回滚依据。

本次本地回放覆盖了 9 个 MMW HA 设备，旧命令/状态引用全部映射，重复执行不新增设备，外键检查为空。它只证明迁移脚本可重复运行，不替代生产冻结后的最终增量验收。
