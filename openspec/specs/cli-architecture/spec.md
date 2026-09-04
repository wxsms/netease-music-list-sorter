## Purpose

定义 CLI 的模块组织与双入口共存约定：共享逻辑抽取为模块、脚本入口与交互入口并存、依赖引入策略，保证重构不改变既有脚本的外部行为。

## Requirements

### Requirement: 共享模块承载核心逻辑

ncm-cli 调用（含 Windows 下绕过 .cmd shim 的启动方式）、歌单曲目分页拉取、专辑缓存、排序计算、备份写入、reorder 提交、回滚执行等核心逻辑 SHALL 收敛到共享模块中，供脚本入口与交互入口共同复用；两个入口 SHALL 不各自维护重复实现。

#### Scenario: 逻辑只有一份

- **WHEN** 排序规则或 ncm-cli 调用方式需要修改
- **THEN** 只需修改共享模块，脚本入口与交互入口行为同步更新

#### Scenario: Windows 启动方式保留

- **WHEN** 共享模块在 Windows 上调用 ncm-cli
- **THEN** 采用直接以 node 启动 ncm-cli dist/index.js 的方式，不经 cmd.exe，不使用 shell: true

### Requirement: 既有脚本入口行为不变

`sort-playlist.js` 与 `rollback.js` 的命令行参数、输出文件路径（backup/new-order 命名规则）、退出码语义 SHALL 保持不变；重构后 SHALL 仍可按 README 记载的方式直接运行。

#### Scenario: 脚本入口回归

- **WHEN** 用户按现有 README 用法运行 `node sort-playlist.js --dry-run`
- **THEN** 行为与重构前一致（输出格式、退出码、产物文件）

### Requirement: 交互入口与依赖管理

项目 SHALL 提供 `package.json` 声明运行时依赖（交互组件库、参数解析库）与启动脚本；交互入口 SHALL 可通过 `npm start`（或等价的 npm script）启动。Node 版本要求 SHALL 维持 18 及以上。

#### Scenario: npm start 启动交互

- **WHEN** 用户在项目根目录运行 npm start
- **THEN** 进入交互式向导

#### Scenario: 依赖可安装

- **WHEN** 用户在克隆项目后执行 npm install
- **THEN** 依赖安装成功，交互入口与脚本入口均可运行
