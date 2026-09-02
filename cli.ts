#!/usr/bin/env bun

import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile, link } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export class MultiCodexError extends Error {}

type Account = { name: string; home: string; expected_email?: string };
type Config = { version: 1; accounts: Account[]; active_account?: string };
type AutoWakeAccountState = {
  next_reset_at?: number;
  used_percent?: number;
  five_hour_next_reset_at?: number;
  five_hour_used_percent?: number;
  last_wake_at?: number;
  last_wake_for_reset_at?: number;
  last_wake_for_five_hour_reset_at?: number;
  last_checked_at?: number;
  last_error?: string;
};
type AutoWakeState = { version: 1; accounts: Record<string, AutoWakeAccountState> };
type WakeWindow = { resets_at: number; used_percent: number };
type WakeObservation = { email: string | null; weekly: WakeWindow; five_hour: WakeWindow | null };
type Json = Record<string, any>;
type OutputFormat = "text" | "json";

const CAPACITIES: Record<string, number> = { plus: 1, prolite: 5, pro: 20 };
const TIERS: Record<string, string> = { plus: "Plus", prolite: "Pro X5", pro: "Pro X20" };
const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  chatgptfreeplan: "Free",
  plus: "Plus",
  chatgptplusplan: "Plus",
  prolite: "Pro X5",
  chatgptprolite: "Pro X5",
  pro: "Pro X20",
  chatgptpro: "Pro X20",
};
const AUTO_WAKE_LABEL = "local.multicodex.auto-wake";
const WEEKLY_WINDOW_MINUTES = 10080;
const AUTO_WAKE_INTERVAL_SECONDS = 15 * 60;
const WAKE_MODEL = "gpt-5.6-terra";
const WAKE_REASONING_EFFORT = "low";
const HELP = `usage: multicodex [--data-dir PATH] {add,remove,rename,list,use,current,exec,usage,wake,autowake} ...

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
  multicodex autowake install`;

const expandHome = (value: string) => value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
const LEGACY_DEFAULT_BASE = () => resolve(expandHome("~/.codex-accounts"));
export const defaultBase = () => resolve(expandHome(process.env.MULTICODEX_HOME ?? "~/.multicodex-accounts"));
export const defaultMainHome = () => resolve(expandHome(process.env.CODEX_HOME ?? "~/.codex"));
const configPath = (base: string) => join(base, "config.json");
const authPath = (home: string) => join(home, "auth.json");
const autoWakeStatePath = (base: string) => join(base, "auto-wake-state.json");
const autoWakePlistPath = () => join(homedir(), "Library", "LaunchAgents", `${AUTO_WAKE_LABEL}.plist`);
const exists = (path: string) => existsSync(path);

async function migrateLegacyDefaultBase(base: string): Promise<void> {
  if (process.env.MULTICODEX_HOME || base !== defaultBase()) return;
  const legacy = LEGACY_DEFAULT_BASE();
  if (legacy === base || !exists(legacy) || exists(base)) return;
  await rename(legacy, base);
  console.error(`multicodex: migrated account data to ${base}`);
}

export function validateName(name: string): string {
  if (!name || name === "." || name === "..") throw new MultiCodexError("account name cannot be empty");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new MultiCodexError("account name may contain only letters, digits, '-' and '_'");
  return name;
}

export function validateEmail(value: string): string {
  const email = value.trim().replaceAll("\\@", "@");
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new MultiCodexError(`invalid email address: ${JSON.stringify(email)}`);
  return email;
}

export function automaticName(email: string, accounts: Account[]): string {
  const stem = email.split("@", 1)[0].replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase() || "account";
  const names = new Set(accounts.map(account => account.name));
  if (!names.has(stem)) return stem;
  let suffix = 2;
  while (names.has(`${stem}-${suffix}`)) suffix++;
  return `${stem}-${suffix}`;
}

export async function loadConfig(base: string, allowMissing = false): Promise<Config> {
  const path = configPath(base);
  if (!exists(path)) {
    if (allowMissing) return { version: 1, accounts: [] };
    throw new MultiCodexError(`no accounts configured; run 'multicodex --data-dir ${base} add EMAIL'`);
  }
  let data: Json;
  try { data = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new MultiCodexError(`cannot read ${path}: ${error}`); }
  if (data.version !== 1 || !Array.isArray(data.accounts)) throw new MultiCodexError(`unsupported or invalid config: ${path}`);
  return data as Config;
}

export async function saveConfig(base: string, config: Config): Promise<void> {
  await mkdir(base, { recursive: true });
  const temporary = join(base, `.config.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath(base));
}

async function loadAutoWakeState(base: string): Promise<AutoWakeState> {
  const path = autoWakeStatePath(base);
  if (!exists(path)) return { version: 1, accounts: {} };
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object") throw new Error("invalid state schema");
    return data as AutoWakeState;
  } catch (error) { throw new MultiCodexError(`cannot read ${path}: ${error}`); }
}

async function saveAutoWakeState(base: string, state: AutoWakeState): Promise<void> {
  await mkdir(base, { recursive: true });
  const temporary = join(base, `.auto-wake-state.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, autoWakeStatePath(base));
}

function decodeJwt(token: unknown): Json | null {
  if (typeof token !== "string") return null;
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { return null; }
}

