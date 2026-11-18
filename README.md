# OpenCodeArena

A continuous multi-agent field for [OpenCode](https://opencode.ai). One objective, a
crew of named child agents, one shared room, a referee, and a claim gate that closes
on evidence.

No rounds. No phases. No judge scoreboard.

## What it does

- Turns one OpenCode session into a team of child agents.
- Gives every seat a name, a role, a brief, and one shared room.
- Keeps facts, tests, results, dead ends and claims in a typed bus.
- Uses a state card and leases so agents do not collide.
- Runs Vera the referee to pulse a quiet room and report.
- Runs a claim gate: verification command, a peer falsifier, and evidence.
- Keeps the field live until every agent leaves or you stop it.

## Requirements

- OpenCode 2.2 or newer.
- Bun 1.2 or newer.
- Git. On Windows, Arena downloads MinGit automatically if git is missing.
- OpenCode desktop for the Arena tab. The tools and the room work without the tab.

No Docker, Python, MCP server or agent file is required.

## Install

```sh
git clone https://github.com/AhmedBoin/OpenCodeArena.git
cd OpenCodeArena
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Linux or macOS:

```sh
bash scripts/setup.sh
```

The setup script installs a self-contained copy into OpenCode, builds the tab, and
copies the skill. Add the plugin once to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/arena"]
}
```

Restart OpenCode.

## Example

Talk to your main OpenCode agent:

```text
make an arena of 4 agents that find why duplicate webhook events create two orders
```

Or use the slash command directly:

```text
/arena --same-role "Security Researcher" --agents 4 Audit https://staging.example.com
```

Or call the tool:

```json
{
  "action": "start",
  "objective": "find why duplicate webhook events create two orders",
  "verification": "bun test"
}
```

The orchestrator plans the crew, creates one child session per seat and a referee,
prepares git worktrees, and opens the room. Each seat works the problem, posts
evidence, and leaves on its own. A claim closes only when the verification passes, a
peer cannot falsify it, and the claim carries evidence.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): plain-English tour, the cast, a diagram and a
  full run walkthrough.
- [GUIDE.md](GUIDE.md): the full command, tool and settings reference.
- [docs/](docs/): the technical design documents.

## Project layout

```text
src/core/      field state, inbox, gate, knowledge
src/field/     roster, prompts, the field driver
src/host/      host port and OpenCode adapter
src/plugin.ts  OpenCode entry, tools, command, RPC
src/gui.tsx    the Arena tab
```
