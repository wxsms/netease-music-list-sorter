## Why

歌单的核心使用方式之一是"按收藏时间线回顾"——最早加入的歌承载回忆、最新加入的歌代表近期口味。当前唯一的排序策略（专辑优先 + 艺人首次出现）会彻底打乱时间线，用户没有任何办法按加入顺序整理歌单。实测确认 `ncm-cli playlist tracks` 返回的每首曲目都带 `extMap.addTime`（毫秒时间戳，409/409 覆盖、无重复），且接口返回顺序不保证按该字段排序，因此需要显式提供按加入时间排序的策略。

## What Changes

- 新增排序策略"按加入歌单时间"：曲目按 `extMap.addTime` 升序排列，最新加入的排在最后
- 该策略为纯单曲级排序，不聚合专辑、不拉取专辑信息（跳过专辑预取步骤，速度更快）
- 交互向导的策略选择列表（`SORT_STRATEGIES`）新增该策略选项
- 缺少 `addTime` 字段的曲目（理论上不存在，容错处理）按原相对顺序排在有时间戳的曲目之后
- 命令行模式（`cli.js sort`）不新增参数，保持交互向导为该策略的唯一入口（与现有"调整歌手顺序"功能一致的做法）

## Capabilities

### New Capabilities

- `sort-strategies`：定义可选排序策略集合的行为契约——策略注册、选择界面、各策略的排序语义（含新增的按加入时间策略与既有默认策略）

### Modified Capabilities

（无。既有 `interactive-cli` spec 的"向导步骤与顺序"要求选择排序策略属于实现细节，本次不改变其需求级别行为；新能力独立成 spec。）

## Impact

- `src/sort.js`：新增纯函数 `sortByAddTime(tracks)`（或等价命名），无 IO
- `src/interactive.js`：`SORT_STRATEGIES` 注册表新增条目；选中新策略时跳过 `prefetchAlbums` 专辑预取
- `tests/sort.test.js`：新增排序函数单测
- `README.md`：排序策略说明补充
- 不影响备份、提交、回滚链路；不新增依赖
