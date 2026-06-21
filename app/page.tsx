"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, Database, Download, Lock, MapPin, Send, Sparkles, Zap } from "lucide-react";
import type { ChartSpec, QueryResponse } from "@/lib/query/types";
import type { GeoJSON as LeafletGeoJSON, LatLngBoundsExpression, Map as LeafletMap, Marker, Rectangle } from "leaflet";

type Station = {
  station_id: string;
  station_name: string;
  region_id: string;
  region_name: string;
  map_x: number;
  map_y: number;
  lng: number;
  lat: number;
  station_type: string;
  status: string;
  charger_count: number;
  revenue30d: number;
  orders30d: number;
  utilization30d: number;
  faults30d: number;
  health_score: number;
};

type Overview = {
  kpi: {
    orders: number;
    revenue: number;
    utilization: number;
    faults: number;
    stations: number;
  };
  regions: {
    region_id: string;
    region_name: string;
    map_x: number;
    map_y: number;
    revenue: number;
    utilization: number;
  }[];
};

type Message = {
  role: "user" | "assistant";
  text: string;
  response?: QueryResponse;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const exportFieldLabels: Record<string, string> = {
  station_name: "站点",
  region_name: "区域",
  total_revenue: "营业额",
  revenue: "营业额",
  sample_loss: "亏损额",
  example_loss: "亏损额",
  loss_amount: "亏损额",
  sample_net_profit_rate: "净利率",
  example_net_profit_rate: "净利率",
  net_profit_rate: "净利率",
  profit_margin: "净利率",
  running_total: "累计营业额",
  overall_total: "总营业额",
  running_share: "累计占比",
  rank: "排名",
  order_count: "订单量",
  utilization_rate: "利用率",
  fault_count: "故障次数",
  lost_revenue_estimate: "故障损失估算"
};

function exportLabel(key: string) {
  return exportFieldLabels[key] || exportFieldLabels[key.toLowerCase()] || key;
}

function localizeExportRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "station_id") continue;
      next[exportLabel(key)] = value;
    }
    return next;
  });
}

function localizeExportColumns(columns: string[], rows: Record<string, unknown>[]) {
  const localized = columns.filter((column) => column !== "station_id").map(exportLabel);
  if (localized.length > 0) return [...new Set(localized)];
  return Object.keys(localizeExportRows(rows)[0] || {});
}

function tableToHtml(columns: string[], rows: Record<string, unknown>[]) {
  return `<table border="1"><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 48) || "chargebi-export";
}

function downloadExcelHtml(fileName: string, sections: { title: string; columns: string[]; rows: Record<string, unknown>[]; chart?: ChartSpec | null; summary?: string }[]) {
  const sheets = sections.map((section) => {
    const tableRows = localizeExportRows(section.rows);
    const tableColumns = localizeExportColumns(section.columns, section.rows);
    const chartRows = localizeExportRows(section.chart?.data || []);
    const chartColumns = section.chart ? localizeExportColumns([...new Set([section.chart.xKey, section.chart.yKey, section.chart.sizeKey, ...(section.chart.seriesKeys || [])].filter(Boolean) as string[])], section.chart.data) : [];
    return `
      <h2>${escapeHtml(section.title)}</h2>
      ${section.summary ? `<p>${escapeHtml(section.summary.replace(/\*\*/g, ""))}</p>` : ""}
      <h3>数据表</h3>
      ${tableToHtml(tableColumns, tableRows)}
      ${section.chart ? `
        <h3>可视化配置</h3>
        ${tableToHtml(["图表标题", "图表类型", "X轴", "Y轴", "气泡大小/系列"], [{
          图表标题: section.chart.title,
          图表类型: section.chart.type,
          X轴: exportLabel(section.chart.xKey),
          Y轴: exportLabel(section.chart.yKey),
          "气泡大小/系列": section.chart.sizeKey ? exportLabel(section.chart.sizeKey) : (section.chart.seriesKeys || []).map(exportLabel).join(", ")
        }])}
        <h3>图表数据</h3>
        ${tableToHtml(chartColumns, chartRows)}
      ` : ""}
    `;
  }).join("<br style='page-break-before:always' />");
  const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body>${sheets}</body></html>`;
  const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(fileName)}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const suggestions = [
  "最近 30 天各区域充电收入排名如何？",
  "哪些站点利用率最低，可能需要优化？",
  "上周故障率最高的 5 个站点是哪些？",
  "未来 7 天哪些站点可能出现高峰压力？"
];

const adminRegionNames = ["浦东新区", "徐汇区", "静安区", "黄浦区", "闵行区", "嘉定区", "松江区"];

const adminRegionAliases: Record<string, string[]> = {
  浦东新区: ["浦东新区", "陆家嘴", "张江"],
  黄浦区: ["黄浦区", "人民广场"],
  闵行区: ["闵行区", "虹桥枢纽"],
  徐汇区: ["徐汇区"],
  静安区: ["静安区"],
  嘉定区: ["嘉定区"],
  松江区: ["松江区"]
};

const regionBounds: Record<string, [[number, number], [number, number]]> = {
  虹桥枢纽: [[31.165, 121.275], [31.245, 121.385]],
  松江区: [[30.94, 121.13], [31.12, 121.32]],
  人民广场: [[31.205, 121.445], [31.255, 121.505]],
  闵行区: [[31.02, 121.28], [31.20, 121.48]],
  浦东新区: [[31.10, 121.48], [31.34, 121.75]],
  静安区: [[31.205, 121.425], [31.275, 121.485]],
  黄浦区: [[31.185, 121.455], [31.255, 121.515]],
  徐汇区: [[31.135, 121.39], [31.225, 121.475]],
  嘉定区: [[31.25, 121.18], [31.46, 121.38]],
  陆家嘴: [[31.215, 121.485], [31.255, 121.535]],
  张江: [[31.16, 121.55], [31.25, 121.66]],
  临港新片区: [[30.82, 121.82], [31.02, 122.05]]
};

