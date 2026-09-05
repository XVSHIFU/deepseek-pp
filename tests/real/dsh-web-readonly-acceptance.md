# 本地工具两轮测试

单轮联网已通过，不必重测。本次验证：**网页 DeepSeek → 本机 Harness 读取文件 → 网页根据读取结果回答**。

## 你只需做这些

1. Chrome 扩展管理页找到开发版 DeepSeek++，点一次「重新加载」；保持 DeepSeek 网页已登录。无需卸载或更换扩展目录。
2. 在 PowerShell 7 执行：

   ```powershell
   cd C:\Users\worker\Documents\deepseek+++++
   .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb -ReadOnlyTools
   ```

3. 输入扩展 ID `pmcipabnfbmmlnojkmdckjoeacgignlf`。脚本会复制新令牌；在扩展「设置 → 本机 Harness」启用桥接，端口 `43123`，粘贴令牌并保存，回终端按回车。若随后扩展已离线，看到「本地只读工具已准备」后再点一次保存。等待终端结果，最长约三分钟。

成功结果包含 `"ok":true`、`"model_steps":2`、`"tool_calls":1`、`"tool_results":1`。把最后的 JSON 发回来即可；不要发送配对令牌。

## 运行环境与范围

- Windows、PowerShell 7.2+、Node.js 24+；本仓库已安装的 DSH 固定为 `0.1.2-rc.1`。
- 模型是已登录 Chrome 中的 DeepSeek 网页；不用 API Key，也不需要给 pi 配置模型。当前本机入口是官方 DSH。
- 自动创建随机内容的 `proof.txt` 和独立 DSH profile，只发布官方 `read` 工具，不读你的项目文件，不执行 shell/写入/编辑。
- 本机准备阶段会写入测试文件和会话日志；模型工具只读。临时目录保留在项目 `.tmp-deepseek-live/readonly-runs/`，不提交 Git。官方读取结果会包含该临时文件的绝对路径。
- 测试退出后本地桥接随之关闭，扩展转为等待重试/离线属正常现象。

这是完整读文件链路的首次真实验收，不代表后续写代码、终端、Skills 和子 Agent 已完成。收到成功结果后，下一项才是受控写入/编辑与 PowerShell。
