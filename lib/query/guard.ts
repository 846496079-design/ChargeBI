const forbidden = ["delete", "update", "insert", "drop", "alter", "create", "truncate", "attach", "detach"];
const allowedTables = [
  "dim_region",
  "dim_station",
  "dim_charger",
  "fact_charging_session",
  "fact_station_daily",
  "fact_fault_ticket",
  "fact_maintenance",
  "dim_tariff",
  "dim_calendar",
  "fact_weather_daily"
];
const allowedCteNames = ["station_base", "fault_loss", "station_metrics", "top_revenue", "bottom_revenue"];

function extractCteNames(normalizedSql: string) {
  if (!normalizedSql.startsWith("with")) return [];
  const names = new Set<string>();
  const matches = normalizedSql.matchAll(/(?:with|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/g);
  for (const match of matches) names.add(match[1]);
  return [...names];
}

export function guardSql(sql: string) {
  const normalized = sql.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized.startsWith("select") && !normalized.startsWith("with")) {
    return { ok: false, reason: "仅允许 SELECT 或 WITH 只读查询" };
  }
  for (const word of forbidden) {
    if (normalized.includes(`${word} `) || normalized.includes(`${word};`)) {
      return { ok: false, reason: `查询包含禁止关键字 ${word.toUpperCase()}` };
    }
  }
  const tableMatches = [...normalized.matchAll(/\bfrom\s+([a-z_]+)|\bjoin\s+([a-z_]+)/g)].map((m) => m[1] || m[2]);
  const dynamicCteNames = extractCteNames(normalized);
  for (const table of tableMatches) {
    if (!allowedTables.includes(table) && !allowedCteNames.includes(table) && !dynamicCteNames.includes(table)) {
      return { ok: false, reason: `表 ${table} 不在白名单内` };
    }
  }
  return { ok: true, reason: "只读 SQL 已通过白名单校验" };
}
