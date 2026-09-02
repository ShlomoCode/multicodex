# multicodex

Use multiple Codex subscriptions as one pool with Codex CLI or Desktop. Switch
accounts, check quotas, run Codex with a selected account, and restart quota
windows automatically.

## Install

```sh
brew install ShlomoCode/multicodex/multicodex
```

## Use

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
  multicodex add you@example.com
  multicodex list
  multicodex usage
  multicodex exec you@example.com
  multicodex use you@example.com
  multicodex wake
  multicodex autowake install
```

Wake requests use the official Codex CLI in ephemeral, read-only mode and
verify a random cryptographic challenge. Multicodex has no backend.
