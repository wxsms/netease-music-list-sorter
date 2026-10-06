# Tag 触发的 npm Trusted Publishing 设计

日期：2026-10-06

## 目标

推 `v*` tag 到 GitHub 后，自动完成：lint/test 校验 → npm 发布（Trusted Publishing / OIDC，零凭证）→ 创建 GitHub Release。

## 触发

`push: tags: ['v*']`。

## Workflow：`.github/workflows/publish.yml`

单 job，步骤依次：

1. `actions/checkout`
2. `actions/setup-node`：Node 22，`registry-url: https://registry.npmjs.org`（npm ≥ 11.5.1 自带，满足 OIDC 发布要求）
3. `npm ci`
4. `npm run lint`
5. `npm test`
6. 版本一致性守卫：tag `v0.0.2` 必须与 package.json `"version": "0.0.2"` 一致，不一致立即失败退出
7. `npm publish`（无任何 token/secret，OIDC 令牌自动携带）
8. `gh release create ${{ github.ref_name }} --generate-notes --title "Release ${{ github.ref_name }}"`

权限：

```yaml
permissions:
  id-token: write   # npm OIDC trusted publishing
  contents: write   # gh release create
```

## 前置配置（用户已在 npm 网站完成）

npmjs.com → ncm-sorter → Settings → Trusted Publisher →
`wxsms/netease-music-list-sorter` + `.github/workflows/publish.yml`，无 environment。

## 失败处理

- lint/test 失败 → 中止，不发布
- tag 与 package.json 版本不一致 → 中止，不发布
- npm publish 失败（如 OIDC 校验不匹配）→ Release 步骤也不会执行（顺序执行），npm 上不会出现半成品版本

## 验收标准

1. 推 `v0.0.2` tag（package.json version 同步为 0.0.2）后 workflow 全绿
2. npm 上出现 `ncm-sorter@0.0.2`
3. GitHub Releases 出现 `v0.0.2` 及自动生成的 notes
4. 故意制造 tag/版本不一致 → workflow 在守卫步骤失败（可用本地 node 脚本验证守卫逻辑，不必真推坏 tag）

## 不做的事

- `--provenance` 标志（可后续加）
- CHANGELOG 文件（`--generate-notes` 足够）
- `workflow_dispatch` 手动触发（发布无需）
- 独立的 release workflow 文件（与参考项目不同，合并为一个）
