import { NextResponse } from "next/server";
import { all } from "@/lib/data/db";

export const runtime = "nodejs";

export async function GET() {
  const stations = all(`
SELECT s.station_id, s.station_name, s.region_id, r.region_name, s.map_x, s.map_y, s.lng, s.lat, s.station_type, s.status,
       s.charger_count,
       ROUND(SUM(d.total_revenue), 2) AS revenue30d,
       SUM(d.order_count) AS orders30d,
       ROUND(AVG(d.utilization_rate), 4) AS utilization30d,
       SUM(d.fault_count) AS faults30d,
       ROUND(AVG(d.health_score), 1) AS health_score
FROM dim_station s
JOIN dim_region r ON s.region_id = r.region_id
JOIN fact_station_daily d ON s.station_id = d.station_id
WHERE d.stat_date >= date('2026-06-20', '-30 day')
GROUP BY s.station_id, s.station_name, s.region_id, r.region_name, s.map_x, s.map_y, s.lng, s.lat, s.station_type, s.status, s.charger_count
ORDER BY revenue30d DESC`);
  return NextResponse.json({ stations });
}
