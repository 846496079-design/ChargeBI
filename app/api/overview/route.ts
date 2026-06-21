import { NextResponse } from "next/server";
import { all, get } from "@/lib/data/db";

export async function GET() {
  const kpi = get<{
    orders: number;
    revenue: number;
    utilization: number;
    faults: number;
    stations: number;
  }>(`
SELECT
  SUM(order_count) AS orders,
  ROUND(SUM(total_revenue), 2) AS revenue,
  ROUND(AVG(utilization_rate), 4) AS utilization,
  SUM(fault_count) AS faults,
  COUNT(DISTINCT station_id) AS stations
FROM fact_station_daily
WHERE stat_date >= date('2026-06-20', '-30 day')`);

  const regions = all(`
SELECT r.region_id, r.region_name, r.map_x, r.map_y,
       ROUND(SUM(d.total_revenue), 2) AS revenue,
       ROUND(AVG(d.utilization_rate), 4) AS utilization
FROM dim_region r
JOIN fact_station_daily d ON r.region_id = d.region_id
WHERE d.stat_date >= date('2026-06-20', '-30 day')
GROUP BY r.region_id, r.region_name, r.map_x, r.map_y
ORDER BY revenue DESC`);

  return NextResponse.json({ kpi, regions });
}

