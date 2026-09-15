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

```bash
npm start
```

按步骤走:选操作(排序 / 回滚 / 退出)→ 选歌单(红心 / 我创建的)→ 选排序策略 → 预览新顺序 → 确认提交。

## 排序策略

- **按加入歌单时间**:最早加入的排最前。
- **按加入歌单时间(倒序)**:最新加入的排最前。
- **专辑优先 + 艺人首次出现**:同专辑连排,艺人按首次出现顺序。
- **歌手/专辑按最集中位置**:同专辑连排,歌手块落在曲目最密集的区域。

## 开发

```bash
npm run lint          # ESLint 检查
npm test              # 单元测试(Jest)
npm run test:coverage # 测试 + 覆盖率
```

CI(GitHub Actions)在 push `master` 与 PR 时跑同样的检查:lint / test / CLI 冒烟 / `npm audit` / openspec 校验,见 `.github/workflows/`。

