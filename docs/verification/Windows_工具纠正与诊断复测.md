# 另一台 Windows：只更新两项，再试一次

这个包修复“工具包装格式被当作普通回答后结束”，并给失败行增加安全诊断信息。网页请求异常的具体原因仍需在出错电脑复现一次，不能把本包视为所有停止问题都已解决。

## 更新（保留原安装和配对）

1. 关闭正在运行的 Harness。把本次 ZIP 解压到一个新目录，在里面打开 PowerShell 7，执行：

   ```powershell
   $plugin = @(Get-ChildItem -LiteralPath ./plugin -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
   if ($plugin.Count -ne 1) { throw '请进入包含 plugin 文件夹的安装包目录' }
   dsh plugin --profile web add $plugin --allow-build=koffi
   if ($LASTEXITCODE -ne 0) { throw '更新失败，请保留错误行' }
   ```

   这是已有环境的更新步骤：原 Harness、pnpm 及三份 vendor 配套依赖不变。不需要再安装 Shell Local。

2. 进入包内 `extensions/chrome/`（Edge 则为 `extensions/edge/`），解压里面的浏览器 ZIP。将解压得到的内容覆盖到**当前扩展已经加载的目录**，然后在浏览器扩展管理页点击该扩展的“重新加载”，刷新已登录的 DeepSeek 网页。

   覆盖前可备份旧扩展目录。应覆盖的是包含浏览器 `manifest.json` 的那一层，不是整包根目录；不要卸载再添加，这样可保留扩展 ID 和配对。诊断需要浏览器扩展与 Harness 插件两项都更新。

## 复测

3. 在**测试项目副本**目录照常运行 `dsh web`，保持原默认/专家和思考设置。先在原来失败的会话中发送一次“继续”，不要重复点发送。若仍失败，复制错误中带 `[web-diag:v1 …]` 的**完整一行**发给我。

   如果出现 `reason=SESSION_QUARANTINED`，先把这一行发来，不要反复重试旧会话；可以新开 Harness 会话，用“先读取当前文件，核对已完成修改，再继续剩余工作”测试副本。旧日志里已经成功过的编辑不会自动回滚。

正常结果应是工具真正执行并继续，而不是只显示 `<tool_call name="…">` 后结束。若无报错但又停止，把最后一段回答发给我即可；如需导出原会话，也可使用原来的会话导出功能。

诊断标记只包含固定原因码、阶段、耗时和请求 ID 的 SHA-256 前 16 位，不增加 Cookie、令牌、网页私有数据或文件正文的记录。**原始会话 ZIP 仍包含原对话和工具结果**；优先只发错误行。

本包不自动上传诊断、不自动重放结果不明的请求，也不会替你更改权限。
