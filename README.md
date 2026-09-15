# netease-music-list-sorter

[![CI](https://github.com/wxsms/netease-music-list-sorter/actions/workflows/main.yml/badge.svg)](https://github.com/wxsms/netease-music-list-sorter/actions/workflows/main.yml)
[![Coverage](https://codecov.io/gh/wxsms/netease-music-list-sorter/branch/master/graph/badge.svg)](https://codecov.io/gh/wxsms/netease-music-list-sorter)

重排网易云音乐歌单的命令行工具。把"我喜欢的音乐"或自己创建的歌单按专辑/艺人聚合成块,同专辑的歌连在一起不被拆散。

## 安装

要求 Node.js 18+。

```bash
git clone https://github.com/wxsms/netease-music-list-sorter.git
cd netease-music-list-sorter
npm install
```

无需其它准备:首次运行时如果未登录,工具会直接在终端显示二维码,用网易云音乐 App 扫码即可。

## 使用

### 交互式向导(推荐)

```bash
npm start
```

按步骤走:选操作(排序 / 回滚 / 退出)→ 选歌单(红心 / 我创建的)→ 选排序策略 → 预览新顺序 → 确认提交。

### 命令行模式

```bash
# 预览红心歌单的排序结果,不提交
node cli.js sort --dry-run

# 实际提交
node cli.js sort

# 排指定歌单
node cli.js sort --playlistId <歌单ID>

# 回滚到某次排序前的顺序
node cli.js rollback <备份文件路径>
```

| 参数 | 说明 |
|------|------|
| `--playlistId <id>` | 指定歌单;不传则默认红心歌单 |
| `--dry-run` | 只预览,不提交 |
| `--no-backup` | 不写备份(不推荐) |
| `--save-new-order` | 把新顺序存成文件,便于人工检查 |

## 排序策略

- **按加入歌单时间**:最早加入的排最前。
- **按加入歌单时间(倒序)**:最新加入的排最前。
- **专辑优先 + 艺人首次出现**:同专辑连排,艺人按首次出现顺序。
- **歌手/专辑按最集中位置**:同专辑连排,歌手块落在曲目最密集的区域。

## 安全设计

- 提交前必预览,需显式确认,取消不发起任何请求。
- 每次提交前自动写备份,内置回滚入口可随时恢复。

## 已知限制

- 收藏的歌单是别人创建的,网易云只允许创建者调整顺序,因此不在可选范围。
- 超大歌单(约 800 首以上)在 Windows 上可能因系统命令行长度限制提交失败。
- 合辑类专辑(如"热门华语262")整张归到第一首歌的艺人名下,合辑内部完整不拆散,但同一艺人在不同合辑里的歌不会紧挨。

## 开发

```bash
npm run lint          # ESLint 检查
npm test              # 单元测试(Jest)
npm run test:coverage # 测试 + 覆盖率
```

CI(GitHub Actions)在 push `master` 与 PR 时跑同样的检查:lint / test / CLI 冒烟 / `npm audit` / openspec 校验,见 `.github/workflows/`。

