# 真实网页测试：照这三步操作

本次只测「本机 DSH → DeepSeek 网页 → 最终回答」，尚不测试本地工具。运行环境：PowerShell 7.2 及以上、Node.js 24、桌面 Chrome / Edge / Firefox。当前电脑的测试 profile 已在项目的 `.tmp-deepseek-live/dsh-home` 中准备并校验过。

1. **加载带「本机 Harness」设置的 DeepSeek++，登录 DeepSeek 网页。**

   已按下方目录安装开发版的，本次修复更新后只需在扩展管理页点击该扩展的「重新加载」，再刷新 DeepSeek 网页；无需卸载、重新安装或更换扩展 ID。原仓库版本没有「本机 Harness」，测试时关闭原版本，保留其数据。

   如设置里没有「本机 Harness」，Chrome 在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展」，目录为：

   ```text
   C:\temp\deepseek-pp-build-e4dcc34\dist\chrome-mv3
   ```

   Edge 使用同一构建下的 `edge-mv3` 目录。Firefox 临时加载 `firefox-mv3/manifest.json`。这些目录已于 2026-09-05 原位更新为 `a5b9380` 登录接线修复构建，目录名保留不变；项目里的 `dist/chrome-mv3` 当前为空。复制扩展管理页面显示的 **DeepSeek++ 扩展 ID**（不是网页会话 ID）。

2. **在 PowerShell 中执行下面这一段，按提示配对。**

   ```powershell
   cd C:\Users\worker\Documents\deepseek+++++
   .\scripts\start-dsh-web-smoke.ps1 -ConfirmRealWeb
   ```

   脚本会询问扩展 ID，生成新配对令牌并放入剪贴板。到 DeepSeek++ 侧栏「设置 → 本机 Harness」，启用桥接，端口填 **43123**，配对令牌按 **Ctrl+V** 粘贴并保存。保存后显示「等待重试」正常；回到 PowerShell 按回车便开始测试。Firefox 应输入完整的 `moz-extension://…` 扩展 origin。

3. **把最后一行 JSON 发给我。**

   `ok:true` 表示单轮通过；失败也直接发送该行（包含 `cause_code` 时一并保留）。无需复制令牌或整个会话日志。

`REAL_WEB_BROWSER_ATTESTATION_REQUIRED` 表示此前只执行了底层命令，还没在同一 PowerShell 里配置测试参数；不表示 DeepSeek 模型请求失败。上面的启动脚本会配置全部参数，因此无需逐个填写环境变量。

<details>
<summary>其他 checkout 的首次 profile 准备</summary>

从已安装项目依赖的仓库根目录执行一次（当前电脑已完成，无需再执行）：

```powershell
$env:DSH_HOME = Join-Path (Get-Location) '.tmp-deepseek-live\dsh-home'
node .\packages\dsh-web-agent-bundle\scripts\seed-profile.mjs --home $env:DSH_HOME
if ($LASTEXITCODE -ne 0) { throw 'profile 初始化失败，请保留原目录并检查错误' }
node .\node_modules\@deepseek-ai\dsh\lib\bin.js plugin --profile deepseek-web-agent add --offline (Join-Path (Get-Location) 'packages\dsh-web-agent-bundle')
if ($LASTEXITCODE -ne 0) { throw '本地 bundle 安装失败' }
```

已有安装时不要再次运行 seed。使用项目锁定的 Harness `0.1.2-rc.1`，不需要全局 `dsh`。

</details>

底层入口仍为 `npm run smoke:dsh-web-agent:real -- --confirm-real-web`，适合已自行配置 `DSH_HOME`、Broker 端口、令牌、扩展 origin 和浏览器准备确认变量的终端。测试会拒绝进程环境及任务目录、DSH_HOME 的 `.env` 中的模型/API 凭证。成功输出只有关联信息及回答哈希；真实网页验收状态以 `docs/progress/MASTER.md` 的执行证据为准。
