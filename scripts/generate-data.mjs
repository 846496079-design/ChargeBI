import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "chargebi.sqlite");
const geoPath = path.join(root, "public", "geo", "shanghai-districts-wgs84.json");

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;");

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const iso = (date) => date.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, "0");

const districtGeoJson = fs.existsSync(geoPath) ? JSON.parse(fs.readFileSync(geoPath, "utf8")) : null;

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng, lat, coordinates) {
  const [outer, ...holes] = coordinates;
  if (!pointInRing(lng, lat, outer)) return false;
  return !holes.some((hole) => pointInRing(lng, lat, hole));
}

function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(lng, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(lng, lat, polygon));
  return false;
}

function flattenCoords(coords, out = []) {
  if (typeof coords?.[0] === "number") {
    out.push(coords);
    return out;
  }
  for (const item of coords) flattenCoords(item, out);
  return out;
}

function featureBounds(feature) {
  const coords = flattenCoords(feature.geometry.coordinates);
  return coords.reduce(
    (acc, coord) => ({
      minLng: Math.min(acc.minLng, coord[0]),
      maxLng: Math.max(acc.maxLng, coord[0]),
      minLat: Math.min(acc.minLat, coord[1]),
      maxLat: Math.max(acc.maxLat, coord[1])
    }),
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity }
  );
}

function findDistrictFeature(name) {
  if (!districtGeoJson) return null;
  return districtGeoJson.features.find((feature) => feature.properties?.name === name) || null;
}

function samplePointInFeature(feature, fallbackLng, fallbackLat) {
  if (!feature) return [fallbackLng, fallbackLat];
  const bounds = featureBounds(feature);
  for (let i = 0; i < 300; i++) {
    const lng = rand(bounds.minLng, bounds.maxLng);
    const lat = rand(bounds.minLat, bounds.maxLat);
    if (pointInGeometry(lng, lat, feature.geometry)) return [lng, lat];
  }
  return [fallbackLng, fallbackLat];
}

const businessRegionToAdmin = {
  R_RENMIN: "黄浦区",
  R_LUJIAZUI: "浦东新区",
  R_ZHANGJIANG: "浦东新区",
  R_HONGQIAO: "闵行区"
};

const today = new Date("2026-06-20T00:00:00+08:00");
const start = new Date(today);
start.setDate(start.getDate() - 364);

