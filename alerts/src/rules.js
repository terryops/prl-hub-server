// Alert rule evaluation — pure, no I/O, so it is unit-testable in plain Node.
//
// Rule kinds:
//   above  value = USD   fire when price >= value
//   below  value = USD   fire when price <= value
//   move   value = %     fire when |change over `window` seconds| >= value
//                        (window: 300 = 5 min, 3600 = 1h, 86400 = 24h)
//
// Rules default to the device's one-shot setting; a per-rule `repeat` choice
// overrides it. One-shot rules switch off after firing; repeating rules stay on.
// While on, it fires once, then DISARMS; it re-arms only
// after the condition has clearly reset, so a price hovering on a threshold
// cannot spam the phone:
//   above/below  re-arm once price is back past the threshold by HYST (2%)
//   move         re-arm once |change| falls under half the threshold
// plus a minimum COOLDOWN between two notifications of the same rule.

export const HYST = 0.02;
export const WINDOWS = [300, 3600, 86400];
const COOLDOWN = { above: 1800, below: 1800 };
// 1h → 15 min, 24h → 6 h; never under 15 min, so a choppy 5-min window can't spam.
const moveCooldown = (window) => Math.max(window / 4, 900);

/// Change in % between `ref` and `usd`, or null without a reference price.
export function pctChange(usd, ref) {
  return ref ? ((usd - ref) / ref) * 100 : null;
}

/// ctx: { usd, now, change: { 3600: pct|null, 86400: pct|null } }
/// rule: { kind, value, window, armed, last_fired }
/// → { fire: bool, armed: bool, change?: pct }
export function evaluate(rule, ctx) {
  const { usd, now } = ctx;
  const armed = !!rule.armed;
  const cooled = !rule.last_fired || now - rule.last_fired >= cooldownOf(rule);

  switch (rule.kind) {
    case "above": {
      if (armed) return { fire: usd >= rule.value && cooled, armed: !(usd >= rule.value && cooled) };
      return { fire: false, armed: usd < rule.value * (1 - HYST) };
    }
    case "below": {
      if (armed) return { fire: usd <= rule.value && cooled, armed: !(usd <= rule.value && cooled) };
      return { fire: false, armed: usd > rule.value * (1 + HYST) };
    }
    case "move": {
      const ch = ctx.change[rule.window];
      if (ch == null) return { fire: false, armed };
      const hit = Math.abs(ch) >= rule.value;
      if (armed) return { fire: hit && cooled, armed: !(hit && cooled), change: ch };
      return { fire: false, armed: Math.abs(ch) < rule.value / 2, change: ch };
    }
    default:
      return { fire: false, armed };
  }
}

function cooldownOf(rule) {
  return rule.kind === "move" ? moveCooldown(rule.window) : COOLDOWN[rule.kind] || 0;
}

/// Server-side state for a rule the client (re)sends, given the stored row `old`.
/// For a one-shot client (`oneshot`), a rule that fired and switched itself off
/// stays off until the user turns it back on. The client sends `seen_fired`: the
/// last_fired it has read back from this server. Only a client that has seen the
/// latest firing (and has therefore shown the rule as off) can switch it back on,
/// so a re-sync from an app that hasn't heard about the push yet can't undo the
/// auto-off. Both values are server timestamps, so phone clock skew can't matter.
/// Legacy clients (no oneshot) keep the old behaviour: their `enabled` wins.
/// Unchanged rules keep armed/last_fired, so a re-sync never re-fires an alert.
export function mergeRule(old, r, oneshot = false) {
  oneshot = r.repeating == null ? oneshot : r.repeating === 0;
  const same = old && old.kind === r.kind && old.value === r.value && old.window === r.window;
  if (!same) return { enabled: r.enabled, armed: 1, last_fired: null };
  const firedOff = oneshot && !old.enabled && old.last_fired && !(r.seen_fired >= old.last_fired);
  return { enabled: r.enabled && !firedOff ? 1 : 0, armed: old.armed, last_fired: old.last_fired };
}

