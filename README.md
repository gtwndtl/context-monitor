# Context & Usage Monitor (`context-monitor`)

A 100% local, offline-first Antigravity sidecar plugin for monitoring **Model Quotas**, **Live Context Window**, and **Token Usage** — with zero external network requests and zero pricing clutter.

## Features

- **Quota** (Default tab): Live remaining model quotas grouped by pool (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) with reset countdowns and full model list, powered by Antigravity's local Language Server (`GetUserStatus`).
- **Context**: Live context window utilization (`% used`, `used / limit`), stacked bar & proportional grid views, category breakdown, Prompt Cache hit ratio, and expandable details (Heavy Tool Calls, MCP Servers, Active Rules, Skills).
- **Usage**: Fast incremental token analytics (`24h`, `7d`, `30d`, `All`), session/project scopes, Cache Hit %, SVG token volume chart, and model/session breakdowns.

## Installation

### Option 1: Clone directly into Antigravity plugins folder

**Windows (PowerShell):**
```powershell
git clone https://github.com/gtwndtl/context-monitor.git "$env:USERPROFILE\.gemini\config\plugins\context-monitor"
```

**macOS / Linux:**
```bash
git clone https://github.com/gtwndtl/context-monitor.git ~/.gemini/config/plugins/context-monitor
```

### Option 2: Install from a cloned local directory via CLI

```bash
git clone https://github.com/gtwndtl/context-monitor.git
agy plugin install ./context-monitor
```

Then enable **Context & Usage** in Antigravity Customizations (or run `agy plugin enable context-monitor`).

## Usage

- Open from the side panel **`+`** button (`Ctrl+T` / `Cmd+T`) and **Pin Tab**, or run `/context-monitor` in chat.
