# context-monitor

Local sidecar panel for Antigravity to check model quotas, context window usage, and token stats without sending any data outside your machine.

## What's inside

- **Quota** - Remaining quota and reset timers for each model group (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`), read from the local language server.
- **Context** - Current conversation context usage, category breakdown, cache hit rate, and heavy tool calls.
- **Usage** - Token volume chart and breakdown by model/session (`24h`, `7d`, `30d`, `All`), with no pricing or external rate fetching.

## Install

Clone directly into your Antigravity plugins folder:

```powershell
# Windows (PowerShell)
git clone https://github.com/gtwndtl/context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
```

```bash
# macOS / Linux
git clone https://github.com/gtwndtl/context-monitor.git ~/.gemini/config/plugins/context-monitor
```

Or install from a local clone:

```bash
git clone https://github.com/gtwndtl/context-monitor.git
agy plugin install ./context-monitor
agy plugin enable context-monitor
```

## Open

Click `+` (`Ctrl+T` / `Cmd+T`) in the side panel and select **Context & Usage**, or type `/context-monitor` in chat.
