# 文件编辑测试（不用 Ubuntu）

已通过的读取测试不用重做；本次只验证：**网页模型读取临时文件 → 本机 Harness 修改一次 → 网页终答**。不改你的项目、不运行终端命令，也不需要重装扩展。

1. 保持开发版 DeepSeek++ 和已登录的 DeepSeek 网页打开。在 PowerShell 7 执行：

   ```powershell
   cd C:\Users\worker\Documents\deepseek+++++
   .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb -FileEdit
   ```

2. 输入扩展 ID `pmcipabnfbmmlnojkmdckjoeacgignlf`。到扩展「设置 → 本机 Harness」，端口填 `43123`，粘贴脚本刚复制的令牌并保存，再回终端按回车。若显示离线，等终端提示工具准备完成后再点保存。
3. 等待结果（网页阶段最长三分钟）。成功应包含 `"ok":true`、`"model_steps":3`、`"tool_calls":2`、`"file_verified":true`。把最后的 JSON 发回来，不要发送令牌。失败先发结果，不必反复重跑。

运行环境：原生 Windows、PowerShell 7.2+、Node.js 24+、仓库已安装的 DSH `0.1.2-rc.1`。模型只用已登录网页，不用 API Key。临时文件与独立会话保存在 `.tmp-deepseek-live/file-edit-runs/`，便于检查；不自动重放失败或结果不明的修改，也不删除旧测试证据。

脚本同时检查真实工具记录和磁盘文件，不能只凭模型说“改好了”通过。退出后桥接关闭、扩展转为离线是正常的。本项通过也不代表命令执行、Skills 等后续计划已经完成。
