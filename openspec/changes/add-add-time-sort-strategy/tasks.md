## 1. 排序核心

- [x] 1.1 在 `src/sort.js` 新增并导出 `sortByAddTime(tracks)`：按 `track.extMap.addTime` 升序稳定排序；`extMap` 或 `addTime` 缺失的曲目按原相对顺序追加末尾；空歌单返回空数组。在 `tests/sort.test.js` 新增单测覆盖：正常升序、返回顺序与时间顺序不一致、缺时间戳容错、同时间戳稳定性、空歌单，全部通过
- [x] 1.2 跑 `npx jest tests/sort.test.js` 确认既有用例无回归

## 2. 策略注册与向导接入

- [x] 2.1 在 `src/interactive.js` 的 `SORT_STRATEGIES` 新增条目：`id: 'add-time'`、中文 label 与一句话 hint、`describe: '按加入歌单时间'`、`compute` 委托 `sortByAddTime`；为两个策略补 `needsAlbums` 标志（默认策略 `true`、新策略 `false`）
- [x] 2.2 `sortFlow` 中按 `strategy.needsAlbums` 条件化专辑预取：`false` 时跳过 `collectAlbumIds` / `prefetchAlbums` / 进度条与"专辑数据就绪"提示，直接计算；`true` 时行为不变。验证：`npx jest` 全量通过
- [x] 2.3 确认环节的"调整歌手顺序"入口仅对 `strategy.id === 'album-first'` 开放（按时间排序的结果不满足歌手块前提）。验证：代码路径检查 + 全量测试通过

## 3. 文档与收尾

- [x] 3.1 `README.md` 补充排序策略说明：交互向导可选"按加入歌单时间"策略及其效果（最早加入在前、不拉专辑信息）
- [x] 3.2 手动冒烟：`npm start` 走一遍向导选新策略，确认策略列表展示、无专辑拉取进度、预览按时间升序、确认环节汇总含策略名；提交前备份正常写入
