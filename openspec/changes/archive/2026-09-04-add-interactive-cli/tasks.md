## 1. 共享模块抽取（无新依赖，可独立回归）

- [x] 1.1 创建 `src/ncm.js`：把 `sort-playlist.js` 的 `resolveNcmEntry` / `runNcm` 移入（保留 Windows 绕过 .cmd shim 的逻辑），导出 `runNcm`；`node -e "require('./src/ncm.js')"` 无报错
- [x] 1.2 创建 `src/playlist.js`：移入 `fetchFavoritePlaylistId` / `fetchPlaylistTracks`，并新增 `fetchPlaylistList(kind)`（封装 `playlist collected` / `playlist created`，返回 `[{id,name,trackCount}]`，字段缺省容错）；先真实跑一次 `ncm-cli playlist collected --output json` 确认返回结构并记录在模块注释里
- [x] 1.3 创建 `src/album-cache.js`：移入三级缓存（进程 Map → `.cache/album-*.json` → 接口）与 `fetchAlbumTracks` / `fetchAlbumTrackOrder`；删除 `.cache/album-1.json` 后重跑能重建缓存文件验证
- [x] 1.4 创建 `src/sort.js`：移入 `computeNewOrder`，改为纯函数——`getAlbumTrackOrder` 通过参数注入，模块内不做任何 IO；用固定 tracks + 假回调构造 3 个用例（含无专辑歌、合辑）验证排序结果与旧实现一致
- [x] 1.5 创建 `src/backup.js`：移入 `snapshot` / `writeBackup` / `writeNewOrder`，新增 `listBackups()`（扫描 `output/backup-*.json`，按文件名时间戳倒序，返回路径+歌曲数）；`node -e` 调用 `listBackups()` 输出与 `ls output/` 对得上
- [x] 1.6 创建 `src/reorder.js`：移入 `submitReorder`，并新增 `rollbackFromBackup(backupPath, playlistId)`（从 `rollback.js` 的提交逻辑收敛）；dry-run 场景下不发起真实请求验证参数拼装
- [x] 1.7 把 `sort-playlist.js` / `rollback.js` 改为薄壳：保留各自 `parseArgs` 与 console 输出，逻辑全部改调 `src/` 模块；`node sort-playlist.js --dry-run` 与 `node rollback.js <backup> --dry-run` 的输出与重构前逐行 diff 一致（先留存重构前输出再对比）

## 2. 交互入口与依赖

- [x] 2.1 创建 `package.json`：`dependencies` 仅 `@clack/prompts` + `commander`，`scripts.start = "node cli.js"`，`engines.node >= 18`；`npm install` 成功且 `npm start -- --help` 不报错
- [x] 2.2 创建 `cli.js`：`process.argv.length <= 2` → `interactive()`；否则用 commander 提供 `--playlistId` / `--dry-run` / `--no-backup` / `--save-new-order` / `--rollback <backup>` 并复用 `src/` 模块执行；`node cli.js --help` 显示用法，带参 dry-run 行为与 `sort-playlist.js` 一致

## 3. 交互向导实现（对应 specs/interactive-cli 与 specs/playlist-selection）

- [x] 3.1 实现 `src/interactive.js` 骨架：intro（读 package.json 版本）→ 环境预检（`runNcm(['user','favorite'])` 一次调用验证可执行+登录，缓存红心 ID）→ 主菜单（排序 / 回滚 / 退出）；拔掉 PATH 里的 ncm-cli 验证显示安装指引并 exit(1)
- [x] 3.2 实现歌单选择分支：来源 select（红心默认项 / 收藏 / 创建）→ 收藏/创建走 spinner + `fetchPlaylistList` + 歌单 select（label 含名称+歌曲数）→ 展示选中歌单的名称/ID/歌曲数；空列表提示后返回来源选择，接口失败可重试或退出
- [x] 3.3 实现排序预览与确认循环：spinner 包裹 `fetchPlaylistTracks` + `computeNewOrder` → `p.note` 展示前 15 首预览 + 位置变动数 + 汇总（歌单名/ID/歌曲数/备份路径）→ 循环 select（确认提交 / 换歌单 / 修改"保存新顺序文件"选项 / 取消）；选取消验证云端无请求、exit 0
- [x] 3.4 实现提交路径：确认后强制 `writeBackup`（交互模式无关闭备份选项）→ 可选 `writeNewOrder` → `submitReorder` → outro 报告结果与备份路径；dry-run 走一遍真实歌单验证产物文件生成
- [x] 3.5 实现回滚分支：`listBackups()` 倒序列出（label 含文件名+歌曲数）→ 空列表提示后回主菜单 → 选中后 note 摘要（歌曲数/目标歌单 ID）→ confirm → `rollbackFromBackup` → outro；用一个旧 backup 对真实歌单回滚一次验证闭环
- [x] 3.6 取消安全统一处理：所有 prompt 用 `p.isCancel()` 检查，取消路径统一 `p.cancel` + `process.exit(0)`；向导每一步 Ctrl+C 验证无 reorder 请求发出

## 4. 文档与收尾

- [x] 4.1 更新 README：交互模式（`npm start`）置顶为推荐用法，脚本用法保留；依赖说明改为"交互入口需 npm install，脚本入口仍零依赖"；`node -e` 校验 README 中所有命令示例可执行
- [x] 4.2 端到端验收：完整走一遍交互向导（选收藏歌单 → 预览 → 确认提交 → outro），再走一遍回滚恢复原顺序，确认歌单最终顺序与初始一致；对照 `specs/interactive-cli/spec.md` 逐条 Scenario 核验通过
