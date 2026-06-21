export const schemaTables = [
  {
    table: "fact_station_daily",
    description: "站点日汇总表，适合趋势、排名、对比、地图指标",
    fields: ["stat_date", "station_id", "region_id", "order_count", "total_revenue", "utilization_rate", "fault_count", "offline_minutes", "health_score"]
  },
  {
    table: "dim_region",
    description: "区域维表，适合区域名称、商圈、地图区域",
    fields: ["region_id", "region_name", "region_type", "business_tag", "map_x", "map_y"]
  },
  {
    table: "dim_station",
    description: "充电站维表，适合地图点位、站点类型、状态",
    fields: ["station_id", "station_name", "region_id", "station_type", "status", "charger_count", "map_x", "map_y"]
  },
  {
    table: "fact_fault_ticket",
    description: "故障工单表，适合故障率、异常、收入损失",
    fields: ["ticket_id", "charger_id", "station_id", "region_id", "fault_type", "fault_level", "created_at", "impact_minutes", "lost_revenue_estimate"]
  },
  {
    table: "dim_calendar",
    description: "日历维表，适合工作日、休息日、节假日、调休分析",
    fields: ["date", "is_workday", "is_weekend", "is_holiday", "holiday_name"]
  },
  {
    table: "fact_weather_daily",
    description: "天气日表，适合归因分析",
    fields: ["weather_date", "region_id", "weather_type", "rainfall_mm", "severe_weather_flag"]
  }
];

export const sensitiveWords = ["手机号", "手机", "电话", "车牌", "身份证", "用户明细", "个人信息", "导出所有用户"];