async function readAuth(home: string): Promise<Json> {
  const path = authPath(home);
  let info;
  try { info = await lstat(path); } catch { throw new MultiCodexError(`authentication file is missing: ${path}`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new MultiCodexError(`authentication path must be a regular, non-symlink file: ${path}`);
  if (platform() !== "win32" && (info.mode & 0o077)) throw new MultiCodexError(`unsafe permissions on ${path}; expected mode 0600`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new MultiCodexError(`cannot parse authentication file ${path}`); }
}

async function readSecureJson(path: string): Promise<Json> {
  let info;
  try { info = await lstat(path); } catch { throw new MultiCodexError(`file is missing: ${path}`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new MultiCodexError(`path must be a regular, non-symlink file: ${path}`);
  if (platform() !== "win32" && (info.mode & 0o077)) throw new MultiCodexError(`unsafe permissions on ${path}; expected mode 0600`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new MultiCodexError(`cannot parse JSON file ${path}`); }
}

async function writeSecureJson(path: string, data: Json): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function syncCliProxyAuth(account: Account): Promise<"source_to_proxy" | "proxy_to_source" | "unchanged" | "unconfigured"> {
  const proxyPath = join(homedir(), ".cli-proxy-api", `codex-${account.name}.json`);
  if (!exists(proxyPath)) return "unconfigured";
  const sourcePath = authPath(account.home);
  const source = await readAuth(account.home);
  const proxy = await readSecureJson(proxyPath);
  const sourceTokens = source.tokens;
  if (!sourceTokens || typeof sourceTokens !== "object") throw new MultiCodexError(`tokens are missing from ${sourcePath}`);
  if (account.expected_email && typeof proxy.email === "string" && proxy.email.toLowerCase() !== account.expected_email.toLowerCase()) {
    throw new MultiCodexError(`CLIProxyAPI auth ${proxyPath} belongs to ${proxy.email}, expected ${account.expected_email}`);
  }
  const tokenKeys = ["access_token", "refresh_token", "id_token", "account_id"];
  if (tokenKeys.every(key => sourceTokens[key] === proxy[key])) return "unchanged";
  const sourceTime = Date.parse(source.last_refresh ?? "");
  const proxyTime = Date.parse(proxy.last_refresh ?? "");
  if (!Number.isFinite(sourceTime) && !Number.isFinite(proxyTime)) {
    throw new MultiCodexError(`cannot choose the newest credentials for ${account.name}; last_refresh is missing`);
  }
  if (Number.isFinite(sourceTime) && (!Number.isFinite(proxyTime) || sourceTime >= proxyTime)) {
    for (const key of tokenKeys) if (typeof sourceTokens[key] === "string") proxy[key] = sourceTokens[key];
    proxy.last_refresh = source.last_refresh;
    await writeSecureJson(proxyPath, proxy);
    return "source_to_proxy";
  }
  for (const key of tokenKeys) if (typeof proxy[key] === "string") sourceTokens[key] = proxy[key];
  source.last_refresh = proxy.last_refresh;
  await writeSecureJson(sourcePath, source);
  return "proxy_to_source";
}

export async function authEmail(home: string): Promise<string | null> {
  const auth = await readAuth(home);
  for (const container of [auth, auth.tokens].filter(Boolean)) {
    if (typeof container.email === "string" && container.email) return container.email;
    for (const key of ["id_token", "access_token", "idToken", "accessToken"]) {
      const email = decodeJwt(container[key])?.email;
      if (typeof email === "string" && email) return email;
    }
  }
  return null;
}

async function verifyIdentity(account: Account, home = account.home): Promise<string | null> {
  const actual = await authEmail(home);
  if (account.expected_email && actual?.toLowerCase() !== account.expected_email.toLowerCase()) {
    throw new MultiCodexError(`logged in as ${JSON.stringify(actual)}, expected ${JSON.stringify(account.expected_email)}`);
  }
  return actual;
}

export async function hasUsableSession(account: Account, readAccount = async (home: string): Promise<Json> => {
  const client = new AppServer(home);
  try {
    await client.initialize();
    return await client.request("account/read", { refreshToken: false });
  } finally { await client.close(); }
}): Promise<boolean> {
  let result: Json;
  try { result = await readAccount(account.home); }
  catch { return false; }
  const actual = result.account?.email;
  if (!actual) return false;
  if (account.expected_email && actual.toLowerCase() !== account.expected_email.toLowerCase()) {
    throw new MultiCodexError(`logged in as ${JSON.stringify(actual)}, expected ${JSON.stringify(account.expected_email)}`);
  }
  return true;
}

export function findAccount(config: Config, identifier: string): Account {
  const clean = identifier.replaceAll("\\@", "@");
  const account = clean.includes("@")
    ? config.accounts.find(item => item.expected_email?.toLowerCase() === validateEmail(clean).toLowerCase())
    : config.accounts.find(item => item.name === validateName(clean));
  if (!account) throw new MultiCodexError(`unknown account: ${clean}`);
  return account;
}

async function copyAuth(sourceHome: string, destinationHome: string): Promise<void> {
  if (resolve(sourceHome) === resolve(destinationHome)) throw new MultiCodexError("authentication source and target paths must be different");
  await readAuth(sourceHome);
  await mkdir(destinationHome, { recursive: true });
  const temporary = join(destinationHome, `.auth.json.${randomUUID()}`);
  await copyFile(authPath(sourceHome), temporary, constants.COPYFILE_EXCL);
  if (platform() !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, authPath(destinationHome));
}

function findExecutable(name: string): string {
  const result = Bun.spawnSync(platform() === "win32" ? ["where.exe", name] : ["sh", "-c", `command -v ${name}`], { stdout: "pipe", stderr: "ignore" });
  const path = result.stdout.toString().trim().split(/\r?\n/)[0];
  if (!path) throw new MultiCodexError(`${name} executable was not found in PATH`);
  return path;
}

async function run(command: string[], options: { env?: Record<string, string | undefined>; stdout?: "inherit" | "pipe"; stderr?: "inherit" | "pipe" } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(command, { env: options.env ?? Bun.env, stdin: "inherit", stdout: options.stdout ?? "inherit", stderr: options.stderr ?? "inherit" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    process.stdout instanceof ReadableStream ? new Response(process.stdout).text() : "",
    process.stderr instanceof ReadableStream ? new Response(process.stderr).text() : "",
  ]);
  return { code, stdout, stderr };
}

class AppServer {
  private process: ReturnType<typeof Bun.spawn>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private id = 1;
  constructor(home: string) {
    const codex = findExecutable("codex");
    this.process = Bun.spawn([codex, "app-server", "--listen", "stdio://"], { env: { ...Bun.env, CODEX_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.reader = (this.process.stdout as ReadableStream<Uint8Array>).getReader();
  }
  private async line(): Promise<string> {
    while (!this.buffer.includes("\n")) {
      const { value, done } = await this.reader.read();
      if (done) throw new MultiCodexError("app-server exited unexpectedly");
      this.buffer += Buffer.from(value).toString("utf8");
    }
    const index = this.buffer.indexOf("\n");
    const line = this.buffer.slice(0, index);
    this.buffer = this.buffer.slice(index + 1);
    return line;
  }
  async request(method: string, params: unknown): Promise<Json> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.requestWithoutTimeout(method, params),
        new Promise<Json>((_, reject) => { timeout = setTimeout(() => reject(new MultiCodexError(`${method} timed out after 30 seconds`)), 30_000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  private async requestWithoutTimeout(method: string, params: unknown): Promise<Json> {
    const id = this.id++;
    (this.process.stdin as FileSink).write(`${JSON.stringify({ id, method, params })}\n`);
    await (this.process.stdin as FileSink).flush();
    while (true) {
      let message: Json;
      try { message = JSON.parse(await this.line()); } catch { continue; }
      if (message.id !== id) continue;
      if (message.error) throw new MultiCodexError(`${method} failed: ${JSON.stringify(message.error)}`);
      return message.result;
    }
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "multicodex", title: "MultiCodex", version: "2" }, capabilities: { experimentalApi: true } });
  }
  async close(): Promise<void> {
    this.process.kill();
    await Promise.race([this.process.exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
  }
}

export function parseUsage(accountResult: Json, limits: Json): Json {
  const account = accountResult.account;
  if (!account) throw new MultiCodexError("profile is not logged in");
  const snapshot = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
  if (!snapshot) throw new MultiCodexError("rate-limit bucket 'codex' is unavailable");
  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  const weekly = windows.find((window: Json) => window.windowDurationMins === WEEKLY_WINDOW_MINUTES) ?? (account.planType === "plus" ? snapshot.secondary : snapshot.primary);
  if (typeof weekly?.usedPercent !== "number") throw new MultiCodexError("weekly usage window is unavailable");
  const five = account.planType === "plus" ? windows.find((window: Json) => window.windowDurationMins === 300) : null;
  const bankedResets = availableBankedResets(limits.rateLimitResetCredits);
  return {
    email: account.email,
    plan_type: account.planType,
    limits: {
      weekly: { remaining_percent: 100 - weekly.usedPercent, resets_at: weekly.resetsAt },
      five_hour: five ? { remaining_percent: 100 - five.usedPercent, resets_at: five.resetsAt } : null,
    },
    available_banked_resets: bankedResets,
    credits_balance: typeof snapshot.credits?.balance === "string" ? snapshot.credits.balance : null,
    credits_unlimited: snapshot.credits?.unlimited === true,
  };
}

export function availableBankedResets(resetCredits: Json | null | undefined): Json[] {
  const count = Number.isInteger(resetCredits?.availableCount) && resetCredits.availableCount > 0 ? resetCredits.availableCount : 0;
  const details = Array.isArray(resetCredits?.credits)
    ? resetCredits.credits.filter((credit: Json) => credit?.status === "available").slice(0, count)
    : [];
  const resets = details.map((credit: Json) => ({ expires_at: typeof credit.expiresAt === "number" && Number.isFinite(credit.expiresAt) ? credit.expiresAt : null }));
  while (resets.length < count) resets.push({ expires_at: null });
  return resets;
}

function tacLevel(models: Json[]): string | null {
  let blue = false, specialty = false;
  for (const model of models) {
    const text = [model.displayName, model.model, model.id].join(" ").toLowerCase();
    if (text.includes("daybreak red") || text.includes("daybreak-red") || text.includes("gpt-5.6-cyber")) return "Daybreak Red";
    if (text.includes("daybreak blue") || text.includes("daybreak-blue")) blue = true;
    else if (model.modelSpecialty === "cyber") specialty = true;
  }
  return blue ? "Daybreak Blue" : specialty ? "Approved (level unknown)" : null;
}

async function readTac(client: AppServer): Promise<string | null> {
  const models: Json[] = [];
  let cursor: string | null = null;
  do {
    const result = await client.request("model/list", { cursor, includeHidden: false, limit: 100 });
    if (Array.isArray(result.data)) models.push(...result.data);
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
  } while (cursor);
  return tacLevel(models);
}

async function readSubscription(home: string): Promise<Json | null> {
  if (typeof Bun.WebView !== "function") throw new MultiCodexError("billing details require Bun 1.4 or newer");
  const auth = await readAuth(home);
  const token = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  const expiresAt = decodeJwt(token)?.exp;
  if (typeof token !== "string" || typeof accountId !== "string" || typeof expiresAt !== "number") return null;
  const expiresIn = Math.max(1, Math.floor(expiresAt - Date.now() / 1000));
  await using view = new Bun.WebView({ dataStore: "ephemeral" });
  await view.navigate("https://chatgpt.com/api/auth/session");
  const linkResult = await view.evaluate(`fetch('/api/auth/link-session',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-i-am-a-browser':'true'},body:${JSON.stringify(JSON.stringify({ auth_token: token, expires_in: expiresIn }))}}).then(r=>r.status)`);
  if (linkResult !== 200) throw new MultiCodexError(`billing session returned HTTP ${linkResult}`);
  const response = await view.evaluate(`fetch('/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}',{headers:{'Authorization':'Bearer '+${JSON.stringify(token)},'ChatGPT-Account-Id':${JSON.stringify(accountId)}}}).then(async r=>({status:r.status,text:await r.text()}))`);
  if (response.status !== 200) throw new MultiCodexError(`billing details returned HTTP ${response.status}`);
  const data = JSON.parse(response.text);
  const accountResponse = await view.evaluate(`fetch('/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min='+new Date().getTimezoneOffset(),{headers:{'Authorization':'Bearer '+${JSON.stringify(token)},'ChatGPT-Account-Id':${JSON.stringify(accountId)}}}).then(async r=>({status:r.status,text:await r.text()}))`);
  const accountData = accountResponse.status === 200 ? JSON.parse(accountResponse.text) : null;
  const scheduledPlanChange = accountData?.accounts?.[accountId]?.entitlement?.scheduled_plan_change ?? null;
  return subscriptionSummary(data, scheduledPlanChange);
}

async function queryAccount(account: Account): Promise<Json> {
  await syncCliProxyAuth(account);
  const client = new AppServer(account.home);
  try {
    await client.initialize();
    const identity = await client.request("account/read", { refreshToken: false });
    const limits = await client.request("account/rateLimits/read", null);
    const tac = await readTac(client);
    const usage = parseUsage(identity, limits);
    if (account.expected_email && usage.email?.toLowerCase() !== account.expected_email.toLowerCase()) throw new MultiCodexError(`logged in as ${usage.email}, expected ${account.expected_email}`);
    const capacity = CAPACITIES[usage.plan_type];
    if (!capacity) throw new MultiCodexError(`server plan ${JSON.stringify(usage.plan_type)} has no automatic capacity mapping`);
    let subscription = null, subscription_error = null;
    try { subscription = await readSubscription(account.home); } catch (error) { subscription_error = String(error instanceof Error ? error.message : error); }
    return { ...usage, name: account.name, capacity, tier: usage.plan_type, tac_level: tac, subscription, subscription_error };
  } finally { await client.close(); await syncCliProxyAuth(account); }
}

function wakeWindow(limit: Json, label: string): WakeWindow {
  const resetsAt = limit?.resets_at;
  const remainingPercent = limit?.remaining_percent;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) throw new MultiCodexError(`${label} reset time is unavailable`);
  if (typeof remainingPercent !== "number" || !Number.isFinite(remainingPercent)) throw new MultiCodexError(`${label} usage is unavailable`);
  return { resets_at: resetsAt, used_percent: 100 - remainingPercent };
}

async function queryWakeWindows(account: Account): Promise<WakeObservation> {
  await syncCliProxyAuth(account);
  const client = new AppServer(account.home);
  try {
    await client.initialize();
    const identity = await client.request("account/read", { refreshToken: false });
    const limits = await client.request("account/rateLimits/read", null);
    const usage = parseUsage(identity, limits);
    if (account.expected_email && usage.email?.toLowerCase() !== account.expected_email.toLowerCase()) {
      throw new MultiCodexError(`logged in as ${usage.email}, expected ${account.expected_email}`);
    }
    return {
      email: usage.email ?? null,
      weekly: wakeWindow(usage.limits.weekly, "weekly"),
      five_hour: usage.limits.five_hour ? wakeWindow(usage.limits.five_hour, "5-hour") : null,
    };
  } finally { await client.close(); await syncCliProxyAuth(account); }
}

const number = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
export const formatDate = (seconds: unknown) => typeof seconds === "number" && Number.isFinite(seconds) ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(seconds * 1000)) : "unknown";
export const timeUntil = (seconds: unknown, now = Date.now() / 1000) => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "unknown";
  let minutes = Math.ceil((seconds - now) / 60); if (minutes <= 0) return "now";
  const days = Math.floor(minutes / 1440); minutes %= 1440; const hours = Math.floor(minutes / 60); minutes %= 60;
  if (days) return hours ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours) return minutes ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  return `in ${minutes}m`;
};

async function login(account: Account): Promise<number> {
  console.log(`Sign in: ${account.name} (${account.expected_email})`);
  await mkdir(account.home, { recursive: true });
  console.log("Choose how to sign in:\n  1. Browser (recommended)\n  2. Device code (must be enabled in ChatGPT settings)");
  const choice = prompt("Choice [1]: ")?.trim() ?? "";
  if (!["", "1", "2"].includes(choice)) throw new MultiCodexError("enter 1 or 2");
  const command = [findExecutable("codex"), "login", ...(choice === "2" ? ["--device-auth"] : [])];
  return (await run(command, { env: { ...Bun.env, CODEX_HOME: account.home } })).code;
}

async function add(base: string, args: string[]): Promise<number> {
  const email = validateEmail(args[0] ?? "");
  const nameIndex = args.indexOf("--name");
  const requestedName = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(`Adding account: ${email}`);
  const config = await loadConfig(base, true);
  let account = config.accounts.find(item => item.expected_email?.toLowerCase() === email.toLowerCase());
  if (account && requestedName && account.name !== requestedName) throw new MultiCodexError(`${email} already exists as '${account.name}'; omit --name to reconnect`);
  if (!account) {
    const name = requestedName ? validateName(requestedName) : automaticName(email, config.accounts);
    if (config.accounts.some(item => item.name === name)) throw new MultiCodexError(`account already exists: ${name}`);
    account = { name, home: join(base, "homes", name), expected_email: email };
    config.accounts.push(account);
    await saveConfig(base, config);
  }
  if (exists(authPath(account.home)) && await hasUsableSession(account)) {
    console.log("Using the existing sign-in from this account's CODEX_HOME.");
    return 0;
  }
  const mainHome = defaultMainHome();
  const mainAccount = { ...account, home: mainHome };
  if (exists(authPath(mainHome)) && (await authEmail(mainHome))?.toLowerCase() === email.toLowerCase() && await hasUsableSession(mainAccount)) {
    const answer = (prompt("This account is already signed in as the main Codex account. Copy its sign-in? [Y/n]: ") ?? "").trim().toLowerCase();
    if (!["n", "no"].includes(answer)) { await copyAuth(mainHome, account.home); console.log("Sign-in copied from the main Codex account."); return 0; }
  }
  return login(account);
}

async function renameAccount(base: string, args: string[]): Promise<number> {
  const config = await loadConfig(base); const account = findAccount(config, args[0] ?? ""); const next = validateName(args[1] ?? ""); const old = account.name;
  if (old === next) { console.log(`Account name unchanged: ${next}`); return 0; }
  if (config.accounts.some(item => item.name === next)) throw new MultiCodexError(`account already exists: ${next}`);
  const managed = resolve(base, "homes");
  if (dirname(resolve(account.home)) === managed) { const nextHome = join(managed, next); if (exists(nextHome)) throw new MultiCodexError(`profile home already exists: ${nextHome}`); if (exists(account.home)) await rename(account.home, nextHome); account.home = nextHome; }
  account.name = next; if (config.active_account === old) config.active_account = next; await saveConfig(base, config);
  console.log(`Account renamed: ${old} to ${next}`); return 0;
}

async function removeAccount(base: string, args: string[]): Promise<number> {
  const config = await loadConfig(base); const account = findAccount(config, args[0] ?? ""); const home = resolve(account.home); const managed = resolve(base, "homes");
  console.log(`Removing account: ${args[0]}`);
  if (dirname(home) !== managed) throw new MultiCodexError(`refusing to delete non-managed profile home ${home}; remove it manually`);
  if (exists(home) && (await lstat(home)).isSymbolicLink()) throw new MultiCodexError(`refusing to delete symlinked profile home: ${home}`);
  config.accounts = config.accounts.filter(item => item !== account); if (config.active_account === account.name) delete config.active_account; await saveConfig(base, config); if (exists(home)) await rm(home, { recursive: true });
  console.log(`Removed account: ${account.name}${account.expected_email ? ` (${account.expected_email})` : ""}\nProfile data: deleted`); return 0;
}

async function useAccount(base: string, args: string[]): Promise<number> {
  const config = await loadConfig(base); const account = findAccount(config, args[0] ?? ""); const main = defaultMainHome();
  console.log(`Switching account: ${account.name}`); await verifyIdentity(account);
  if (config.active_account && config.active_account !== account.name) { const current = findAccount(config, config.active_account); if (exists(authPath(main))) await copyAuth(main, current.home); }
  await copyAuth(account.home, main); config.active_account = account.name; await saveConfig(base, config);
  console.log(`Active account: ${account.name}${account.expected_email ? ` (${account.expected_email})` : ""}\nRestart any open Codex app or terminal to use this account.`); return 0;
}

async function current(base: string, format: OutputFormat): Promise<number> {
  const config = await loadConfig(base);
  if (!config.active_account) {
    console.log(format === "json" ? JSON.stringify({ account: null, authentication: "not_configured" }, null, 2) : "No active account. Run 'multicodex use NAME' to choose one.");
    return 0;
  }
  const account = findAccount(config, config.active_account); const email = await verifyIdentity(account, defaultMainHome());
  if (format === "json") console.log(JSON.stringify({ account: { name: account.name, email }, authentication: "verified" }, null, 2));
  else console.log(`Current account: ${account.name}${email ? ` (${email})` : ""}\nAuthentication: verified`);
  return 0;
}

async function listAccounts(base: string, format: OutputFormat): Promise<number> {
  const config = await loadConfig(base);
  if (format === "json") {
    console.log(JSON.stringify({
      active_account: config.active_account ?? null,
      accounts: config.accounts.map(account => ({ name: account.name, email: account.expected_email ?? null, active: config.active_account === account.name })),
    }, null, 2));
    return 0;
  }
  console.log(`Accounts: ${config.accounts.length}`);
  for (const account of config.accounts) console.log(`${account.name}${account.expected_email ? ` (${account.expected_email})` : ""}${config.active_account === account.name ? ": active" : ""}`);
  return 0;
}

async function linkEntry(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  if (platform() === "win32") info.isDirectory() ? await symlink(source, destination, "junction") : await link(source, destination);
  else await symlink(source, destination, info.isDirectory() ? "dir" : "file");
}

async function execAccount(base: string, args: string[]): Promise<number> {
  const config = await loadConfig(base); const account = findAccount(config, args.shift() ?? ""); await syncCliProxyAuth(account); await verifyIdentity(account);
  const main = defaultMainHome(); const overlay = await mkdtemp(join(dirname(main), ".multicodex-exec-"));
  const original = await readFile(authPath(account.home));
  try {
    for (const entry of await readdir(main)) if (entry !== "auth.json" && !entry.startsWith("auth.json.") && !entry.startsWith(".auth.json.")) await linkEntry(join(main, entry), join(overlay, entry));
    await copyAuth(account.home, overlay);
    const code = (await run([findExecutable("codex"), ...args.filter((value, index) => !(index === 0 && value === "--"))], { env: { ...Bun.env, CODEX_HOME: overlay } })).code;
    const refreshed = await readFile(authPath(overlay)); const current = await readFile(authPath(account.home));
    if (!refreshed.equals(original) && current.equals(original)) await copyAuth(overlay, account.home);
    await syncCliProxyAuth(account);
    return code;
  } finally { await rm(overlay, { recursive: true, force: true }); }
}

function printReset(label: string, timestamp: unknown): void {
  const date = formatDate(timestamp); console.log(date === "unknown" ? `  ${label}: unknown` : `  ${label}: ${timeUntil(timestamp)}; ${date}`);
}

function planName(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return PLAN_NAMES[value.toLowerCase()] ?? value;
}

function scheduledPlan(subscription: Json): string | null {
  const change = subscription.scheduled_plan_change;
  if (typeof change === "string") return change;
  if (!change || typeof change !== "object") return null;
  for (const key of ["plan", "plan_type", "target_plan", "new_plan", "subscription_plan"]) {
    if (typeof change[key] === "string") return change[key];
  }
  return null;
}

function canonicalPlan(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.toLowerCase();
  if (["free", "chatgptfreeplan"].includes(normalized)) return "free";
  if (["plus", "chatgptplusplan"].includes(normalized)) return "plus";
  if (["prolite", "chatgptprolite"].includes(normalized)) return "prolite";
  if (["pro", "chatgptpro"].includes(normalized)) return "pro";
  return value;
}

export function subscriptionSummary(subscription: Json, scheduledPlanChange: unknown = null): Json {
  const scheduled = canonicalPlan(scheduledPlan({ scheduled_plan_change: scheduledPlanChange }));
  const nextPlan = scheduled
    ?? (subscription.will_renew === true ? canonicalPlan(subscription.plan_type) : null)
    ?? (subscription.cancellation_outcome === "deactivate" ? "free" : null);
  return {
    billing_cycle_ends_at: subscription.active_until ?? null,
    will_renew: subscription.will_renew === true,
    plan_type: subscription.plan_type ?? null,
    next_plan: nextPlan,
  };
}

export function billingOutcome(subscription: Json): string {
  const target = planName(subscription.next_plan);
  if (!target) return "unknown";
  const renewsSamePlan = subscription.will_renew === true && canonicalPlan(subscription.plan_type) === canonicalPlan(subscription.next_plan);
  return renewsSamePlan ? `renews as ${target}` : `will switch to ${target}`;
}

export function buildUsageReport(accounts: Account[], settled: PromiseSettledResult<Json>[]): Json {
  const rows = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const summary: Json = {
    overall_weekly_remaining_percent: null,
    remaining_weighted_units: null,
    total_weighted_units: null,
  };
  if (rows.length) {
    const total = rows.reduce((sum, row) => sum + row.capacity, 0);
    const left = rows.reduce((sum, row) => sum + row.capacity * Math.max(0, Math.min(1, row.limits.weekly.remaining_percent / 100)), 0);
    summary.overall_weekly_remaining_percent = Number((left / total * 100).toFixed(1));
    summary.remaining_weighted_units = left;
    summary.total_weighted_units = total;
  }
  return {
    summary,
    accounts: settled.map((result, index) => result.status === "fulfilled"
      ? { ...result.value, error: null }
      : {
        name: accounts[index].name,
        email: accounts[index].expected_email ?? null,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }),
  };
}

async function usage(base: string, args: string[], format: OutputFormat): Promise<number> {
  const config = await loadConfig(base); const accounts = args[0] ? [findAccount(config, args[0])] : config.accounts;
  if (!accounts.length) throw new MultiCodexError("no accounts configured; use 'add' first");
  if (format === "text") console.log(`Reading usage for ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}...`);
  const settled = await Promise.allSettled(accounts.map(queryAccount)); const rows = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (format === "json") {
    console.log(JSON.stringify(buildUsageReport(accounts, settled), null, 2));
    return settled.some(result => result.status === "rejected") ? 1 : 0;
  }
  console.log("\nUsage summary");
  if (rows.length) { const total = rows.reduce((sum, row) => sum + row.capacity, 0); const left = rows.reduce((sum, row) => sum + row.capacity * Math.max(0, Math.min(1, row.limits.weekly.remaining_percent / 100)), 0); const coverage = rows.length !== accounts.length ? `${rows.length} of ${accounts.length} accounts` : `${rows.length} ${rows.length === 1 ? "account" : "accounts"}`; console.log(`Overall weekly: ${(left / total * 100).toFixed(1)}% left; ${number(left)} of ${number(total)} weighted units across ${coverage}`); }
  else console.log("Overall weekly: unavailable");
  console.log();
  for (let index = 0; index < accounts.length; index++) {
    const result = settled[index], account = accounts[index];
    if (result.status === "rejected") { console.log(`${account.name} (${account.expected_email ?? "email unknown"}): Usage unavailable\n  Reason: ${result.reason instanceof Error ? result.reason.message : result.reason}\n`); continue; }
    const row = result.value; console.log(`${row.name} (${row.email ?? "unknown email"}): ${TIERS[row.tier] ?? row.tier}${row.tac_level ? `, ${row.tac_level}` : ""}`);
    if (row.limits.five_hour) { console.log(`  5-hour usage: ${number(row.limits.five_hour.remaining_percent)}% left`); printReset("5-hour reset", row.limits.five_hour.resets_at); }
    console.log(`  Weekly usage: ${number(row.limits.weekly.remaining_percent)}% left`); printReset("Weekly reset", row.limits.weekly.resets_at);
    if (row.available_banked_resets.length) {
      console.log(`  Banked resets available: ${row.available_banked_resets.length}`);
      row.available_banked_resets.forEach((reset: Json, resetIndex: number) => printReset(`Banked reset ${resetIndex + 1} expires`, reset.expires_at));
    }
    if (row.credits_unlimited) console.log("  Credits: unlimited"); else if (row.credits_balance !== null) console.log(`  Credits: ${row.credits_balance}`);
    if (row.subscription?.billing_cycle_ends_at) { const end = Date.parse(row.subscription.billing_cycle_ends_at) / 1000; console.log(`  Monthly billing cycle: ${timeUntil(end)}; ${formatDate(end)}`); console.log(`  After billing cycle: ${billingOutcome(row.subscription)}`); }
    else console.log(`  Monthly billing cycle: unavailable${row.subscription_error ? ` (${row.subscription_error})` : ""}`);
    console.log();
  }
  return settled.some(result => result.status === "rejected") ? 1 : 0;
}

async function wakeOne(account: Account): Promise<{ name: string; code: number; detail: string }> {
  await syncCliProxyAuth(account);
  const challenge = randomBytes(32).toString("hex"); const directory = await mkdtemp(join(tmpdir(), "multicodex-wake-")); const output = join(directory, "last-message.txt");
  try {
    const prompt = `Reply with exactly the following challenge string and nothing else. Do not use Markdown and do not call tools:\n${challenge}`;
    const result = await run([findExecutable("codex"), ...wakeCodexArgs(output, prompt)], { env: { ...Bun.env, CODEX_HOME: account.home }, stdout: "pipe", stderr: "pipe" });
    if (result.code) return { name: account.name, code: result.code, detail: result.stderr.trim() || "Codex request failed" };
    const response = (await readFile(output, "utf8")).trimEnd(); const matches = response.length === challenge.length && timingSafeEqual(Buffer.from(response), Buffer.from(challenge));
    return { name: account.name, code: matches ? 0 : 1, detail: matches ? "challenge verified" : "Codex response did not match the random challenge" };
  } finally { await rm(directory, { recursive: true, force: true }); await syncCliProxyAuth(account); }
}

export function wakeCodexArgs(output: string, prompt: string): string[] {
  return [
    "exec",
    "--model", WAKE_MODEL,
    "--config", `model_reasoning_effort=${JSON.stringify(WAKE_REASONING_EFFORT)}`,
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--output-last-message", output,
    prompt,
  ];
}

async function wake(base: string, format: OutputFormat): Promise<number> {
  const accounts = (await loadConfig(base)).accounts; if (!accounts.length) throw new MultiCodexError("no accounts configured; use 'add' first");
  if (format === "text") console.log(`Sending requests: ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`);
  const results = await Promise.all(accounts.map(wakeOne));
  if (format === "text") {
    for (const result of results) console.log(result.code ? `${result.name}: Failed: ${result.detail} (exit code ${result.code})` : `${result.name}: Sent and verified`);
    console.log(`Wake complete: ${results.filter(result => !result.code).length} of ${results.length}.\n\nUsage resets`);
  }
  const usages = await Promise.allSettled(accounts.map(queryAccount));
  if (format === "json") {
    console.log(JSON.stringify({
      requests: { successful: results.filter(result => !result.code).length, total: results.length, accounts: results },
      usage: buildUsageReport(accounts, usages),
    }, null, 2));
  } else {
    usages.forEach((result, index) => { if (result.status === "rejected") console.log(`${accounts[index].name}: unavailable`); else { console.log(`${accounts[index].name}:`); if (result.value.limits.five_hour) printReset("5-hour", result.value.limits.five_hour.resets_at); printReset("Weekly", result.value.limits.weekly.resets_at); } });
  }
  return results.some(result => result.code) || usages.some(result => result.status === "rejected") ? 1 : 0;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function launchDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) throw new MultiCodexError("autowake requires a user launchd session");
  return `gui/${uid}`;
}

export function stableAutoWakeExecutable(invoked: string, pathExecutable: string): string {
  return invoked.includes("/Cellar/multicodex/") ? pathExecutable : invoked;
}

function autoWakePlist(base: string): string {
  const invoked = resolve(process.argv[1]);
  const executable = invoked.includes("/Cellar/multicodex/")
    ? stableAutoWakeExecutable(invoked, findExecutable("multicodex"))
    : invoked;
  const bun = findExecutable("bun");
  const values = [bun, executable, "--data-dir", base, "--format", "json", "autowake", "run"];
  const argumentsXml = values.map(value => `      <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AUTO_WAKE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${AUTO_WAKE_INTERVAL_SECONDS}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
  </dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<{ code: number; detail: string }> {
  const result = await run(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.code, detail: result.stderr.trim() || result.stdout.trim() };
}

async function installAutoWake(base: string, format: OutputFormat): Promise<number> {
  if (platform() !== "darwin") throw new MultiCodexError("background autowake installation is currently supported only on macOS; run 'autowake run' from your scheduler on other platforms");
  await loadConfig(base);
  const path = autoWakePlistPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, autoWakePlist(base), { mode: 0o600 });
  await rename(temporary, path);
  const domain = launchDomain();
  await launchctl(["bootout", domain, path]);
  const loaded = await launchctl(["bootstrap", domain, path]);
  if (loaded.code) throw new MultiCodexError(`cannot load auto-wake LaunchAgent: ${loaded.detail || `exit code ${loaded.code}`}`);
  const result = { installed: true, label: AUTO_WAKE_LABEL, interval_seconds: AUTO_WAKE_INTERVAL_SECONDS, plist: path, state: autoWakeStatePath(base) };
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(`Auto-wake installed.\nChecks: every ${AUTO_WAKE_INTERVAL_SECONDS / 60} minutes and after login\nLaunchAgent: ${path}\nState: ${autoWakeStatePath(base)}`);
  return 0;
}

async function uninstallAutoWake(base: string, format: OutputFormat): Promise<number> {
  if (platform() !== "darwin") throw new MultiCodexError("background auto-wake installation is currently supported only on macOS");
  const path = autoWakePlistPath();
  if (exists(path)) {
    await launchctl(["bootout", launchDomain(), path]);
    await rm(path, { force: true });
  }
  const result = { installed: false, label: AUTO_WAKE_LABEL, state_preserved: exists(autoWakeStatePath(base)) };
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(`Auto-wake uninstalled.${result.state_preserved ? ` State preserved at ${autoWakeStatePath(base)}.` : ""}`);
  return 0;
}

async function autoWakeStatus(base: string, format: OutputFormat): Promise<number> {
  if (platform() !== "darwin") throw new MultiCodexError("background auto-wake status is currently supported only on macOS");
  const path = autoWakePlistPath();
  const loaded = exists(path) && (await launchctl(["print", `${launchDomain()}/${AUTO_WAKE_LABEL}`])).code === 0;
  const state = await loadAutoWakeState(base);
  const result = { installed: exists(path), loaded, interval_seconds: AUTO_WAKE_INTERVAL_SECONDS, plist: path, state };
  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Auto-wake: ${loaded ? "running" : exists(path) ? "installed but not loaded" : "not installed"}`);
    for (const [name, account] of Object.entries(state.accounts)) {
      const resets = [
        account.next_reset_at ? `weekly ${timeUntil(account.next_reset_at)}; ${formatDate(account.next_reset_at)}` : null,
        account.five_hour_next_reset_at ? `5-hour ${timeUntil(account.five_hour_next_reset_at)}; ${formatDate(account.five_hour_next_reset_at)}` : null,
      ].filter(Boolean).join(", ");
      const detail = account.last_error ? `error: ${account.last_error}` : resets || "reset not observed yet";
      console.log(`  ${name}: ${detail}`);
    }
  }
  return loaded || !exists(path) ? 0 : 1;
}

export function autoWakeDecision(previous: AutoWakeAccountState, observed: { resets_at: number; used_percent: number }, now: number): { due: boolean; unexpected_reset: boolean; wake_for_reset: number; tracked_reset: number } {
  const trackedReset = typeof previous.next_reset_at === "number" ? previous.next_reset_at : observed.resets_at;
  const scheduledReset = trackedReset <= now;
  const resetMovedForward = typeof previous.next_reset_at === "number" && observed.resets_at > previous.next_reset_at + 5 * 60;
  const usageDroppedToZero = typeof previous.used_percent === "number" && previous.used_percent > 0 && observed.used_percent === 0;
  const unexpectedReset = !scheduledReset && observed.used_percent === 0 && (resetMovedForward || usageDroppedToZero);
  const wakeForReset = unexpectedReset ? observed.resets_at : trackedReset;
  return {
    due: observed.used_percent === 0 && (scheduledReset || unexpectedReset) && previous.last_wake_for_reset_at !== wakeForReset,
    unexpected_reset: unexpectedReset,
    wake_for_reset: wakeForReset,
    tracked_reset: trackedReset,
  };
}

function fiveHourState(previous: AutoWakeAccountState): AutoWakeAccountState {
  return {
    next_reset_at: previous.five_hour_next_reset_at,
    used_percent: previous.five_hour_used_percent,
    last_wake_for_reset_at: previous.last_wake_for_five_hour_reset_at,
  };
}

export function autoWakeDecisions(previous: AutoWakeAccountState, observed: WakeObservation, now: number) {
  const weekly = autoWakeDecision(previous, observed.weekly, now);
  let fiveHour = observed.five_hour ? autoWakeDecision(fiveHourState(previous), observed.five_hour, now) : null;
  if (fiveHour?.due && observed.weekly.used_percent >= 100) fiveHour = { ...fiveHour, due: false };
  return { weekly, five_hour: fiveHour };
}

function confirmedAutoWakeDecisions(previous: AutoWakeAccountState, first: WakeObservation, second: WakeObservation, now: number) {
  const decisions = autoWakeDecisions(previous, second, now);
  return {
    weekly: {
      ...decisions.weekly,
      due: first.weekly.used_percent === 0 && second.weekly.used_percent === 0 && decisions.weekly.due,
    },
    five_hour: decisions.five_hour ? {
      ...decisions.five_hour,
      due: first.five_hour?.used_percent === 0 && second.five_hour?.used_percent === 0 && decisions.five_hour.due,
    } : null,
  };
}

async function runAutoWake(base: string, format: OutputFormat, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const config = await loadConfig(base);
  if (!config.accounts.length) throw new MultiCodexError("no accounts configured; use 'add' first");
  const state = await loadAutoWakeState(base);
  const results: Json[] = [];
  for (const account of config.accounts) {
    const previous = state.accounts[account.name] ?? {};
    try {
      const first = await queryWakeWindows(account);
      let observed = first;
      let decisions = autoWakeDecisions(previous, observed, now);
      if (decisions.weekly.due || decisions.five_hour?.due) {
        observed = await queryWakeWindows(account);
        decisions = confirmedAutoWakeDecisions(previous, first, observed, now);
      }
      const weeklyDue = decisions.weekly.due;
      const fiveHourDue = decisions.five_hour?.due === true;
      if (!weeklyDue && !fiveHourDue) {
        state.accounts[account.name] = {
          ...previous,
          next_reset_at: observed.weekly.resets_at,
          used_percent: observed.weekly.used_percent,
          five_hour_next_reset_at: observed.five_hour?.resets_at,
          five_hour_used_percent: observed.five_hour?.used_percent,
          last_checked_at: now,
          last_error: undefined,
        };
        const weeklyActive = decisions.weekly.tracked_reset <= now && observed.weekly.used_percent > 0;
        const fiveHourActive = decisions.five_hour && decisions.five_hour.tracked_reset <= now && (observed.five_hour?.used_percent ?? 0) > 0;
        const action = weeklyActive || fiveHourActive ? "already_active" : "waiting";
        results.push({ name: account.name, action, weekly: observed.weekly, five_hour: observed.five_hour });
        await saveAutoWakeState(base, state);
        continue;
      }
      const wakeResult = await wakeOne(account);
      if (wakeResult.code) throw new MultiCodexError(wakeResult.detail);
      let refreshed = observed;
      let refreshError: string | undefined;
      try { refreshed = await queryWakeWindows(account); }
      catch (error) { refreshError = error instanceof Error ? error.message : String(error); }
      state.accounts[account.name] = {
        ...previous,
        next_reset_at: refreshed.weekly.resets_at,
        used_percent: refreshed.weekly.used_percent,
        five_hour_next_reset_at: refreshed.five_hour?.resets_at,
        five_hour_used_percent: refreshed.five_hour?.used_percent,
        last_wake_at: now,
        last_wake_for_reset_at: weeklyDue ? decisions.weekly.wake_for_reset : previous.last_wake_for_reset_at,
        last_wake_for_five_hour_reset_at: fiveHourDue ? decisions.five_hour!.wake_for_reset : previous.last_wake_for_five_hour_reset_at,
        last_checked_at: now,
        last_error: refreshError,
      };
      const wokenWindows = [
        weeklyDue ? { window: "weekly", reason: decisions.weekly.unexpected_reset ? "unexpected_reset" : "scheduled_reset", reset_at: decisions.weekly.wake_for_reset } : null,
        fiveHourDue ? { window: "five_hour", reason: decisions.five_hour!.unexpected_reset ? "unexpected_reset" : "scheduled_reset", reset_at: decisions.five_hour!.wake_for_reset } : null,
      ].filter(Boolean);
      results.push({ name: account.name, action: "woken", windows: wokenWindows, weekly: refreshed.weekly, five_hour: refreshed.five_hour, warning: refreshError ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.accounts[account.name] = { ...previous, last_checked_at: now, last_error: message };
      results.push({ name: account.name, action: "error", error: message });
    }
    await saveAutoWakeState(base, state);
  }
  await saveAutoWakeState(base, state);
  const output = { checked_at: now, accounts: results };
  if (format === "json") console.log(JSON.stringify(output, null, 2));
  else for (const result of results) {
    const resets = [
      result.weekly?.resets_at ? `weekly ${timeUntil(result.weekly.resets_at)}` : null,
      result.five_hour?.resets_at ? `5-hour ${timeUntil(result.five_hour.resets_at)}` : null,
    ].filter(Boolean).join(", ");
    console.log(`${result.name}: ${result.action}${result.error ? `: ${result.error}` : resets ? `; ${resets}` : ""}`);
  }
  return results.some(result => result.action === "error") ? 1 : 0;
}

async function autoWake(base: string, args: string[], format: OutputFormat): Promise<number> {
  const action = args[0] ?? "status";
  if (args.length > 1) throw new MultiCodexError(`unexpected autowake argument: ${args[1]}`);
  switch (action) {
    case "install": return installAutoWake(base, format);
    case "uninstall": return uninstallAutoWake(base, format);
    case "status": return autoWakeStatus(base, format);
    case "run": return runAutoWake(base, format);
    default: throw new MultiCodexError(`unknown autowake action: ${action}`);
  }
}

export function parse(argv: string[]): { base: string; format: OutputFormat; command?: string; args: string[] } {
  let base = defaultBase(); let format: OutputFormat = "text"; const args = [...argv];
  const dataIndex = args.indexOf("--data-dir"); if (dataIndex >= 0) { if (!args[dataIndex + 1]) throw new MultiCodexError("--data-dir requires PATH"); base = resolve(expandHome(args[dataIndex + 1])); args.splice(dataIndex, 2); }
  let optionBoundary = outputOptionBoundary(args);
  for (let index = 0; index < optionBoundary;) {
    const value = args[index];
    if (value === "-J") { format = "json"; args.splice(index, 1); optionBoundary--; continue; }
    if (value.startsWith("--format=")) { format = parseOutputFormat(value.slice("--format=".length)); args.splice(index, 1); optionBoundary--; continue; }
    if (value === "--format") {
      if (index + 1 >= optionBoundary) throw new MultiCodexError("--format requires FORMAT");
      format = parseOutputFormat(args[index + 1]); args.splice(index, 2); optionBoundary -= 2; continue;
    }
    index++;
  }
  if (args.includes("-h") || args.includes("--help")) return { base, format, command: "help", args: [] };
  return { base, format, command: args.shift(), args };
}

function outputOptionBoundary(argv: string[]): number {
  let execBoundary = argv.length;
  for (let index = 0; index < argv.length;) {
    const value = argv[index];
    if (value === "--") break;
    if (value === "--data-dir" || value === "--format") { index += 2; continue; }
    if (value === "-J" || value.startsWith("--format=")) { index++; continue; }
    if (value === "exec") execBoundary = index;
    break;
  }
  const boundaries = [execBoundary, argv.indexOf("--")].filter(index => index >= 0);
  return boundaries.length ? Math.min(...boundaries) : argv.length;
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") return value;
  throw new MultiCodexError(`unsupported output format: ${JSON.stringify(value)} (expected text or json)`);
}

function requestsJson(argv: string[]): boolean {
  const boundary = outputOptionBoundary(argv);
  return argv.slice(0, boundary).some((value, index, options) => value === "-J" || value === "--format=json" || (value === "--format" && options[index + 1] === "json"));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let format: OutputFormat = requestsJson(argv) ? "json" : "text";
  try {
    const parsed = parse(argv); const { base, command, args } = parsed; format = parsed.format;
    if (command !== undefined && command !== "help") await migrateLegacyDefaultBase(base);
    if (format === "json" && command && !["list", "current", "usage", "wake", "autowake"].includes(command)) throw new MultiCodexError(`JSON output is not supported for the '${command}' command`);
    switch (command) {
      case undefined: case "help": console.log(HELP); return 0;
      case "add": return await add(base, args);
      case "remove": return await removeAccount(base, args);
      case "rename": return await renameAccount(base, args);
      case "list": return await listAccounts(base, format);
      case "use": return await useAccount(base, args);
      case "current": return await current(base, format);
      case "exec": return await execAccount(base, args);
      case "usage": return await usage(base, args, format);
      case "wake": return await wake(base, format);
      case "autowake": return await autoWake(base, args, format);
      default: throw new MultiCodexError(`unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(format === "json" ? JSON.stringify({ error: { message } }) : `multicodex: error: ${message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
