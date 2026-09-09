# DeepSeek++ Harness · DeepSeek Web × Local Agent

Use the signed-in DeepSeek website as the model for your local DeepSeek Harness. Chat, read and edit project files, and run commands from the Harness web interface, without a model API key.

**Install and pair once → run `dsh web` → work in the Harness web interface.**

[中文与完整安装步骤](README.md)

## Local Harness

This project adds a browser connection to DeepSeek++ and a companion DSH plugin:

- Use the logged-in DeepSeek web session for model inference.
- Keep Harness in charge of conversations, context, tools, Skills, subagents, and task execution.
- Pair the extension and configure permissions from the Harness settings UI.
- Choose Default or Expert independently of Thinking on/off, with defaults for new sessions and per-session selection.
- Use collapsible settings that follow the Harness language and light/dark theme.
- Save and continue conversations, or import completed standalone DeepSeek Web Agent sessions.
- Use PowerShell 7 on Windows without WSL, and official Bash/sandbox behavior on Linux.
- Keep other Harness model providers and the original DeepSeek++ browser features available.

The browser extension supplies the web model connection; Harness owns local tools. Browser-side memory and MCP settings are managed separately from Harness plugins.

## Installation

Requirements: Node.js 24.x, pnpm `11.7.0`, DeepSeek Harness `0.1.2-rc.1`, and Chrome, Edge, or Firefox on the same computer. pnpm installs the Harness plugins. Windows commands use PowerShell 7. Linux commands require Bash and a working Bubblewrap or Landlock backend.

Use this Harness version together with the bundled dependencies: the plugin's model, tool, and settings integrations are paired with these interfaces.

Install pnpm and the official Harness locally:

```sh
npm install --global pnpm@11.7.0
npm install --global @deepseek-ai/dsh@0.1.2-rc.1
```