db.exec(`
CREATE TABLE dim_region (
  region_id TEXT PRIMARY KEY,
  region_name TEXT NOT NULL,
  region_type TEXT NOT NULL,
  parent_region TEXT,
  city TEXT NOT NULL,
  center_lng REAL NOT NULL,
  center_lat REAL NOT NULL,
  map_x REAL NOT NULL,
  map_y REAL NOT NULL,
  population_level TEXT NOT NULL,
  business_tag TEXT NOT NULL
);

CREATE TABLE dim_station (
  station_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  region_id TEXT NOT NULL,
  address TEXT NOT NULL,
  lng REAL NOT NULL,
  lat REAL NOT NULL,
  map_x REAL NOT NULL,
  map_y REAL NOT NULL,
  station_type TEXT NOT NULL,
  operator TEXT NOT NULL,
  open_date TEXT NOT NULL,
  parking_spaces INTEGER NOT NULL,
  charger_count INTEGER NOT NULL,
  fast_charger_count INTEGER NOT NULL,
  slow_charger_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  service_hours TEXT NOT NULL
);

CREATE TABLE dim_charger (
  charger_id TEXT PRIMARY KEY,
  station_id TEXT NOT NULL,
  charger_type TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  power_kw REAL NOT NULL,
  install_date TEXT NOT NULL,
  current_status TEXT NOT NULL,
  last_online_at TEXT NOT NULL
);

CREATE TABLE fact_charging_session (
  session_id TEXT PRIMARY KEY,
  charger_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  user_segment TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  charging_minutes INTEGER NOT NULL,
  energy_kwh REAL NOT NULL,
  electricity_fee REAL NOT NULL,
  service_fee REAL NOT NULL,
  total_fee REAL NOT NULL,
  payment_status TEXT NOT NULL,
  session_status TEXT NOT NULL,
  tariff_period TEXT NOT NULL
);

CREATE TABLE fact_station_daily (
  stat_date TEXT NOT NULL,
  station_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  order_count INTEGER NOT NULL,
  active_charger_count INTEGER NOT NULL,
  total_charging_minutes INTEGER NOT NULL,
  total_energy_kwh REAL NOT NULL,
  total_revenue REAL NOT NULL,
  electricity_revenue REAL NOT NULL,
  service_revenue REAL NOT NULL,
  avg_order_value REAL NOT NULL,
  utilization_rate REAL NOT NULL,
  fault_count INTEGER NOT NULL,
  offline_minutes INTEGER NOT NULL,
  health_score REAL NOT NULL,
  PRIMARY KEY (stat_date, station_id)
);

CREATE TABLE fact_fault_ticket (
  ticket_id TEXT PRIMARY KEY,
  charger_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  fault_type TEXT NOT NULL,
  fault_level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  status TEXT NOT NULL,
  impact_minutes INTEGER NOT NULL,
  lost_revenue_estimate REAL NOT NULL
);

CREATE TABLE fact_maintenance (
  maintenance_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  engineer_team TEXT NOT NULL,
  dispatch_time TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  finish_time TEXT NOT NULL,
  action_type TEXT NOT NULL,
  result TEXT NOT NULL,
  response_minutes INTEGER NOT NULL,
  repair_minutes INTEGER NOT NULL
);

CREATE TABLE dim_tariff (
  tariff_id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL,
  effective_start TEXT NOT NULL,
  effective_end TEXT NOT NULL,
  period_name TEXT NOT NULL,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  electricity_price REAL NOT NULL,
  service_price REAL NOT NULL
);

CREATE TABLE dim_calendar (
  date TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  week_of_year INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  is_workday INTEGER NOT NULL,
  is_weekend INTEGER NOT NULL,
  is_holiday INTEGER NOT NULL,
  holiday_name TEXT,
  is_adjusted_workday INTEGER NOT NULL,
  day_part_rules TEXT NOT NULL
);

CREATE TABLE fact_weather_daily (
  weather_date TEXT NOT NULL,
  region_id TEXT NOT NULL,
  weather_type TEXT NOT NULL,
  min_temp REAL NOT NULL,
  max_temp REAL NOT NULL,
  rainfall_mm REAL NOT NULL,
  severe_weather_flag INTEGER NOT NULL,
  PRIMARY KEY (weather_date, region_id)
);

`);

const regions = [
  ["R_PUDONG", "浦东新区", "行政区", 121.544, 31.221, 66, 42, "高", "商务办公"],
  ["R_XUHUI", "徐汇区", "行政区", 121.436, 31.188, 45, 56, "高", "商业居住"],
  ["R_JINGAN", "静安区", "行政区", 121.459, 31.229, 46, 36, "高", "商务办公"],
  ["R_HUANGPU", "黄浦区", "行政区", 121.484, 31.231, 52, 39, "高", "核心商圈"],
  ["R_MINHANG", "闵行区", "行政区", 121.381, 31.112, 35, 68, "中", "居住社区"],
  ["R_JIADING", "嘉定区", "行政区", 121.265, 31.375, 20, 24, "中", "产业园"],
  ["R_SONGJIANG", "松江区", "行政区", 121.228, 31.032, 23, 78, "中", "居住社区"],
  ["R_LINGANG", "临港新片区", "产业区", 121.929, 30.900, 84, 82, "中", "产业园"],
  ["R_HONGQIAO", "虹桥枢纽", "交通枢纽", 121.327, 31.200, 31, 48, "高", "交通枢纽"],
  ["R_ZHANGJIANG", "张江", "产业园", 121.599, 31.205, 72, 48, "高", "产业园"],
  ["R_LUJIAZUI", "陆家嘴", "商圈", 121.503, 31.239, 59, 36, "高", "核心商圈"],
  ["R_RENMIN", "人民广场", "商圈", 121.475, 31.230, 51, 42, "高", "核心商圈"]
];