function money(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return `${value.toFixed(0)} 元`;
}

function percent(value: number) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function statusClass(status: string) {
  if (status.includes("高负荷")) return "status-高负荷";
  if (status.includes("低利用")) return "status-低利用";
  if (status.includes("维护")) return "status-维护中";
  if (status.includes("故障")) return "status-故障";
  return "status-正常";
}

function stationBelongsToSelectedAdmin(station: Station, selectedRegionName: string | null) {
  if (!selectedRegionName) return true;
  const aliases = adminRegionAliases[selectedRegionName] || [selectedRegionName];
  return aliases.includes(station.region_name);
}

function pointInRing(lng: number, lat: number, ring: number[][]) {
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

function pointInPolygon(lng: number, lat: number, coordinates: number[][][]) {
  if (!coordinates.length) return false;
  const [outer, ...holes] = coordinates;
  if (!pointInRing(lng, lat, outer)) return false;
  return !holes.some((hole) => pointInRing(lng, lat, hole));
}

function pointInGeometry(lng: number, lat: number, geometry: GeoJSON.Geometry | null | undefined) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(lng, lat, geometry.coordinates as number[][][]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).some((polygon) => pointInPolygon(lng, lat, polygon));
  return false;
}

function findDistrictFeature(districtGeoJson: GeoJSON.FeatureCollection | null, selectedRegionName: string | null) {
  if (!districtGeoJson || !selectedRegionName) return null;
  return districtGeoJson.features.find((feature) => {
    const props = feature.properties as Record<string, unknown> | null;
    const name = String(props?.name || props?.fullname || "");
    return name === selectedRegionName || name.includes(selectedRegionName) || selectedRegionName.includes(name);
  }) || null;
}

