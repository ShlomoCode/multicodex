# multicodex

Use multiple Codex subscriptions as one pool, without repeatedly signing in and out.

Works with Codex CLI and Codex Desktop using only official Codex tools.

- Start all usage windows with one command: `wake` sends one request per account after a reset.
- See what remains: `usage` shows balances, reset times, renewal or cancellation, and total weighted capacity.
- Keep working: `exec` runs Codex with any account without changing the active one; `use` switches the active account.

Supported on macOS, Linux, and Windows. Requires Bun 1.4+ and Codex CLI 0.115.0+.
Billing lookup uses the built-in system WebKit on macOS and an installed Chrome, Chromium, Edge, or Brave browser on Linux and Windows.

## Install

```sh
curl --create-dirs -fsSL https://raw.githubusercontent.com/ShlomoCode/multicodex/main/cli.ts -o ~/.local/bin/multicodex && chmod +x ~/.local/bin/multicodex
```

On Windows, download `cli.ts` with `curl.exe` and run it with Bun.

## Usage

```text
usage: multicodex [--data-dir PATH] {add,remove,rename,list,use,current,exec,usage,wake} ...

Use multiple Codex accounts on this computer.

commands:
  add EMAIL [--name NAME]       add an account and sign in
  remove ACCOUNT               remove an account and its profile data
  rename ACCOUNT NEW_NAME      rename an account
  list                         list configured accounts
  use ACCOUNT                  switch the active Codex account
  current                      show the active account
  exec ACCOUNT [CODEX_ARG...]  run Codex CLI with a specific account
  usage [ACCOUNT]              show usage for one or all accounts
  wake                         send one small request from every account

options:
  -h, --help                   show this help message and exit
  --data-dir PATH              account data directory (default: ~/.codex-accounts)
  --format FORMAT              output format for list, current, usage, and wake (text or json)
  -J                           shorthand for --format json

Examples:
  multicodex add you@example.com --name personal
  multicodex list
  multicodex usage
  multicodex exec personal
  multicodex use personal
  multicodex wake
```

## JSON output

Use `--format json` or `-J` with `list`, `current`, `usage`, or `wake` to receive one machine-readable JSON document. The flag can appear before or after the command.

```sh
multicodex usage --format json
multicodex -J list
```

Partial `usage` and `wake` failures remain structured in the `accounts` array and produce a nonzero exit status. With JSON output selected, command-level errors are written to standard error as `{ "error": { "message": "..." } }`.
