# multicodex

Use multiple Codex subscriptions as one pool, without repeatedly signing in and out.

Works with Codex CLI and Codex Desktop using only official Codex tools.

- Start all usage windows with one command: `wake` sends one request per account.
- Keep windows active automatically: `autowake` detects scheduled and early resets, then wakes only unused accounts.
- See what remains: `usage` shows balances, reset times, renewal or cancellation, and total weighted capacity.
- Keep working: `exec` runs Codex with any account without changing the active one; `use` switches the active account.

Supported on macOS, Linux, and Windows. Requires Bun 1.4+ and Codex CLI 0.115.0+.
Billing lookup uses the built-in system WebKit on macOS and an installed Chrome, Chromium, Edge, or Brave browser on Linux and Windows.

## Install

```sh
brew tap ShlomoCode/tap
brew install multicodex
```

Homebrew installs Bun from `oven-sh/bun`. Codex CLI remains a separate runtime
requirement. On Windows, download `cli.ts` from the matching GitHub release and
run it with Bun.

## Usage

```text
usage: multicodex [--data-dir PATH] {add,remove,rename,list,use,current,exec,usage,wake,autowake} ...

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
  autowake install             check every 15 minutes and wake accounts after quota resets
  autowake status              show scheduler and per-account state
  autowake run                 check now and wake only accounts whose reset is due
  autowake uninstall           remove the background scheduler

options:
  -h, --help                   show this help message and exit
  --data-dir PATH              account data directory (default: ~/.multicodex-accounts)
  --format FORMAT              output format for list, current, usage, and wake (text or json)
  -J                           shorthand for --format json

Examples:
  multicodex add you@example.com --name personal
  multicodex list
  multicodex usage
  multicodex exec personal
  multicodex use personal
  multicodex wake
  multicodex autowake install
```

The former default directory, `~/.codex-accounts`, is moved automatically to
`~/.multicodex-accounts` when the new directory does not exist. Override the
location with `MULTICODEX_HOME` or `--data-dir`.

## Automatic wake

On macOS, install the background scheduler once:

```sh
multicodex autowake install
```

The LaunchAgent checks every 15 minutes and after login. For every account it
reads the official weekly Codex rate-limit window without forcing an OAuth token
refresh. For Plus accounts it also tracks the 5-hour window. It sends one wake
request when either eligible window has two consecutive preflight reads at
exactly `0%` usage and either:

- the tracked reset time has arrived; or
- the service moved the reset time forward early or dropped usage to zero.

If both windows reset together, one request wakes both. A 5-hour wake is skipped
while the weekly quota is exhausted. Each reset window is recorded in
`~/.multicodex-accounts/auto-wake-state.json`, so the same window is never woken
twice. Failed requests remain due and are retried on the next check. Wake
requests explicitly use `gpt-5.6-terra` with low reasoning effort.

```sh
multicodex autowake status
multicodex autowake run
multicodex autowake uninstall
```

`autowake run` is portable and can be invoked by another scheduler on Linux or
Windows. Background installation and status management currently use macOS
LaunchAgents.

When matching `~/.cli-proxy-api/codex-ACCOUNT.json` files exist, multicodex keeps
their OAuth credentials synchronized with each account profile using the newest
`last_refresh` value. CLIProxyAPI metadata such as account priority is preserved.

## JSON output

Use `--format json` or `-J` with `list`, `current`, `usage`, `wake`, or `autowake` to receive one machine-readable JSON document. The flag can appear before or after the command.

```sh
multicodex usage --format json
multicodex -J list
```

Partial `usage` and `wake` failures remain structured in the `accounts` array and produce a nonzero exit status. With JSON output selected, command-level errors are written to standard error as `{ "error": { "message": "..." } }`.
