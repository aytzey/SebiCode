# AGENTS.md — sebi-code (for Codex / non-Claude agents)

This is a mirror of CLAUDE.md for Codex, Gemini, and other AI agents. See CLAUDE.md for the complete documentation.

## What This Is

Modified Claude Code 2.1.88 with dual-provider support (Anthropic Claude + OpenAI Codex). The `/sebiralph` skill orchestrates both models for complex implementations.

## Build

```bash
export PATH="$HOME/.bun/bin:$PATH"
rm -f .cache/workspace/.prepared.json
node scripts/build-cli.mjs --no-minify
```

## Key Files

- `source/src/services/api/openai-adapter.ts` — Codex Responses API adapter
- `source/src/services/api/client.ts` — Provider routing (providerOverride)
- `source/src/tools/AgentTool/runAgent.ts` — Cross-provider model mapping
- `source/src/skills/sebiralph/` — Dual-model orchestration skill (10 files)
- `scripts/build-cli.mjs` — Build script with post-build SDK patches

## Testing Changes

After any modification, always test both providers:
```bash
node dist/cli.js -p "Say ok"                           # Claude
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "Say ok"   # Codex
```

## See CLAUDE.md for full documentation.
