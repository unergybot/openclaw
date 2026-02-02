# Copilot instructions (OpenClaw)

## Big picture
- OpenClaw is a local-first “Gateway” control plane (WS at `ws://127.0.0.1:18789`) that routes messages from many channels to agents/tools and serves the web UI.- **BestBox integration**: the `bestbox` extension (`extensions/bestbox/`) routes enterprise queries (ERP/CRM/IT Ops/OA) to BestBox's LangGraph Agent API.- Core code lives in `src/` (CLI in `src/cli`, commands in `src/commands`, routing in `src/routing`, channel adapters in `src/{telegram,discord,slack,signal,imessage,web}`).
- Extensions are workspace packages under `extensions/*` and must be treated as first-class when changing shared routing/onboarding logic.

## Dev workflow
- Runtime baseline: Node 22+.
- Install: `pnpm install` (Bun is supported; prefer Bun for running TS scripts).
- Build/typecheck: `pnpm build` (outputs `dist/` for Node/prod).
- Run from source: `pnpm openclaw ...` (runs TS directly) or `pnpm gateway:watch` for the dev loop.
- Lint/format/test: `pnpm lint` (oxlint), `pnpm format` (oxfmt), `pnpm test` (vitest).

## Repo conventions that bite newcomers
- Extensions: keep runtime deps in the extension’s `dependencies`; don’t add plugin-only deps to root `package.json`.
- Avoid `workspace:*` in an extension’s `dependencies` (plain `npm install` breaks); use `openclaw` in `devDependencies`/`peerDependencies` instead.
- Don’t edit `node_modules/`; don’t change `pnpm.patchedDependencies` / patches without explicit approval.

## UI/TTY patterns (reuse these)
- CLI progress/spinners: `src/cli/progress.ts`.
- Status tables + wrapping: `src/terminal/table.ts`.
- Shared palette (no hardcoded colors): `src/terminal/palette.ts`.

## Docs
- Mintlify docs in `docs/`: internal links must be root-relative with no `.md`/`.mdx` (e.g. `/configuration#hooks`).

## Safety / workflow guardrails
- Don’t create/apply/drop git stashes and don’t switch branches unless explicitly asked.
