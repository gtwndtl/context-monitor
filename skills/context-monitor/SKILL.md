---
name: context-monitor
description: Open the 100% local Context & Usage side-pane panel to inspect live context window breakdown, token volume, and prompt cache efficiency. Use when the user runs /context-monitor or asks to open the Context & Usage panel.
---

# Context & Usage Panel

Open or guide the user to the **Context & Usage** side-pane panel (`context-monitor/monitor_panel`).

## Instructions

1. Check read-only whether the `context-monitor/monitor_panel` sidecar is active:
   - Check `~/.gemini/antigravity/sidecar_data/context-monitor/monitor_panel/logs/sidecar.log` or inspect `GetAllPlugins` for `context-monitor` (`disabled == false`).
2. **If active**, output the one-click pill on its own line:
   `[Context & Usage](sidecar://context-monitor/monitor_panel/)`
   Tell the user they can also open it from the `+` button (`Ctrl+T` / `Cmd+T`) in the side panel, and pin it via **Right-click tab -> Pin Tab**.
3. **If not yet enabled**, provide:
   - `[Context & Usage](customization://context-monitor)`
   - `[Open Sidecars Dashboard](sidecar://dashboard)`
   Tell them to enable the **Context & Usage** plugin/sidecar once so it appears in the side panel `+` menu.