function SimpleChart({ response, chart: explicitChart, onFocusStation }: { response?: QueryResponse; chart?: ChartSpec | null; onFocusStation: (stationId: string) => void }) {
  const chart = explicitChart ?? response?.answer.chart;
  if (!chart || chart.data.length === 0) return null;
  const max = Math.max(...chart.data.map((item) => Number(item[chart.yKey]) || 0), 1);
  const width = 640;
  const height = 240;
  const pad = 42;
  const labelArea = 48;
  const barWidth = Math.max(18, (width - pad * 2) / chart.data.length - 10);
  const shortLabel = (value: unknown) => {
    const text = String(value ?? "");
    return text.length > 7 ? `${text.slice(0, 6)}…` : text;
  };
  const fullLabel = (value: unknown) => String(value ?? "");
  const formatValue = (value: number) => {
    if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1)}万`;
    if (Math.abs(value) < 1) return `${(value * 100).toFixed(1)}%`;
    return String(Math.round(value));
  };
  const formatTotal = (value: number, key: string) => /占比|比例/.test(key) ? `${(value * 100).toFixed(0)}%` : formatValue(value);
  const colors = ["#ad3f09", "#d98c61", "#1f8a7a", "#7b6aa8", "#6c7a89", "#e2a96f", "#3f7f7b", "#bd6c3a"];

  if (chart.type === "table") return null;

  if (chart.type === "comparison") {
    const series = chart.seriesKeys || [];
    const colors = ["#ad3f09", "#1f8a7a", "#6c7a89"];
    const metrics = chart.data;
    const groupWidth = (width - pad * 2) / Math.max(metrics.length, 1);
    const barWidth = Math.max(10, Math.min(24, (groupWidth - 18) / Math.max(series.length, 1)));

    return (
      <div className="chart-box comparison-chart">
        <div className="section-title">
          <Activity size={16} />
          {chart.title}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="230" role="img" aria-label={chart.title}>
          <line x1={pad} y1={height - pad - labelArea} x2={width - pad} y2={height - pad - labelArea} stroke="#eadfd6" />
          {metrics.map((item, metricIndex) => {
            const groupX = pad + metricIndex * groupWidth + groupWidth / 2;
            const metricMax = Math.max(...series.map((key) => Math.abs(Number(item[key]) || 0)), 1);
            return (
              <g key={String(item["指标"])}>
                {series.map((key, seriesIndex) => {
                  const raw = Number(item[key]) || 0;
                  const h = (Math.abs(raw) / metricMax) * (height - pad * 2 - labelArea);
                  const x = groupX - (series.length * barWidth + (series.length - 1) * 5) / 2 + seriesIndex * (barWidth + 5);
                  const y = height - pad - labelArea - h;
                  return (
                    <g key={key}>
                      <rect x={x} y={y} width={barWidth} height={h} rx="5" fill={colors[seriesIndex % colors.length]} opacity={key === "差值" ? 0.72 : 0.95} />
                      <text x={x + barWidth / 2} y={Math.max(12, y - 6)} textAnchor="middle" fontSize="10" fontWeight="700" fill="#4a3227">
                        {formatValue(raw)}
                      </text>
                    </g>
                  );
                })}
                <text x={groupX} y={height - pad - labelArea + 18} textAnchor="middle" fontSize="11" fill="#746b64">
                  {shortLabel(item["指标"])}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="chart-legend-row">
          {series.map((key, index) => (
            <span key={key}>
              <i style={{ background: colors[index % colors.length] }} />
              {key}
            </span>
          ))}
        </div>
        <div className="notice">对比图基于查询结果表自动编排，包含最高、最低和差值。</div>
      </div>
    );
  }

  if (chart.type === "pie") {
    const total = chart.data.reduce((sum, item) => sum + Math.max(0, Number(item[chart.yKey]) || 0), 0) || 1;
    let current = -Math.PI / 2;
    const cx = 165;
    const cy = 118;
    const radius = 82;
    const arcPath = (start: number, end: number) => {
      const x1 = cx + radius * Math.cos(start);
      const y1 = cy + radius * Math.sin(start);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const largeArc = end - start > Math.PI ? 1 : 0;
      return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    };

    return (
      <div className="chart-box pie-chart">
        <div className="section-title">
          <Activity size={16} />
          {chart.title}
        </div>
        <div className="pie-layout">
          <svg viewBox="0 0 330 236" width="56%" height="236" role="img" aria-label={chart.title}>
            {chart.data.map((item, index) => {
              const value = Math.max(0, Number(item[chart.yKey]) || 0);
              const angle = (value / total) * Math.PI * 2;
              const start = current;
              const end = current + angle;
              current = end;
              return <path key={index} d={arcPath(start, end)} fill={colors[index % colors.length]} stroke="#fffdfa" strokeWidth="3" />;
            })}
            <circle cx={cx} cy={cy} r="38" fill="#fffdfa" />
            <text x={cx} y={cy - 4} textAnchor="middle" fontSize="13" fontWeight="800" fill="#4a3227">合计</text>
            <text x={cx} y={cy + 16} textAnchor="middle" fontSize="13" fill="#746b64">{formatTotal(total, chart.yKey)}</text>
          </svg>
          <div className="pie-legend">
            {chart.data.map((item, index) => {
              const value = Number(item[chart.yKey]) || 0;
              return (
                <div key={index} className="pie-legend-item">
                  <i style={{ background: colors[index % colors.length] }} />
                  <span title={fullLabel(item[chart.xKey])}>{fullLabel(item[chart.xKey])}</span>
                  <strong>{((value / total) * 100).toFixed(1)}%</strong>
                </div>
              );
            })}
          </div>
        </div>
        <div className="notice">{chart.xKey} / {chart.yKey} · 占比类问题自动使用饼图。</div>
      </div>
    );
  }

  if (chart.type === "bubble") {
    const sizeKey = chart.sizeKey || chart.yKey;
    const xs = chart.data.map((item) => Number(item[chart.xKey]) || 0);
    const ys = chart.data.map((item) => Number(item[chart.yKey]) || 0);
    const ss = chart.data.map((item) => Math.abs(Number(item[sizeKey]) || 0));
    const maxX = Math.max(...xs, 1);
    const minX = Math.min(...xs, 0);
    const maxY = Math.max(...ys, 1);
    const minY = Math.min(...ys, 0);
    const maxS = Math.max(...ss, 1);
    const chartHeight = height - pad * 2 - labelArea;
    const labelKey = chart.data[0]?.["站点"] !== undefined ? "站点" : chart.data[0]?.["区域"] !== undefined ? "区域" : chart.xKey;

    return (
      <div className="chart-box bubble-chart">
        <div className="section-title">
          <Activity size={16} />
          {chart.title}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="230" role="img" aria-label={chart.title}>
          <line x1={pad} y1={height - pad - labelArea} x2={width - pad} y2={height - pad - labelArea} stroke="#eadfd6" />
          <line x1={pad} y1={pad} x2={pad} y2={height - pad - labelArea} stroke="#eadfd6" />
          {chart.data.map((item, index) => {
            const rawX = Number(item[chart.xKey]) || 0;
            const rawY = Number(item[chart.yKey]) || 0;
            const rawS = Math.abs(Number(item[sizeKey]) || 0);
            const x = pad + ((rawX - minX) / Math.max(maxX - minX, 1)) * (width - pad * 2);
            const y = height - pad - labelArea - ((rawY - minY) / Math.max(maxY - minY, 1)) * chartHeight;
            const r = 8 + (rawS / maxS) * 18;
            return (
              <g key={index}>
                <circle cx={x} cy={y} r={r} fill={colors[index % colors.length]} opacity="0.72" stroke="#fffdfa" strokeWidth="2" />
                <text x={x + r + 4} y={y + 4} fontSize="10" fill="#4a3227">
                  {shortLabel(item[labelKey])}
                </text>
              </g>
            );
          })}
          <text x={width - pad} y={height - pad - labelArea + 28} textAnchor="end" fontSize="11" fill="#746b64">{chart.xKey}</text>
          <text x={pad} y={pad - 12} textAnchor="start" fontSize="11" fill="#746b64">{chart.yKey}</text>
        </svg>
        <div className="notice">{chart.xKey} / {chart.yKey} / 气泡大小：{sizeKey} · 影响权重类问题自动使用气泡分布图。</div>
      </div>
    );
  }

  const shouldTiltLabels = chart.data.length > 6 || chart.data.some((item) => fullLabel(item[chart.xKey]).length > 6);
  const barLabelArea = shouldTiltLabels ? 82 : labelArea;
  const barChartHeight = height - pad * 2 - barLabelArea;
  return (
    <div className="chart-box">
      <div className="section-title">
        <Activity size={16} />
        {chart.title}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="230" role="img" aria-label={chart.title}>
        <line x1={pad} y1={height - pad - barLabelArea} x2={width - pad} y2={height - pad - barLabelArea} stroke="#eadfd6" />
        {chart.type === "line" || chart.type === "forecast" ? (
          <polyline
            fill="none"
            stroke="#ad3f09"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={chart.data
              .map((item, index) => {
                const x = pad + (index / Math.max(chart.data.length - 1, 1)) * (width - pad * 2);
                const y = height - pad - barLabelArea - (Number(item[chart.yKey]) / max) * barChartHeight;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        ) : (
          chart.data.map((item, index) => {
            const value = Number(item[chart.yKey]) || 0;
            const h = (value / max) * barChartHeight;
            const x = pad + index * (barWidth + 10);
            const y = height - pad - barLabelArea - h;
            const stationId = typeof item.station_id === "string" ? item.station_id : null;
            const labelX = x + barWidth / 2;
            const labelY = height - pad - barLabelArea + 18;
            return (
              <g key={index} className={stationId ? "chart-clickable" : undefined} onClick={() => stationId && onFocusStation(stationId)}>
                <rect x={x} y={y} width={barWidth} height={h} rx="6" fill={index === 0 ? "#ad3f09" : "#d98c61"} />
                <text x={x + barWidth / 2} y={Math.max(14, y - 8)} textAnchor="middle" fontSize="11" fontWeight="700" fill="#4a3227">
                  {formatValue(value)}
                </text>
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor={shouldTiltLabels ? "end" : "middle"}
                  fontSize="10"
                  fill="#746b64"
                  transform={shouldTiltLabels ? `rotate(-35 ${labelX} ${labelY})` : undefined}
                >
                  {shouldTiltLabels ? fullLabel(item[chart.xKey]) : shortLabel(item[chart.xKey])}
                </text>
              </g>
            );
          })
        )}
      </svg>
      <div className="notice">{chart.xKey} / {chart.yKey} · 数据来自本地 SQLite 示例库，按当前 SQL 查询结果绘制。</div>
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  onFocusStation
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  onFocusStation: (stationId: string) => void;
}) {
  if (rows.length === 0) return null;
  const formatCell = (column: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return "-";
    const num = Number(value);
    if (Number.isFinite(num)) {
      if (/率|占比|比例/.test(column)) return `${(num * 100).toFixed(1)}%`;
      if (/营业额|收入|金额|损失|亏损|盈利|利润|费用/.test(column)) return num >= 10000 ? `${(num / 10000).toFixed(1)}万` : `${num.toFixed(0)}`;
      if (!Number.isInteger(num)) return num.toFixed(2);
    }
    return String(value);
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((row, index) => {
            const stationId = typeof row.station_id === "string" ? row.station_id : null;
            return (
              <tr key={index} className={stationId ? "clickable-row" : undefined} onClick={() => stationId && onFocusStation(stationId)}>
                {columns.map((column) => (
                  <td key={column}>{formatCell(column, row[column])}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const renderInline = (value: string) => {
    const emphasized = value.includes("**")
      ? value
      : value.replace(/(Top\d+|[-+]?\d+(?:\.\d+)?%|[-+]?\d+(?:\.\d+)?\s*万|[-+]?\d+(?:\.\d+)?\s*元|[-+]?\d+(?:\.\d+)?\s*单|[-+]?\d+(?:\.\d+)?)/g, "**$1**");
    const parts = emphasized.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      }
      return <span key={index}>{part}</span>;
    });
  };
  const hasMarkdownStructure = /\n\s*- |\*\*[^*]+\*\*/.test(text);
  const normalizedText = hasMarkdownStructure
    ? text
    : `**结论**\n${text
        .split(/(?<=。|；|;)/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => `- ${item}`)
        .join("\n")}`;
  const lines = normalizedText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return (
    <div className="markdown-text">
      {lines.map((line, index) => {
        if (line.startsWith("### ")) return <h4 key={index}>{renderInline(line.slice(4))}</h4>;
        if (line.startsWith("## ")) return <h4 key={index}>{renderInline(line.slice(3))}</h4>;
        if (line.startsWith("# ")) return <h4 key={index}>{renderInline(line.slice(2))}</h4>;
        if (line.startsWith("- ")) return <div className="markdown-bullet" key={index}>{renderInline(line.slice(2))}</div>;
        return <p key={index}>{renderInline(line)}</p>;
      })}
    </div>
  );
}

function AnswerView({
  response,
  onFollowup,
  onClarify,
  onFocusStation
}: {
  response: QueryResponse;
  onFollowup: (text: string) => void;
  onClarify: (text: string, response: QueryResponse) => void;
  onFocusStation: (stationId: string) => void;
}) {
  const [clarificationText, setClarificationText] = useState("");
  const modelTrace = response.trust.schemaMatches.find((item) => item.table === "DeepSeek 意图识别");
  const modelStatus = response.trust.modelTrace;
  const isClarification = response.type === "clarification";
  const exportSections = (response.answer.blocks && response.answer.blocks.length > 0)
    ? response.answer.blocks.map((block) => ({
        title: block.title,
        columns: block.table.columns,
        rows: block.table.rows,
        chart: block.chart,
        summary: block.summary
      }))
    : [{
        title: response.answer.chart?.title || "ChargeBI 查询结果",
        columns: response.answer.table.columns,
        rows: response.answer.table.rows,
        chart: response.answer.chart,
        summary: response.answer.summary
      }];
  return (
    <div className="answer-card">
      <div className="answer-section">
        <div className="section-title">
          <Sparkles size={16} />
          我理解你的问题
        </div>
        <div className="notice">{response.understanding.interpretedQuestion}</div>
      </div>

      <div className="answer-section">
        <div className="section-title">
          <Bot size={16} />
          AI 分析结论
        </div>
        <MarkdownText text={response.answer.summary} />
      </div>

      {response.workflow.length > 0 && (
        <div className="answer-section">
          <div className="section-title">
            <Zap size={16} />
            问数链路
          </div>
          <div className="model-trace">
            {modelTrace
              ? `DeepSeek 已参与意图识别：${modelTrace.fields.join(" / ")}${modelStatus?.latencyMs ? ` · ${modelStatus.latencyMs}ms` : ""}`
              : modelStatus
                ? `DeepSeek 调用状态：${modelStatus.configured ? "已配置" : "未配置"} / ${modelStatus.called ? "已调用" : "未调用"} / ${modelStatus.ok ? "成功" : `失败${modelStatus.error ? `（${modelStatus.error}）` : ""}`}${modelStatus.latencyMs ? ` · ${modelStatus.latencyMs}ms` : ""}，当前使用规则兜底。`
                : "当前回答使用规则兜底链路，未获得可用模型识别结果。"}
          </div>
          <div className="workflow">
            {response.workflow.map((item) => (
              <div className="workflow-step" key={item.step}>
                <span className="workflow-dot" />
                {item.step}
              </div>
            ))}
          </div>
        </div>
      )}

      {response.answer.kpis.length > 0 && (
        <div className="answer-section">
          <div className="kpis">
            {response.answer.kpis.map((kpi) => (
              <div className="kpi-card" key={kpi.label}>
                <div className="kpi-label">{kpi.label}</div>
                <div className="kpi-value">{kpi.value}</div>
                {kpi.delta && <div className="kpi-delta">{kpi.delta}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {response.answer.blocks && response.answer.blocks.length > 1 ? (
        <div className="answer-section">
          <div className="section-heading">
            <div className="section-title">
              <Database size={16} />
              分析结果
            </div>
            <button className="export-btn" type="button" onClick={() => downloadExcelHtml("ChargeBI-全部分析结果", exportSections)}>
              <Download size={14} /> 导出全部
            </button>
          </div>
          <div className="result-blocks">
            {response.answer.blocks.map((block, index) => (
              <div className="result-block" key={`${block.title}-${index}`}>
                <div className="result-block-header">
                  <div className="result-block-title">{index === 0 ? `主要结果：${block.title}` : block.title}</div>
                  <button className="export-btn subtle" type="button" onClick={() => downloadExcelHtml(`ChargeBI-${block.title}`, [{
                    title: block.title,
                    columns: block.table.columns,
                    rows: block.table.rows,
                    chart: block.chart,
                    summary: block.summary
                  }])}>
                    <Download size={14} /> 导出
                  </button>
                </div>
                {block.summary && <MarkdownText text={block.summary} />}
                {block.kpis && block.kpis.length > 0 && (
                  <div className="mini-kpis">
                    {block.kpis.map((kpi) => (
                      <span key={`${block.title}-${kpi.label}`}><b>{kpi.label}</b>{kpi.value}</span>
                    ))}
                  </div>
                )}
                {block.chart && <SimpleChart chart={block.chart} onFocusStation={onFocusStation} />}
                <ResultTable columns={block.table.columns} rows={block.table.rows} onFocusStation={onFocusStation} />
              </div>
            ))}
          </div>
        </div>
      ) : response.answer.chart ? (
        <div className="answer-section">
          <div className="section-heading">
            <div className="section-title">
              <Activity size={16} />
              可视化结果
            </div>
            <button className="export-btn" type="button" onClick={() => downloadExcelHtml("ChargeBI-当前图表和数据", exportSections)}>
              <Download size={14} /> 导出 Excel
            </button>
          </div>
          <SimpleChart response={response} onFocusStation={onFocusStation} />
        </div>
      ) : null}

      {(!response.answer.blocks || response.answer.blocks.length <= 1) && response.answer.table.rows.length > 0 && (
        <div className="answer-section">
          <div className="section-heading">
            <div className="section-title">
              <Database size={16} />
              查询结果
            </div>
            <button className="export-btn" type="button" onClick={() => downloadExcelHtml("ChargeBI-当前查询结果", exportSections)}>
              <Download size={14} /> 导出 Excel
            </button>
          </div>
          <ResultTable columns={response.answer.table.columns} rows={response.answer.table.rows} onFocusStation={onFocusStation} />
        </div>
      )}

      {response.answer.followUps.length > 0 && (
        <div className="answer-section">
          <div className="section-title">{isClarification ? "可选澄清方向" : "继续追问"}</div>
          <div className="followups">
            {response.answer.followUps.map((item) => (
              <button className="followup" key={item} onClick={() => isClarification ? onClarify(item, response) : onFollowup(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      {isClarification && (
        <div className="answer-section clarification-box">
          <div className="section-title">补充说明后继续执行</div>
          <p className="notice">在这里补一句说明就行，我会把它并回刚才的问题继续查，不会当作一次全新的提问。</p>
          <form
            className="clarification-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = clarificationText.trim();
              if (!value) return;
              onClarify(value, response);
              setClarificationText("");
            }}
          >
            <input
              value={clarificationText}
              onChange={(event) => setClarificationText(event.target.value)}
              placeholder="例如：这里的他们指营业额最高的那些站点"
            />
            <button className="primary-btn" type="submit" disabled={!clarificationText.trim()}>
              <Send size={16} /> 继续执行
            </button>
          </form>
        </div>
      )}

      <div className="answer-section">
        <details>
          <summary>可信解释：Schema 匹配与 SQL</summary>
          {response.trust.schemaMatches.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>表</th>
                    <th>字段</th>
                    <th>置信度</th>
                    <th>理由</th>
                  </tr>
                </thead>
                <tbody>
                  {response.trust.schemaMatches.map((item) => (
                    <tr key={item.table}>
                      <td>{item.table}</td>
                      <td>{item.fields.join(", ")}</td>
                      <td>{item.confidence}</td>
                      <td>{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">该问题未进入数据库查询链路。</p>
          )}
          {response.trust.sql && <pre>{response.trust.sql.trim()}</pre>}
          <p className="notice">{response.trust.guardResult}</p>
        </details>
      </div>
    </div>
  );
}

function ChargeMap({
  overview,
  stations,
  highlightedStationIds,
  highlightedRegionIds,
  focusedStationId,
  selectedRegionName,
  selectedStation,
  onSelectStation,
  onSelectRegion,
  onClearRegion,
  onClearSelection
}: {
  overview: Overview | null;
  stations: Station[];
  highlightedStationIds: string[];
  highlightedRegionIds: string[];
  focusedStationId: string | null;
  selectedRegionName: string | null;
  selectedStation: Station | null;
  onSelectStation: (station: Station) => void;
  onSelectRegion: (regionName: string) => void;
  onClearRegion: () => void;
  onClearSelection: () => void;
}) {
  const [mapReady, setMapReady] = useState(false);
  const [districtGeoJson, setDistrictGeoJson] = useState<GeoJSON.FeatureCollection | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const regionBoxRef = useRef<Rectangle | LeafletGeoJSON | null>(null);

  useEffect(() => {
    let disposed = false;
    fetch("/geo/shanghai-districts-wgs84.json")
      .then((res) => {
        if (!res.ok) throw new Error(`GeoJSON 加载失败：${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!disposed) setDistrictGeoJson(data);
      })
      .catch(() => {
        if (!disposed) setDistrictGeoJson(null);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let map: LeafletMap | null = null;
    let markers: Marker[] = [];
    let disposed = false;

    async function initMap() {
      if (stations.length === 0) return;
      const L = await import("leaflet");
      if (disposed) return;

      const container = document.getElementById("chargebi-leaflet-map");
      if (!container) return;
      container.innerHTML = "";

      map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: true
      }).setView([31.22, 121.47], 10);
      mapRef.current = map;
      L.control.zoom({ position: "topright" }).addTo(map);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18
      }).addTo(map);

      map.on("click", () => {
        onClearSelection();
      });

      const bounds: LatLngBoundsExpression = stations.map((station) => [station.lat, station.lng]);
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 11 });

      markers = stations.map((station) => {
        const hasSelectedAdminRegion = Boolean(selectedRegionName && adminRegionAliases[selectedRegionName]);
        const selectedDistrictFeature = findDistrictFeature(districtGeoJson, selectedRegionName);
        const inSelectedAdminRegion = selectedDistrictFeature
          ? pointInGeometry(station.lng, station.lat, selectedDistrictFeature.geometry)
          : stationBelongsToSelectedAdmin(station, selectedRegionName);
        const hasAnyHighlight = highlightedStationIds.length > 0 || highlightedRegionIds.length > 0 || Boolean(focusedStationId) || hasSelectedAdminRegion;
        const highlighted = focusedStationId
          ? focusedStationId === station.station_id
          : hasSelectedAdminRegion
            ? inSelectedAdminRegion
            : highlightedStationIds.includes(station.station_id) || highlightedRegionIds.includes(station.region_id);
        const dimmed = hasAnyHighlight && !highlighted;
        const status = station.status.includes("高负荷")
          ? "high"
          : station.status.includes("低利用")
            ? "low"
            : station.status.includes("维护")
              ? "maintenance"
              : "normal";
        const size = highlighted ? 34 : Math.max(24, Math.min(30, 22 + Number(station.revenue30d) / 220000));
        const icon = L.divIcon({
          className: `charge-marker ${status} ${highlighted ? "highlight" : ""} ${dimmed ? "dimmed" : ""}`,
          html: `<span>⚡</span>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        });
        const marker = L.marker([station.lat, station.lng], { icon }).addTo(map!);
        marker.bindTooltip(`${station.station_name}<br/>${station.region_name} · ${station.status}`, { direction: "top" });
        marker.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          onSelectStation(station);
        });
        return marker;
      });

      if (selectedRegionName) {
        if (regionBoxRef.current) {
          regionBoxRef.current.remove();
          regionBoxRef.current = null;
        }
        const matchedFeature = findDistrictFeature(districtGeoJson, selectedRegionName);
        if (matchedFeature) {
          regionBoxRef.current = L.geoJSON(matchedFeature, {
            style: {
              color: "#ad3f09",
              weight: 3,
              opacity: 1,
              dashArray: "8 6",
              fillColor: "#ad3f09",
              fillOpacity: 0.08
            },
            interactive: false
          }).addTo(map);
          map.fitBounds(regionBoxRef.current.getBounds(), { padding: [36, 36], maxZoom: 13 });
        } else {
          const regionBoundsValue = regionBounds[selectedRegionName];
          if (regionBoundsValue) {
            regionBoxRef.current = L.rectangle(regionBoundsValue, {
              color: "#ad3f09",
              weight: 3,
              dashArray: "8 6",
              fillColor: "#ad3f09",
              fillOpacity: 0.08,
              interactive: false
            }).addTo(map);
            map.fitBounds(regionBoundsValue, { padding: [36, 36], maxZoom: 13 });
          }
        }
      }

      setMapReady(true);
    }

    initMap();

    return () => {
      disposed = true;
      markers.forEach((marker) => marker.remove());
      markers = [];
      if (regionBoxRef.current) {
        regionBoxRef.current.remove();
        regionBoxRef.current = null;
      }
      if (map) map.remove();
      mapRef.current = null;
    };
  }, [stations, highlightedStationIds, highlightedRegionIds, focusedStationId, selectedRegionName, districtGeoJson, onSelectStation, onClearSelection]);

  useEffect(() => {
    async function focusRegion() {
      if (!mapRef.current) return;
      const L = await import("leaflet");
      if (regionBoxRef.current) {
        regionBoxRef.current.remove();
        regionBoxRef.current = null;
      }

      if (!selectedRegionName) {
        if (stations.length > 0) {
          const bounds: LatLngBoundsExpression = stations.map((station) => [station.lat, station.lng]);
          mapRef.current.fitBounds(bounds, { padding: [28, 28], maxZoom: 11 });
        }
        return;
      }

      const matchedFeature = findDistrictFeature(districtGeoJson, selectedRegionName);

      if (matchedFeature) {
        regionBoxRef.current = L.geoJSON(matchedFeature, {
          style: {
            color: "#ad3f09",
            weight: 3,
            opacity: 1,
            dashArray: "8 6",
            fillColor: "#ad3f09",
            fillOpacity: 0.08
          },
          interactive: false
        }).addTo(mapRef.current);
        mapRef.current.fitBounds(regionBoxRef.current.getBounds(), { padding: [36, 36], maxZoom: 13 });
        return;
      }

      const bounds = regionBounds[selectedRegionName];
      if (!bounds) return;
      regionBoxRef.current = L.rectangle(bounds, {
        color: "#ad3f09",
        weight: 3,
        dashArray: "8 6",
        fillColor: "#ad3f09",
        fillOpacity: 0.08,
        interactive: false
      }).addTo(mapRef.current);
      mapRef.current.fitBounds(bounds, { padding: [36, 36], maxZoom: 13 });
    }

    focusRegion();
  }, [selectedRegionName, mapReady, districtGeoJson]);

  return (
    <div className="map-area">
      <div className="map-canvas">
        {stations.length === 0 && (
          <div className="map-empty-state">
            <h3>正在加载充电站点</h3>
            <p>如果这里长时间为空，请检查 `/api/stations` 是否返回站点数据。</p>
          </div>
        )}
        <div id="chargebi-leaflet-map" className="leaflet-map" />
        <div className="map-legend">
          <span><i className="legend-dot normal" />正常</span>
          <span><i className="legend-dot high" />高负荷</span>
          <span><i className="legend-dot low" />低利用</span>
          <span><i className="legend-dot maintenance" />维护</span>
        </div>
        <div className="region-shortcuts">
          <button className={!selectedRegionName ? "active" : ""} onClick={onClearRegion}>
            全区域
          </button>
          {adminRegionNames.map((regionName) => {
            const region = overview?.regions.find((item) => item.region_name === regionName);
            return (
            <button
              key={regionName}
              className={(region && highlightedRegionIds.includes(region.region_id)) || selectedRegionName === regionName ? "active" : ""}
              onClick={() => onSelectRegion(regionName)}
            >
              {regionName}
            </button>
            );
          })}
        </div>
        {selectedStation && <div className="station-detail">
          <h3>{selectedStation ? selectedStation.station_name : "上海都市圈示例充电网络"}</h3>
          <div className="notice">
            {selectedStation
              ? `${selectedStation.region_name} · ${selectedStation.station_type} · ${selectedStation.status}`
              : "点击地图上的区域或站点，可以把它作为下一轮问数上下文。"}
          </div>
          <div className="detail-grid">
            <div className="detail-item">
              <div className="detail-label">30天收入</div>
              <div className="detail-value">{selectedStation ? money(Number(selectedStation.revenue30d)) : money(Number(overview?.kpi.revenue || 0))}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">订单量</div>
              <div className="detail-value">{selectedStation ? selectedStation.orders30d : overview?.kpi.orders}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">利用率</div>
              <div className="detail-value">{selectedStation ? percent(Number(selectedStation.utilization30d)) : percent(Number(overview?.kpi.utilization || 0))}</div>
            </div>
            <div className="detail-item">
              <div className="detail-label">故障次数</div>
              <div className="detail-value">{selectedStation ? selectedStation.faults30d : overview?.kpi.faults}</div>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}

export default function Home() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<Record<string, unknown>>({});
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [selectedRegionName, setSelectedRegionName] = useState<string | null>(null);
  const [focusedStationId, setFocusedStationId] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let disposed = false;

    async function loadInitialData() {
      setDataLoading(true);
      setDataError(null);
      try {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 12000);
        const [overviewRes, stationRes] = await Promise.all([
          fetch("/api/overview", { cache: "no-store", signal: controller.signal }),
          fetch("/api/stations", { cache: "no-store", signal: controller.signal })
        ]);
        window.clearTimeout(timeoutId);
        if (!overviewRes.ok || !stationRes.ok) {
          throw new Error(`接口返回异常：overview ${overviewRes.status}, stations ${stationRes.status}`);
        }
        const [overviewData, stationData] = await Promise.all([overviewRes.json(), stationRes.json()]);
        if (disposed) return;
        setOverview(overviewData);
        setStations(Array.isArray(stationData.stations) ? stationData.stations : []);
      } catch (error) {
        if (disposed) return;
        setDataError(error instanceof Error && error.name === "AbortError" ? "初始化数据请求超时，请点击重试。" : error instanceof Error ? error.message : "初始化数据加载失败");
      } finally {
        if (!disposed) setDataLoading(false);
      }
    }

    loadInitialData();

    return () => {
      disposed = true;
    };
  }, [reloadToken]);

  const lastResponse = [...messages].reverse().find((message) => message.response)?.response;
  const highlightedStationIds = useMemo(() => lastResponse?.answer.mapHighlight.stationIds || [], [lastResponse]);
  const highlightedRegionIds = useMemo(() => lastResponse?.answer.mapHighlight.regionIds || [], [lastResponse]);

  async function ask(text: string, options?: { clarificationFor?: QueryResponse }) {
    const question = text.trim();
    if (!question || loading) return;
    const conversationTurns = messages.slice(-6).map((message) => ({
      role: message.role,
      text: message.text,
      intent: message.response?.understanding.intent,
      interpretedQuestion: message.response?.understanding.interpretedQuestion
    }));
    setInput("");
    setLoading(true);
    setMessages((prev) => [...prev, { role: "user", text: question }]);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          context: {
            ...context,
            selectedRegion: selectedRegionName,
            selectedStation: selectedStation?.station_id,
            conversationTurns,
            ...(options?.clarificationFor
              ? {
                  clarificationFor: {
                    originalQuestion: options.clarificationFor.understanding.interpretedQuestion,
                    pendingQuestion: options.clarificationFor.nextContext?.pendingClarification
                  }
                }
              : {})
          }
        })
      });
      const data = (await res.json()) as QueryResponse;
      setContext((prev) => ({ ...prev, ...(data.nextContext || {}) }));
      setFocusedStationId(null);
      setMessages((prev) => [...prev, { role: "assistant", text: data.answer.summary, response: data }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "查询暂时失败，请稍后重试，或从推荐问题开始。"
        }
      ]);
    } finally {
      setLoading(false);
    }
  }

  const clarify = useCallback((text: string, response: QueryResponse) => {
    ask(text, { clarificationFor: response });
  }, [context, selectedRegionName, selectedStation, messages, loading]);

  const selectRegion = useCallback((regionName: string) => {
    setSelectedRegionName(regionName);
    setSelectedStation(null);
    setFocusedStationId(null);
    setContext((prev) => ({ ...prev, selectedRegion: regionName }));
  }, []);

  const clearRegion = useCallback(() => {
    setSelectedRegionName(null);
    setSelectedStation(null);
    setFocusedStationId(null);
    setContext((prev) => {
      const next = { ...prev };
      delete next.selectedRegion;
      delete next.selectedStation;
      return next;
    });
  }, []);

  const selectStation = useCallback((station: Station) => {
    setSelectedStation(station);
    setFocusedStationId(station.station_id);
    setSelectedRegionName(station.region_name);
    setContext((prev) => ({ ...prev, selectedStation: station.station_id, selectedRegion: station.region_name }));
  }, []);

  const clearMapSelection = useCallback(() => {
    setSelectedStation(null);
    setFocusedStationId(null);
  }, []);

  const focusStationFromResult = useCallback((stationId: string) => {
    const station = stations.find((item) => item.station_id === stationId);
    setFocusedStationId(stationId);
    if (station) {
      setSelectedStation(station);
      setSelectedRegionName(station.region_name);
      setContext((prev) => ({ ...prev, selectedStation: station.station_id, selectedRegion: station.region_name }));
    }
  }, [stations]);

  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand-block">
            <div className="logo-mark">CB</div>
            <div>
              <h1 className="brand-title">ChargeBI ·新能源充电站运营问数助手</h1>
              <p className="brand-subtitle">在地图上看懂上海都市圈充电网络，不用等分析师，随时查数据。</p>
            </div>
          </div>
          <div className="demo-pill">公开数据结构 + 模拟运营数据 · 作品集 Demo</div>
        </header>

        <section className="workspace">
          <div className="panel chat-panel">
            <div className="chat-header">
              <h2>智能问数工作台</h2>
              <p>您的专属数据分析师，随时查询收入、利用率、故障、盈亏与增长机会。</p>
              {selectedRegionName && <div className="small-pill" style={{ marginTop: 12 }}>已选择区域：{selectedRegionName}</div>}
              {selectedStation && <div className="small-pill" style={{ marginTop: 12 }}>已选择站点：{selectedStation.station_name}</div>}
              <div className="suggestions">
                {suggestions.map((item) => (
                  <button className="suggestion" key={item} onClick={() => ask(item)}>
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="conversation">
              {messages.length === 0 && (
                <div className="message assistant">
                  <div className="bubble">
                    你好，我是 ChargeBI。你可以问我上海都市圈充电网络的收入、订单、利用率、故障、节假日表现和运营建议。
                  </div>
                </div>
              )}
              {messages.map((message, index) => (
                <div className={`message ${message.role}`} key={index}>
                  <div className="bubble">{message.role === "assistant" && message.response ? "已完成本次问数分析。" : message.text}</div>
                  {message.response && <AnswerView response={message.response} onFollowup={ask} onClarify={clarify} onFocusStation={focusStationFromResult} />}
                </div>
              ))}
              {loading && (
                <div className="message assistant">
                  <div className="bubble">正在理解问题、匹配 Schema 并生成查询...</div>
                </div>
              )}
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                ask(input);
              }}
            >
              <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="试试问：浦东和徐汇最近 30 天哪个区域利用率更高？" />
              <button className="primary-btn" type="submit" disabled={loading || !input.trim()}>
                <Send size={16} /> {input.trim() ? "发送" : "请输入问题"}
              </button>
            </form>
          </div>

          <div className="panel map-panel">
            <div className="map-header">
              <div>
                <h2>上海都市圈充电运营看板</h2>
                <p>站点运营状态一图掌握，点击行政区缩放下钻，核心指标一目了然。</p>
              </div>
              <div className="station-count-badge">
                <span className="station-count-icon">
                  <MapPin size={14} />
                </span>
                <span>{dataLoading ? "加载站点中" : `${stations.length} 个示例站点`}</span>
              </div>
            </div>

            <div className="overview-grid">
              <div className="kpi-card">
                <div className="kpi-label">30天订单</div>
                <div className="kpi-value">{dataLoading ? "..." : overview?.kpi.orders ?? "-"}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">30天收入</div>
                <div className="kpi-value">{dataLoading ? "..." : money(Number(overview?.kpi.revenue || 0))}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">平均利用率</div>
                <div className="kpi-value">{dataLoading ? "..." : percent(Number(overview?.kpi.utilization || 0))}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">故障次数</div>
                <div className="kpi-value">{dataLoading ? "..." : overview?.kpi.faults ?? "-"}</div>
              </div>
            </div>

            {dataError ? (
              <div className="map-area">
                <div className="map-empty-state">
                  <h3>地图数据加载失败</h3>
                  <p>{dataError}</p>
                  <button className="suggestion" onClick={() => setReloadToken((value) => value + 1)}>重新加载数据</button>
                </div>
              </div>
            ) : dataLoading ? (
              <div className="map-area">
                <div className="map-empty-state">
                  <h3>正在加载充电站点</h3>
                  <p>正在请求 `/api/overview` 和 `/api/stations`。如果超过 12 秒仍未完成，会显示错误原因。</p>
                  <button className="suggestion" onClick={() => setReloadToken((value) => value + 1)}>重试加载</button>
                </div>
              </div>
            ) : (
              <ChargeMap
                overview={overview}
                stations={stations}
                highlightedStationIds={highlightedStationIds}
                highlightedRegionIds={highlightedRegionIds}
                focusedStationId={focusedStationId}
                selectedRegionName={selectedRegionName}
                selectedStation={selectedStation}
                onSelectStation={selectStation}
                onSelectRegion={selectRegion}
                onClearRegion={clearRegion}
                onClearSelection={clearMapSelection}
              />
            )}
          </div>
        </section>

        <p className="notice" style={{ margin: "16px 8px 0" }}>
          <Lock size={13} /> 本 Demo 不查询手机号、车牌或可识别个人身份的数据。所有运营数据均为示例数据。
        </p>
      </div>
    </main>
  );
}
