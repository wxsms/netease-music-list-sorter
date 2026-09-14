## Context

`src/sort.js` 的 `computeNewOrder` 已实现"专辑优先 + 艺人首次出现"：按专辑分组 → 每张专辑记 `{ ownerKey, firstPos }`（firstPos = 该专辑最早出现那首歌的位置）→ 歌手块按各自最早专辑的 firstPos 排序。策略注册表 `SORT_STRATEGIES`（`src/interactive.js`）已有 3 个策略，`needsAlbums` 标志控制专辑预取。用户已确认：集中度用中位数定义，歌手与专辑两层都按中位数。

## Goals / Non-Goals

**Goals:**

- 新增"按最集中位置"策略：歌手块间、同歌手专辑间均按曲目位置中位数升序
- 复用 `computeNewOrder` 的分组骨架与专辑内排序逻辑，只替换"归属位置"的计算方式
- 输出仍是歌手块序列，"调整歌手顺序"入口可复用

**Non-Goals:**

- 不改变默认策略（首次出现）的行为
- 不做加权平均、最大簇中心等其他集中度算法（中位数已确认）
- 不给命令行模式加参数

## Decisions

**1. 实现为 `computeNewOrder` 的可选参数而非独立函数。**
`computeNewOrder(tracks, getAlbumTrackOrder, hooks)` 已有 hooks 参数位，新增 `opts.positionMode: 'first' | 'median'`（默认 `'first'`）。分组、专辑内排序、`__unknown__` 兜底全部复用，只有两处"位置"语义变化：专辑的归属位置（firstPos → medianPos）、歌手块间的排序键（该歌手全部曲目位置的中位数）。备选：复制一个 `computeNewOrderByMedian`——否决，两函数 90% 逻辑相同，复制会带来双维护负担。

**2. 中位数取"排序后中间元素"，偶数个取中间两个的平均。**
歌手层：收集该歌手（含其全部专辑）所有曲目位置，排序取中位数。专辑层：收集该专辑所有曲目位置取中位数。平均而非取下中位，避免两簇对称时抖动。

**3. 歌手层排序键直接用"歌手全部曲目位置的中位数"，不经过专辑层中位数聚合。**
备选：歌手位置 = 其各专辑中位数的再中位数——否决，多一层间接会让"一首离群歌"的影响传导失真；直接用全量曲目位置最贴合"最集中"直觉。

**4. 策略注册：`id: 'median-position'`，`needsAlbums: true`，排在专辑优先策略之后。**
label `🎯 歌手/专辑按最集中位置`，hint `块落在曲目最密集的区域,而非首次出现位置`。`compute` 传 `{ positionMode: 'median' }`。

## Risks / Trade-offs

- [中位数与首次出现结果可能完全相同（歌单本来就按首次出现聚拢时）] → 无害，用户从预览可确认；spec 不承诺两者不同
- [`computeNewOrder` 加参数后签名变长] → 参数有默认值，既有调用方（cli.js、测试）零改动
- [偶数中位数的平均值可能是 .5 小数] → 排序比较用减法，浮点无影响

## Migration Plan

纯新增，无迁移。回滚 = revert。
