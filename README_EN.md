# DeepSeek++ · DeepSeek Web × Local Harness

Use the signed-in DeepSeek website as the model for your local DeepSeek Harness. Chat, read and edit project files, and run commands from the Harness web interface, without a model API key.

**Install and pair once → run `dsh web` → work in the Harness web interface.**

[中文与完整安装步骤](README.md)

## Local Harness

This project adds a browser connection to DeepSeek++ and a companion DSH plugin:

- Use the logged-in DeepSeek web session for model inference.
- Keep Harness in charge of conversations, context, tools, Skills, subagents, and task execution.
- Pair the extension and configure permissions from the Harness settings UI.
- Save and continue conversations, or import completed standalone DeepSeek Web Agent sessions.
- Use PowerShell 7 on Windows without WSL, and official Bash/sandbox behavior on Linux.
- Keep other Harness model providers and the original DeepSeek++ browser features available.

The browser extension supplies the web model connection; Harness owns local tools. Browser-side memory and MCP settings are managed separately from Harness plugins.

## Installation

Requirements: Node.js 24.x, DeepSeek Harness `0.1.2-rc.1`, and Chrome, Edge, or Firefox on the same computer. Windows commands use PowerShell 7. Linux commands require Bash and a working Bubblewrap or Landlock backend.

Install the official Harness locally:

```sh
npm install --global @deepseek-ai/dsh@0.1.2-rc.1
```

Follow the [Windows / Linux installation instructions](README.md#首次安装) to install prerequisites, load the browser extension, and install the DSH plugin with its companion dependencies. Browser extension builds and Harness plugin builds are separate steps; when using a matching prebuilt package, source compilation is unnecessary.

Download the companion archive `deepseek-web-harness-preview-395cf37.zip` from [GitHub Releases](https://github.com/XVSHIFU/deepseek-pp/releases/tag/web-harness-preview-20260907), rather than the generated Source code archives. Extract it and open the enclosed `deepseek-web-official-395cf37` directory for the package-based installation steps.

Then [pair them in the settings UI](README.md#首次配对只做一次). The extension ID and pairing token are saved for daily use.

## Daily use

Keep the signed-in DeepSeek page open. From your project directory, run:

```sh
dsh web
```

Create or continue a conversation in the Harness web interface. Stop the service with `Ctrl+C` in its terminal.

## Commands and data

Windows native commands are disabled by default. Enable them in the DeepSeek Web settings, keep **Ask for every command**, and create a new session. Approved commands run with the current Windows-user permissions, not a workspace sandbox.

Linux retains the official `workspace-write + ask` behavior: ordinary commands run in a file sandbox, with approval requested when broader file access is needed. A file sandbox is not network isolation.

Files and tool results used for a task are sent to the DeepSeek website as model context. Only select projects you permit the model to process, and review commands before approving them.

## Friendly Links

- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) - AI-friendly CLI for Office document processing
- [1flowbase](https://github.com/taichuy/1flowbase) - Open-source virtual model gateway for publishing multi-model workflows as OpenAI / Claude-compatible endpoints
- [FrontAgent](https://github.com/FrontAgent/FrontAgent) - AI agent platform for frontend engineering with RAG, Skills, SDD, MCP, CLI, and VS Code support
- [MuseAI](https://github.com/yejiming/MuseAI) - AI character and story-world interaction project for creating characters and continuing story interactions
- [Spec Driven Develop](https://github.com/zhu1090093659/spec_driven_develop) - A spec-driven development method for AI coding agents
- [Awesome-Prompts Role Playing](https://github.com/dongshuyan/Awesome-Prompts/tree/master/%E8%A7%92%E8%89%B2%E6%89%AE%E6%BC%94) - Curated role-playing prompt collection
- [LINUX DO](https://linux.do) - A next-generation open-source technology community

## Acknowledgements

Built on [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp) and the plugin mechanisms of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Thanks to the upstream authors and contributors.

## License

Apache-2.0 for this repository. The companion Harness archives retain their MIT license files.
