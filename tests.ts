import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authEmail, automaticName, autoWakeDecision, autoWakeDecisions, billingOutcome, buildUsageReport, defaultBase, formatDate, hasUsableSession, loadConfig, main, parse, parseUsage, saveConfig, stableAutoWakeExecutable, subscriptionSummary, timeUntil, validateEmail, validateName, wakeCodexArgs } from "./cli";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "multicodex-test-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try { return { code: await action(), output: lines.join("\n") }; }
  finally { console.log = original; }
}

describe("identity validation", () => {
  test("given_an_escaped_email_when_validated_then_it_is_normalized", () => {
    expect(validateEmail(String.raw`person\@example.com`)).toBe("person@example.com");
  });

  test("given_an_invalid_name_when_validated_then_it_is_rejected", () => {
    expect(() => validateName("two words")).toThrow("may contain only");
  });

  test("given_duplicate_local_parts_when_names_are_generated_then_a_suffix_is_added", () => {
    expect(automaticName("person@two.example", [{ name: "person", home: "/tmp/person" }])).toBe("person-2");
  });

  test("given_a_secure_auth_file_when_email_is_read_then_the_jwt_claim_is_used", async () => {
    // Given
    const root = await temporaryDirectory();
    await mkdir(join(root, "profile"));
    await writeFile(join(root, "profile", "auth.json"), JSON.stringify({ tokens: { id_token: jwt({ email: "person@example.com" }) } }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(join(root, "profile", "auth.json"), 0o600);

    // When / Then
    expect(await authEmail(join(root, "profile"))).toBe("person@example.com");
  });

  test("given_a_stale_auth_file_when_the_codex_session_is_checked_then_it_is_not_reused", async () => {
    // Given
    const account = { name: "person", home: "/unused", expected_email: "person@example.com" };

    // When
    const usable = await hasUsableSession(account, async () => ({ account: null }));

    // Then
    expect(usable).toBeFalse();
  });

  test("given_a_matching_live_session_when_the_codex_session_is_checked_then_it_is_reused", async () => {
    const account = { name: "person", home: "/unused", expected_email: "person@example.com" };
    expect(await hasUsableSession(account, async () => ({ account: { email: "person@example.com" } }))).toBeTrue();
  });
});

describe("usage parsing", () => {
  test("given_plus_windows_when_usage_is_parsed_then_weekly_and_five_hour_limits_are_distinguished", () => {
    // Given
    const account = { account: { email: "plus@example.com", planType: "plus" } };
    const limits = { rateLimits: {
      primary: { usedPercent: 70, resetsAt: 100, windowDurationMins: 300 },
      secondary: { usedPercent: 20, resetsAt: 200, windowDurationMins: 10080 },
      credits: { balance: "0", unlimited: false },
    }, rateLimitResetCredits: {
      availableCount: 2,
      credits: [{ id: "reset-1", status: "available", expiresAt: 1784246400 }],
    } };

    // When
    const usage = parseUsage(account, limits);

    // Then
    expect(usage.limits.weekly.remaining_percent).toBe(80);
    expect(usage).not.toHaveProperty("remaining_fraction");
    expect(usage).not.toHaveProperty("remaining_percent");
    expect(usage).not.toHaveProperty("resets_at");
    expect(usage).not.toHaveProperty("five_hour");
    expect(usage.limits.five_hour.remaining_percent).toBe(30);
    expect(usage.available_banked_resets).toEqual([
      { expires_at: 1784246400 },
      { expires_at: null },
    ]);
    expect(usage).not.toHaveProperty("available_reset_credits");
  });

  test("given_a_pro_plan_when_usage_is_parsed_then_no_five_hour_limit_is_returned", () => {
    const usage = parseUsage(
      { account: { planType: "pro" } },
      { rateLimits: { primary: { usedPercent: 25, resetsAt: 200, windowDurationMins: 10080 } } },
    );
    expect(usage.limits.weekly.remaining_percent).toBe(75);
    expect(usage.limits.five_hour).toBeNull();
    expect(usage.available_banked_resets).toEqual([]);
  });
});

describe("time formatting", () => {
  test("given_a_future_timestamp_when_duration_is_formatted_then_it_is_readable", () => {
    expect(timeUntil(100 + 2 * 86400 + 3 * 3600, 100)).toBe("in 2d 3h");
  });

  test("given_a_timestamp_when_date_is_formatted_then_iso_syntax_is_not_used", () => {
    expect(formatDate(1_788_000_000)).not.toContain("T");
  });
});

describe("billing outcome", () => {
  test("given_a_scheduled_plan_change_when_the_subscription_is_summarized_then_next_plan_is_canonical", () => {
    const summary = subscriptionSummary({
      active_until: "2026-09-30T00:00:00Z",
      plan_type: "chatgptpro",
      will_renew: true,
      cancellation_outcome: "deactivate",
    }, { plan: "chatgptprolite" });

    expect(summary).toEqual({
      billing_cycle_ends_at: "2026-09-30T00:00:00Z",
      will_renew: true,
      plan_type: "chatgptpro",
      next_plan: "prolite",
    });
    expect(summary).not.toHaveProperty("active_until");
    expect(summary).not.toHaveProperty("cancellation_outcome");
    expect(summary).not.toHaveProperty("scheduled_plan_change");
    expect(billingOutcome(summary)).toBe("will switch to Pro X5");
  });

  test("given_a_cancelled_paid_plan_when_the_subscription_is_summarized_then_free_is_next", () => {
    const summary = subscriptionSummary({ plan_type: "plus", will_renew: false, cancellation_outcome: "deactivate" });
    expect(summary.next_plan).toBe("free");
    expect(billingOutcome(summary)).toBe("will switch to Free");
  });

  test("given_a_renewing_plan_when_the_subscription_is_summarized_then_the_current_plan_is_next", () => {
    const summary = subscriptionSummary({ plan_type: "chatgptpro", will_renew: true });
    expect(summary.next_plan).toBe("pro");
    expect(billingOutcome(summary)).toBe("renews as Pro X20");
  });
});

describe("configuration and commands", () => {
  test("given_no_environment_override_when_default_base_is_read_then_the_home_location_is_used", () => {
    const previous = process.env.MULTICODEX_HOME;
    delete process.env.MULTICODEX_HOME;
    try { expect(defaultBase()).toEndWith(".multicodex-accounts"); }
    finally { if (previous === undefined) delete process.env.MULTICODEX_HOME; else process.env.MULTICODEX_HOME = previous; }
  });

  test("given_a_config_when_it_is_saved_and_loaded_then_accounts_are_preserved", async () => {
    const root = await temporaryDirectory();
    await saveConfig(root, { version: 1, accounts: [{ name: "one", home: join(root, "one"), expected_email: "one@example.com" }] });
    expect((await loadConfig(root)).accounts[0].name).toBe("one");
  });

  test("given_accounts_when_list_runs_then_the_active_account_is_marked", async () => {
    // Given
    const root = await temporaryDirectory();
    await saveConfig(root, { version: 1, active_account: "two", accounts: [
      { name: "one", home: join(root, "one"), expected_email: "one@example.com" },
      { name: "two", home: join(root, "two"), expected_email: "two@example.com" },
    ] });

    // When
    const result = await capture(() => main(["--data-dir", root, "list"]));

    // Then
    expect(result.code).toBe(0);
    expect(result.output).toContain("two (two@example.com): active");
  });

  for (const jsonFlag of [["--format", "json"], ["-J"]]) {
    test(`given_accounts_when_list_runs_with_${jsonFlag.join("_")}_then_structured_json_is_returned`, async () => {
      const root = await temporaryDirectory();
      await saveConfig(root, { version: 1, active_account: "two", accounts: [
        { name: "one", home: join(root, "one"), expected_email: "one@example.com" },
        { name: "two", home: join(root, "two"), expected_email: "two@example.com" },
      ] });

      const result = await capture(() => main(["--data-dir", root, "list", ...jsonFlag]));
      const output = JSON.parse(result.output);

      expect(result.code).toBe(0);
      expect(output.active_account).toBe("two");
      expect(output.accounts).toEqual([
        { name: "one", email: "one@example.com", active: false },
        { name: "two", email: "two@example.com", active: true },
      ]);
    });
  }

  test("given_no_active_account_when_current_runs_as_json_then_a_null_account_is_returned", async () => {
    const root = await temporaryDirectory();
    await saveConfig(root, { version: 1, accounts: [] });

    const result = await capture(() => main(["-J", "--data-dir", root, "current"]));

    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ account: null, authentication: "not_configured" });
  });

  test("given_format_flags_in_exec_arguments_when_arguments_are_parsed_then_they_are_forwarded_unchanged", () => {
    const parsed = parse(["exec", "personal", "--", "tool", "-J", "--format", "json"]);

    expect(parsed.format).toBe("text");
    expect(parsed.command).toBe("exec");
    expect(parsed.args).toEqual(["personal", "--", "tool", "-J", "--format", "json"]);
  });

  test("given_a_json_flag_before_exec_when_arguments_are_parsed_then_it_remains_a_global_option", () => {
    const parsed = parse(["--data-dir", "/tmp/accounts", "-J", "exec", "personal"]);

    expect(parsed.format).toBe("json");
    expect(parsed.command).toBe("exec");
    expect(parsed.args).toEqual(["personal"]);
  });

  test("given_an_account_email_when_rename_runs_then_the_new_name_is_saved", async () => {
    // Given
    const root = await temporaryDirectory();
    await saveConfig(root, { version: 1, accounts: [{ name: "old", home: join(root, "homes", "old"), expected_email: "one@example.com" }] });

    // When
    expect((await capture(() => main(["--data-dir", root, "rename", "one@example.com", "new"]))).code).toBe(0);

    // Then
    expect((await loadConfig(root)).accounts[0].name).toBe("new");
  });

  test("given_help_when_main_runs_then_all_commands_are_shown", async () => {
    const result = await capture(() => main(["--help"]));
    expect(result.code).toBe(0);
    expect(result.output).toContain("{add,remove,rename,list,use,current,exec,usage,wake,autowake}");
  });
});

