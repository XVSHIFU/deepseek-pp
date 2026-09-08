# 2026-09-08 r2 推送准备

状态：**2026-09-08 已推送并正式发布。** 仓库为 `XVSHIFU/deepseek-pp`，分支与默认展示分支均为 `feature/web-harness`；未改 main、未 force push、未向上游提 PR。用户最终 README 与 12 张新增图片原样纳入提交 `41d25b51600502c0018ec248087ddf5c3b1e7edd`。

正式发布：[web-harness-20260908-r2](https://github.com/XVSHIFU/deepseek-pp/releases/tag/web-harness-20260908-r2)，发布时间 `2026-09-08T07:58:14Z`，`draft=false`、`prerelease=false`，已设为 Latest。旧的两个预发布 Release 及其附件已按用户要求删除；旧 Git 标签、本地安装包保留，可重新上传恢复附件，但旧下载链接不再可用。

## 本次内容

- 模型生成使用独立的默认五分钟预算，保留 RPC 十秒时限及显式请求超时。
- 工具调用之后等待真实结果，不向 Harness 转发同次生成中未经工具结果支持的后续正文；保留已有完整流验证和不自动重放规则。
- 对应回归测试、必要的已跟踪 Harness 插件构建产物、验证记录。
- 中英文 README：完整包安装、两层解压定位、首次配对、模型选择、Windows 原生命令、Linux / WSL 分工、原位升级。README 只写能力和使用方法。

## 待推送的 Git 差异

2026-09-08 fetch 后远端基线为 `e2874b30b86495ad6e96083552de9486d81405cb`，准备开始时本地领先 3 个提交，远端无独有提交。正式推送前再次核对。

```text
README.md
README_EN.md
assets/image-20260908132550835.png
assets/image-20260908132711630.png
assets/image-20260908132725306.png
assets/image-20260908132813534.png
assets/image-20260908132845913.png
assets/image-20260908132853521.png
assets/image-20260908134207798.png
assets/image-20260908134234617.png
assets/image-20260908155129472.png
assets/image-20260908155138697.png
assets/image-20260908155143989.png
assets/image-20260908155149537.png
core/harness-bridge/deepseek-turn-adapter.ts
core/interceptor/streaming-tool-text.ts
docs/delivery/github-push-20260908-r2.md
docs/delivery/github-release-20260908-r2.md
docs/images/guide/extension-folder.svg
docs/images/guide/extension-pairing.png
docs/images/guide/harness-connection.jpg
docs/images/guide/harness-model.jpg
docs/images/guide/harness-permissions-pairing.jpg
docs/progress/MASTER.md
docs/verification/20260908-超时修复包使用.md
packages/dsh-deepseek-web-official-plugin/lib/index.js
packages/dsh-web-model-transport/src/host.ts
tests/dsh-web-model-transport.test.ts
tests/harness-deepseek-turn-adapter.test.ts
tests/harness-tool-wire.test.ts
tests/streaming-tool-text.test.ts
```

继续使用当前仓库，无需复制第二个源码目录。原始用户日志、截图、配对令牌、浏览器配置、DSH home、临时脚本、node_modules、dist、参考仓库以及 `.release` 不纳入 Git 差异。

## 待发布的独立附件

- `.release/deepseek-web-harness-20260908-r2.zip`
- `.release/deepseek-web-harness-20260908-r2.zip.sha256`

完整包解压后 README 与 extensions/plugin/vendor 同级，含 Chrome、Edge、Firefox 扩展 ZIP、一个 Harness 插件 TGZ、三份配套 vendor TGZ、双语 README 及五张本地配图、Apache-2.0 / MIT 许可、manifest 和 SHA256SUMS。新电脑无需旧包或增量补丁，解压后图片无需联网加载。

浏览器与 Harness 插件复用已核验的 `a636469` 修复包；vendor 复用原完整包并逐项核对散列；README 使用本轮提交。组件来源分开记录，不重建或改写旧产物，不把旧包的整体校验值当作新包校验值。

按用户最终指示新建正式 Release `web-harness-20260908-r2`，设置为 Latest，上传完整 ZIP 和 SHA-256 校验文件。先核对新发布和附件，再删除 `web-harness-preview-20260907`、`web-harness-preview-20260908` 两个 Release 及附件；保留它们的 Git 标签与本地备份。README 已指向 r2 附件，因此与源码一起上线。发布文案见同目录 `github-release-20260908-r2.md`。

## 验证范围

- 运行时修复已有定向 171/171、compile、prompt freeze 7/7、官方插件和三浏览器构建等证据，见 MASTER。
- Windows 真实 Chrome + 官方 Harness：3 次文件工具调用及结果、中文终答、连续追问和 31.08 秒长回答完成；人工样本文件未改变。
- 本轮整理不改变运行时代码；验证文档命令语法、整包文件清单、来源散列及压缩后内容。不冒称重新执行 Linux 新机、完整模式矩阵或全仓 ci:quality。
- 原始测试日志留在本机隔离目录，不进入源码和分发包。
- 发布闭环尝试执行 `ci:quality`，在第一个 `verify:workflows` 因本机未安装 `actionlint` 停止，后续项目未执行；没有残留测试进程。不将本机完整门禁记为通过，不修改依赖或绕过检查。正式 Release 类型是用户的发布选择，具体运行时验证仍以上述定向测试、构建和真实网页证据为准。

## 最终本地附件

- 用户最终新增 12 张 `assets/` 截图已逐张查看，README 原样保留；中文共 17 个图片引用、英文 5 个，全部图片纳入最终整包。以下为最终正式发布附件的校验记录。
- **本轮图文补齐：** 中英文 README 均引用 `docs/images/guide/` 下相同的五张图：三张当前 Harness 实拍、一张用户提供的浏览器扩展设置截图、一张明确标注的安装目录 SVG 示意图。仅截取设置区域，排除地址栏和聊天记录；扩展输入框中的令牌已被界面隐藏，没有读取或生成令牌。扩展示例的“等待重试”如实保留并解释，未改图伪造已连接。没有为截图修改用户的模型、权限或配对配置。
- 无图版本保存在 `.release/.backups/r2-before-images-864f923/`，未加入用户截图的图文版本保存在 `.release/.backups/r2-before-user-images-c7df73b/`；均可恢复。
- 完整 ZIP：28,349,627 字节，SHA-256 `d3a8672de95473bc396e1c60511dde6c835229d686ba1f27c327ad20edb54954`。GitHub 附件状态为 `uploaded`，其 digest 与本地一致；正式发布后下载公开 `.zip.sha256` 文件，内容一致。
- Manifest SHA-256：`e02d609d6e1c296fee0ff06e7f3335620bd5766f8bb6b5b813496244516074b3`。
- README 与全部配图来源提交：`41d25b51600502c0018ec248087ddf5c3b1e7edd`；也是正式标签的目标提交，本发布记录的补充不改变附件。
- 28 个 payload 文件均列入 manifest，加上 manifest 与 SHA256SUMS 共 30 个文件；ZIP 解压内容与目录逐文件散列一致，内部校验清单全部通过。中文 17 个、英文 5 个图片引用均能在包内解析。
- 两份 README 的 7 段 PowerShell 示例通过 PowerShell Parser；14 段 Bash/sh 示例通过 Git Bash `bash -n`。只检查语法，没有执行环境安装命令；本机已测试的相同运行时组件不重复构建。
- 旧完整包与 `a636469` 增量包均在本地保留。删除旧 Release 前再次核对 9 月 7 日、9 月 8 日两个旧包的散列与旧远端附件一致；未删除旧 Git 标签。没有公开真实会话、令牌或 DSH 配置。
