# Harness 请求预算补丁（配套依赖）

这三份 MIT 许可的包来自维护者批准的 Harness fork 独立分支，不是官方新版本或本项目发布包。保留 `0.1.2-rc.1` 的包版本及原依赖范围，用文件名 SHA-256 和 npm lock integrity 区分补丁身份。根 `devDependencies` + `$` overrides 固定全部消费者到同一份 LLM；没有复制 Harness 核心源码或修改它的 `master`。

- 源仓库：`https://github.com/XVSHIFU/deepseek-harness.git`
- 分支：`codex/web-request-budget`；提交：`34d57aed2e386af0b61874390c86fc5915c51b1a`
- 基线及未变的 master：`76fda729799fe9b3848dbe2c211d4b231032b81e`
- [补丁源码分支](https://github.com/XVSHIFU/deepseek-harness/tree/codex/web-request-budget)已保存到远端；本仓库携带以下锁定归档，普通构建无需克隆 Harness。需要修改补丁时按[开发恢复说明](../../docs/development/recovery.md)获取源码，不修改 Harness 的 `master`。

| 包 | SHA-256 |
|---|---|
| dsh-llm | `494a4a63fb46ca6c8875ac25a03a6298285db315810e6bc6951f157c530da274` |
| dsh-compaction-basic | `44f8a92cd6992f4a24499d8df6e009a2dd5f173916fd7d7c699a84a8fc235ea3` |
| dsh-llm-retry | `aa44c61be81b55382521986134e0d517c6301e5743c447b23a7b5dc9273a2c87` |

实现仅增加发送前预算检查、原引擎的有界压缩恢复及普通重试排除。网页适配器复用现有序列化与 codec 测量完整请求，不提高 128 消息／1 MiB 上限。摘要仍调用网页模型；无法缩减的固定包络或单个完整工具单元会明确失败。

构建使用 fork 原来的工具和配置：Node 24.18.0、pnpm 11.7.0，按原 lock 安装依赖；`tsc -b` 三个包及 Typert generator 的 tsconfig；`tsdown --env.DSH_BUILD_FACE host --workspace 'packages/{llm/llm,llm/llm-retry,compaction/compaction-basic}'` 加三个对应包的 `--filter`；再对三包执行原 `pnpm pack --pack-destination <目录>`。没有改造发布脚本。已核对所有具体 exports、host/remote 元数据、许可和包内无源码／source map。

在独立 DeepSeek++ checkout 中，`npm ci --ignore-scripts --offline` 已验证可安装这些本地归档；所有已锁定版本保持不变。P6 独立交付和 T7 官方增量插件均复用这三份归档；安装 T7 时需与插件包一起通过官方 `dsh plugin` 加入。当前入口见[根 README](../../README.md)，验证范围见[MASTER](../../docs/progress/MASTER.md)。后续升级须重新固定来源、包摘要及锁文件，并重跑上下文和 CLI 集成，不可把它替换为浮动 master/latest。
