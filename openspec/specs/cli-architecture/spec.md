## Purpose

定义 CLI 的模块组织与入口约定：共享逻辑抽取为模块、统一入口（交互向导与命令行子命令）、依赖引入策略。

## Requirements

### Requirement: 共享模块承载核心逻辑

ncm-cli 调用（含 Windows 下绕过 .cmd shim 的启动方式）、歌单曲目分页拉取、专辑缓存、排序计算、备份写入、reorder 提交、回滚执行等核心逻辑 SHALL 收敛到共享模块中，供交互向导与命令行子命令共同复用；两条路径 SHALL 不各自维护重复实现。

#### Scenario: 逻辑只有一份

- **WHEN** 排序规则或 ncm-cli 调用方式需要修改
- **THEN** 只需修改共享模块，交互向导与命令行子命令行为同步更新

#### Scenario: Windows 启动方式保留

- **WHEN** 共享模块在 Windows 上调用 ncm-cli
- **THEN** 采用直接以 node 启动 ncm-cli dist/index.js 的方式，不经 cmd.exe，不使用 shell: true

### Requirement: 统一 CLI 入口

排序与回滚 SHALL 通过统一 CLI 入口（`cli.js`）提供：无参数运行进入交互式向导，带子命令（`sort` / `rollback`）运行走命令行模式；项目 SHALL 不再维护独立的脚本入口文件。

#### Scenario: 命令行排序

- **WHEN** 用户运行 `node cli.js sort --dry-run`
- **THEN** 系统计算新顺序并预览，不提交

#### Scenario: 命令行回滚

- **WHEN** 用户运行 `node cli.js rollback <backup.json> --dry-run`
- **THEN** 系统展示将提交的顺序，不提交

### Requirement: 交互入口与依赖管理

项目 SHALL 提供 `package.json` 声明运行时依赖（交互组件库、参数解析库）与启动脚本；CLI SHALL 可通过 `npm start`（或等价的 npm script）启动。Node 版本要求 SHALL 维持 18 及以上。

#### Scenario: npm start 启动交互

- **WHEN** 用户在项目根目录运行 npm start
- **THEN** 进入交互式向导

#### Scenario: 依赖可安装

- **WHEN** 用户在克隆项目后执行 npm install
- **THEN** 依赖安装成功，CLI 全部功能可运行
