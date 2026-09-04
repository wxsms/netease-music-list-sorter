## Context

当前仓库是两个自包含的 Node 脚本（CommonJS、零 npm 依赖）：`sort-playlist.js`（拉歌单 → 按专辑优先规则计算新顺序 → 提交 reorder）与 `rollback.js`（从 backup 文件恢复顺序）。两者各自复制了一份 ncm-cli 调用逻辑（含 Windows 下绕过 `.cmd` shim 直接 `node dist/index.js` 的关键处理）。参考项目 `bilibili-video2mp3` 的模式：`commander` 解析参数，无参数时走 `@clack/prompts` 交互向导（intro → 分步 prompt → note 汇总 → select 确认 → outro），交互与命令行两条路径复用同一批核心函数。

约束：排序规则、backup/new-order 文件命名、脚本入口的参数与退出码都不能变；Windows 的 ncm-cli 启动方式必须原样保留；Node 18+。

## Goals / Non-Goals

**Goals:**

- 一套共享核心模块，脚本入口与交互入口共同复用，消除两份重复的 ncm-cli 调用实现。
- 交互向导覆盖完整闭环：环境预检 → 选歌单 → 预览 → 确认提交；外加回滚入口。
- 交互路径默认安全：不确认绝不提交 reorder。

**Non-Goals:**

- 不改变排序算法本身（专辑优先 + 艺人首次出现规则维持现状）。
- 不做配置文件 / 持久化偏好记忆（记住上次选的歌单等）。
- 不做 ncm-cli 之外的直连 OpenAPI 方案（>800 首的限制依旧存在）。
- 不发布到 npm（本地工具，`npm start` / `node cli.js` 即可）。

## Decisions

### D1: 模块拆分——CommonJS 保持不变，不引入构建步骤

新建 `src/` 目录，全部用 CommonJS（与现有脚本一致），不做 ESM 迁移、不上 TypeScript、不引入构建工具。理由：项目体量小，构建链会显著抬高维护成本；参考项目虽是 ESM，但其价值在交互模式而非模块体系。

模块划分：

```
src/
├── ncm.js            # resolveNcmEntry + runNcm（唯一一份 ncm-cli 调用实现）
├── playlist.js       # fetchFavoritePlaylistId / fetchPlaylistTracks / fetchPlaylistList(collected|created)
├── album-cache.js    # 三级缓存 + fetchAlbumTracks / fetchAlbumTrackOrder
├── sort.js           # computeNewOrder（纯函数，不碰 IO）
├── backup.js         # snapshot / writeBackup / writeNewOrder / listBackups
├── reorder.js        # submitReorder / rollbackFromBackup
└── interactive.js    # 交互向导（@clack/prompts）
cli.js                # 交互入口（无参数 → interactive；有参数 → 转发给 sort-playlist 逻辑）
sort-playlist.js      # 薄壳：parseArgs → 调 src 模块（行为不变）
rollback.js           # 薄壳：parseArgs → 调 src 模块（行为不变）
```

`sort.js` 保持纯函数（输入 tracks + 一个 `getAlbumTrackOrder` 回调），把 `fetchAlbumTrackOrder` 从外部注入——这样排序核心可以在不 mock 文件系统的情况下单测。备选方案是把缓存读取也放进 `sort.js`，被否决：会让纯逻辑依赖 IO，测试成本高。

### D2: 交互库选 `@clack/prompts`，参数解析选 `commander`

与参考项目一致。`@clack/prompts` 提供 intro/outro/spinner/select/confirm/note 的成套视觉风格，且 `p.isCancel()` 统一处理 Ctrl+C 与 ESC，正好满足"任意步骤取消安全"的要求。备选 `inquirer`（更老、API 分散）、`enquirer`（维护弱），均不如 clack 简洁。

`commander` 只用于 `cli.js` 的有参数分支与 `--help`；`sort-playlist.js` / `rollback.js` 保持手写 `parseArgs` 不动——它们是既有稳定接口，重写参数解析收益低、回归风险高。

### D3: 双入口判定规则——`process.argv.length <= 2` 进交互

与参考项目相同的判定：`cli.js` 无参数时进 `interactive()`，有参数时按 commander 解析执行排序/回滚。`sort-playlist.js` / `rollback.js` 保持原样直跑（不进交互），保证 cron / 脚本化用法零变化。

`package.json` 增加 `"start": "node cli.js"`；不设 `bin`（不发布 npm）。

### D4: 交互向导流程（对应 specs/interactive-cli）

