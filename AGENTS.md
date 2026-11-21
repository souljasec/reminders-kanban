# Installing Reminders Kanban, a guide for AI assistants

You are helping a user install **Reminders Kanban**: a desktop Kanban widget for Apple Reminders on macOS,
plus an MCP server that lets you (the assistant) add and manage their tasks. Follow these steps in order.

## 1. Check the system

```bash
sw_vers -productVersion          # must be 14 or higher
```

- Not macOS, or older than 14? Stop and tell the user it needs macOS 14 Sonoma or newer.

## 2. Run the installer (non-interactive)

```bash
curl -fsSL https://raw.githubusercontent.com/souljasec/reminders-kanban/main/install.sh | bash -s -- --yes
```

`--yes` accepts the defaults: install Übersicht via Homebrew if missing, build the helper, connect every AI app found
(Claude Desktop, Claude Code, Codex), and add Übersicht to Login Items.

To limit what it changes, pass any of: `--no-login-item`, `--no-claude-desktop`, `--no-claude-code`, `--no-codex`.
To connect only yourself, e.g. Claude Code: `--yes --claude-code --no-claude-desktop --no-codex`.

Possible stops and what to do:

| Message | What to do |
| --- | --- |
| `Install Übersicht first` (no Homebrew) | Ask the user to install Homebrew from https://brew.sh, or Übersicht from https://tracesof.net/uebersicht/, then rerun. |
| `Xcode Command Line Tools are needed` | A macOS dialog has opened. Ask the user to click **Install**, wait until it finishes, then rerun step 2. |
| `No Reminders access yet` | Tell the user to click **Allow** on the macOS prompt, or enable it in System Settings → Privacy & Security → Reminders. |

## 3. Verify

```bash
"$HOME/Library/Application Support/Reminders Kanban/reminders-kanban" doctor
```

All lines marked `✓` means it's working. Any `✗` line includes the fix (after `→`).

## 4. Tell the user

- The widget is now on their desktop. They can drag its header to move it.
- macOS may ask for Reminders access. They should click **Allow**.
- **Claude Desktop must be restarted** to load the new tools. In Claude Code, new tools are available in the
  next session.

## 5. Using the tools (after the restart)

The MCP server `reminders-kanban` provides:

| Tool | Use |
| --- | --- |
| `list_tasks` | `status` (open, todo, doing, done, all), `project`, `due` (overdue, today, week), `query` |
| `add_task` | `title` (required), `description`, `link`, `due` (ISO 8601 or "tomorrow 3pm"), `status` (todo, doing), `project` |
| `update_task` | `id` (or unique part of the title) plus any of title, description, link, due ("none" clears it), project, status |
| `move_task` | `id`, `status` (todo, doing, done) |
| `complete_task` | `id` |

Guidelines: keep titles short and put details in `description`. Set `due` whenever the user mentions a time.
There is no delete tool: if the user wants a task removed, tell them to right-click it in the widget → Delete.

## Update

If the user asks to update Reminders Kanban, check the installed version, then rerun the installer. It installs
the latest release and keeps their tasks, projects, order and widget position.

```bash
"$HOME/Library/Application Support/Reminders Kanban/reminders-kanban" version
curl -fsSL https://raw.githubusercontent.com/souljasec/reminders-kanban/main/install.sh | bash -s -- --yes
```

Pass the same `--no-…` flags as at install if the user limited what it changes. Afterwards, tell them the old and
new version (the installer prints `old → new`) and that **Claude Desktop must be restarted** to load the new
helper. The widget reloads by itself.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/souljasec/reminders-kanban/main/install.sh | bash -s -- --uninstall
```