Follow the [Windows / Linux installation instructions](README.md#首次安装) to install prerequisites, load the browser extension, and install the DSH plugin with its companion dependencies. Browser extension builds and Harness plugin builds are separate steps; when using a matching prebuilt package, source compilation is unnecessary.

In the Assets section of [GitHub Releases](https://github.com/XVSHIFU/deepseek-pp/releases), choose the complete installation archive **`deepseek-web-harness-20260909.zip`**, or use that archive if you already have it. No separate extension patch is needed. Do not choose the generated Source code archives. Extract it and enter `deepseek-web-harness-20260909`, containing `README.md`, `extensions`, `plugin`, and `vendor`. Run package installation and upgrade commands from that directory.

Install the Harness plugin and companion dependencies:

Windows (PowerShell 7):

```powershell
$vendor = @(Get-ChildItem -LiteralPath ./vendor -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
$plugin = @(Get-ChildItem -LiteralPath ./plugin -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
dsh plugin --profile web add $vendor $plugin --allow-build=koffi
```

Linux (Bash):

```bash
dsh plugin --profile web add ./vendor/*.tgz ./plugin/*.tgz --allow-build=koffi
```

Wait for installation to succeed, then load the browser extension below. Installation needs internet access. Git and source compilation are unnecessary when using the complete installation archive.

Then [pair them in the settings UI](README.md#首次配对只做一次). The extension ID and pairing token are saved for daily use.

For Chrome / Edge, extract the companion archive first, then extract the browser ZIP inside `extensions/chrome/` or `extensions/edge/`. In the browser's **Load unpacked** dialog, choose the extracted browser folder containing `manifest.json` alongside `_locales/` and `assets/`. Do not choose the companion archive's top-level folder: its `manifest.json` is a package inventory, not a browser extension manifest. Enable only **DeepSeek++ Harness**, not both it and the original extension.

![Extract both archives and load only the inner browser extension folder](docs/images/guide/extension-folder.svg)

For Firefox, extract the Firefox ZIP, open `about:debugging#/runtime/this-firefox`, and select **Load Temporary Add-on** with the extension's `manifest.json`. Pair using its full `moz-extension://…` address. Temporary loading ends when the browser exits; update the pairing if the address changes after reloading. Keep the extension folder, then open the DeepSeek website, sign in, and refresh the page.

**WSL Ubuntu with a Windows browser:** install Node.js, pnpm, Harness, and the DSH plugin inside Ubuntu using the Linux instructions, and run `dsh web` there. Load the browser extension in Windows Chrome / Edge and use that browser's extension ID for pairing. You can extract another copy of the archive on Windows solely for the extension, or run `explorer.exe .` in Ubuntu to open its current folder and copy the extracted extension to a permanent Windows directory. Project files and commands remain in Ubuntu. Shell Local is not required.

In Harness, expand **Settings → Plugins → DeepSeek Web model**. Enter the extension ID under **Connection**, select **Set DeepSeek Web as the default for future new sessions**, then **Save settings**. Reopen the card, select **Generate pairing token → Copy** under **Pairing**, and paste it into the browser extension's **Settings → Local Harness** with port `43123`. Save there and check that the connection is established. Existing pairing does not need to be regenerated.

The screenshots below use the Chinese interface; the controls are in the same positions in English. Use your own extension ID, not the example shown.

![Harness plugin connection settings and extension ID field](docs/images/guide/harness-connection.jpg)

In the extension, paste the token into the masked field and click **Save** at the bottom right. This location example shows **Waiting to retry** before connection; successful pairing should show **Connected**.

![Browser extension bridge switch, port, masked pairing token and Save button](docs/images/guide/extension-pairing.png)

## Daily use

Keep the signed-in DeepSeek page open. From your project directory, run:

```sh
dsh web
```

Select your project workspace in the Harness sidebar; use **Add workspace** if it is not listed. Create or continue a conversation, and check that the model selector shows **DeepSeek Web (Default)** or **DeepSeek Web (Expert)**. Stop the service with `Ctrl+C` in its terminal.

If prompted to sign in, refresh the signed-in DeepSeek page before sending the task again. If disconnected, check that `dsh web` is still running and save the connection settings in the extension's Local Harness panel. Reinstallation is unnecessary for these cases.

In the extension's **Settings → Local Harness**, the minimum model request interval defaults to **5 seconds** and can be increased to **30 seconds**. Harness sessions connected through that extension share it. If DeepSeek reports too many requests, wait; repeated rate limits extend the cooldown. Completed tool results are retained. Check your progress before creating or branching a Harness session to continue; do not repeatedly resend a failed task.

## Model mode and thinking

Under **Settings → Plugins → DeepSeek Web model → Web model**, select **Default** or **Expert** and independently enable or disable thinking. Select the option to make this provider the default for future sessions and save.

For an existing session, use the Harness model selector: **DeepSeek Web (Default)** or **DeepSeek Web (Expert)**, with **Thinking off / Thinking on**. Change selections between replies; they apply to subsequent turns without changing other sessions. No manual mode change on the DeepSeek website is needed.

Thinking appears in a collapsible live panel. It is not stored in session history or restored after a page reload; final answers and tool results are retained. This connection supports text and local tools, not image uploads or vision.

Mode, thinking, and the default-provider switch are independent. Enable the last switch and save if you want new sessions to use the web model automatically.

![Model mode, thinking toggle and default-provider setting in Harness](docs/images/guide/harness-model.jpg)

## Upgrade

Stop Harness with `Ctrl+C` and keep the previous package. From the new package directory, update the companion dependencies and plugin together:

These steps apply to complete packages. For a package explicitly labelled as a browser-extension-only update, follow its instructions and leave unchanged Harness components installed.

Windows (PowerShell 7):

```powershell
$vendor = @(Get-ChildItem -LiteralPath ./vendor -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
$plugin = @(Get-ChildItem -LiteralPath ./plugin -Filter '*.tgz' | Select-Object -ExpandProperty FullName)
dsh plugin --profile web add $vendor $plugin --force --allow-build=koffi
```

Linux (Bash):

```bash
dsh plugin --profile web add ./vendor/*.tgz ./plugin/*.tgz --force --allow-build=koffi
```

After the command succeeds, back up the currently loaded extension folder and copy the new browser ZIP's extracted files into that same folder. Reload the extension and refresh the signed-in DeepSeek page, then run `dsh web` again. Keeping the original Chrome/Edge extension path preserves its ID and pairing. Firefox temporary loading may change the origin and require pairing again. Installation and upgrades may need internet access.

Existing settings receive a default 5-second request interval without pairing again. To roll back, restore the pre-upgrade extension settings and matching components together; do not use an old extension with the new settings format.

## Commands and data

Harness commands do not require the browser extension's MCP → Shell Local. On Windows, enable the Harness plugin's Windows command switch; full workspace access does not enable it. When Harness runs in WSL, commands run in Ubuntu, while the paired browser can run on Windows.

Windows native commands are disabled by default. Enable them in the DeepSeek Web settings, keep **Ask for every command**, and create a new session. Approved commands run with the current Windows-user permissions, not a workspace sandbox.

This screenshot shows Windows commands enabled with per-command approval. The pairing section below already has a saved token; it does not need to be regenerated.

![Windows PowerShell command switch, approval policy, executable field and saved pairing status](docs/images/guide/harness-permissions-pairing.jpg)

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
