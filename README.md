# netease-music-list-sorter

按"专辑优先 + 艺人首次出现"规则重排网易云音乐歌单的 Python 脚本。

通过 [`ncm-cli`](https://www.npmjs.com/package/@music163/ncm-cli) 拉取歌单与专辑数据,本地计算新顺序后,调 `ncm-cli playlist reorder` 一次性提交到云端。

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
5. **无专辑信息的歌**:按原顺序追加在最末尾。
6. **歌单曲目数 > 500**:`fetch_playlist_tracks` 自动分页拉取,每页 500。

## 依赖

- Python 3.9+(用了 `dict[str, ...]` 等类型注解语法)
- Node.js + npm 全局安装的 `ncm-cli`,且已 `ncm-cli login` 登录网易云音乐

```bash
npm install -g @music163/ncm-cli
ncm-cli login
```

确认 CLI 可用:

```bash
ncm-cli --version
ncm-cli user favorite --output table
```

## 使用

### 排红心歌单(默认)

```bash
# 先预览,不提交
python sort_playlist.py --dry-run

# 实际提交
python sort_playlist.py
```

### 排指定歌单

```bash
python sort_playlist.py --playlistId <加密歌单ID> --dry-run
python sort_playlist.py --playlistId <加密歌单ID>
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
- **三级**:进程内 dict → 磁盘 `.cache/album-*.json` → ncm-cli 接口。
- 缓存的是 album tracks 的**完整返回**(歌名、艺人、时长、专辑内顺序等),其它功能可自由读取。
- 旧格式缓存(只存 encId 列表)在读取时会被自动忽略并重新拉接口升级。
- 想强制刷新某张专辑:删除对应的 `.cache/album-<albumId>.json`。

## 回滚

`rollback.py` 把歌单顺序恢复到某个 backup 文件记录的顺序:

```bash
python rollback.py output/backup-<playlistId>-<timestamp>.json
python rollback.py output/backup-<playlistId>-<timestamp>.json --dry-run
python rollback.py <backup.json> --playlistId <enc>   # backup 文件名无法解析 ID 时手动指定
```

## Windows 平台注意事项

脚本在 Windows 上**直接调 `node` 启动 `ncm-cli` 的 `dist/index.js`**,而不是走 `.cmd` shim。原因:

- `ncm-cli.cmd` 经 cmd.exe 解析,而 **cmd.exe 命令行长度上限 8191 字符**。
- reorder 时 378 个 encId 拼出的命令约 14K 字符,会被 cmd.exe 拒绝并报"命令行太长",导致请求根本没发出。
- 直接 `node <dist/index.js>` 绕开 cmd.exe,可处理到 ~800 首歌的 reorder(`CreateProcess` 上限约 32K 字符)。

如果脚本报"找不到 node"或类似错误,确认 `node` 在 PATH 中,或修改 `_resolve_ncm_entry` 指向本地 node.exe。

## 已知限制

- **歌单 > 800 首**:`playlist reorder` 的命令行长度会超 Windows `CreateProcess` 的 32K 上限。这种情况脚本会失败,需要走网易云 OpenAPI 直连方案(不依赖 ncm-cli)。
- **合辑类专辑被合并到归属艺人**:像"热门华语262""我是歌手第N期"这种合辑,整张专辑会被归到第一首歌的 first_artist 名下。这意味着同一艺人在不同合辑里的歌不会紧挨在一起——这是"专辑优先"规则的取舍,合辑内部完整不被拆散的代价。
- **`ncm-cli playlist tracks` 的分页**:已实现自动分页(每页 500),不会丢歌。
- **reorder 是云端不可撤销操作**:脚本默认会写 backup;没有 backup 不要跑实际提交。

## 项目文件

```
.
├── sort_playlist.py   # 主脚本:拉歌单 → 计算 → 提交 reorder
├── rollback.py        # 从 backup 文件回滚歌单顺序
├── .gitignore         # 忽略 output/ .cache/ 凭据文件等
├── CLAUDE.md          # 给 AI 协作者的提示词
└── README.md
```

## 依赖范围

仅使用 Python 标�准库(`subprocess` / `json` / `pathlib` / `argparse` 等),不安装任何第三方 Python 包。
