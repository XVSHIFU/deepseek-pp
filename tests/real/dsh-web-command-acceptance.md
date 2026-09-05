# Linux 命令测试

**已于 2026-09-05 通过，无需重复测试或重装扩展。** 已验证「网页 DeepSeek → 本机 Bash 读文件、写文件并运行短测试 → 网页终答」。以下步骤仅供以后需要复测时使用。

1. 保持 Chrome 中已登录的 DeepSeek 网页打开，在 Windows PowerShell 运行：

   ```powershell
   cd C:\Users\worker\Documents\deepseek+++++
   .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb -LinuxCommands
   ```

2. 输入扩展 ID `pmcipabnfbmmlnojkmdckjoeacgignlf`。将自动复制的新令牌粘贴到扩展「设置 → 本机 Harness」，端口 `43123`，启用并保存；回终端按回车。若显示离线，看到准备完成后再点一次保存。

3. 等待结果。成功 JSON 应含 `"ok":true`、`"command_verified":true`、`"file_verified":true`、`"test_verified":true`。失败时把完整 JSON 发回来，不必连续重试。

运行环境：已有 WSL2 Ubuntu、Linux Node 24、项目专用 Linux 依赖与官方 Linux 沙箱；Ubuntu 的 Windows 程序互操作须已关闭。Agent 和 Bash 在 Ubuntu 运行，浏览器仍在 Windows；不需要模型 API。

测试只创建并使用新的临时项目，不读取你的项目文件。原始日志和验证文件保留在 Ubuntu 的 `~/deepseek-web-harness/.tmp-deepseek-live/command-runs/`，失败也保留，不自动重放命令。输出文件为本次 `workspace/linux-command-created.txt`。

本次结果：`command-0469b0dc-bf30-44fb-ac29-ddbc1e8bcf36`，2 次模型回合、1 次本机工具调用；`command_verified`、`file_verified`、`test_verified` 均为 `true`。原始会话与落盘文件已只读复验一致，未再次请求网页。完整证据见 `docs/progress/MASTER.md`。