/// mergeRule as one SQL upsert, so the merge reads the row as it is at write
/// time: a tick that fires the rule between a PUT's read and its write can no
/// longer be undone (re-armed, switched back on) by that PUT. The tests hold
/// the two equal. Binds: token, id, kind, value, window, enabled, oneshot, seen_fired, repeating.
/// (In an UPDATE, SQLite reads every `rules.` column before any is assigned.)
export const upsertRule = (guard = null) => `
  INSERT INTO rules (token, id, kind, value, window, enabled, armed, last_fired, repeating)
  ${guard == null ? "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, ?9)" : `SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, ?9 WHERE ${guard}`}
  ON CONFLICT(token, id) DO UPDATE SET
    enabled = CASE WHEN rules.kind = excluded.kind AND rules.value = excluded.value AND rules.window = excluded.window
                   THEN CASE WHEN excluded.enabled = 1
                              AND NOT (COALESCE(?9 = 0, ?7 = 1) AND rules.enabled = 0 AND COALESCE(rules.last_fired, 0) > 0
                                       AND ?8 < rules.last_fired)
                             THEN 1 ELSE 0 END
                   ELSE excluded.enabled END,
    armed = CASE WHEN rules.kind = excluded.kind AND rules.value = excluded.value AND rules.window = excluded.window
                 THEN rules.armed ELSE 1 END,
    last_fired = CASE WHEN rules.kind = excluded.kind AND rules.value = excluded.value AND rules.window = excluded.window
                      THEN rules.last_fired ELSE NULL END,
    kind = excluded.kind, value = excluded.value, window = excluded.window, repeating = excluded.repeating`;
export const UPSERT_RULE = upsertRule();

/// Validate one client-supplied rule; returns a normalized rule or null.
export function sanitizeRule(r) {
  if (!r || typeof r !== "object") return null;
  const id = typeof r.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(r.id) ? r.id : null;
  const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  if (!id || value == null) return null;
  const enabled = r.enabled === false ? 0 : 1;
  if (r.repeat != null && typeof r.repeat !== "boolean") return null;
  const repeating = r.repeat == null ? null : r.repeat ? 1 : 0;
  // The rule's last_fired as the client last read it from us; 0 = never seen one.
  const seen_fired = typeof r.seen_fired === "number" && Number.isFinite(r.seen_fired) && r.seen_fired > 0
    ? Math.floor(r.seen_fired) : 0;
  // Thresholds are set to at most 2 decimals (cents / hundredths of a percent).
  const v = Math.round(value * 100) / 100;
  if (r.kind === "above" || r.kind === "below") {
    if (!(v >= 0.01 && v < 1e6)) return null;
    return { id, kind: r.kind, value: v, window: 0, enabled, seen_fired, repeating };
  }
  if (r.kind === "move") {
    if (!(v >= 0.5 && v <= 1000) || !WINDOWS.includes(r.window)) return null;
    return { id, kind: "move", value: v, window: r.window, enabled, seen_fired, repeating };
  }
  return null;
}

// ── push window (免打扰) ─────────────────────────────────────────────────────
//
// A device may limit pushes to a daily window of local time, [start, end) in
// minutes after midnight (end < start wraps past midnight). No window = all day.
// An alert that fires outside it is queued and pushed at the next window start.

/// Validate the client's { start, end, tz }; null = all day.
export function sanitizeWindow(w) {
  if (!w || typeof w !== "object") return null;
  const ok = (m) => Number.isInteger(m) && m >= 0 && m < 1440;
  if (!ok(w.start) || !ok(w.end) || w.start === w.end) return null;
  const tz = typeof w.tz === "string" && w.tz.length <= 64 && validTZ(w.tz) ? w.tz : "UTC";
  return { start: w.start, end: w.end, tz };
}

function validTZ(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/// Local time of `t` (unix s) in `tz` as { min: minutes after midnight, sec }.
export function localClock(t, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(t * 1000));
  const get = (k) => Number(parts.find((p) => p.type === k).value);
  return { min: get("hour") * 60 + get("minute"), sec: get("second") };
}

/// "03:12" in the device's time zone.
export function localHM(t, tz) {
  const { min } = localClock(t, tz);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/// Is a push allowed at `t` for a device with window `w` (row fields win_start/win_end/tz)?
export function windowOpen(w, t) {
  if (!w || w.start == null || w.end == null || w.start === w.end) return true;
  const { min } = localClock(t, w.tz);
  return w.start < w.end ? min >= w.start && min < w.end : min >= w.start || min < w.end;
}