```
intro（版本号）
├─ 预检：ncm-cli --version + user favorite 探测登录态
│    └─ 失败 → note(指引) + exit(1)
├─ 主菜单 select：
│    ① 🎵 排序歌单  ② ⏪ 回滚歌单  ③ 退出
├─ ① 排序分支：
│    ├─ select 来源：红心 / 收藏 / 创建
│    ├─ 红心 → 直接定目标；收藏/创建 → spinner 拉列表 → select 歌单（label: 名称 + 歌曲数）
│    ├─ spinner 拉曲目 → computeNewOrder（spinner 包裹，专辑缓存命中时很快）
│    ├─ note 预览：前 15 首表格 + 位置变动统计 + 汇总（歌单名/ID/歌曲数/备份路径）
│    └─ 循环 select：🚀 确认提交 / 📂 换一个歌单 / ⚙ 修改选项(保存新顺序文件) / ❌ 取消
└─ ② 回滚分支：
     ├─ listBackups() 按时间倒序 → select 备份文件（label: 文件名 + 歌曲数）
     ├─ 空 → 提示后回主菜单
     └─ note 摘要 → confirm → submitReorder
```

关键点：确认环节用"循环 select + 可修改选项"（参考项目的模式），而不是一次性 confirm——满足 spec 里"确认前可调整选项"的要求。预览与汇总合并为一个 `p.note`，避免步骤冗长。

### D5: 备份策略——交互模式强制写备份

交互路径不允许关闭备份（没有 `--no-backup` 等价物）。理由：交互模式面向不熟悉参数的用户，是误操作的高发场景；备份是唯一的安全网。脚本入口保留 `--no-backup` 不变（spec 只约束交互入口）。

### D6: 环境预检的实现方式

用 `runNcm(['user', 'favorite'])` 一次调用同时验证"可执行"与"已登录"：能启动且返回 `data.id` 即通过；`res.error`（ENOENT）→ 未安装；非零退出或无 `data.id` → 未登录/凭据失效。不做单独的 `--version` 探测，减少一次子进程调用。预检结果（红心歌单 ID）顺手缓存，选"红心"来源时直接复用，省一次重复请求。

### D7: 歌单列表拉取——新增 `playlist collected/created` 封装

`src/playlist.js` 新增 `fetchPlaylistList(kind)`，封装 `ncm-cli playlist collected` / `playlist created`，返回 `[{id, name, trackCount}]`。ncm-cli 这两个命令若也有分页，先按单页实现并在返回条数达到页上限时打 WARN（与现有 `fetchPlaylistTracks` 的防御风格一致）；分页参数确认后再补。这是设计上唯一的外部行为不确定点，已列入 Open Questions。

## Risks / Trade-offs

- [ncm-cli `playlist collected/created` 的返回结构未实测] → 实现时先用真实 CLI 跑一次确认字段名（`data.id` / `data.name` / `data.trackCount`），封装层做字段缺省容错；若结构差异大，只改 `fetchPlaylistList` 一处。
- [重构可能改变脚本入口的输出格式] → `sort-playlist.js` / `rollback.js` 改薄壳后，逐行对照现有 console 输出做回归（dry-run 跑一遍 diff 输出）；`src` 模块内部不打日志，日志留在入口层，保证输出格式由入口全权控制。
- [引入 npm 依赖后，"零依赖"卖点消失] → README 明确说明：脚本入口仍只依赖 Node 标准库可跑（依赖仅交互入口需要）；`package.json` 的 dependencies 只含 `@clack/prompts` 与 `commander` 两个小体积包。
- [clack 的 select 在超长歌单列表（>100 项）下的渲染性能] → clack 内部有虚拟滚动处理；若实测卡顿，给列表加"按首字母/数量分段"的二级选择，作为后续优化，不阻塞本期。
- [交互模式误提交] → 强制备份（D5）+ 提交前 note 汇总 + 显式确认三重防护；reorder 本身不可撤销，但 backup + 回滚入口构成恢复路径。

## Migration Plan

1. 先抽模块（`src/`），`sort-playlist.js` / `rollback.js` 改薄壳，回归验证输出一致——此步不引入任何新依赖，可独立提交。
2. 加 `package.json` + 依赖 + `cli.js` 交互入口。
3. README 更新用法（交互模式置顶，脚本用法保留）。
4. 回滚策略：整个变更是纯新增 + 内部重构，git revert 即可；云端数据层面由既有 backup 机制兜底。

## Open Questions

- `ncm-cli playlist collected / created` 是否需要分页参数（limit/offset）？待实现时实测确认；不影响模块划分与交互流程设计。
