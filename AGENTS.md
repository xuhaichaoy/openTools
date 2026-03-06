# Agent Working Rules (Performance First)

## Scan Policy
- Always read `.gitignore` before broad repository scans.
- Respect `.gitignore`, `.ignore`, and `.rgignore` when searching or listing files.
- Start from user-provided file paths first; avoid full-repo traversal unless required.

## Heavy Directories
- Do not scan these paths unless user explicitly asks:
  - `node_modules/`
  - `src-tauri/target/`
  - `crates/**/target/`
  - `dist/`
  - `dist-ssr/`

## Search Strategy
- Prefer `rg` with narrow globs and direct paths over recursive listing.
- Read only the minimal set of files needed to complete the task.
