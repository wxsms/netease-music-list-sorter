## Why

当前项目只有两个"一次性脚本"入口（`sort-playlist.js` / `rollback.js`），用户必须记住参数拼写（`--playlistId`、`--dry-run`、`--no-backup` 等）并手动从 `ncm-cli` 输出里找加密歌单 ID，上手成本高。参考 `bilibili-video2mp3` 的做法：无参数运行时进入交互式向导（选歌单 → 预览 → 确认提交），有参数时保持现有命令行行为，可以显著降低使用门槛，同时不破坏已有自动化用法。

## What Changes

- 新增交互式 CLI 入口：不带参数直接运行（如 `node cli.js` 或 `npm start`）时，进入交互向导，按步骤完成"选歌单 → 预览新顺序 → 确认提交"。
- 交互向导支持从 `ncm-cli` 拉取"红心 / 收藏 / 创建"三类歌单列表，让用户用方向键选择目标歌单，不再需要手动复制加密 ID。
- 交互模式默认先 dry-run 预览，用户明确确认后才提交 reorder；提交前展示汇总信息（歌单名、歌曲数、备份文件路径、位置变动数）。
- 交互模式内置回滚入口：列出 `output/` 下的 backup 文件供选择并回滚。
- 引入 npm 依赖 `@clack/prompts`（交互组件）与 `commander`（参数解析），项目从"零依赖"变为有少量运行时依赖；现有 `sort-playlist.js` / `rollback.js` 的直接用法保持不变（**非破坏性**）。
- 将现有脚本中的可复用逻辑（ncm-cli 调用、歌单拉取、排序计算、备份/回滚）抽取为共享模块，供交互入口与原脚本共同使用。

## Capabilities

### New Capabilities

- `interactive-cli`: 无参数运行时的交互式向导流程——歌单选择、排序预览、提交确认、回滚入口，以及取消/中断行为。
- `playlist-selection`: 从 ncm-cli 拉取并展示红心/收藏/创建歌单列表，供用户选择目标歌单（含分页与空列表处理）。
- `cli-architecture`: CLI 的模块结构约定——共享模块划分、双入口（脚本入口与交互入口）共存关系、依赖引入策略。

### Modified Capabilities

（无——现有 `sort-playlist.js` / `rollback.js` 的命令行行为不变，仅内部重构为调用共享模块。）

## Impact

- **代码**：新增 `src/` 目录承载共享模块与交互入口；`sort-playlist.js` / `rollback.js` 改为薄壳调用共享模块（外部行为不变）。
- **依赖**：新增 `package.json` 与运行时依赖 `@clack/prompts`、`commander`；Node 版本要求维持 18+。
- **文档**：README 需补充交互模式用法；`CLAUDE.md`（如有）同步更新。
- **风险**：Windows 上 ncm-cli 的 spawn 方式（绕过 .cmd shim）必须保留在共享模块中，不能因重构退化为 `shell: true`。
