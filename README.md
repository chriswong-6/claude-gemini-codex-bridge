# claude-gemini-codex-bridge

A Claude Code `PreToolUse` hook that chains **Gemini** and **Codex** sequentially when a tool call targets files too large for Claude's context window.

## How it works

```
Claude triggers Read / Grep / Glob / Task
          │
          ▼
   Token estimate > 50k?
          │
    No ───┴─── Yes
    │               │
  (pass through)    ▼
              Gemini 1.5 Pro
          (summarise large context)
                    │
                    ▼
                  Codex
          (deep analysis on summary)
                    │
                    ▼
          Result injected back into Claude
```

If Codex is unavailable, the Gemini summary is returned as fallback.  
Results are SHA-256 cached (TTL: 1 hour) so repeated calls on the same files are instant.

## Requirements

| Dependency | Notes |
|---|---|
| Node.js ≥ 18 | built-in `fetch` required |
| `GEMINI_API_KEY` | Google AI Studio key |
| `codex` CLI | `npm install -g @openai/codex` |
| `jq` | for `install.sh` |

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/claude-gemini-codex-bridge
cd claude-gemini-codex-bridge

export GEMINI_API_KEY=your_key_here
bash install.sh
```

The script adds a `PreToolUse` hook entry to `~/.claude/settings.json`.

## Uninstall

```bash
bash uninstall.sh
```

## Configuration

All options can be overridden via environment variables. Defaults are in `config/defaults.json`.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | _(required)_ | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-1.5-pro` | Gemini model to use |
| `CLAUDE_TOKEN_LIMIT` | `50000` | Token threshold that triggers the pipeline |
| `GEMINI_TOKEN_LIMIT` | `800000` | Upper bound; files larger than this are passed through |
| `MAX_TOTAL_SIZE_BYTES` | `10485760` | Hard 10 MB cap |
| `CODEX_APPROVAL_MODE` | `suggest` | `suggest` / `auto-edit` / `full-auto` |
| `CODEX_BIN` | `codex` | Path to the codex binary |
| `CACHE_TTL_SECONDS` | `3600` | Cache TTL (1 hour) |
| `DEBUG_LEVEL` | `0` | `0`=off `1`=basic `2`=verbose |
| `LOG_DIR` | `~/.claude-gemini-codex-bridge/logs` | Log directory |

## Project structure

```
claude-gemini-codex-bridge/
├── config/
│   └── defaults.json          # Default configuration values
├── hooks/
│   ├── pre-tool-use.mjs       # Hook entry point (reads stdin, orchestrates pipeline)
│   └── lib/
│       ├── cache.mjs          # SHA-256 content-based cache
│       ├── codex.mjs          # Codex CLI integration
│       ├── config.mjs         # Config loader (defaults + env overrides)
│       ├── gemini.mjs         # Gemini REST API client
│       ├── logger.mjs         # Stderr/file logger (never pollutes stdout)
│       ├── paths.mjs          # @-notation path resolver + file extractor
│       └── router.mjs         # Routing decision engine (token estimation)
├── install.sh
├── uninstall.sh
└── package.json
```

## Credits

Inspired by:
- [tkaufmann/claude-gemini-bridge](https://github.com/tkaufmann/claude-gemini-bridge) — PreToolUse hook pattern, routing logic, caching
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — Codex integration architecture
