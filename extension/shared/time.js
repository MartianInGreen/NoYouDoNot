export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isoWeekKey(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function timeBucket(date = new Date()) {
  const hour = date.getHours();
  if (hour < 6) return "late night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

export function activeIntentSnapshot(settings, date = new Date()) {
  return {
    always: String(settings.alwaysIntent || "").trim(),
    daily:
      settings.dailyIntent?.date === localDateKey(date)
        ? String(settings.dailyIntent.text || "").trim()
        : "",
    weekly:
      settings.weeklyIntent?.week === isoWeekKey(date)
        ? String(settings.weeklyIntent.text || "").trim()
        : "",
    projects: (settings.projects || [])
      .filter((project) => project.active && String(project.intent || "").trim())
      .map((project) => ({
        name: String(project.name || "Untitled project").slice(0, 100),
        intent: String(project.intent || "").slice(0, 1500)
      }))
  };
}

export function formatDuration(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  if (safe < 60) return `${Math.round(safe)}s`;
  const minutes = Math.round(safe / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function recentDateKeys(count, end = new Date()) {
  const keys = [];
  for (let offset = 0; offset < count; offset += 1) {
    const value = new Date(end);
    value.setDate(end.getDate() - offset);
    keys.push(localDateKey(value));
  }
  return keys;
}
