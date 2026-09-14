## Context

排序策略注册表 `SORT_STRATEGIES`（`src/interactive.js`）已为多策略预留扩展位，每个策略是 `{ id, label, hint, describe, compute(tracks, getAlbumTrackOrder) }` 形状的对象；当前只有默认策略。排序核心 `src/sort.js` 是纯函数模块（无 IO），专辑内顺序通过回调注入。实测（2026-09-14，红心歌单 409 首）确认 `ncm-cli playlist tracks` 每首曲目带 `extMap.addTime` 毫秒时间戳，覆盖率 100%、无重复，且接口返回顺序不保证按该字段排序。

## Goals / Non-Goals

**Goals:**

- 新增"按加入歌单时间"策略，纯内存计算、零额外请求
- 复用现有策略注册表与选择界面，不改动向导流程结构
- 缺 `addTime` 的曲目容错（排末尾、不丢歌）

**Non-Goals:**

- 不做降序（最新在前）变体——需要时可作为后续策略再加，避免选项膨胀
- 不给命令行模式（`cli.js sort`）加对应参数——与"调整歌手顺序"一致，交互向导先行
- 不改变默认策略行为与专辑缓存链路

## Decisions

**1. 排序函数放 `src/sort.js`，命名 `sortByAddTime(tracks)`。**
与 `computeNewOrder` 同级导出，保持"纯函数排序核心"的模块约定。签名不需要 `getAlbumTrackOrder` 回调（不依赖专辑数据）。备选：做成 `computeNewOrder` 的模式参数——否决，两种策略语义差异大（单曲级 vs 专辑块级），强行共用一个函数会引入模式分支复杂度。

**2. 时间戳读取路径 `track.extMap && track.extMap.addTime`，两级容错。**
`extMap` 或 `addTime` 缺失的曲目归入"无时间戳"组，按原相对顺序追加在有序组之后（稳定排序：先按有无分组，组内 `Array.prototype.sort` 在 V8 中稳定，同时间戳时保持原顺序）。备选：缺时间戳直接报错中止——否决，实测 100% 覆盖但接口无契约保证，容错比硬失败更稳。

**3. 策略对象增加 `needsAlbums` 标志（默认策略为 `true`，新策略为 `false`），向导据此跳过专辑预取。**
备选：在 `compute` 返回值上判断——否决，预取发生在 `compute` 调用之前，必须由策略元数据提前声明。跳过预取同时跳过 `collectAlbumIds` 与进度条，直接 `strategy.compute(tracks, fetchAlbumTrackOrder)`（新策略的 compute 忽略第二参数）。

**4. 确认环节的"歌手顺序调整"入口仅对默认策略开放。**
`extractArtistBlocks` 的前提是曲目已按歌手块排列，按加入时间排序的结果不满足该前提。实现上：向导在进入确认循环前按 `strategy.id === 'album-first'` 判断是否提供调整选项。

## Risks / Trade-offs

- [接口字段变化：`extMap.addTime` 未来可能消失或改名] → 容错分组保证不崩、不丢歌；单测覆盖缺字段场景，字段消失时策略退化为"大致原顺序"，用户可从预览发现异常
- [策略选项增多后选择界面变复杂] → 当前仅 2 项，每个选项带一句话 hint，复杂度可控；后续策略超过 4~5 个再考虑分组
- [跳过专辑预取后，`strategy.compute` 的第二参数对新策略无意义] → 签名保持不变以兼容注册表约定，新策略的 compute 忽略之，注释说明

## Migration Plan

纯新增，无迁移。回滚 = revert 提交即可，不影响任何既有数据（备份/缓存/新顺序文件格式均不变）。