const insertRegion = db.prepare("INSERT INTO dim_region VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (const r of regions) insertRegion.run(r[0], r[1], r[2], "上海都市圈", "上海", r[3], r[4], r[5], r[6], r[7], r[8]);

const stationTypes = ["商业综合体", "社区", "园区", "交通枢纽", "公共停车场"];
const statusPool = ["正常", "正常", "正常", "高负荷", "低利用", "维护中"];
const stationInsert = db.prepare("INSERT INTO dim_station VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const chargerInsert = db.prepare("INSERT INTO dim_charger VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

const stations = [];
const chargersByStation = new Map();
let stationNo = 1;

for (const region of regions) {
  const stationCount = region[0] === "R_LINGANG" ? 5 : randInt(5, 7);
  for (let i = 0; i < stationCount; i++) {
    const id = `ST_${String(stationNo).padStart(3, "0")}`;
    stationNo++;
    const stationType = pick(stationTypes);
    const chargerCount = randInt(8, 26);
    const fastCount = Math.round(chargerCount * rand(0.45, 0.78));
    const slowCount = chargerCount - fastCount;
    const adminName = businessRegionToAdmin[region[0]] || region[1];
    const districtFeature = findDistrictFeature(adminName);
    const [lng, lat] = samplePointInFeature(districtFeature, region[3] + rand(-0.035, 0.035), region[4] + rand(-0.025, 0.025));
    const x = clamp(region[5] + rand(-5, 5), 8, 92);
    const y = clamp(region[6] + rand(-5, 5), 12, 88);
    const status = pick(statusPool);
    const name = `${region[1]}${pick(["中心", "绿地", "星湾", "城市", "新能", "云谷", "枢纽"])}充电站`;
    const station = {
      id,
      name,
      regionId: region[0],
      regionName: region[1],
      regionTag: region[8],
      stationType,
      chargerCount,
      fastCount,
      slowCount,
      status,
      x,
      y,
      lng,
      lat
    };
    stations.push(station);
    stationInsert.run(
      id,
      name,
      region[0],
      `${region[1]}示例路${randInt(10, 399)}号`,
      lng,
      lat,
      x,
      y,
      stationType,
      "ChargeBI 示范运营",
      iso(new Date(today.getTime() - randInt(240, 950) * 86400000)),
      randInt(12, 80),
      chargerCount,
      fastCount,
      slowCount,
      status,
      "00:00-24:00"
    );

    const chargers = [];
    for (let c = 1; c <= chargerCount; c++) {
      const chargerId = `CH_${id}_${pad(c)}`;
      const fast = c <= fastCount;
      const cStatus = status === "维护中" && Math.random() < 0.35 ? "维护" : pick(["可用", "可用", "占用", "离线", "故障"]);
      chargers.push(chargerId);
      chargerInsert.run(
        chargerId,
        id,
        fast ? "快充" : "慢充",
        fast ? "国标直流" : "国标交流",
        fast ? pick([60, 90, 120, 160]) : pick([7, 11, 22]),
        iso(new Date(today.getTime() - randInt(180, 1200) * 86400000)),
        cStatus,
        `2026-06-20 ${pad(randInt(0, 23))}:${pad(randInt(0, 59))}:00`
      );
    }
    chargersByStation.set(id, chargers);
  }
}

const tariffInsert = db.prepare("INSERT INTO dim_tariff VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
for (const region of regions) {
  tariffInsert.run(`TF_${region[0]}_PEAK`, region[0], "2025-06-21", "2026-06-20", "峰", 8, 11, 1.18, 0.38);
  tariffInsert.run(`TF_${region[0]}_FLAT`, region[0], "2025-06-21", "2026-06-20", "平", 11, 17, 0.86, 0.34);
  tariffInsert.run(`TF_${region[0]}_VALLEY`, region[0], "2025-06-21", "2026-06-20", "谷", 0, 7, 0.42, 0.24);
}

const holidayMap = new Map([
  ["2025-10-01", "国庆节"],
  ["2025-10-02", "国庆节"],
  ["2025-10-03", "国庆节"],
  ["2026-01-01", "元旦"],
  ["2026-02-17", "春节"],
  ["2026-02-18", "春节"],
  ["2026-02-19", "春节"],
  ["2026-04-05", "清明节"],
  ["2026-05-01", "劳动节"],
  ["2026-06-19", "端午节"]
]);

const calendarInsert = db.prepare("INSERT INTO dim_calendar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const weatherInsert = db.prepare("INSERT INTO fact_weather_daily VALUES (?, ?, ?, ?, ?, ?, ?)");
const calendars = [];

for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
  const date = iso(d);
  const day = d.getDay();
  const isWeekend = day === 0 || day === 6;
  const holiday = holidayMap.get(date) || null;
  const isHoliday = Boolean(holiday);
  const week = Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + new Date(d.getFullYear(), 0, 1).getDay() + 1) / 7);
  calendars.push({ date, isWeekend, isHoliday, month: d.getMonth() + 1 });
  calendarInsert.run(date, d.getFullYear(), d.getMonth() + 1, week, day || 7, isWeekend || isHoliday ? 0 : 1, isWeekend ? 1 : 0, isHoliday ? 1 : 0, holiday, 0, "凌晨/早高峰/日间/晚高峰/夜间");
  for (const region of regions) {
    const summer = d.getMonth() >= 5 && d.getMonth() <= 8;
    const rain = Math.random() < (summer ? 0.22 : 0.14);
    const severe = summer && Math.random() < 0.03;
    const maxTemp = summer ? rand(29, 38) : rand(8, 26);
    weatherInsert.run(date, region[0], severe ? "高温" : rain ? "雨" : pick(["晴", "阴", "多云"]), maxTemp - rand(5, 11), maxTemp, rain ? rand(2, 38) : 0, severe ? 1 : 0);
  }
}

const dailyInsert = db.prepare("INSERT INTO fact_station_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const sessionInsert = db.prepare("INSERT INTO fact_charging_session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const faultInsert = db.prepare("INSERT INTO fact_fault_ticket VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const maintenanceInsert = db.prepare("INSERT INTO fact_maintenance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

const typeFactor = {
  "商业综合体": 1.18,
  "社区": 0.92,
  "园区": 1.02,
  "交通枢纽": 1.32,
  "公共停车场": 0.82
};
const tagFactor = {
  "商务办公": 1.12,
  "商业居住": 1.05,
  "核心商圈": 1.26,
  "居住社区": 0.9,
  "产业园": 0.96,
  "交通枢纽": 1.2
};
const faultTypes = ["离线", "支付失败", "枪线异常", "过温", "通信异常"];
const teams = ["浦东一组", "浦西一组", "虹桥运维组", "临港运维组"];
const userSegments = ["私家车", "网约车", "出租车", "物流车"];
const vehicleTypes = ["纯电轿车", "纯电 SUV", "商用车"];
let sessionNo = 1;
let faultNo = 1;
let maintenanceNo = 1;

db.exec("BEGIN TRANSACTION");
for (const dayInfo of calendars) {
  const season = dayInfo.month >= 6 && dayInfo.month <= 8 ? 1.12 : dayInfo.month <= 2 ? 1.05 : 1;
  for (const station of stations) {
    const base = station.chargerCount * rand(1.8, 3.6) * (typeFactor[station.stationType] || 1) * (tagFactor[station.regionTag] || 1) * season;
    const weekendFactor = dayInfo.isHoliday ? 1.18 : dayInfo.isWeekend ? (station.stationType === "社区" ? 1.16 : 0.92) : (station.stationType === "园区" ? 1.14 : 1);
    const statusFactor = station.status === "低利用" ? 0.55 : station.status === "维护中" ? 0.72 : station.status === "高负荷" ? 1.32 : 1;
    const orders = Math.max(0, Math.round(base * weekendFactor * statusFactor * rand(0.78, 1.24)));
    const avgMinutes = station.stationType === "交通枢纽" ? rand(34, 50) : rand(42, 72);
    const totalMinutes = Math.round(orders * avgMinutes);
    const energy = Math.round(orders * rand(24, 46) * 10) / 10;
    const serviceRatio = rand(0.19, 0.28);
    const revenue = Math.round(energy * rand(1.08, 1.58) * 100) / 100;
    const service = Math.round(revenue * serviceRatio * 100) / 100;
    const electricity = Math.round((revenue - service) * 100) / 100;
    const faultCount = Math.random() < (station.status === "维护中" ? 0.13 : station.status === "低利用" ? 0.06 : 0.035) ? randInt(1, 3) : 0;
    const offline = faultCount ? randInt(45, 420) : randInt(0, 30);
    const utilization = clamp(totalMinutes / (station.chargerCount * 1440), 0.02, 0.86);
    const health = clamp(96 - faultCount * 8 - offline / 90 - Math.max(0, 0.18 - utilization) * 80 + rand(-3, 3), 42, 99);
    const activeChargers = Math.max(1, Math.min(station.chargerCount, Math.round(station.chargerCount * clamp(utilization * 2.4, 0.35, 0.98))));
    dailyInsert.run(dayInfo.date, station.id, station.regionId, orders, activeChargers, totalMinutes, energy, revenue, electricity, service, orders ? revenue / orders : 0, utilization, faultCount, offline, health);

    const sampleSessions = Math.min(orders, randInt(1, 2));
    for (let s = 0; s < sampleSessions; s++) {
      const hour = pick([1, 7, 8, 9, 12, 15, 18, 19, 20, 22]);
      const minutes = Math.round(clamp(avgMinutes * rand(0.55, 1.4), 12, 120));
      const startTime = `${dayInfo.date} ${pad(hour)}:${pad(randInt(0, 59))}:00`;
      const endHour = (hour + Math.floor((minutes + 30) / 60)) % 24;
      const endTime = `${dayInfo.date} ${pad(endHour)}:${pad(randInt(0, 59))}:00`;
      const kwh = Math.round(rand(15, 62) * 10) / 10;
      const fee = Math.round(kwh * rand(1.05, 1.65) * 100) / 100;
      const svc = Math.round(fee * rand(0.18, 0.3) * 100) / 100;
      const period = hour >= 8 && hour < 11 || hour >= 17 && hour < 21 ? "峰" : hour < 7 ? "谷" : "平";
      sessionInsert.run(`SE_${String(sessionNo++).padStart(8, "0")}`, pick(chargersByStation.get(station.id)), station.id, station.regionId, pick(userSegments), pick(vehicleTypes), startTime, endTime, minutes, kwh, fee - svc, svc, fee, "已支付", "完成", period);
    }

    for (let f = 0; f < faultCount; f++) {
      const ticketId = `FT_${String(faultNo++).padStart(7, "0")}`;
      const hour = randInt(6, 22);
      const created = `${dayInfo.date} ${pad(hour)}:${pad(randInt(0, 59))}:00`;
      const response = randInt(18, 95);
      const repair = randInt(45, 260);
      const level = repair > 190 ? "高" : repair > 100 ? "中" : "低";
      const lost = Math.round((revenue / Math.max(orders, 1)) * rand(2, 8) * 100) / 100;
      faultInsert.run(ticketId, pick(chargersByStation.get(station.id)), station.id, station.regionId, pick(faultTypes), level, created, `${dayInfo.date} ${pad(Math.min(23, hour + Math.ceil((response + repair) / 60)))}:${pad(randInt(0, 59))}:00`, "已解决", response + repair, lost);
      maintenanceInsert.run(`MT_${String(maintenanceNo++).padStart(7, "0")}`, ticketId, station.id, pick(teams), created, `${dayInfo.date} ${pad(Math.min(23, hour + 1))}:${pad(randInt(0, 59))}:00`, `${dayInfo.date} ${pad(Math.min(23, hour + 3))}:${pad(randInt(0, 59))}:00`, pick(["远程重启", "现场维修", "更换模块"]), pick(["已恢复", "需复检", "待备件"]), response, repair);
    }
  }
}
db.exec("COMMIT");

db.exec(`
CREATE INDEX idx_station_region ON dim_station(region_id);
CREATE INDEX idx_daily_date ON fact_station_daily(stat_date);
CREATE INDEX idx_daily_region ON fact_station_daily(region_id);
CREATE INDEX idx_session_start ON fact_charging_session(start_time);
CREATE INDEX idx_session_station ON fact_charging_session(station_id);
CREATE INDEX idx_fault_created ON fact_fault_ticket(created_at);
ANALYZE;
`);
db.close();

console.log(`Generated ${dbPath}`);
console.log(`Regions: ${regions.length}, Stations: ${stations.length}`);