describe("automatic wake scheduling", () => {
  test("given_a_completed_scheduled_reset_with_zero_usage_when_checked_then_wake_is_due", () => {
    const decision = autoWakeDecision({ next_reset_at: 900, used_percent: 80 }, { resets_at: 700_000, used_percent: 0 }, 1_000);
    expect(decision.due).toBeTrue();
    expect(decision.unexpected_reset).toBeFalse();
  });

  test("given_nonzero_usage_when_a_reset_is_due_then_wake_is_suppressed", () => {
    const decision = autoWakeDecision({ next_reset_at: 900, used_percent: 80 }, { resets_at: 700_000, used_percent: 0.1 }, 1_000);
    expect(decision.due).toBeFalse();
  });

  test("given_an_early_reset_to_zero_when_checked_then_it_is_detected", () => {
    const decision = autoWakeDecision({ next_reset_at: 2_000, used_percent: 40 }, { resets_at: 700_000, used_percent: 0 }, 1_000);
    expect(decision.due).toBeTrue();
    expect(decision.unexpected_reset).toBeTrue();
    expect(decision.wake_for_reset).toBe(700_000);
  });

  test("given_an_already_woken_window_when_checked_then_duplicate_wake_is_suppressed", () => {
    const decision = autoWakeDecision({ next_reset_at: 2_000, used_percent: 40, last_wake_for_reset_at: 700_000 }, { resets_at: 700_000, used_percent: 0 }, 1_000);
    expect(decision.due).toBeFalse();
  });

  test("given_a_plus_5_hour_reset_with_weekly_capacity_when_checked_then_wake_is_due", () => {
    const decisions = autoWakeDecisions(
      { next_reset_at: 2_000, used_percent: 20, five_hour_next_reset_at: 900, five_hour_used_percent: 80 },
      { email: null, weekly: { resets_at: 2_000, used_percent: 20 }, five_hour: { resets_at: 20_000, used_percent: 0 } },
      1_000,
    );
    expect(decisions.weekly.due).toBeFalse();
    expect(decisions.five_hour?.due).toBeTrue();
  });

  test("given_a_5_hour_reset_with_exhausted_weekly_quota_when_checked_then_wake_is_suppressed", () => {
    const decisions = autoWakeDecisions(
      { next_reset_at: 2_000, used_percent: 100, five_hour_next_reset_at: 900, five_hour_used_percent: 80 },
      { email: null, weekly: { resets_at: 2_000, used_percent: 100 }, five_hour: { resets_at: 20_000, used_percent: 0 } },
      1_000,
    );
    expect(decisions.five_hour?.due).toBeFalse();
  });

  test("given_an_account_without_a_5_hour_window_when_checked_then_only_weekly_is_tracked", () => {
    const decisions = autoWakeDecisions(
      { next_reset_at: 2_000, used_percent: 20 },
      { email: null, weekly: { resets_at: 2_000, used_percent: 20 }, five_hour: null },
      1_000,
    );
    expect(decisions.five_hour).toBeNull();
  });

  test("given_a_wake_request_when_arguments_are_built_then_terra_low_is_forced", () => {
    const args = wakeCodexArgs("/tmp/result", "challenge");
    expect(args.slice(1, 5)).toEqual(["--model", "gpt-5.6-terra", "--config", 'model_reasoning_effort="low"']);
  });

  test("given_a_homebrew_cellar_executable_when_the_scheduler_is_built_then_the_stable_link_is_used", () => {
    expect(stableAutoWakeExecutable(
      "/opt/homebrew/Cellar/multicodex/0.1.0/bin/multicodex",
      "/opt/homebrew/bin/multicodex",
    )).toBe("/opt/homebrew/bin/multicodex");
  });
});

describe("JSON usage output", () => {
  test("given_successful_and_failed_reads_when_the_report_is_built_then_summary_and_errors_are_structured", () => {
    const accounts = [
      { name: "one", home: "/one", expected_email: "one@example.com" },
      { name: "two", home: "/two", expected_email: "two@example.com" },
    ];
    const report = buildUsageReport(accounts, [
      { status: "fulfilled", value: { name: "one", email: "one@example.com", capacity: 5, limits: { weekly: { remaining_percent: 50, resets_at: 100 }, five_hour: null } } },
      { status: "rejected", reason: new Error("session expired") },
    ]);

    expect(report.summary).toEqual({
      overall_weekly_remaining_percent: 50,
      remaining_weighted_units: 2.5,
      total_weighted_units: 5,
    });
    expect(report.accounts[0].error).toBeNull();
    expect(report.accounts[0].limits).toEqual({ weekly: { remaining_percent: 50, resets_at: 100 }, five_hour: null });
    expect(report.accounts[0]).not.toHaveProperty("remaining_fraction");
    expect(report.accounts[1]).toEqual({ name: "two", email: "two@example.com", error: "session expired" });
  });
});
