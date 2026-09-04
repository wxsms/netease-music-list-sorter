# netease-music-list-sorter

按"专辑优先 + 艺人首次出现"规则重排网易云音乐歌单的 Node.js CLI 工具。

通过 [`ncm-cli`](https://www.npmjs.com/package/@music163/ncm-cli) 拉取歌单与专辑数据,本地计算新顺序后,调 `ncm-cli playlist reorder` 一次性提交到云端。

提供两种用法:

- **交互式向导**(推荐):`npm start`,按步骤选歌单 → 预览 → 确认提交,无需记参数。
- **命令行脚本**:`node sort-playlist.js` / `node rollback.js`,适合熟练用户与自动化。

## 适用场景

- 你在网易云有一个收藏数量较多、内容跨多张专辑的歌单(例如"我喜欢的音乐")。
- 你希望同一张专辑的歌保持原专辑内顺序连在一起,不被拆散。
- 你希望同一艺人的多张专辑挨着出现,艺人之间的顺序按"该艺人首次出现在原歌单的位置"决定。
- 合辑专辑(例如"Joey Yung X Hacken Lee Concert 2015")即便内含多位艺人主唱的歌,也保持完整不被拆开。

## 排序规则

1. **专辑作为顶层聚合单位**:每张专辑(`album.id`)的所有歌连在一起,按 `ncm-cli album tracks` 返回的顺序排,不被艺人拆散。
2. **专辑归属艺人**:该专辑在原歌单里**最早出现**那首歌的 `artists[0]`。
3. **艺人之间**:按归属艺人在原歌单里的首次出现位置升序排。
4. **同一艺人多张专辑**:按各自第一首歌在原歌单中的位置升序排。
5. **无专辑信息的歌**:归到一个名为 `__unknown__` 的虚拟艺人名下,按首次出现位置插入主排序(`artists[0]` 为空时同样落到这里)。
6. **歌单曲目数 > 500**:`fetchPlaylistTracks` 自动分页拉取,每页 500。

## 依赖

- Node.js 18+
- npm 全局安装的 `ncm-cli`,且已 `ncm-cli login` 登录网易云音乐

```bash
npm install -g @music163/ncm-cli
ncm-cli login
```

确认 CLI 可用:

```bash
ncm-cli --version
ncm-cli user favorite --output table
```

项目依赖分两层:

- **交互入口**(`npm start` / `node cli.js`)需要 `@clack/prompts` 与 `commander`,克隆后跑一次 `npm install` 即可。
- **脚本入口**(`sort-playlist.js` / `rollback.js`)只依赖 Node 标准库,不装 npm 包也能跑。

## 使用

### 交互式向导(推荐)

```bash
npm start        # 或 node cli.js
```

流程:环境预检(自动验证 ncm-cli 已安装已登录)→ 选操作(排序 / 回滚 / 退出)→ 选歌单来源(红心 / 收藏 / 创建)→ 选歌单 → 预览新顺序与汇总 → 确认提交。

安全设计:

- 提交前必预览(前 15 首新顺序 + 位置变动统计)并需显式确认,取消不发起任何请求。
- 交互模式**强制写备份**,提交后 outro 会报告备份文件路径。
- 内置回滚入口:列出 `output/` 下的备份文件(最新在前),选中确认即可恢复。

### 命令行模式

`cli.js` 也支持带子命令运行(行为与脚本入口一致):

```bash
node cli.js sort --dry-run
node cli.js sort --playlistId <enc>
node cli.js rollback output/backup-<playlistId>-<timestamp>.json --dry-run
```

### 排红心歌单(脚本入口,默认)

```bash
# 先预览,不提交
node sort-playlist.js --dry-run

# 实际提交
node sort-playlist.js
```

### 排指定歌单

```bash
node sort-playlist.js --playlistId <加密歌单ID> --dry-run
node sort-playlist.js --playlistId <加密歌单ID>
```

加密歌单 ID 可以通过 `ncm-cli user favorite`(红心)或 `ncm-cli playlist collected / created`(收藏/创建的歌单)拿到,JSON 响应里的 `data.id` 字段就是。

### 完整参数

| 参数 | 说明 |
|------|------|
| `--playlistId <enc>` | 加密歌单 ID;不传则默认红心歌单(自动跑 `user favorite` 查询) |
| `--dry-run` | 只计算新顺序并预览,不提交 |
| `--no-backup` | 不写备份文件(不推荐,reorder 不可撤销) |
| `--save-new-order` | 把排序后的新顺序写到 `output/new-order-<playlistId>.json`,便于人工检查 |

## 输出与缓存

| 路径 | 内容 | 是否入库 |
|------|------|---------|
| `output/backup-<playlistId>-<timestamp>.json` | 排序前的原始顺序(每次跑都写,带时间戳) | 否(.gitignore) |
| `output/new-order-<playlistId>.json` | 排序后的新顺序(固定文件名,覆盖写) | 否(.gitignore) |
| `.cache/album-<albumId>.json` | album tracks 接口的完整返回,跨次运行复用 | 否(.gitignore) |

缓存策略:
- **三级**:进程内 `Map` → 磁盘 `.cache/album-*.json` → ncm-cli 接口。
- 缓存的是 album tracks 的**完整返回**(歌名、艺人、时长、专辑内顺序等),其它功能可自由读取。
- 旧格式缓存(只存 encId 列表)在读取时会被自动忽略并重新拉接口升级。
- 想强制刷新某张专辑:删除对应的 `.cache/album-<albumId>.json`。

## 回滚

`rollback.js` 把歌单顺序恢复到某个 backup 文件记录的顺序:

```bash
node rollback.js output/backup-<playlistId>-<timestamp>.json
node rollback.js output/backup-<playlistId>-<timestamp>.json --dry-run
node rollback.js <backup.json> --playlistId <enc>   # backup 文件名无法解析 ID 时手动指定
```

## Windows 平台注意事项

脚本在 Windows 上**直接调 `node` 启动 `ncm-cli` 的 `dist/index.js`**,而不是走 `.cmd` shim。原因:

- `ncm-cli.cmd` 经 cmd.exe 解析,而 **cmd.exe 命令行长度上限 8191 字符**。
- reorder 时 378 个 encId 拼出的命令约 14K 字符,会被 cmd.exe 拒绝并报"命令行太长",导致请求根本没发出。
- `child_process.spawnSync` 不带 `shell: true` 时,Windows 上 Node 不会自动找 `.cmd` 后缀(`ENOENT`);带 `shell: true` 又会触发上面的 8K 限制。
- 直接 `node <dist/index.js>` 绕开 cmd.exe,可处理到 ~800 首歌的 reorder(`CreateProcess` 上限约 32K 字符)。

如果脚本报"无法启动 ncm-cli"或类似错误,确认 `ncm-cli` 已通过 `npm install -g` 安装并在 PATH 中,或修改 `resolveNcmEntry` 指向本地 node.exe。

## 已知限制

- **歌单 > 800 首**:`playlist reorder` 的命令行长度会超 Windows `CreateProcess` 的 32K 上限。这种情况脚本会失败,需要走网易云 OpenAPI 直连方案(不依赖 ncm-cli)。
- **合辑类专辑被合并到归属艺人**:像"热门华语262""我是歌手第N期"这种合辑,整张专辑会被归到第一首歌的 first_artist 名下。这意味着同一艺人在不同合辑里的歌不会紧挨在一起——这是"专辑优先"规则的取舍,合辑内部完整不被拆散的代价。
- **`ncm-cli playlist tracks` 的分页**:已实现自动分页(每页 500),不会丢歌。
- **reorder 是云端不可撤销操作**:脚本默认会写 backup;没有 backup 不要跑实际提交。

## 项目文件

```
.
├── cli.js             # CLI 入口:无参数进交互向导,带参数走命令行模式
├── src/
│   ├── interactive.js # 交互式向导(@clack/prompts)
│   ├── ncm.js         # ncm-cli 调用(含 Windows 绕过 .cmd shim 的启动方式)
│   ├── playlist.js    # 红心/收藏/创建歌单列表与曲目拉取
│   ├── album-cache.js # album tracks 三级缓存
│   ├── sort.js        # 排序核心(纯函数,专辑内顺序回调注入)
│   ├── backup.js      # 备份/新顺序落盘/备份枚举
│   └── reorder.js     # reorder 提交(排序与回滚共用)
├── sort-playlist.js   # 脚本入口:拉歌单 → 计算 → 提交 reorder(薄壳,逻辑在 src/)
├── rollback.js        # 脚本入口:从 backup 文件回滚歌单顺序(薄壳,逻辑在 src/)
├── package.json       # 交互入口的依赖(@clack/prompts + commander)与 npm start
├── .gitignore         # 忽略 output/ .cache/ node_modules/ 凭据文件等
├── CLAUDE.md          # 给 AI 协作者的提示词
└── README.md
```

## 依赖范围

- 脚本入口(`sort-playlist.js` / `rollback.js`):仅 Node.js 标准库。
- 交互入口(`cli.js`):`@clack/prompts`(交互组件)+ `commander`(参数解析),见 `package.json`。

