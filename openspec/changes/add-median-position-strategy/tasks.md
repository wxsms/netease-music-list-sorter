## 1. 排序核心

- [x] 1.1 在 `src/sort.js` 给 `computeNewOrder` 增加可选参数 `opts.positionMode`（`'first'` 默认 / `'median'`）：`'median'` 时专辑归属位置与歌手块排序键改为曲目位置中位数（偶数个取中间两数平均），分组、专辑内排序、`__unknown__` 兜底逻辑复用不变。在 `tests/sort.test.js` 新增单测：歌手块按中位数（离群首歌不拉偏）、同歌手多专辑按中位数、专辑聚合与内序不变、无专辑容错、默认参数行为与既有用例一致，全部通过
- [x] 1.2 跑 `npx jest tests/sort.test.js` 确认既有用例无回归

## 2. 策略注册与文档

- [x] 2.1 在 `src/interactive.js` 的 `SORT_STRATEGIES` 注册 `median-position` 策略（`needsAlbums: true`，排在专辑优先之后），`compute` 传 `{ positionMode: 'median' }`；确认"调整歌手顺序"入口对该策略开放（输出仍是歌手块序列）。验证：`npx jest` 全量通过
- [x] 2.2 `README.md` 策略列表补充"歌手/专辑按最集中位置"说明
- [x] 2.3 手动冒烟：`npm start` 选新策略走一遍向导，确认策略列表展示、专辑拉取进度正常、预览符合中位数语义、确认环节汇总含策略名
