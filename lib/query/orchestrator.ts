import { all, get } from "@/lib/data/db";
import { schemaTables, sensitiveWords } from "@/lib/data/schema";
import { generateQueryPlanWithDeepSeek, interpretWithDeepSeek, summarizeWithDeepSeek, verifyAnswerWithDeepSeek, type AiAnswerAudit, type AiQueryPlan } from "@/lib/ai/deepseek";
import { guardSql } from "./guard";
import type { AnswerBlock, ChartSpec, QueryResponse } from "./types";

const today = "2026-06-20";

function workflow() {
  return [
    "理解问题",
    "识别指标、时间和区域",
    "匹配数据表和字段",
    "生成 SQL",
    "校验查询安全性",
    "执行查询",
    "生成分析结论"
  ].map((step) => ({ step, status: "completed" as const }));
}

function fmtMoney(value: number) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return `${value.toFixed(0)} 元`;
}

function fmtPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function blocked(question: string, reason: string, followUps: string[]): QueryResponse {
  return {
    type: "blocked",
    understanding: {
      intent: "blocked",
      interpretedQuestion: question
    },
    workflow: workflow().slice(0, 2),
    answer: {
      summary: reason,
      kpis: [],
      chart: null,
      table: { columns: [], rows: [] },
      mapHighlight: {},
      followUps
    },
    trust: {
      schemaMatches: [],
      sql: "",
      guardResult: "未进入 SQL 生成"
    },
    nextContext: {}
  };
}

function schemaMatch(tables: string[], reason: string) {
  return schemaTables
    .filter((item) => tables.includes(item.table))
    .map((item, index) => ({
      table: item.table,
      fields: item.fields,
      reason,
      confidence: Number((0.92 - index * 0.04).toFixed(2))
    }));
}

function runSql<T extends Record<string, unknown>>(sql: string): T[] {
  const guard = guardSql(sql);
  if (!guard.ok) throw new Error(guard.reason);
  return all<T>(sql);
}

function emptyBlockedFromPlan(question: string, plan: AiQueryPlan, trace: NonNullable<QueryResponse["trust"]["modelTrace"]>): QueryResponse {
  const needsClarification = !plan.missingData?.length && (plan.followUps?.length || /澄清|确认|明确|不确定|指代|对象|口径/.test(plan.reason || ""));
  if (needsClarification) {
    const response = clarification(
      question,
      plan.reason || "我需要补充一个关键信息，才能继续生成安全查询。",
      plan.followUps || ["补充分析对象", "补充时间范围", "补充指标口径"],
      {}
    );
    response.trust.modelTrace = trace;
    response.trust.schemaMatches = [
      {
        table: "DeepSeek QueryPlan",
        fields: plan.dimensions || plan.metrics || [],
        reason: plan.reason,
        confidence: 0.86
      },
      ...response.trust.schemaMatches
    ];
    return response;
  }
  return {
    type: "blocked",
    understanding: {
      intent: "data_unavailable_or_forbidden",
      interpretedQuestion: plan.interpretedQuestion || question,
      metrics: plan.metrics || [],
      dimensions: plan.dimensions || []
    },
    workflow: workflow(),
    answer: {
      summary: plan.reason || `当前数据库无法回答这个问题。${plan.missingData?.length ? `缺少数据：${plan.missingData.join("、")}` : ""}`,
      kpis: [],
      chart: null,
      table: { columns: [], rows: [] },
      mapHighlight: {},
      followUps: plan.followUps || ["换成收入、订单、利用率或故障相关问题", "查看最近 30 天各区域收入排名"]
    },
    trust: {
      modelTrace: trace,
      schemaMatches: [
        {
          table: "DeepSeek QueryPlan",
          fields: plan.missingData || [],
          reason: plan.reason,
          confidence: 0.9
        }
      ],
      sql: "",
      guardResult: "未生成 SQL：权限或数据可得性未通过"
    },
    nextContext: {}
  };
}

function tableColumns(rows: Record<string, unknown>[]) {
  const keys = new Set<string>();
  for (const row of rows) Object.keys(row).forEach((key) => keys.add(key));
  return [...keys].filter((key) => key !== "station_id").slice(0, 10);
}

const fieldLabels: Record<string, string> = {
  stat_date: "日期",
  date: "日期",
  station_name: "站点",
  region_name: "区域",
  total_revenue: "营业额",
  revenue: "营业额",
  top30_revenue: "前30站点营业额",
  total: "总营业额",
  order_count: "订单量",
  total_orders: "订单量",
  orders: "订单量",
  avg_utilization: "平均利用率",
  utilization_rate: "利用率",
  utilization: "利用率",
  fault_count: "故障次数",
  total_faults: "故障次数",
  faults: "故障次数",
  fault_rate: "故障率",
  lost_revenue_estimate: "故障损失",
  loss_amount: "亏损额",
  sample_loss: "亏损额",
  example_loss: "亏损额",
  profit: "盈利额",
  profit_margin: "净利率",
  sample_profit: "盈利额",
  example_profit: "盈利额",
  sample_net_profit_rate: "净利率",
  example_net_profit_rate: "净利率",
  net_profit_rate: "净利率",
  share: "占比",
  ratio: "占比",
  percentage: "占比"
};

function labelForField(key: string) {
  return fieldLabels[key] || fieldLabels[key.toLowerCase()] || key;
}

function localizeRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => {
    const localized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      localized[labelForField(key)] = value;
    }
    if (row.station_id !== undefined) localized.station_id = row.station_id;
    return localized;
  });
}

function localizeColumns(columns: string[]) {
  return columns.map(labelForField).filter((column, index, arr) => arr.indexOf(column) === index);
}

function normalizeResultRows(rows: Record<string, unknown>[]) {
  return localizeRows(rows).map(enrichStationMeta);
}

function chartWithLocalizedKeys(chart: ChartSpec | null): ChartSpec | null {
  if (!chart) return null;
  const xKey = labelForField(chart.xKey);
  const yKey = labelForField(chart.yKey);
  const sizeKey = chart.sizeKey ? labelForField(chart.sizeKey) : undefined;
  return {
    ...chart,
    xKey,
    yKey,
    sizeKey,
    data: localizeRows(chart.data)
  };
}

function pivotSingleMetricRow(row: Record<string, unknown>, columns: string[], text: string) {
  let numericKeys = columns.filter((key) => isNumericColumn([row], key));
  if (/营业额|收入|营收|流水/.test(text)) {
    numericKeys = numericKeys.filter((key) => /营业额|收入|营收|流水/.test(key));
  } else if (/订单/.test(text)) {
    numericKeys = numericKeys.filter((key) => /订单/.test(key));
  } else if (/利用率/.test(text)) {
    numericKeys = numericKeys.filter((key) => /利用率/.test(key));
  } else if (/故障/.test(text)) {
    numericKeys = numericKeys.filter((key) => /故障|损失/.test(key));
  }
  const nonNumericKeys = columns.filter((key) => !numericKeys.includes(key) && key !== "station_id");
  if (numericKeys.length < 2 || nonNumericKeys.length > 3) return null;
  return numericKeys.map((key) => ({ 指标: labelForField(key), 数值: Number(row[key]) || 0 }));
}

function isNumericColumn(rows: Record<string, unknown>[], key: string) {
  return rows.some((row) => row[key] !== null && row[key] !== undefined && row[key] !== "" && Number.isFinite(Number(row[key])));
}

function numericColumns(rows: Record<string, unknown>[], columns: string[]) {
  return columns.filter((key) => !["station_id", "站点", "区域", "子查询", "日期", "stat_date"].includes(key) && isNumericColumn(rows, key));
}

function inferChartSpec(
  question: string,
  subQuery: NonNullable<AiQueryPlan["subQueries"]>[number],
  rows: Record<string, unknown>[],
  columns: string[]
): ChartSpec | null {
  if (!rows.length) return null;
  const text = `${question} ${subQuery.name} ${subQuery.purpose}`;
  const nums = numericColumns(rows, columns);
  const pivoted = rows.length === 1 ? pivotSingleMetricRow(rows[0], columns, text) : null;
  const explicitlyNeedsChart = /图表|可视化|画图|趋势|走势|占比|构成|分布|对比|比较|差异|关系|相关|贡献/.test(text);
  if (pivoted) {
    if (!explicitlyNeedsChart && pivoted.length < 3) return null;
    return {
      type: "bar",
      title: subQuery.name,
      xKey: "指标",
      yKey: "数值",
      data: pivoted
    };
  }
  const xKey = subQuery.xKey && columns.includes(subQuery.xKey) ? subQuery.xKey : columns.find((key) => !nums.includes(key) && key !== "station_id") || columns[0] || "名称";
  const yKey = subQuery.yKey && columns.includes(subQuery.yKey) ? subQuery.yKey : nums[0] || columns[1] || "指标值";
  const dateKey = columns.find((key) => ["日期", "stat_date", "date", "day"].includes(key) || key.includes("日期"));
  const asksShare = /占比|比例|构成|结构|份额|分布/.test(text);
  const asksTrend = /趋势|走势|变化|每日|每天|按天|按周|周度|月度|环比/.test(text);
  const asksBubble = /影响|权重|贡献度|相关|关系|分布格局|矩阵|象限/.test(text);
  const hasComparisonValue = rows.length >= 2 || nums.length >= 2 || asksTrend || asksShare || asksBubble;
  if (!hasComparisonValue) return null;

  if ((subQuery.chartType === "bubble" || asksBubble) && rows.length >= 3 && nums.length >= 2) {
    const [bubbleX, bubbleY, bubbleSize] = nums;
    return {
      type: "bubble",
      title: subQuery.name,
      xKey: subQuery.xKey && nums.includes(subQuery.xKey) ? subQuery.xKey : bubbleX,
      yKey: subQuery.yKey && nums.includes(subQuery.yKey) ? subQuery.yKey : bubbleY,
      sizeKey: subQuery.sizeKey && nums.includes(subQuery.sizeKey) ? subQuery.sizeKey : bubbleSize || bubbleY,
      data: rows
    };
  }

  if ((subQuery.chartType === "pie" || asksShare) && rows.length >= 2 && nums.length >= 1) {
    return {
      type: "pie",
      title: subQuery.name,
      xKey,
      yKey,
      data: rows
    };
  }

  if ((subQuery.chartType === "line" || subQuery.chartType === "forecast" || asksTrend) && (dateKey || rows.length >= 3)) {
    return {
      type: subQuery.chartType === "forecast" ? "forecast" : "line",
      title: subQuery.name,
      xKey: dateKey || xKey,
      yKey,
      data: rows
    };
  }

  if (subQuery.chartType === "table" || !nums.length) {
    return {
      type: "table",
      title: subQuery.name,
      xKey,
      yKey,
      data: rows
    };
  }

  return {
    type: "bar",
    title: subQuery.name,
    xKey,
    yKey,
    data: rows
  };
}

function buildAnswerBlock(
  question: string,
  item: { name: string; rows: Record<string, unknown>[]; subQuery: NonNullable<AiQueryPlan["subQueries"]>[number] }
): AnswerBlock {
  const rows = normalizeResultRows(item.rows);
  const columns = tableColumns(rows);
  const numericKeys = numericColumns(rows, columns);
  const primaryMetric = numericKeys[0];
  const topRow = rows[0];
  const primaryValue = primaryMetric && topRow ? Number(topRow[primaryMetric]) : null;
  const formattedPrimaryValue =
    primaryMetric && Number.isFinite(primaryValue)
      ? /率|占比|比例/.test(primaryMetric)
        ? fmtPct(Number(primaryValue))
        : /营业额|收入|金额|损失|亏损|盈利|利润|费用/.test(primaryMetric)
          ? fmtMoney(Number(primaryValue))
          : Number(primaryValue).toFixed(2)
      : "";
  const entityKey = columns.find((key) => ["站点", "区域", "日期"].includes(key)) || columns.find((key) => key !== "station_id" && !numericKeys.includes(key));
  const entityValue = entityKey && topRow ? String(topRow[entityKey] ?? "") : "";
  const kpis = [
    { label: "返回行数", value: `${rows.length} 行` },
    ...(primaryMetric && formattedPrimaryValue
      ? [{ label: primaryMetric, value: formattedPrimaryValue }]
      : []),
    ...(entityValue ? [{ label: entityKey || "对象", value: entityValue }] : [])
  ].slice(0, 3);
  return {
    title: item.name,
    summary: `**${item.name}**\n- ${item.subQuery.purpose || "按当前子查询返回结果。"}\n- 返回 **${rows.length}** 行数据${entityValue ? `，首行对象为 **${entityValue}**` : ""}${primaryMetric && formattedPrimaryValue ? `，${primaryMetric} 为 **${formattedPrimaryValue}**` : ""}。`,
    kpis,
    chart: chartWithLocalizedKeys(inferChartSpec(question, item.subQuery, rows, columns)),
    table: {
      columns: localizeColumns(columns),
      rows
    }
  };
}

function timeWindowFromQuestion(question: string) {
  if (question.includes("两周") || question.includes("14天") || question.includes("十四天")) {
    return { label: "过去 14 天", sql: `date('${today}', '-14 day')` };
  }
  if (question.includes("一周") || question.includes("7天") || question.includes("七天")) {
    return { label: "过去 7 天", sql: `date('${today}', '-7 day')` };
  }
  return { label: "最近 30 天", sql: `date('${today}', '-30 day')` };
}

function topLimitFromQuestion(question: string, fallback = 10) {
  const nMatch =
    question.match(/(?:Top|top)\s*(\d+|一|二|两|三|四|五|六|七|八|九|十)/) ||
    question.match(/前\s*(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*(?:个|家|座)?\s*(?:站点|充电站|区域)/) ||
    question.match(/(?:最高|最多|最低|最少)的?\s*(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*(?:个|家|座)?\s*(?:站点|充电站|区域)?/) ||
    question.match(/(?:最高|最多)的?前\s*(\d+|一|二|两|三|四|五|六|七|八|九|十)\s*(?:个|家|座)?/);
  const nMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Math.min(20, Math.max(1, nMatch ? nMap[nMatch[1]] || Number(nMatch[1]) || fallback : fallback));
}

function hasInSentenceAntecedent(question: string) {
  const numberWord = "(?:\\d+|一|二|两|三|四|五|六|七|八|九|十)";
  const rankedObjectPatterns = [
    new RegExp(`(?:营业额|收入|营收|流水|亏损额|亏损|故障损失|故障|利用率|净利率).{0,10}(?:最高|最多|最低|最少).{0,8}(?:${numberWord}|Top|top)?\\s*(?:个|家|座)?\\s*(?:站点|充电站|区域|企业|运营商)?`),
    new RegExp(`(?:前|Top|top)\\s*${numberWord}\\s*(?:个|家|座)?\\s*(?:站点|充电站|区域|企业|运营商)`),
    new RegExp(`(?:最高|最多|最低|最少)的?\\s*${numberWord}\\s*(?:个|家|座)?\\s*(?:站点|充电站|区域|企业|运营商)`),
    /从前往后|从高到低|累计|累加|到\s*(?:Top|top)\s*几/,
    /这些站点|上述站点|该站点|该区域/
  ];
  return rankedObjectPatterns.some((pattern) => pattern.test(question));
}

function hasTwoComparableRankedSets(question: string) {
  const rankedMetrics = [
    "(?:营业额|收入|营收|流水)",
    "(?:亏损额|亏损额度|亏损额)"
  ];
  return rankedMetrics.filter((metric) => hasRankedMetricSet(question, metric)).length >= 2;
}

function timeWindowFromQuestionOrContext(question: string, context: Record<string, unknown>) {
  if (/两周|14天|十四天|一周|7天|七天|30天|三十天|最近/.test(question)) return timeWindowFromQuestion(question);
  const contextTime = typeof context.timeRange === "string" ? context.timeRange : "";
  if (contextTime.includes("14")) return { label: "过去 14 天", sql: `date('${today}', '-14 day')` };
  if (contextTime.includes("7")) return { label: "过去 7 天", sql: `date('${today}', '-7 day')` };
  return timeWindowFromQuestion(question);
}

function stationIdsFromContext(context: Record<string, unknown>) {
  if (Array.isArray(context.selectedStations)) return context.selectedStations.map(String).filter(Boolean);
  const blocks = Array.isArray(context.lastBlocks) ? context.lastBlocks as { rows?: Record<string, unknown>[] }[] : [];
  return blocks.flatMap((block) => block.rows || []).map((row) => row.station_id).filter(Boolean).map(String);
}

function sqlStringList(values: string[]) {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function hasRankedMetricSet(question: string, metricPattern: string) {
  const numberWord = "(?:\\d+|一|二|两|三|四|五|六|七|八|九|十)";
  const metricBeforeRank = new RegExp(`${metricPattern}.{0,8}(?:最高|最多|最低|最少|Top|top|前)\\s*${numberWord}?`);
  const rankBeforeMetric = new RegExp(`(?:最高|最多|最低|最少|Top|top|前)\\s*${numberWord}?.{0,8}${metricPattern}`);
  return metricBeforeRank.test(question) || rankBeforeMetric.test(question);
}

function answerLossTopFaultLossComparison(question: string, context: Record<string, unknown>): QueryResponse | null {
  const asksLossTop = hasRankedMetricSet(question, "(?:亏损额|亏损额度|亏损额)");
  const asksFaultLoss = /故障损失|故障.*损失|损失/.test(question);
  const asksCompareContext = /他们|这些|上述|比起来|相比|比较|对比/.test(question);
  if (!asksLossTop || !asksFaultLoss || !asksCompareContext) return null;

  const referenceStationIds = [...new Set(stationIdsFromContext(context))];
  if (referenceStationIds.length === 0) {
    return clarification(
      question,
      "你要把亏损额 Top 站点和“他们”对比，但当前上下文里没有可继承的站点集合。",
      ["先查前两周营业额 Top10 站点", "明确要对比的站点列表"],
      context
    );
  }

  const limit = topLimitFromQuestion(question, 10);
  const time = timeWindowFromQuestionOrContext(question, context);
  const referenceIdsSql = sqlStringList(referenceStationIds);
  const baseCte = `
WITH fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE created_at >= ${time.sql}
  GROUP BY station_id
),
station_finance AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         ROUND(COALESCE(f.故障损失估算, 0), 2) AS 故障损失估算,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算,
         ROUND(MAX(0, COALESCE(f.故障损失估算, 0) + SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8 - SUM(d.service_revenue)), 2) AS 亏损额
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  LEFT JOIN fault_loss f ON f.station_id = d.station_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name, f.故障损失估算
)`;
  const lossTopSql = `${baseCte}
SELECT station_id, 站点, 区域, 营业额, 故障损失估算, 运维成本估算, 亏损额
FROM station_finance
ORDER BY 亏损额 DESC
LIMIT ${limit}`;
  const referenceSql = `${baseCte}
SELECT station_id, 站点, 区域, 营业额, 故障损失估算, 运维成本估算, 亏损额
FROM station_finance
WHERE station_id IN (${referenceIdsSql})
ORDER BY 故障损失估算 DESC
LIMIT ${Math.min(20, referenceStationIds.length)}`;
  const lossRows = normalizeResultRows(runSql(lossTopSql));
  const referenceRows = normalizeResultRows(runSql(referenceSql));
  const lossFaultTotal = lossRows.reduce((sum, row) => sum + Number(row["故障损失估算"] || 0), 0);
  const referenceFaultTotal = referenceRows.reduce((sum, row) => sum + Number(row["故障损失估算"] || 0), 0);
  const diff = lossFaultTotal - referenceFaultTotal;
  const columns = ["站点", "区域", "营业额", "故障损失估算", "运维成本估算", "亏损额"];
  const comparisonRows = [
    { 对象: `亏损额 Top${limit} 站点`, 故障损失估算: lossFaultTotal, 站点数: lossRows.length },
    { 对象: "上一轮站点集合", 故障损失估算: referenceFaultTotal, 站点数: referenceRows.length },
    { 对象: "差值", 故障损失估算: Number(diff.toFixed(2)), 站点数: "-" }
  ];
  const chart: ChartSpec = {
    type: "bar",
    title: `亏损额 Top${limit} vs 上一轮站点故障损失`,
    xKey: "对象",
    yKey: "故障损失估算",
    data: comparisonRows
  };

  return {
    type: "answer",
    understanding: {
      intent: "contextual_loss_top_fault_loss_comparison",
      interpretedQuestion: `查询${time.label}亏损额最高 Top${limit} 站点的故障损失，并与上一轮站点集合的故障损失对比`,
      timeRange: time.label,
      metrics: ["亏损额", "故障损失估算"],
      dimensions: ["站点", "对比组"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `**结论**\n- ${time.label}亏损额 Top${limit} 站点的故障损失合计 **${fmtMoney(lossFaultTotal)}**。\n- 上一轮站点集合的故障损失合计 **${fmtMoney(referenceFaultTotal)}**。\n- 两组相差 **${fmtMoney(Math.abs(diff))}**，${diff >= 0 ? "亏损额 Top 站点故障损失更高" : "上一轮站点集合故障损失更高"}。\n\n**业务解读**\n- 这不是“故障次数最高”问题，而是围绕“亏损额 Top10”与上下文站点集合做故障损失对比。`,
      kpis: [
        { label: `亏损额 Top${limit} 故障损失`, value: fmtMoney(lossFaultTotal) },
        { label: "上一轮站点故障损失", value: fmtMoney(referenceFaultTotal) },
        { label: "差值", value: fmtMoney(Math.abs(diff)) }
      ],
      chart,
      table: { columns: ["对象", "故障损失估算", "站点数"], rows: comparisonRows },
      blocks: [
        { title: "对比汇总", chart, table: { columns: ["对象", "故障损失估算", "站点数"], rows: comparisonRows } },
        { title: `亏损额 Top${limit} 站点明细`, chart: null, table: { columns, rows: lossRows } },
        { title: "上一轮站点集合明细", chart: null, table: { columns, rows: referenceRows } }
      ],
      mapHighlight: { stationIds: [...new Set([...lossRows, ...referenceRows].map((row) => row.station_id).filter(Boolean).map(String))] },
      followUps: ["解释亏损额 Top 站点为什么亏损", "看两组站点的利用率差异", "给出止损优先级建议"]
    },
    trust: {
      modelTrace: { provider: "context-contract", configured: true, called: true, ok: true },
      schemaMatches: [
        {
          table: "Conversation Context",
          fields: ["selectedStations", String(context.timeRange || time.label)],
          reason: "第三问中的“他们”绑定到上一轮站点集合，同时新查询亏损额 TopN 站点。",
          confidence: 0.96
        },
        ...schemaMatch(["fact_station_daily", "fact_fault_ticket", "dim_station", "dim_region"], "计算亏损额 TopN 与上下文站点集合的故障损失")
      ],
      sql: `-- 子查询 1: 亏损额 Top${limit} 故障损失\n${lossTopSql.trim()}\n\n-- 子查询 2: 上一轮站点集合故障损失\n${referenceSql.trim()}`,
      guardResult: "2 个只读 SQL 子查询均已通过安全校验"
    },
    nextContext: {
      ...context,
      lastIntent: "contextual_loss_top_fault_loss_comparison",
      selectedStations: [...new Set([...lossRows, ...referenceRows].map((row) => row.station_id).filter(Boolean).map(String))],
      timeRange: time.label
    }
  };
}

function answerRevenueTopVsLossTopFaultLoss(question: string): QueryResponse | null {
  const asksRevenueTop = hasRankedMetricSet(question, "(?:营业额|收入|营收|流水)");
  const asksLossTop = hasRankedMetricSet(question, "(?:亏损额|亏损额度|亏损额)");
  const asksFaultLoss = /故障损失|故障.*损失/.test(question);
  const asksCompare = /比起来|相比|比较|对比|差值|差多少|主因/.test(question);
  if (!asksRevenueTop || !asksLossTop || !asksFaultLoss || !asksCompare) return null;

  const limit = topLimitFromQuestion(question, 10);
  const time = timeWindowFromQuestion(question);
  const baseCte = `
WITH fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE created_at >= ${time.sql}
  GROUP BY station_id
),
station_finance AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         ROUND(COALESCE(f.故障损失估算, 0), 2) AS 故障损失估算,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算,
         ROUND(MAX(0, COALESCE(f.故障损失估算, 0) + SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8 - SUM(d.service_revenue)), 2) AS 亏损额
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  LEFT JOIN fault_loss f ON f.station_id = d.station_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name, f.故障损失估算
)`;
  const revenueSql = `${baseCte}
SELECT station_id, 站点, 区域, 营业额, 服务费收入, 故障损失估算, 运维成本估算, 亏损额,
       ROUND(故障损失估算 * 1.0 / NULLIF(故障损失估算 + 运维成本估算, 0), 4) AS 故障损失占亏损驱动比例
FROM station_finance
ORDER BY 营业额 DESC
LIMIT ${limit}`;
  const lossSql = `${baseCte}
SELECT station_id, 站点, 区域, 营业额, 服务费收入, 故障损失估算, 运维成本估算, 亏损额,
       ROUND(故障损失估算 * 1.0 / NULLIF(故障损失估算 + 运维成本估算, 0), 4) AS 故障损失占亏损驱动比例
FROM station_finance
ORDER BY 亏损额 DESC
LIMIT ${limit}`;
  const revenueRows = normalizeResultRows(runSql(revenueSql));
  const lossRows = normalizeResultRows(runSql(lossSql));
  const revenueFaultLoss = revenueRows.reduce((sum, row) => sum + Number(row["故障损失估算"] || 0), 0);
  const lossTopFaultLoss = lossRows.reduce((sum, row) => sum + Number(row["故障损失估算"] || 0), 0);
  const revenueExampleLoss = revenueRows.reduce((sum, row) => sum + Number(row["亏损额"] || 0), 0);
  const lossTopExampleLoss = lossRows.reduce((sum, row) => sum + Number(row["亏损额"] || 0), 0);
  const diff = revenueFaultLoss - lossTopFaultLoss;
  const revenueOpsCost = revenueRows.reduce((sum, row) => sum + Number(row["运维成本估算"] || 0), 0);
  const lossTopOpsCost = lossRows.reduce((sum, row) => sum + Number(row["运维成本估算"] || 0), 0);
  const revenueFaultShare = revenueFaultLoss + revenueOpsCost ? revenueFaultLoss / (revenueFaultLoss + revenueOpsCost) : 0;
  const lossTopFaultShare = lossTopFaultLoss + lossTopOpsCost ? lossTopFaultLoss / (lossTopFaultLoss + lossTopOpsCost) : 0;
  const causeText = lossTopFaultShare >= 0.45 ? "故障损失是亏损的重要主因之一" : "故障损失不是唯一主因，运维成本和服务费收入不足也需要一起看";
  const summaryRows = [
    { 对象: `营业额 Top${limit}`, 故障损失估算: Number(revenueFaultLoss.toFixed(2)), 亏损额: Number(revenueExampleLoss.toFixed(2)), 故障损失占亏损驱动比例: Number(revenueFaultShare.toFixed(4)) },
    { 对象: `亏损额 Top${limit}`, 故障损失估算: Number(lossTopFaultLoss.toFixed(2)), 亏损额: Number(lossTopExampleLoss.toFixed(2)), 故障损失占亏损驱动比例: Number(lossTopFaultShare.toFixed(4)) },
    { 对象: "差值（营业额Top - 亏损额Top）", 故障损失估算: Number(diff.toFixed(2)), 亏损额: Number((revenueExampleLoss - lossTopExampleLoss).toFixed(2)), 故障损失占亏损驱动比例: Number((revenueFaultShare - lossTopFaultShare).toFixed(4)) }
  ];
  const summaryColumns = ["对象", "故障损失估算", "亏损额", "故障损失占亏损驱动比例"];
  const detailColumns = ["站点", "区域", "营业额", "服务费收入", "故障损失估算", "运维成本估算", "亏损额", "故障损失占亏损驱动比例"];
  const comparisonChart: ChartSpec = {
    type: "comparison",
    title: `${time.label}营业额 Top${limit} vs 亏损额 Top${limit} 故障损失`,
    xKey: "指标",
    yKey: "指标值",
    seriesKeys: [`营业额 Top${limit}`, `亏损额 Top${limit}`, "差值"],
    data: [
      { 指标: "故障损失估算", [`营业额 Top${limit}`]: revenueFaultLoss, [`亏损额 Top${limit}`]: lossTopFaultLoss, 差值: diff },
      { 指标: "亏损额", [`营业额 Top${limit}`]: revenueExampleLoss, [`亏损额 Top${limit}`]: lossTopExampleLoss, 差值: revenueExampleLoss - lossTopExampleLoss }
    ]
  };
  const blocks: AnswerBlock[] = [
    { title: "两组站点故障损失对比", chart: comparisonChart, table: { columns: summaryColumns, rows: summaryRows } },
    { title: `营业额最高 Top${limit} 明细`, chart: null, table: { columns: detailColumns, rows: revenueRows } },
    { title: `亏损额最高 Top${limit} 明细`, chart: null, table: { columns: detailColumns, rows: lossRows } }
  ];
  const stationIds = [...new Set([...revenueRows, ...lossRows].map((row) => row.station_id).filter(Boolean).map(String))];

  return {
    type: "answer",
    understanding: {
      intent: "revenue_top_vs_loss_top_fault_loss",
      interpretedQuestion: `对比${time.label}营业额 Top${limit} 与亏损额 Top${limit} 两组站点的故障损失，并判断故障损失是否是亏损主因。`,
      timeRange: time.label,
      metrics: ["营业额", "亏损额", "故障损失估算", "故障损失占亏损额比例"],
      dimensions: ["站点", "区域"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `**结论**\n- ${time.label}营业额 Top${limit} 站点故障损失合计 **${fmtMoney(revenueFaultLoss)}**，亏损额 Top${limit} 站点故障损失合计 **${fmtMoney(lossTopFaultLoss)}**，差值 **${fmtMoney(Math.abs(diff))}**（${diff >= 0 ? "营业额 Top 更高" : "亏损额 Top 更高"}）。\n- 对亏损额 Top${limit} 来看，故障损失占亏损驱动因素 **${fmtPct(lossTopFaultShare)}**，${causeText}。\n\n**口径说明**\n- “他们”已解析为句内/澄清中提到的 **亏损额 Top${limit} 站点**。\n- 主因判断使用 故障损失 /（故障损失 + 运维成本），亏损额 = MAX(0, 故障损失估算 + 运维成本估算 - 服务费收入)。`,
      kpis: [
        { label: `营业额 Top${limit} 故障损失`, value: fmtMoney(revenueFaultLoss) },
        { label: `亏损额 Top${limit} 故障损失`, value: fmtMoney(lossTopFaultLoss) },
        { label: "故障损失差值", value: fmtMoney(Math.abs(diff)) }
      ],
      chart: comparisonChart,
      table: { columns: summaryColumns, rows: summaryRows },
      blocks,
      mapHighlight: { stationIds },
      followUps: ["看两组站点的交集", "按故障类型拆开看", "给出亏损站点止损建议"]
    },
    trust: {
      modelTrace: { provider: "deterministic-query-contract", configured: true, called: true, ok: true },
      schemaMatches: [
        {
          table: "Coreference Resolver",
          fields: ["营业额 TopN", "亏损额 TopN", "他们"],
          reason: "句内或澄清文本已明确两组站点集合，直接合并执行对比。",
          confidence: 0.96
        },
        ...schemaMatch(["fact_station_daily", "fact_fault_ticket", "dim_station", "dim_region"], "对比营业额 TopN 与亏损额 TopN 的故障损失")
      ],
      sql: `-- 子查询 1: 营业额 Top${limit} 故障损失\n${revenueSql.trim()}\n\n-- 子查询 2: 亏损额 Top${limit} 故障损失\n${lossSql.trim()}`,
      guardResult: "2 个只读 SQL 子查询均已通过安全校验"
    },
    nextContext: {
      lastIntent: "revenue_top_vs_loss_top_fault_loss",
      selectedStations: stationIds,
      timeRange: time.label,
      lastBlocks: [
        { kind: "revenue_top", title: `营业额最高 Top${limit}`, columns: detailColumns, rows: revenueRows.slice(0, 10) },
        { kind: "loss_top", title: `亏损额最高 Top${limit}`, columns: detailColumns, rows: lossRows.slice(0, 10) }
      ]
    }
  };
}

function answerLossTopRevenueAndLossShare(question: string): QueryResponse | null {
  const asksLossTop = /亏损|亏损额|亏损额度|亏/.test(question) && /最高|最多|Top|top|前/.test(question);
  const asksRevenueAmount = /营业总额|营业额|收入|营收|流水/.test(question);
  const asksLossShare = /总亏损|整体亏损|全部亏损|亏损额.*百分|亏损额.*占比|占.*亏损/.test(question) && /百分之|百分比|占比|比例|占/.test(question);
  if (!asksLossTop || !asksRevenueAmount || !asksLossShare) return null;

  const limit = topLimitFromQuestion(question, 10);
  const time = timeWindowFromQuestion(question);
  const detailSql = `
WITH fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE created_at >= ${time.sql}
  GROUP BY station_id
),
station_finance AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         ROUND(COALESCE(f.故障损失估算, 0), 2) AS 故障损失估算,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算,
         ROUND(MAX(0, COALESCE(f.故障损失估算, 0) + SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8 - SUM(d.service_revenue)), 2) AS 亏损额
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  LEFT JOIN fault_loss f ON f.station_id = d.station_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name, f.故障损失估算
),
total_loss AS (
  SELECT SUM(亏损额) AS 整体亏损额 FROM station_finance
)
SELECT station_id, 站点, 区域, 营业额, 服务费收入, 故障损失估算, 运维成本估算, 亏损额,
       ROUND(亏损额 * 1.0 / NULLIF((SELECT 整体亏损额 FROM total_loss), 0), 4) AS 整体亏损额占比
FROM station_finance
ORDER BY 亏损额 DESC
LIMIT ${limit}`;
  const totalSql = `
WITH fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE created_at >= ${time.sql}
  GROUP BY station_id
),
station_finance AS (
  SELECT d.station_id,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         ROUND(COALESCE(f.故障损失估算, 0), 2) AS 故障损失估算,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算,
         ROUND(MAX(0, COALESCE(f.故障损失估算, 0) + SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8 - SUM(d.service_revenue)), 2) AS 亏损额
  FROM fact_station_daily d
  LEFT JOIN fault_loss f ON f.station_id = d.station_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY d.station_id, f.故障损失估算
)
SELECT ROUND(SUM(营业额), 2) AS 全部站点营业额,
       ROUND(SUM(亏损额), 2) AS 全部站点亏损额
FROM station_finance`;
  const rows = normalizeResultRows(runSql(detailSql));
  const totals = runSql<{ 全部站点营业额: number; 全部站点亏损额: number }>(totalSql)[0] || { 全部站点营业额: 0, 全部站点亏损额: 0 };
  const topRevenue = rows.reduce((sum, row) => sum + Number(row["营业额"] || 0), 0);
  const topLoss = rows.reduce((sum, row) => sum + Number(row["亏损额"] || 0), 0);
  const totalLoss = Number(totals.全部站点亏损额 || 0);
  const lossShare = totalLoss ? topLoss / totalLoss : 0;
  const summaryRows = [
    { 指标: `亏损额 Top${limit} 站点营业总额`, 数值: topRevenue, 展示值: fmtMoney(topRevenue) },
    { 指标: `亏损额 Top${limit} 站点亏损额`, 数值: topLoss, 展示值: fmtMoney(topLoss) },
    { 指标: `${time.label}全部站点亏损额`, 数值: totalLoss, 展示值: fmtMoney(totalLoss) },
    { 指标: `亏损额 Top${limit} 占整体亏损额比例`, 数值: Number(lossShare.toFixed(4)), 展示值: fmtPct(lossShare) }
  ];
  const detailColumns = ["站点", "区域", "营业额", "服务费收入", "故障损失估算", "运维成本估算", "亏损额", "整体亏损额占比"];
  const summaryColumns = ["指标", "展示值", "数值"];
  const detailChart: ChartSpec = {
    type: "pie",
    title: `${time.label}亏损额 Top${limit} 占整体亏损额`,
    xKey: "站点",
    yKey: "整体亏损额占比",
    data: [
      ...rows.map((row) => ({ 站点: row["站点"], 整体亏损额占比: row["整体亏损额占比"] })),
      ...(lossShare < 0.999 ? [{ 站点: "其他站点", 整体亏损额占比: Number(Math.max(0, 1 - lossShare).toFixed(4)) }] : [])
    ]
  };
  const blocks: AnswerBlock[] = [
    {
      title: `亏损额 Top${limit} 汇总`,
      chart: {
        type: "bar",
        title: `亏损额 Top${limit} 关键汇总`,
        xKey: "指标",
        yKey: "数值",
        data: summaryRows
      },
      table: { columns: summaryColumns, rows: summaryRows }
    },
    {
      title: `亏损额最高 Top${limit} 明细`,
      chart: detailChart,
      table: { columns: detailColumns, rows }
    }
  ];

  return {
    type: "answer",
    understanding: {
      intent: "loss_top_revenue_and_loss_share",
      interpretedQuestion: `查询${time.label}亏损额最高 Top${limit} 站点，回答这些站点的营业总额，并计算这些站点的亏损额占全部站点亏损额的比例。`,
      timeRange: time.label,
      metrics: ["营业额", "亏损额", "整体亏损额占比"],
      dimensions: ["站点", "区域"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `**结论**\n- ${time.label}亏损额最高 Top${limit} 站点的营业总额为 **${fmtMoney(topRevenue)}**。\n- 这些站点的亏损额合计 **${fmtMoney(topLoss)}**，占全部站点亏损额 **${fmtPct(lossShare)}**。\n\n**关键口径**\n- “他们占总亏损额”中的“他们”绑定为这些站点的 **亏损额**，不是营业额。\n- 亏损额 = MAX(0, 故障损失估算 + 运维成本估算 - 服务费收入)。\n\n**业务解读**\n- 该结果同时回答了营业规模和亏损集中度，避免把营业额与亏损额跨指标相除。`,
      kpis: [
        { label: `亏损额 Top${limit} 营业总额`, value: fmtMoney(topRevenue) },
        { label: `亏损额 Top${limit} 亏损额`, value: fmtMoney(topLoss) },
        { label: "占整体亏损额", value: fmtPct(lossShare) }
      ],
      chart: detailChart,
      table: { columns: detailColumns, rows },
      blocks,
      mapHighlight: { stationIds: rows.map((row) => String(row.station_id)).filter(Boolean) },
      followUps: ["这些站点亏损主要来自故障还是运营成本？", "对比这些站点和营业额 Top10 的交集", "按区域看亏损额集中度"]
    },
    trust: {
      modelTrace: { provider: "deterministic-query-contract", configured: true, called: true, ok: true },
      schemaMatches: [
        {
          table: "Metric Binding Guard",
          fields: ["营业额", "亏损额", "整体亏损额占比"],
          reason: "占比分子和分母均绑定为亏损额，营业额只作为单独汇总指标。",
          confidence: 0.99
        },
        ...schemaMatch(["fact_station_daily", "fact_fault_ticket", "dim_station", "dim_region"], "计算亏损额 TopN、营业总额和整体亏损额占比")
      ],
      sql: `-- 子查询 1: 亏损额 Top${limit} 明细\n${detailSql.trim()}\n\n-- 子查询 2: 全部站点营业额与亏损额\n${totalSql.trim()}`,
      guardResult: "2 个只读 SQL 子查询均已通过安全校验"
    },
    nextContext: {
      lastIntent: "loss_top_revenue_and_loss_share",
      selectedStations: rows.map((row) => String(row.station_id)).filter(Boolean),
      timeRange: time.label,
      lastBlocks: [{
        kind: "loss_top",
        title: `亏损额最高 Top${limit}`,
        columns: detailColumns,
        rows: rows.slice(0, 10)
      }]
    }
  };
}

function answerRevenueTopShare(question: string): QueryResponse | null {
  const asksRevenueTop = /营业额|收入|营收|流水/.test(question) && /最高|最多|Top|top|前/.test(question);
  const asksShare = /百分之|百分比|占比|比例|占整体|占总/.test(question);
  const asksLoss = /亏损|亏损额|亏|损失/.test(question);
  if (!asksRevenueTop || !asksShare || asksLoss) return null;

  const limit = topLimitFromQuestion(question, 10);
  const time = timeWindowFromQuestion(question);
  const sql = `
WITH station_revenue AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 平均利用率
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name
),
total_revenue AS (
  SELECT SUM(营业额) AS 整体营业额 FROM station_revenue
)
SELECT station_id, 站点, 区域, 营业额, 订单量, 平均利用率,
       ROUND(营业额 * 1.0 / NULLIF((SELECT 整体营业额 FROM total_revenue), 0), 4) AS 整体营业额占比
FROM station_revenue
ORDER BY 营业额 DESC
LIMIT ${limit}`;
  const rows = normalizeResultRows(runSql(sql));
  const totalTopRevenue = rows.reduce((sum, row) => sum + Number(row["营业额"] || 0), 0);
  const totalTopShare = rows.reduce((sum, row) => sum + Number(row["整体营业额占比"] || 0), 0);
  const top = rows[0];
  const columns = ["站点", "区域", "营业额", "订单量", "平均利用率", "整体营业额占比"];
  const pieRows = [
    ...rows.map((row) => ({ 站点: row["站点"], 整体营业额占比: row["整体营业额占比"] })),
    ...(totalTopShare < 0.999 ? [{ 站点: "其他站点", 整体营业额占比: Number(Math.max(0, 1 - totalTopShare).toFixed(4)) }] : [])
  ];
  const chart: ChartSpec = {
    type: "pie",
    title: `${time.label}营业额 Top${limit} 占比`,
    xKey: "站点",
    yKey: "整体营业额占比",
    data: pieRows
  };

  return {
    type: "answer",
    understanding: {
      intent: "revenue_top_share",
      interpretedQuestion: `查询${time.label}营业额最高 Top${limit} 站点的营业额，并计算它们占整体营业额的比例`,
      timeRange: time.label,
      metrics: ["营业额", "整体营业额占比", "订单量", "平均利用率"],
      dimensions: ["站点", "区域"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `**结论**\n- ${time.label}营业额最高 Top${limit} 站点合计营业额 **${fmtMoney(totalTopRevenue)}**，合计占整体营业额 **${fmtPct(totalTopShare)}**。\n- Top1 站点是 **${top?.["站点"] ?? "无数据"}**，单站占比 **${fmtPct(Number(top?.["整体营业额占比"] || 0))}**。\n\n**呈现方式**\n- 饼图展示 Top${limit} 与其他站点的整体营业额构成。\n- 表格给出每个 Top 站点的营业额、订单量、平均利用率和占比。`,
      kpis: [
        { label: `Top${limit} 合计营业额`, value: fmtMoney(totalTopRevenue) },
        { label: `Top${limit} 合计占比`, value: fmtPct(totalTopShare) },
        { label: "Top1 站点", value: top ? String(top["站点"]) : "无" }
      ],
      chart,
      table: { columns, rows },
      blocks: [{ title: `营业额最高 Top${limit}`, chart, table: { columns, rows } }],
      mapHighlight: { stationIds: rows.map((row) => String(row.station_id)).filter(Boolean) },
      followUps: ["这些站点最近 14 天趋势如何？", "这些站点的故障损失高吗？", "按区域汇总这些站点贡献"]
    },
    trust: {
      modelTrace: { provider: "deterministic-query-contract", configured: true, called: true, ok: true },
      schemaMatches: schemaMatch(["fact_station_daily", "dim_station", "dim_region"], "计算营业额 TopN 及整体占比"),
      sql,
      guardResult: "1 个只读 SQL 子查询已通过安全校验"
    },
    nextContext: {
      lastIntent: "revenue_top_share",
      selectedStations: rows.map((row) => String(row.station_id)).filter(Boolean),
      timeRange: time.label,
      lastBlocks: [{
        kind: "revenue_top",
        title: `营业额最高 Top${limit}`,
        columns,
        rows: rows.slice(0, 10)
      }]
    }
  };
}

function answerRevenueAndLossTopShare(question: string): QueryResponse | null {
  const asksRevenueTop = /营业额|收入|营收|流水/.test(question) && /最高|最多|Top|top|前/.test(question);
  const asksLossTop = /亏损|亏损额|亏|损失/.test(question) && /最高|最多|Top|top|前/.test(question);
  const asksShare = /百分之|百分比|占比|比例|占整体|占总/.test(question);
  if (!asksRevenueTop || !asksLossTop || !asksShare) return null;

  const limit = topLimitFromQuestion(question, 3);
  const time = timeWindowFromQuestion(question);

  const revenueSql = `
WITH station_revenue AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 平均利用率
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name
),
total_revenue AS (
  SELECT SUM(营业额) AS 整体营业额 FROM station_revenue
)
SELECT station_id, 站点, 区域, 营业额, 订单量, 平均利用率,
       ROUND(营业额 * 1.0 / NULLIF((SELECT 整体营业额 FROM total_revenue), 0), 4) AS 整体营业额占比
FROM station_revenue
ORDER BY 营业额 DESC
LIMIT ${limit}`;

  const lossSql = `
WITH fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE created_at >= ${time.sql}
  GROUP BY station_id
),
station_finance AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         ROUND(COALESCE(f.故障损失估算, 0), 2) AS 故障损失估算,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算,
         ROUND(MAX(0, COALESCE(f.故障损失估算, 0) + SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8 - SUM(d.service_revenue)), 2) AS 亏损额
  FROM fact_station_daily d
  JOIN dim_station s ON s.station_id = d.station_id
  JOIN dim_region r ON r.region_id = d.region_id
  LEFT JOIN fault_loss f ON f.station_id = d.station_id
  WHERE d.stat_date >= ${time.sql}
  GROUP BY s.station_id, s.station_name, r.region_name, f.故障损失估算
),
total_loss AS (
  SELECT SUM(亏损额) AS 整体亏损额 FROM station_finance
)
SELECT station_id, 站点, 区域, 营业额, 服务费收入, 故障损失估算, 运维成本估算, 亏损额,
       ROUND(亏损额 * 1.0 / NULLIF((SELECT 整体亏损额 FROM total_loss), 0), 4) AS 整体亏损额占比
FROM station_finance
ORDER BY 亏损额 DESC
LIMIT ${limit}`;

  const revenueRows = normalizeResultRows(runSql(revenueSql));
  const lossRows = normalizeResultRows(runSql(lossSql));
  const stationIds = [...new Set([...revenueRows, ...lossRows].map((row) => row.station_id).filter(Boolean).map(String))];
  const revenueShare = revenueRows.reduce((sum, row) => sum + Number(row["整体营业额占比"] || 0), 0);
  const lossShare = lossRows.reduce((sum, row) => sum + Number(row["整体亏损额占比"] || 0), 0);
  const revenueChart: ChartSpec = {
    type: "pie",
    title: `${time.label}营业额 Top${limit} 占比`,
    xKey: "站点",
    yKey: "整体营业额占比",
    data: [
      ...revenueRows.map((row) => ({ 站点: row["站点"], 整体营业额占比: row["整体营业额占比"] })),
      ...(revenueShare < 0.999 ? [{ 站点: "其他站点", 整体营业额占比: Number(Math.max(0, 1 - revenueShare).toFixed(4)) }] : [])
    ]
  };
  const lossChart: ChartSpec = {
    type: "pie",
    title: `${time.label}亏损额 Top${limit} 占比`,
    xKey: "站点",
    yKey: "整体亏损额占比",
    data: [
      ...lossRows.map((row) => ({ 站点: row["站点"], 整体亏损额占比: row["整体亏损额占比"] })),
      ...(lossShare < 0.999 ? [{ 站点: "其他站点", 整体亏损额占比: Number(Math.max(0, 1 - lossShare).toFixed(4)) }] : [])
    ]
  };
  const blocks: AnswerBlock[] = [
    {
      title: `营业额最高 Top${limit}`,
      chart: revenueChart,
      table: { columns: ["站点", "区域", "营业额", "订单量", "平均利用率", "整体营业额占比"], rows: revenueRows }
    },
    {
      title: `亏损额最高 Top${limit}`,
      chart: lossChart,
      table: { columns: ["站点", "区域", "营业额", "服务费收入", "故障损失估算", "运维成本估算", "亏损额", "整体亏损额占比"], rows: lossRows }
    }
  ];
  const topRevenue = revenueRows[0];
  const topLoss = lossRows[0];

  return {
    type: "answer",
    understanding: {
      intent: "multi_intent_revenue_loss_top_share",
      interpretedQuestion: `拆成 2 个子查询：${time.label}营业额最高 Top${limit} 及其整体占比；${time.label}亏损额最高 Top${limit} 及其整体亏损占比`,
      timeRange: time.label,
      metrics: ["营业额", "整体营业额占比", "亏损额", "整体亏损额占比"],
      dimensions: ["站点", "区域"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `**结论**\n- ${time.label}，营业额最高的是 **${topRevenue?.["站点"] ?? "无数据"}**，占整体营业额 **${fmtPct(Number(topRevenue?.["整体营业额占比"] || 0))}**。\n- 亏损额最高的是 **${topLoss?.["站点"] ?? "无数据"}**，占整体亏损额 **${fmtPct(Number(topLoss?.["整体亏损额占比"] || 0))}**。\n\n**任务拆解**\n- 子查询 1：营业额 Top${limit} 及整体营业额占比。\n- 子查询 2：亏损额 Top${limit} 及整体亏损额占比。`,
      kpis: [
        { label: "任务拆解", value: "2 个子查询" },
        { label: "营业额Top站点", value: topRevenue ? String(topRevenue["站点"]) : "无" },
        { label: "亏损额Top站点", value: topLoss ? String(topLoss["站点"]) : "无" }
      ],
      chart: revenueChart,
      table: blocks[0].table,
      blocks,
      mapHighlight: { stationIds },
      followUps: ["解释这些亏损站点为什么亏损", "看 Top3 站点最近 14 天趋势", "把营业额 Top3 和亏损额 Top3 做交集分析"]
    },
    trust: {
      modelTrace: { provider: "deterministic-query-contract", configured: true, called: true, ok: true },
      schemaMatches: [
        {
          table: "Intent Contract",
          fields: ["营业额TopN", "亏损额TopN", "整体占比", time.label],
          reason: "复杂 query 被拆成两个并列任务，避免压缩成单一最高/最低对比。",
          confidence: 0.98
        },
        ...schemaMatch(["fact_station_daily", "fact_fault_ticket", "dim_station", "dim_region"], "计算营业额、亏损额及整体占比")
      ],
      sql: `-- 子查询 1: 营业额 Top${limit} 及整体占比\n${revenueSql.trim()}\n\n-- 子查询 2: 亏损额 Top${limit} 及整体亏损占比\n${lossSql.trim()}`,
      guardResult: "2 个只读 SQL 子查询均已通过安全校验"
    },
    nextContext: {
      lastIntent: "multi_intent_revenue_loss_top_share",
      selectedStations: stationIds,
      timeRange: time.label,
      lastBlocks: blocks.map((block) => ({
        kind: block.title.includes("营业额") ? "revenue_top" : block.title.includes("亏损") ? "loss_top" : "result",
        title: block.title,
        columns: block.table.columns,
        rows: block.table.rows.slice(0, 10)
      }))
    }
  };
}

function clarification(question: string, reason: string, followUps: string[], context: Record<string, unknown> = {}): QueryResponse {
  const { pendingClarification: _pendingClarification, ...restContext } = context;
  return {
    type: "clarification",
    understanding: {
      intent: "needs_clarification",
      interpretedQuestion: question
    },
    workflow: workflow().slice(0, 2),
    answer: {
      summary: `**需要补充一个信息**\n- ${reason}\n\n在下方澄清框补充后，我会把它并回原问题继续执行。`,
      kpis: [],
      chart: null,
      table: { columns: [], rows: [] },
      mapHighlight: {},
      followUps
    },
    trust: {
      schemaMatches: [
        {
          table: "Clarification Gate",
          fields: ["上下文指代", "置信度"],
          reason,
          confidence: 0.78
        }
      ],
      sql: "",
      guardResult: "未生成 SQL：等待用户澄清"
    },
    nextContext: {
      ...restContext,
      pendingClarification: {
        originalQuestion: question,
        reason,
        followUps,
        createdAt: new Date().toISOString()
      }
    }
  };
}

function answerTopSetIntersection(question: string, context: Record<string, unknown>): QueryResponse | null {
  if (!/交集|重合|共同|同时上榜|都在/.test(question)) return null;
  const blocks = Array.isArray(context.lastBlocks) ? context.lastBlocks as { kind?: string; title?: string; columns?: string[]; rows?: Record<string, unknown>[] }[] : [];
  const revenueBlock = blocks.find((block) => block.kind === "revenue_top" || String(block.title || "").includes("营业额")) || (context.lastIntent === "multi_intent_revenue_loss_top_share" ? blocks[0] : undefined);
  const lossBlock = blocks.find((block) => block.kind === "loss_top" || String(block.title || "").includes("亏损")) || (context.lastIntent === "multi_intent_revenue_loss_top_share" ? blocks[1] : undefined);
  if (!revenueBlock || !lossBlock) {
    return clarification(
      question,
      "你问到了“交集/重合”，但当前上下文里没有找到可用于比较的两个 Top 列表。",
      ["先查过去两周营业额 Top3 和亏损额 Top3", "说明要比较哪两个榜单的交集"],
      context
    );
  }

  const revenueRows = revenueBlock.rows || [];
  const lossRows = lossBlock.rows || [];
  const lossByStation = new Map(lossRows.map((row) => [String(row["站点"] || row.station_name), row]));
  const rows = revenueRows
    .filter((row) => lossByStation.has(String(row["站点"] || row.station_name)))
    .map((row) => {
      const station = String(row["站点"] || row.station_name);
      const lossRow = lossByStation.get(station) || {};
      return {
        station_id: row.station_id || lossRow.station_id,
        站点: station,
        区域: row["区域"] || lossRow["区域"] || "-",
        营业额: row["营业额"],
        整体营业额占比: row["整体营业额占比"],
        亏损额: lossRow["亏损额"],
        整体亏损额占比: lossRow["整体亏损额占比"]
      };
    });
  const stationIds = rows.map((row) => row.station_id).filter(Boolean).map(String);
  const columns = ["站点", "区域", "营业额", "整体营业额占比", "亏损额", "整体亏损额占比"];
  const summary = rows.length
    ? `**交集结论**\n- 两个榜单共有 **${rows.length} 个**重合站点。\n- 同时进入营业额 Top 和亏损额 Top 的站点是：**${rows.map((row) => row["站点"]).join("、")}**。\n\n**业务含义**\n- 这些站点收入规模高，但亏损压力也高，优先检查故障损失、服务费收入和运维成本结构。`
    : `**交集结论**\n- 当前两个榜单没有重合站点。\n\n**业务含义**\n- 营业额贡献站点和亏损压力站点不是同一批，建议分别制定增长和止损策略。`;

  return {
    type: "answer",
    understanding: {
      intent: "contextual_top_set_intersection",
      interpretedQuestion: "基于上一轮营业额 Top 与亏损额 Top 结果做交集分析",
      timeRange: typeof context.timeRange === "string" ? context.timeRange : undefined,
      metrics: ["营业额", "整体营业额占比", "亏损额", "整体亏损额占比"],
      dimensions: ["站点"],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary,
      kpis: [
        { label: "交集站点", value: `${rows.length} 个` },
        { label: "对比对象", value: "2 个榜单" }
      ],
      chart: rows.length > 0 ? {
        type: "comparison",
        title: "营业额 Top 与亏损额 Top 交集站点对比",
        xKey: "指标",
        yKey: "指标值",
        seriesKeys: rows.map((row) => String(row["站点"])),
        data: [
          Object.fromEntries([["指标", "整体营业额占比"], ...rows.map((row) => [String(row["站点"]), row["整体营业额占比"]])]),
          Object.fromEntries([["指标", "整体亏损额占比"], ...rows.map((row) => [String(row["站点"]), row["整体亏损额占比"]])])
        ]
      } : null,
      table: { columns, rows },
      blocks: [{ title: "交集分析", chart: null, table: { columns, rows } }],
      mapHighlight: { stationIds },
      followUps: ["解释交集站点为什么亏损", "看这些站点最近 14 天趋势", "给出止损优先级建议"]
    },
    trust: {
      modelTrace: { provider: "context-contract", configured: true, called: true, ok: true },
      schemaMatches: [
        {
          table: "Conversation Context",
          fields: [String(revenueBlock.title), String(lossBlock.title)],
          reason: "追问命中上一轮结果块，直接基于上下文做交集分析。",
          confidence: 0.96
        }
      ],
      sql: "",
      guardResult: "未生成新 SQL：本轮基于上一轮查询结果做上下文计算"
    },
    nextContext: {
      ...context,
      lastIntent: "contextual_top_set_intersection",
      selectedStations: stationIds
    }
  };
}

function numberValue(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "number" ? value : Number(value || 0);
}

const comparisonMetricAliases = [
  { label: "营业额", aliases: ["营业额", "收入", "收入额", "营收", "总收入", "30天收入", "revenue", "total_revenue"] },
  { label: "订单量", aliases: ["订单量", "订单", "订单数", "30天订单", "orders", "order_count", "total_orders"] },
  { label: "利用率", aliases: ["利用率", "平均利用率", "utilization", "avg_utilization"] },
  { label: "故障率", aliases: ["故障率", "fault_rate"] },
  { label: "故障次数", aliases: ["故障次数", "故障数", "faults", "fault_count", "total_faults"] },
  { label: "净利率", aliases: ["净利率", "净利率", "profit_margin", "net_margin"] },
  { label: "盈利额", aliases: ["盈利额", "盈利额", "利润", "profit", "net_profit"] },
  { label: "亏损额", aliases: ["亏损额", "亏损额", "loss", "loss_amount"] }
];

function findRowValue(row: Record<string, unknown>, aliases: string[]) {
  const rowKeys = Object.keys(row);
  for (const alias of aliases) {
    const matchedKey = rowKeys.find((key) => key === alias || key.toLowerCase() === alias.toLowerCase());
    if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== null && row[matchedKey] !== "") {
      return numberValue(row, matchedKey);
    }
  }
  return null;
}

function stationName(row: Record<string, unknown>) {
  return String(row["站点"] || row["站点名称"] || row["station_name"] || row["name"] || "未知站点");
}

function regionName(row: Record<string, unknown>) {
  return String(row["区域"] || row["行政区"] || row["region_name"] || row["region"] || "-");
}

function enrichStationMeta(row: Record<string, unknown>) {
  const stationId = typeof row.station_id === "string" ? row.station_id : "";
  const name = stationName(row);
  const station = stationId
    ? get<{ station_id: string; station_name: string; region_name: string }>(
        `SELECT s.station_id, s.station_name, r.region_name
         FROM dim_station s
         JOIN dim_region r ON r.region_id = s.region_id
         WHERE s.station_id = ?`,
        [stationId]
      )
    : get<{ station_id: string; station_name: string; region_name: string }>(
        `SELECT s.station_id, s.station_name, r.region_name
         FROM dim_station s
         JOIN dim_region r ON r.region_id = s.region_id
         WHERE s.station_name = ?`,
        [name]
      );
  if (!station) return row;
  return {
    ...row,
    station_id: row.station_id || station.station_id,
    station_name: row.station_name || station.station_name,
    region_name: row.region_name || station.region_name,
    站点: row["站点"] || station.station_name,
    区域: row["区域"] || station.region_name
  };
}

function enhanceComparisonRows(rows: Record<string, unknown>[]) {
  if (rows.length !== 2) return { rows, columns: tableColumns(rows), chart: null as ChartSpec | null };
  const labels = rows.map((row) => String(row["子查询"] || row["子问题"] || ""));
  const looksLikeExtremeComparison = labels.some((label) => label.includes("最高")) && labels.some((label) => label.includes("最低"));
  if (!looksLikeExtremeComparison) return { rows, columns: tableColumns(rows), chart: null as ChartSpec | null };

  const metrics = comparisonMetricAliases
    .map((metric) => ({
      label: metric.label,
      first: findRowValue(rows[0], metric.aliases),
      second: findRowValue(rows[1], metric.aliases)
    }))
    .filter((metric) => metric.first !== null || metric.second !== null);
  const normalizedRows = rows.map((row, index) => ({
    ...row,
    子查询: String(row["子查询"] || row["子问题"] || (index === 0 ? "对象1" : "对象2")),
    站点: stationName(row),
    区域: regionName(row),
    ...Object.fromEntries(metrics.map((metric) => [metric.label, index === 0 ? metric.first ?? 0 : metric.second ?? 0]))
  }));
  const diffRow: Record<string, unknown> = {
    子查询: "差值",
    站点: `${stationName(rows[0])} - ${stationName(rows[1])}`,
    区域: "-"
  };
  for (const metric of metrics) {
    diffRow[metric.label] = Number(((metric.first ?? 0) - (metric.second ?? 0)).toFixed(4));
  }
  const enhancedRows = [...normalizedRows, diffRow];
  const columns = ["子查询", "站点", "区域", ...metrics.map((metric) => metric.label)].filter((column, index, arr) => arr.indexOf(column) === index);
  const firstLabel = String(normalizedRows[0]["子查询"] || "对象1");
  const secondLabel = String(normalizedRows[1]["子查询"] || "对象2");
  const chart: ChartSpec = {
    type: "comparison",
    title: "最高站点 vs 最低站点关键指标对比",
    xKey: "指标",
    yKey: "指标值",
    seriesKeys: [firstLabel, secondLabel, "差值"],
    data: metrics.map((metric) => ({
      指标: metric.label,
      [firstLabel]: metric.first ?? 0,
      [secondLabel]: metric.second ?? 0,
      差值: numberValue(diffRow, metric.label)
    }))
  };
  return { rows: enhancedRows, columns, chart };
}

function deterministicAnswerAudit(question: string, response: QueryResponse): AiAnswerAudit {
  const answerText = [
    response.understanding.interpretedQuestion,
    response.answer.summary,
    ...response.answer.kpis.map((item) => `${item.label}:${item.value}`),
    response.trust.sql
  ].join("\n");
  const asksOneWeek = /过去一周|最近一周|上一周|上周|近7天|最近7天|7天|七天/.test(question);
  const asksTwoWeeks = /前两周|过去两周|最近两周|近14天|最近14天|14天|十四天/.test(question);
  const saysOneWeek = /过去 7 天|最近 7 天|-7 day|7天|七天|一周|上周/.test(answerText);
  const saysTwoWeeks = /过去 14 天|最近 14 天|-14 day|14天|十四天|两周|前两周/.test(answerText);
  if (asksOneWeek && saysTwoWeeks) {
    return {
      pass: false,
      confidence: 0.96,
      failureType: "answer_question_mismatch",
      reason: "用户询问一周口径，但候选答案使用了两周/14天口径。",
      repairInstruction: "重新规划：时间范围必须使用过去一周/最近7天，不要使用前两周或14天。"
    };
  }
  if (asksTwoWeeks && saysOneWeek && !saysTwoWeeks) {
    return {
      pass: false,
      confidence: 0.96,
      failureType: "answer_question_mismatch",
      reason: "用户询问两周口径，但候选答案使用了一周/7天口径。",
      repairInstruction: "重新规划：时间范围必须使用前两周/过去两周/最近14天，不要使用7天。"
    };
  }
  const tableColumnsText = [
    ...response.answer.table.columns,
    ...(response.answer.blocks || []).flatMap((block) => block.table.columns)
  ].join(" ");
  const asksLossDenominator = /总亏损|整体亏损|全部亏损|亏损额.*百分|亏损额.*占比/.test(question);
  const asksRevenueAmount = /营业总额|营业额|收入|营收|流水/.test(question);
  const hasRevenueOverLoss = /营业.{0,8}(占|比例|百分).{0,8}亏损|营业总额.{0,12}总亏损|营业额.{0,12}总亏损/.test(answerText + tableColumnsText);
  if (asksLossDenominator && asksRevenueAmount && hasRevenueOverLoss) {
    return {
      pass: false,
      confidence: 0.98,
      failureType: "metric_binding_error",
      reason: "候选答案把营业额绑定为总亏损额占比的分子，属于跨指标量纲错误。",
      repairInstruction: "重新规划：如果用户问亏损额 TopN 站点的营业总额以及它们占总亏损额的比例，TopN 集合按亏损额排序；营业总额单独汇总；占比必须用这些站点的亏损额 / 全部站点亏损额，不能用营业额 / 亏损额。"
    };
  }

  const percentValues = [
    ...response.answer.kpis.map((item) => item.value),
    response.answer.summary
  ].join(" ").match(/-?\d+(?:\.\d+)?%/g) || [];
  const hasExtremeCompositionShare = percentValues.some((value) => Math.abs(Number(value.replace("%", ""))) > 100);
  if (/占比|百分|比例|构成/.test(question) && hasExtremeCompositionShare) {
    return {
      pass: false,
      confidence: 0.9,
      failureType: "metric_binding_error",
      reason: "候选答案出现超过 100% 的构成占比，疑似分子分母口径不一致。",
      repairInstruction: "重新检查所有占比字段，确保分子和分母为同一指标口径；如果是亏损额占比，分子分母都必须是亏损额。"
    };
  }

  return { pass: true, confidence: 0.86, reason: "确定性指标量纲校验通过。" };
}

async function auditCandidateAnswer(question: string, response: QueryResponse): Promise<{ audit: AiAnswerAudit; trace?: NonNullable<QueryResponse["trust"]["modelTrace"]> }> {
  const deterministic = deterministicAnswerAudit(question, response);
  if (!deterministic.pass) return { audit: deterministic };

  const { value, trace } = await verifyAnswerWithDeepSeek({
    question,
    interpretedQuestion: response.understanding.interpretedQuestion,
    metrics: response.understanding.metrics,
    dimensions: response.understanding.dimensions,
    sql: response.trust.sql,
    kpis: response.answer.kpis,
    table: {
      columns: response.answer.table.columns,
      rows: response.answer.table.rows.slice(0, 12)
    },
    blocks: (response.answer.blocks || []).slice(0, 5).map((block) => ({
      title: block.title,
      table: {
        columns: block.table.columns,
        rows: block.table.rows.slice(0, 12)
      },
      chartTitle: block.chart?.title,
      chartType: block.chart?.type,
      xKey: block.chart?.xKey,
      yKey: block.chart?.yKey
    })),
    summary: response.answer.summary
  });
  return {
    audit: value || { pass: true, confidence: 0.65, reason: "Verifier 未返回有效 JSON，保留确定性校验结果。" },
    trace
  };
}

function attachAudit(response: QueryResponse, audit: AiAnswerAudit, trace?: NonNullable<QueryResponse["trust"]["modelTrace"]>) {
  response.trust.schemaMatches = [
    {
      table: "Answer Verifier",
      fields: [audit.pass ? "pass" : "blocked", audit.failureType || "none"],
      reason: audit.reason,
      confidence: Number((audit.confidence ?? 0.5).toFixed(2))
    },
    ...response.trust.schemaMatches
  ];
  if (trace && response.trust.modelTrace) {
    response.trust.modelTrace = {
      ...response.trust.modelTrace,
      latencyMs: (response.trust.modelTrace.latencyMs || 0) + (trace.latencyMs || 0),
      ok: response.trust.modelTrace.ok && trace.ok
    };
  }
}

async function buildAiResponse(question: string, context: Record<string, unknown> = {}): Promise<QueryResponse | null> {
  const { value: plan, trace } = await generateQueryPlanWithDeepSeek(question, context);
  if (!plan) return null;
  if (!plan.canAnswer) return emptyBlockedFromPlan(question, plan, trace);
  if (!Array.isArray(plan.subQueries) || plan.subQueries.length === 0) return null;

  const executed: { name: string; sql: string; rows: Record<string, unknown>[]; subQuery: NonNullable<AiQueryPlan["subQueries"]>[number] }[] = [];
  for (const subQuery of plan.subQueries.slice(0, 5)) {
    if (!subQuery.sql) return null;
    const guard = guardSql(subQuery.sql);
    if (!guard.ok) return null;
    const rows = runSql(subQuery.sql);
    executed.push({ name: subQuery.name, sql: subQuery.sql, rows, subQuery });
  }

  const combinedRows: Record<string, unknown>[] = executed.flatMap((item) => item.rows.map((row) => enrichStationMeta({ 子查询: item.name, ...row })));
  const enhanced = enhanceComparisonRows(combinedRows);
  const hasEnhancedComparison = Boolean(enhanced.chart);
  const blocks = executed.map((item) => buildAnswerBlock(question, item));
  const primaryBlock = hasEnhancedComparison
    ? {
        title: "对比结果",
        summary: "**对比结果**\n- 已将多个子查询结果合并成对比视图，便于同时查看差异和明细。",
        kpis: [{ label: "对比对象", value: `${enhanced.rows.length} 行` }],
        chart: enhanced.chart,
        table: {
          columns: enhanced.columns,
          rows: enhanced.rows
        }
      }
    : blocks[0];
  const stationIds = [...new Set(combinedRows.map((row) => row.station_id).filter(Boolean).map(String))];
  const { value: aiSummary, trace: summaryTrace } = await summarizeWithDeepSeek({
    question,
    plan,
    results: executed.map((item) => ({ name: item.name, rows: item.rows.slice(0, 12) }))
  });
  const columns = primaryBlock?.table.columns || [];
  const answerBlocks = hasEnhancedComparison ? [primaryBlock, ...blocks] : blocks;
  const blockSummary = blocks.length > 1
    ? `\n\n**子任务拆解**\n${blocks.map((block, index) => `- 子任务 ${index + 1}：${block.title}，返回 ${block.table.rows.length} 行数据。`).join("\n")}`
    : "";

  return {
    type: "answer",
    understanding: {
      intent: plan.subQueries.length > 1 ? "ai_multi_query_plan" : "ai_query_plan",
      interpretedQuestion: plan.interpretedQuestion,
      timeRange: plan.timeRange,
      metrics: plan.metrics || [],
      dimensions: plan.dimensions || [],
      filters: []
    },
    workflow: workflow(),
    answer: {
      summary: `${aiSummary?.summary || `已根据 AI QueryPlan 执行 ${executed.length} 个子查询，并返回 ${combinedRows.length} 行结果。`}${blockSummary}`,
      kpis: aiSummary?.kpis || blocks.flatMap((block) => block.kpis || [{ label: block.title, value: `${block.table.rows.length} 行` }]).slice(0, 6),
      chart: primaryBlock?.chart || null,
      table: {
        columns,
        rows: primaryBlock?.table.rows || []
      },
      blocks: answerBlocks,
      mapHighlight: { stationIds },
      followUps: aiSummary?.followUps || plan.followUps || ["继续追问原因", "按区域拆开看", "查看相关站点趋势"]
    },
    trust: {
      modelTrace: {
        ...trace,
        latencyMs: (trace.latencyMs || 0) + (summaryTrace.latencyMs || 0),
        ok: trace.ok && summaryTrace.ok
      },
      schemaMatches: [
        {
          table: "DeepSeek QueryPlan",
          fields: plan.subQueries.flatMap((item) => item.fields || []).slice(0, 12),
          reason: plan.reason,
          confidence: 0.95
        },
        ...plan.subQueries.map((item, index) => ({
          table: item.name,
          fields: [...(item.tables || []), ...(item.fields || [])],
          reason: item.purpose,
          confidence: Number((0.9 - index * 0.03).toFixed(2))
        }))
      ],
      sql: executed.map((item, index) => `-- AI 子查询 ${index + 1}: ${item.name}\n${item.sql.trim()}`).join("\n\n"),
      guardResult: `${executed.length} 个 AI SQL 子查询均已通过只读安全校验`
    },
    nextContext: {
      lastIntent: plan.subQueries.length > 1 ? "ai_multi_query_plan" : "ai_query_plan",
      selectedStations: stationIds,
      timeRange: plan.timeRange,
      lastBlocks: blocks.map((block) => ({
        kind: block.title.includes("营业额") ? "revenue_top" : block.title.includes("亏损") ? "loss_top" : "result",
        title: block.title,
        columns: block.table.columns,
        rows: block.table.rows.slice(0, 10)
      }))
    }
  };
}

async function answerQuestionWithAi(question: string, context: Record<string, unknown> = {}): Promise<QueryResponse | null> {
  let repairInstruction = "";
  let previousFailure = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await buildAiResponse(
      question,
      repairInstruction
        ? {
            ...context,
            answerVerifierRepairInstruction: repairInstruction,
            answerVerifierRetry: attempt,
            previousFailure
          }
        : context
    );
    if (!response) return null;

    const { audit, trace } = await auditCandidateAnswer(question, response);
    attachAudit(response, audit, trace);
    if (audit.pass) return response;
    if (attempt === 0 && audit.repairInstruction && audit.failureType !== previousFailure) {
      repairInstruction = audit.repairInstruction;
      previousFailure = audit.failureType || "unknown";
      continue;
    }
    return null;
  }
  return null;
}

function baseResponse(args: {
  intent: string;
  interpretedQuestion: string;
  timeRange?: string;
  metrics: string[];
  dimensions: string[];
  filters?: string[];
  sql: string;
  rows: Record<string, unknown>[];
  summary: string;
  kpis: { label: string; value: string; delta?: string }[];
  chart: ChartSpec | null;
  columns: string[];
  followUps: string[];
  tableNames: string[];
  mapHighlight?: { regionIds?: string[]; stationIds?: string[] };
  nextContext?: Record<string, unknown>;
}): QueryResponse {
  return {
    type: "answer",
    understanding: {
      intent: args.intent,
      interpretedQuestion: args.interpretedQuestion,
      timeRange: args.timeRange,
      metrics: args.metrics,
      dimensions: args.dimensions,
      filters: args.filters || []
    },
    workflow: workflow(),
    answer: {
      summary: args.summary,
      kpis: args.kpis,
      chart: args.chart,
      table: {
        columns: args.columns,
        rows: args.rows
      },
      mapHighlight: args.mapHighlight || {},
      followUps: args.followUps
    },
    trust: {
      schemaMatches: schemaMatch(args.tableNames, "根据问题中的指标、时间和维度匹配对应事实表与维表"),
      sql: args.sql,
      guardResult: guardSql(args.sql).reason
    },
    nextContext: args.nextContext || {}
  };
}

function answerQuestionByRules(question: string, context: Record<string, unknown> = {}): QueryResponse {
  const q = question.trim();
  const lower = q.toLowerCase();

  if (!q) {
    return blocked(q, "请输入你想查询的充电运营问题。", ["最近 30 天各区域充电收入排名如何？", "哪些站点利用率最低？"]);
  }

  if (sensitiveWords.some((word) => q.includes(word))) {
    return blocked(q, "这个问题涉及个人敏感信息，当前 Demo 不支持查询手机号、车牌或可识别个人身份的数据。你可以改问聚合指标。", [
      "不同车辆类型的平均充电时长如何？",
      "各区域用户分群订单量如何？",
      "最近 30 天各区域收入排名如何？"
    ]);
  }

  if (["股票", "路线", "旅游", "美食", "天气预报", "迪士尼"].some((word) => q.includes(word))) {
    return blocked(q, "当前 Demo 主要支持城市充电网络运营数据，包括收入、订单、利用率、故障、运维、天气和节假日影响。", [
      "最近 30 天各区域充电收入排名如何？",
      "未来 7 天哪些站点可能出现高峰压力？",
      "上周故障率最高的 5 个站点是哪些？"
    ]);
  }

  const selectedRegion = typeof context.selectedRegion === "string" ? context.selectedRegion : null;
  const asksPudong = q.includes("浦东");
  const asksXuhui = q.includes("徐汇");
  const regionFilter = asksPudong ? "浦东新区" : asksXuhui ? "徐汇区" : selectedRegion;

  if ((q.includes("营业额") || q.includes("收入")) && q.includes("最高") && q.includes("最低") && (q.includes("订单") || q.includes("利用率") || q.includes("故障"))) {
    const sql = `
WITH station_metrics AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 利用率,
         SUM(d.fault_count) AS 故障次数,
         ROUND(SUM(d.fault_count) * 1.0 / NULLIF(s.charger_count * 7, 0), 4) AS 故障率
  FROM fact_station_daily d
  JOIN dim_station s ON d.station_id = s.station_id
  JOIN dim_region r ON d.region_id = r.region_id
  WHERE d.stat_date >= date('${today}', '-7 day')
  GROUP BY s.station_id, s.station_name, r.region_name, s.charger_count
),
top_revenue AS (
  SELECT '营业额最高' AS 子问题, *
  FROM station_metrics
  ORDER BY 营业额 DESC
  LIMIT 1
),
bottom_revenue AS (
  SELECT '营业额最低' AS 子问题, *
  FROM station_metrics
  ORDER BY 营业额 ASC
  LIMIT 1
)
SELECT * FROM top_revenue
UNION ALL
SELECT * FROM bottom_revenue`;
    const rows = runSql(sql);
    const high = rows.find((row) => row["子问题"] === "营业额最高");
    const low = rows.find((row) => row["子问题"] === "营业额最低");
    const orderDiff = high && low ? Number(high["订单量"]) - Number(low["订单量"]) : 0;
    const utilizationDiff = high && low ? Number(high["利用率"]) - Number(low["利用率"]) : 0;
    const faultRateDiff = high && low ? Number(high["故障率"]) - Number(low["故障率"]) : 0;
    const stationIds = rows.map((row) => String(row.station_id));
    return {
      type: "answer",
      understanding: {
        intent: "revenue_extreme_comparison",
        interpretedQuestion: "查询过去 7 天全上海营业额最高和最低的站点，并比较二者订单量、利用率、故障率差异",
        timeRange: "过去 7 天",
        metrics: ["营业额", "订单量", "利用率", "故障率"],
        dimensions: ["站点", "区域"],
        filters: ["全上海"]
      },
      workflow: workflow(),
      answer: {
        summary: high && low
          ? `过去 7 天，营业额最高的站点是${high["站点"]}，营业额 ${fmtMoney(Number(high["营业额"]))}；营业额最低的站点是${low["站点"]}，营业额 ${fmtMoney(Number(low["营业额"]))}。两者订单量相差 ${orderDiff} 单，利用率相差 ${fmtPct(utilizationDiff)}，故障率相差 ${fmtPct(faultRateDiff)}。`
          : "当前没有足够站点数据进行营业额极值对比。",
        kpis: [
          { label: "营业额最高", value: high ? `${high["站点"]} · ${fmtMoney(Number(high["营业额"]))}` : "无数据" },
          { label: "营业额最低", value: low ? `${low["站点"]} · ${fmtMoney(Number(low["营业额"]))}` : "无数据" },
          { label: "订单量差", value: `${orderDiff} 单` },
          { label: "利用率差", value: fmtPct(utilizationDiff) },
          { label: "故障率差", value: fmtPct(faultRateDiff) }
        ],
        chart: {
          type: "bar",
          title: "营业额最高与最低站点对比",
          xKey: "子问题",
          yKey: "营业额",
          data: rows
        },
        table: {
          columns: ["子问题", "站点", "区域", "营业额", "订单量", "利用率", "故障次数", "故障率"],
          rows
        },
        mapHighlight: { stationIds },
        followUps: ["解释营业额差异的原因", "这两个站点最近 30 天趋势如何？", "再比较服务费收入和故障损失"]
      },
      trust: {
        schemaMatches: schemaMatch(["fact_station_daily", "dim_station", "dim_region"], "营业额极值比较需要站点日汇总、站点维表和区域维表"),
        sql,
        guardResult: guardSql(sql).reason
      },
      nextContext: {
        lastIntent: "revenue_extreme_comparison",
        selectedStations: stationIds,
        timeRange: "过去 7 天"
      }
    };
  }

  if ((q.includes("亏损") || q.includes("亏") || q.includes("损失")) && (q.includes("盈利") || q.includes("利润")) && q.includes("利用率")) {
    const baseCte = `
WITH station_base AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 利用率,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算
  FROM fact_station_daily d
  JOIN dim_station s ON d.station_id = s.station_id
  JOIN dim_region r ON d.region_id = r.region_id
  WHERE d.stat_date >= date('${today}', '-7 day')
  GROUP BY s.station_id, s.station_name, r.region_name
),
fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE date(created_at) >= date('${today}', '-7 day')
  GROUP BY station_id
),
station_metrics AS (
  SELECT station_base.station_id, 站点, 区域, 营业额, 订单量, 利用率,
         服务费收入,
         COALESCE(故障损失估算, 0) AS 故障损失估算,
         运维成本估算,
         ROUND(服务费收入 - COALESCE(故障损失估算, 0) - 运维成本估算, 2) AS 盈利额,
         ROUND(MAX(0, COALESCE(故障损失估算, 0) + 运维成本估算 - 服务费收入), 2) AS 亏损额,
         ROUND((服务费收入 - COALESCE(故障损失估算, 0) - 运维成本估算) / NULLIF(营业额, 0), 4) AS 净利率
  FROM station_base
  LEFT JOIN fault_loss ON station_base.station_id = fault_loss.station_id
)`;
    const lossSql = `${baseCte}
SELECT '亏损最严重' AS 子问题, station_id, 站点, 区域, 亏损额 AS 指标值, 营业额, 利用率, 盈利额, 净利率
FROM station_metrics
ORDER BY 亏损额 DESC
LIMIT 1`;
    const profitSql = `${baseCte}
SELECT '盈利最多' AS 子问题, station_id, 站点, 区域, 盈利额 AS 指标值, 营业额, 利用率, 盈利额, 净利率
FROM station_metrics
ORDER BY 盈利额 DESC
LIMIT 1`;
    const utilizationSql = `${baseCte}
SELECT '利用率最低' AS 子问题, station_id, 站点, 区域, 利用率 AS 指标值, 营业额, 利用率, 盈利额, 净利率
FROM station_metrics
ORDER BY 利用率 ASC
LIMIT 1`;
    const lossRow = runSql(lossSql)[0];
    const profitRow = runSql(profitSql)[0];
    const utilizationRow = runSql(utilizationSql)[0];
    const rows = [lossRow, profitRow, utilizationRow].filter(Boolean);
    const stationIds = [...new Set(rows.map((row) => String(row.station_id)))];
    return {
      type: "answer",
      understanding: {
        intent: "multi_intent_profit_loss_utilization",
        interpretedQuestion: "拆成 3 个子查询：过去 7 天亏损最严重站点、盈利最多站点、利用率最低站点",
        timeRange: "过去 7 天",
        metrics: ["亏损额", "盈利额", "利用率"],
        dimensions: ["站点", "区域"],
        filters: []
      },
      workflow: workflow(),
      answer: {
        summary: `我把这个问题拆成 3 个子查询分别回答：亏损最严重的是${lossRow?.["站点"] ?? "无数据"}，盈利最多的是${profitRow?.["站点"] ?? "无数据"}，利用率最低的是${utilizationRow?.["站点"] ?? "无数据"}。这属于多意图查询，需要分别计算和排序。`,
        kpis: [
          { label: "亏损最严重", value: lossRow ? `${lossRow["站点"]} · ${fmtMoney(Number(lossRow["指标值"]))}` : "无数据" },
          { label: "盈利最多", value: profitRow ? `${profitRow["站点"]} · ${fmtMoney(Number(profitRow["指标值"]))}` : "无数据" },
          { label: "利用率最低", value: utilizationRow ? `${utilizationRow["站点"]} · ${fmtPct(Number(utilizationRow["指标值"]))}` : "无数据" }
        ],
        chart: {
          type: "bar",
          title: "三个子查询的命中站点",
          xKey: "子问题",
          yKey: "指标值",
          data: rows
        },
        table: {
          columns: ["子问题", "站点", "区域", "指标值", "营业额", "利用率", "盈利额", "净利率"],
          rows
        },
        mapHighlight: { stationIds },
        followUps: ["分别解释这三个站点为什么上榜", "这三个站点最近 30 天趋势如何？", "这些站点的故障情况怎么样？"]
      },
      trust: {
        schemaMatches: schemaMatch(["fact_station_daily", "dim_station", "dim_region", "fact_fault_ticket"], "多意图问题拆成 3 个站点经营子查询"),
        sql: [lossSql, profitSql, utilizationSql].map((sql, index) => `-- 子查询 ${index + 1}\n${sql.trim()}`).join("\n\n"),
        guardResult: "3 个只读子查询均已通过 SQL 护栏校验"
      },
      nextContext: {
        lastIntent: "multi_intent_profit_loss_utilization",
        selectedStations: stationIds,
        timeRange: "过去 7 天"
      }
    };
  }

  if ((q.includes("亏损") || q.includes("亏") || q.includes("损失")) && (q.includes("营业额") || q.includes("收入")) && (q.includes("净利率") || q.includes("利润率"))) {
    const baseCte = `
WITH station_base AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 利用率,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算
  FROM fact_station_daily d
  JOIN dim_station s ON d.station_id = s.station_id
  JOIN dim_region r ON d.region_id = r.region_id
  WHERE d.stat_date >= date('${today}', '-7 day')
  GROUP BY s.station_id, s.station_name, r.region_name
),
fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE date(created_at) >= date('${today}', '-7 day')
  GROUP BY station_id
),
station_metrics AS (
  SELECT station_base.station_id, 站点, 区域, 营业额, 订单量, 利用率,
         服务费收入,
         COALESCE(故障损失估算, 0) AS 故障损失估算,
         运维成本估算,
         ROUND(MAX(0, COALESCE(故障损失估算, 0) + 运维成本估算 - 服务费收入), 2) AS 亏损额,
         ROUND((服务费收入 - COALESCE(故障损失估算, 0) - 运维成本估算) / NULLIF(营业额, 0), 4) AS 净利率
  FROM station_base
  LEFT JOIN fault_loss ON station_base.station_id = fault_loss.station_id
)`;
    const lossSql = `${baseCte}
SELECT '亏损额最高' AS 子问题, station_id, 站点, 区域, 亏损额 AS 指标值, 营业额, 净利率
FROM station_metrics
ORDER BY 亏损额 DESC
LIMIT 1`;
    const revenueSql = `${baseCte}
SELECT '营业额最高' AS 子问题, station_id, 站点, 区域, 营业额 AS 指标值, 营业额, 净利率
FROM station_metrics
ORDER BY 营业额 DESC
LIMIT 1`;
    const marginSql = `${baseCte}
SELECT '净利率最高' AS 子问题, station_id, 站点, 区域, 净利率 AS 指标值, 营业额, 净利率
FROM station_metrics
ORDER BY 净利率 DESC
LIMIT 1`;
    const lossRow = runSql(lossSql)[0];
    const revenueRow = runSql(revenueSql)[0];
    const marginRow = runSql(marginSql)[0];
    const rows = [lossRow, revenueRow, marginRow].filter(Boolean);
    const stationIds = [...new Set(rows.map((row) => String(row.station_id)))];
    return {
      type: "answer",
      understanding: {
        intent: "multi_intent_station_extremes",
        interpretedQuestion: "拆成 3 个子查询：过去 7 天亏损额最高站点、营业额最高站点、净利率最高站点",
        timeRange: "过去 7 天",
        metrics: ["亏损额", "营业额", "净利率"],
        dimensions: ["站点", "区域"],
        filters: []
      },
      workflow: workflow(),
      answer: {
        summary: `我把这个问题拆成 3 个子查询分别回答：亏损额最高的是${lossRow?.["站点"] ?? "无数据"}，营业额最高的是${revenueRow?.["站点"] ?? "无数据"}，净利率最高的是${marginRow?.["站点"] ?? "无数据"}。这三个指标排序方向不同，不能合并成一个查询。`,
        kpis: [
          { label: "亏损额最高", value: lossRow ? `${lossRow["站点"]} · ${fmtMoney(Number(lossRow["指标值"]))}` : "无数据" },
          { label: "营业额最高", value: revenueRow ? `${revenueRow["站点"]} · ${fmtMoney(Number(revenueRow["指标值"]))}` : "无数据" },
          { label: "净利率最高", value: marginRow ? `${marginRow["站点"]} · ${fmtPct(Number(marginRow["指标值"]))}` : "无数据" }
        ],
        chart: {
          type: "bar",
          title: "三个子查询的命中站点",
          xKey: "子问题",
          yKey: "指标值",
          data: rows
        },
        table: {
          columns: ["子问题", "站点", "区域", "指标值", "营业额", "净利率"],
          rows
        },
        mapHighlight: { stationIds },
        followUps: ["分别解释这三个站点为什么上榜", "只看亏损额最高站点的故障情况", "这三个站点最近 30 天趋势如何？"]
      },
      trust: {
        schemaMatches: schemaMatch(["fact_station_daily", "dim_station", "dim_region", "fact_fault_ticket"], "多意图问题拆成 3 个站点经营极值子查询"),
        sql: [lossSql, revenueSql, marginSql].map((sql, index) => `-- 子查询 ${index + 1}\n${sql.trim()}`).join("\n\n"),
        guardResult: "3 个只读子查询均已通过 SQL 护栏校验"
      },
      nextContext: {
        lastIntent: "multi_intent_station_extremes",
        selectedStations: stationIds,
        timeRange: "过去 7 天"
      }
    };
  }

  if ((q.includes("亏损") || q.includes("亏") || q.includes("损失")) && (q.includes("净利率") || q.includes("利润率") || q.includes("利率"))) {
    const sql = `
WITH station_base AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 利用率,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算
  FROM fact_station_daily d
  JOIN dim_station s ON d.station_id = s.station_id
  JOIN dim_region r ON d.region_id = r.region_id
  WHERE d.stat_date >= date('${today}', '-7 day')
  GROUP BY s.station_id, s.station_name, r.region_name
),
fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE date(created_at) >= date('${today}', '-7 day')
  GROUP BY station_id
)
SELECT station_base.station_id, 站点, 区域, 营业额, 订单量, 利用率,
       服务费收入,
       COALESCE(故障损失估算, 0) AS 故障损失估算,
       运维成本估算,
       ROUND(MAX(0, COALESCE(故障损失估算, 0) + 运维成本估算 - 服务费收入), 2) AS 亏损额,
       ROUND((服务费收入 - COALESCE(故障损失估算, 0) - 运维成本估算) / NULLIF(营业额, 0), 4) AS 净利率
FROM station_base
LEFT JOIN fault_loss ON station_base.station_id = fault_loss.station_id
ORDER BY 亏损额 DESC, 净利率 ASC
LIMIT 12`;
    const rows = runSql(sql);
    const topLoss = [...rows].sort((a, b) => Number(b["亏损额"]) - Number(a["亏损额"]))[0];
    const lowestMargin = [...rows].sort((a, b) => Number(a["净利率"]) - Number(b["净利率"]))[0];
    return baseResponse({
      intent: "loss_margin_analysis",
      interpretedQuestion: "查询过去 7 天站点亏损额最高者，并同时找出净利率最低者",
      timeRange: "过去 7 天",
      metrics: ["亏损额", "净利率", "营业额", "故障损失估算", "运维成本估算"],
      dimensions: ["站点", "区域"],
      sql,
      rows,
      summary: topLoss && lowestMargin
        ? `过去 7 天，亏损额最高的站点是${topLoss["站点"]}，亏损额约 ${fmtMoney(Number(topLoss["亏损额"]))}；净利率最低的站点是${lowestMargin["站点"]}，净利率约 ${fmtPct(Number(lowestMargin["净利率"]))}。这里按站点维度计算，不是区域收入排名。`
        : "过去 7 天没有足够的站点亏损与净利率数据。",
      kpis: [
        { label: "亏损额最高站点", value: topLoss ? String(topLoss["站点"]) : "无" },
        { label: "最高亏损额", value: topLoss ? fmtMoney(Number(topLoss["亏损额"])) : "0 元" },
        { label: "净利率最低站点", value: lowestMargin ? String(lowestMargin["站点"]) : "无" },
        { label: "最低净利率", value: lowestMargin ? fmtPct(Number(lowestMargin["净利率"])) : "0%" }
      ],
      chart: {
        type: "bar",
        title: "过去 7 天站点亏损额 Top 12",
        xKey: "站点",
        yKey: "亏损额",
        data: rows
      },
      columns: ["站点", "区域", "营业额", "订单量", "利用率", "服务费收入", "故障损失估算", "运维成本估算", "亏损额", "净利率"],
      followUps: ["为什么这个站点亏损最高？", "按故障损失排序", "这些站点最近 30 天趋势如何？"],
      tableNames: ["fact_station_daily", "dim_station", "dim_region", "fact_fault_ticket"],
      mapHighlight: { stationIds: [topLoss?.station_id, lowestMargin?.station_id].filter(Boolean).map(String) },
      nextContext: {
        lastIntent: "loss_margin_analysis",
        selectedStations: [topLoss?.station_id, lowestMargin?.station_id].filter(Boolean),
        timeRange: "过去 7 天"
      }
    });
  }

  if ((q.includes("营业额") || q.includes("收入")) && (q.includes("净利率") || q.includes("利润率"))) {
    const sql = `
WITH station_base AS (
  SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
         ROUND(SUM(d.total_revenue), 2) AS 营业额,
         ROUND(SUM(d.service_revenue), 2) AS 服务费收入,
         SUM(d.order_count) AS 订单量,
         ROUND(AVG(d.utilization_rate), 4) AS 利用率,
         ROUND(SUM(d.total_revenue) * 0.16 + SUM(d.order_count) * 0.8, 2) AS 运维成本估算
  FROM fact_station_daily d
  JOIN dim_station s ON d.station_id = s.station_id
  JOIN dim_region r ON d.region_id = r.region_id
  WHERE d.stat_date >= date('${today}', '-7 day')
  GROUP BY s.station_id, s.station_name, r.region_name
),
fault_loss AS (
  SELECT station_id, ROUND(SUM(lost_revenue_estimate), 2) AS 故障损失估算
  FROM fact_fault_ticket
  WHERE date(created_at) >= date('${today}', '-7 day')
  GROUP BY station_id
)
SELECT station_base.station_id, 站点, 区域, 营业额, 订单量, 利用率,
       服务费收入,
       COALESCE(故障损失估算, 0) AS 故障损失估算,
       运维成本估算,
       ROUND((服务费收入 - COALESCE(故障损失估算, 0) - 运维成本估算) / NULLIF(营业额, 0), 4) AS 净利率
FROM station_base
LEFT JOIN fault_loss ON station_base.station_id = fault_loss.station_id
ORDER BY 营业额 DESC
LIMIT 12`;
    const rows = runSql(sql);
    const topRevenue = [...rows].sort((a, b) => Number(b["营业额"]) - Number(a["营业额"]))[0];
    const topMargin = [...rows].sort((a, b) => Number(b["净利率"]) - Number(a["净利率"]))[0];
    return baseResponse({
      intent: "multi_metric_station_analysis",
      interpretedQuestion: "查询过去 7 天站点营业额最高者，并同时比较站点净利率",
      timeRange: "过去 7 天",
      metrics: ["营业额", "净利率", "订单量", "利用率"],
      dimensions: ["站点", "区域"],
      sql,
      rows,
      summary: topRevenue && topMargin
        ? `过去 7 天，营业额最高的站点是${topRevenue["站点"]}，营业额 ${fmtMoney(Number(topRevenue["营业额"]))}；净利率最高的站点是${topMargin["站点"]}，净利率约 ${fmtPct(Number(topMargin["净利率"]))}。这说明“收入最高”和“经营效率最高”不是同一个问题，需要分开看。`
        : "过去 7 天没有足够站点经营数据。",
      kpis: [
        { label: "营业额最高站点", value: topRevenue ? String(topRevenue["站点"]) : "无" },
        { label: "最高营业额", value: topRevenue ? fmtMoney(Number(topRevenue["营业额"])) : "0 元" },
        { label: "净利率最高站点", value: topMargin ? String(topMargin["站点"]) : "无" },
        { label: "最高净利率", value: topMargin ? fmtPct(Number(topMargin["净利率"])) : "0%" }
      ],
      chart: {
        type: "bar",
        title: "过去 7 天站点营业额 Top 12",
        xKey: "站点",
        yKey: "营业额",
        data: rows
      },
      columns: ["站点", "区域", "营业额", "订单量", "利用率", "服务费收入", "故障损失估算", "运维成本估算", "净利率"],
      followUps: ["按净利率重新排序", "这些站点故障情况怎么样？", "净利率口径是什么？"],
      tableNames: ["fact_station_daily", "dim_station", "dim_region", "fact_fault_ticket"],
      mapHighlight: { stationIds: [topRevenue?.station_id, topMargin?.station_id].filter(Boolean).map(String) },
      nextContext: {
        lastIntent: "multi_metric_station_analysis",
        selectedStations: [topRevenue?.station_id, topMargin?.station_id].filter(Boolean),
        timeRange: "过去 7 天"
      }
    });
  }

  if ((q.includes("故障") && (q.includes("最高") || q.includes("异常") || q.includes("哪些"))) || q.includes("这些站点故障")) {
    const sql = `
SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
       COUNT(f.ticket_id) AS 故障次数,
       ROUND(SUM(f.lost_revenue_estimate), 2) AS 预估收入损失,
       GROUP_CONCAT(DISTINCT f.fault_type) AS 主要故障
FROM fact_fault_ticket f
JOIN dim_station s ON f.station_id = s.station_id
JOIN dim_region r ON f.region_id = r.region_id
WHERE date(f.created_at) >= date('${today}', '-7 day')
GROUP BY s.station_id, s.station_name, r.region_name
ORDER BY 故障次数 DESC, 预估收入损失 DESC
LIMIT 5`;
    const rows = runSql(sql);
    const top = rows[0];
    return baseResponse({
      intent: "fault_anomaly",
      interpretedQuestion: "查询最近 7 天故障次数最高的站点，并估算收入损失",
      timeRange: "最近 7 天",
      metrics: ["故障次数", "预估收入损失"],
      dimensions: ["站点", "区域"],
      sql,
      rows,
      summary: top ? `最近 7 天故障最突出的站点是${top["站点"]}，故障次数为 ${top["故障次数"]} 次。建议优先检查通信、枪线和过温类问题，并评估是否需要节前巡检。` : "最近 7 天没有明显故障记录。",
      kpis: [
        { label: "异常站点", value: `${rows.length} 个` },
        { label: "最高故障次数", value: top ? `${top["故障次数"]} 次` : "0 次" },
        { label: "最高损失估算", value: top ? fmtMoney(Number(top["预估收入损失"])) : "0 元" }
      ],
      chart: {
        type: "bar",
        title: "故障站点 Top 5",
        xKey: "站点",
        yKey: "故障次数",
        data: rows
      },
      columns: ["站点", "区域", "故障次数", "预估收入损失", "主要故障"],
      followUps: ["这些站点收入损失多少？", "按故障类型拆开看", "只看浦东新区"],
      tableNames: ["fact_fault_ticket", "dim_station", "dim_region"],
      mapHighlight: { stationIds: rows.map((r) => String(r.station_id)) },
      nextContext: { lastIntent: "fault_anomaly", selectedStations: rows.map((r) => r.station_id), timeRange: "最近 7 天" }
    });
  }

  if (q.includes("利用率") && (q.includes("最低") || q.includes("优化") || q.includes("低"))) {
    const sql = `
SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域, s.station_type AS 站点类型,
       ROUND(AVG(d.utilization_rate), 4) AS 利用率,
       ROUND(SUM(d.total_revenue), 2) AS 收入,
       SUM(d.fault_count) AS 故障次数,
       ROUND(AVG(d.health_score), 1) AS 健康度
FROM fact_station_daily d
JOIN dim_station s ON d.station_id = s.station_id
JOIN dim_region r ON d.region_id = r.region_id
WHERE d.stat_date >= date('${today}', '-30 day')
GROUP BY s.station_id, s.station_name, r.region_name, s.station_type
HAVING 故障次数 < 12
ORDER BY 利用率 ASC
LIMIT 8`;
    const rows = runSql(sql);
    const avg = rows.reduce((sum, r) => sum + Number(r["利用率"]), 0) / Math.max(rows.length, 1);
    return baseResponse({
      intent: "low_utilization_suggestion",
      interpretedQuestion: "查询最近 30 天低利用率且非严重故障的站点，并给出优化建议",
      timeRange: "最近 30 天",
      metrics: ["利用率", "收入", "健康度"],
      dimensions: ["站点", "站点类型"],
      sql,
      rows,
      summary: `最近 30 天低利用率站点主要集中在社区和公共停车场类型，平均利用率约 ${fmtPct(avg)}。这些站点不是单纯故障导致，更可能与位置、时段需求和运营活动不足有关，建议优先做夜间低谷优惠和周边导流。`,
      kpis: [
        { label: "低利用站点", value: `${rows.length} 个` },
        { label: "平均利用率", value: fmtPct(avg) },
        { label: "优化优先级", value: "中高" }
      ],
      chart: {
        type: "bar",
        title: "低利用率站点",
        xKey: "站点",
        yKey: "利用率",
        data: rows.map((r) => ({ ...r, 利用率: Number(r["利用率"]) }))
      },
      columns: ["站点", "区域", "站点类型", "利用率", "收入", "故障次数", "健康度"],
      followUps: ["只看商业综合体站点", "这些站点夜间订单怎么样？", "给我具体优化建议"],
      tableNames: ["fact_station_daily", "dim_station", "dim_region"],
      mapHighlight: { stationIds: rows.map((r) => String(r.station_id)) },
      nextContext: { lastIntent: "low_utilization", selectedStations: rows.map((r) => r.station_id), timeRange: "最近 30 天" }
    });
  }

  if (q.includes("未来") || q.includes("预测") || q.includes("高峰压力")) {
    const sql = `
SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
       ROUND(AVG(d.utilization_rate), 4) AS 近30天利用率,
       SUM(d.order_count) AS 近30天订单,
       SUM(d.fault_count) AS 故障次数,
       ROUND(AVG(d.health_score), 1) AS 健康度
FROM fact_station_daily d
JOIN dim_station s ON d.station_id = s.station_id
JOIN dim_region r ON d.region_id = r.region_id
WHERE d.stat_date >= date('${today}', '-30 day')
GROUP BY s.station_id, s.station_name, r.region_name
ORDER BY 近30天利用率 DESC, 近30天订单 DESC
LIMIT 8`;
    const rows: Record<string, unknown>[] = runSql(sql).map((r) => ({
      ...r,
      高峰压力指数: Math.round(Number(r["近30天利用率"]) * 100 + Number(r["故障次数"]) * 1.6)
    }));
    const top = rows[0];
    return baseResponse({
      intent: "forecast",
      interpretedQuestion: "根据近 30 天利用率、订单和故障情况，估算未来 7 天高峰压力站点",
      timeRange: "未来 7 天预测，参考近 30 天",
      metrics: ["利用率", "订单量", "高峰压力指数"],
      dimensions: ["站点", "区域"],
      sql,
      rows,
      summary: top ? `未来 7 天高峰压力最高的站点预计是${top["站点"]}。判断依据是近 30 天利用率和订单量持续较高，同时存在一定故障风险。建议提前巡检高功率快充桩，并准备晚高峰临时运维响应。` : "当前没有足够数据进行预测。",
      kpis: [
        { label: "高压力站点", value: `${rows.length} 个` },
        { label: "最高压力指数", value: top ? String(top["高峰压力指数"]) : "0" },
        { label: "预测方式", value: "趋势外推" }
      ],
      chart: {
        type: "bar",
        title: "未来 7 天高峰压力指数",
        xKey: "站点",
        yKey: "高峰压力指数",
        data: rows
      },
      columns: ["站点", "区域", "近30天利用率", "近30天订单", "故障次数", "健康度", "高峰压力指数"],
      followUps: ["这些站点需要提前巡检吗？", "只看晚高峰压力", "按区域汇总预测"],
      tableNames: ["fact_station_daily", "dim_station", "dim_region"],
      mapHighlight: { stationIds: rows.map((r) => String(r.station_id)) },
      nextContext: { lastIntent: "forecast", selectedStations: rows.map((r) => r.station_id) }
    });
  }

  if (q.includes("下降") || q.includes("为什么")) {
    const sql = `
WITH this_month AS (
  SELECT d.region_id, SUM(d.order_count) AS orders, SUM(d.total_revenue) AS revenue, SUM(d.fault_count) AS faults
  FROM fact_station_daily d
  WHERE d.stat_date >= date('${today}', 'start of month')
  GROUP BY d.region_id
),
last_month AS (
  SELECT d.region_id, SUM(d.order_count) AS orders, SUM(d.total_revenue) AS revenue, SUM(d.fault_count) AS faults
  FROM fact_station_daily d
  WHERE d.stat_date >= date('${today}', 'start of month', '-1 month')
    AND d.stat_date < date('${today}', 'start of month')
  GROUP BY d.region_id
)
SELECT r.region_id, r.region_name AS 区域,
       this_month.orders AS 本月订单,
       last_month.orders AS 上月订单,
       this_month.orders - last_month.orders AS 订单变化,
       ROUND((this_month.orders - last_month.orders) * 1.0 / NULLIF(last_month.orders, 0), 4) AS 变化率,
       this_month.faults AS 本月故障,
       last_month.faults AS 上月故障
FROM this_month
JOIN last_month ON this_month.region_id = last_month.region_id
JOIN dim_region r ON r.region_id = this_month.region_id
ORDER BY 订单变化 ASC
LIMIT 8`;
    const rows = runSql(sql);
    const worst = rows[0];
    return baseResponse({
      intent: "root_cause",
      interpretedQuestion: "对比本月和上月订单变化，并从区域和故障角度做归因",
      timeRange: "本月对比上月",
      metrics: ["订单量", "故障次数", "变化率"],
      dimensions: ["区域"],
      sql,
      rows,
      summary: worst ? `本月订单下降主要来自${worst["区域"]}，订单变化为 ${worst["订单变化"]}。同时该区域本月故障为 ${worst["本月故障"]} 次，可继续拆解站点、时段和天气因素，判断是供给故障还是需求波动。` : "本月订单没有明显下降。",
      kpis: [
        { label: "下降最明显区域", value: worst ? String(worst["区域"]) : "无" },
        { label: "最大订单变化", value: worst ? String(worst["订单变化"]) : "0" },
        { label: "建议追问", value: "故障/时段" }
      ],
      chart: {
        type: "bar",
        title: "本月订单变化归因",
        xKey: "区域",
        yKey: "订单变化",
        data: rows
      },
      columns: ["区域", "本月订单", "上月订单", "订单变化", "变化率", "本月故障", "上月故障"],
      followUps: ["主要看徐汇", "是不是因为故障变多？", "按站点拆开看"],
      tableNames: ["fact_station_daily", "dim_region", "fact_fault_ticket"],
      mapHighlight: { regionIds: rows.slice(0, 3).map((r) => String(r.region_id)) },
      nextContext: { lastIntent: "root_cause", timeRange: "本月对比上月" }
    });
  }

  if (q.includes("浦东") && q.includes("徐汇") || q.includes("对比")) {
    const sql = `
SELECT r.region_id, r.region_name AS 区域,
       SUM(d.order_count) AS 订单量,
       ROUND(SUM(d.total_revenue), 2) AS 收入,
       ROUND(AVG(d.utilization_rate), 4) AS 利用率
FROM fact_station_daily d
JOIN dim_region r ON d.region_id = r.region_id
WHERE d.stat_date >= date('${today}', '-30 day')
  AND r.region_name IN ('浦东新区', '徐汇区')
GROUP BY r.region_id, r.region_name
ORDER BY 收入 DESC`;
    const rows = runSql(sql);
    const winner = rows[0];
    return baseResponse({
      intent: "comparison",
      interpretedQuestion: "对比浦东新区和徐汇区最近 30 天订单量、收入和利用率",
      timeRange: "最近 30 天",
      metrics: ["订单量", "收入", "利用率"],
      dimensions: ["区域"],
      sql,
      rows,
      summary: winner ? `最近 30 天${winner["区域"]}收入更高。若只看利用率，徐汇可能因为站点密度更高而更紧张，适合继续拆解站点供给。` : "没有查到两个区域的对比数据。",
      kpis: [
        { label: "收入领先区域", value: winner ? String(winner["区域"]) : "无" },
        { label: "对比区域", value: "2 个" }
      ],
      chart: {
        type: "bar",
        title: "浦东 vs 徐汇",
        xKey: "区域",
        yKey: "收入",
        data: rows
      },
      columns: ["区域", "订单量", "收入", "利用率"],
      followUps: ["按站点拆开看", "再看故障率", "按工作日和休息日拆开看"],
      tableNames: ["fact_station_daily", "dim_region"],
      mapHighlight: { regionIds: rows.map((r) => String(r.region_id)) },
      nextContext: { selectedRegions: rows.map((r) => r.region_id), timeRange: "最近 30 天" }
    });
  }

  if (q.includes("站点") && (q.includes("贡献") || q.includes("最大") || regionFilter)) {
    const where = regionFilter ? `AND r.region_name = '${regionFilter}'` : "";
    const sql = `
SELECT s.station_id, s.station_name AS 站点, r.region_name AS 区域,
       ROUND(SUM(d.total_revenue), 2) AS 收入,
       SUM(d.order_count) AS 订单量,
       ROUND(AVG(d.utilization_rate), 4) AS 利用率
FROM fact_station_daily d
JOIN dim_station s ON d.station_id = s.station_id
JOIN dim_region r ON d.region_id = r.region_id
WHERE d.stat_date >= date('${today}', '-30 day') ${where}
GROUP BY s.station_id, s.station_name, r.region_name
ORDER BY 收入 DESC
LIMIT 8`;
    const rows = runSql(sql);
    const top = rows[0];
    return baseResponse({
      intent: "station_ranking",
      interpretedQuestion: `查询${regionFilter || "全市"}最近 30 天收入贡献最高的站点`,
      timeRange: "最近 30 天",
      metrics: ["收入", "订单量", "利用率"],
      dimensions: ["站点"],
      filters: regionFilter ? [regionFilter] : [],
      sql,
      rows,
      summary: top ? `${regionFilter || "全市"}最近 30 天收入贡献最高的站点是${top["站点"]}，收入 ${fmtMoney(Number(top["收入"]))}。这些头部站点适合继续关注故障和高峰压力。` : "没有查到站点贡献数据。",
      kpis: [
        { label: "Top 站点", value: top ? String(top["站点"]) : "无" },
        { label: "Top 收入", value: top ? fmtMoney(Number(top["收入"])) : "0 元" },
        { label: "站点数量", value: `${rows.length} 个` }
      ],
      chart: {
        type: "bar",
        title: "站点收入贡献 Top 8",
        xKey: "站点",
        yKey: "收入",
        data: rows
      },
      columns: ["站点", "区域", "收入", "订单量", "利用率"],
      followUps: ["这些站点故障情况怎么样？", "按晚高峰拆开看", "未来 7 天压力如何？"],
      tableNames: ["fact_station_daily", "dim_station", "dim_region"],
      mapHighlight: { stationIds: rows.map((r) => String(r.station_id)) },
      nextContext: { selectedStations: rows.map((r) => r.station_id), selectedRegion: regionFilter, timeRange: "最近 30 天" }
    });
  }

  const sql = `
SELECT r.region_id, r.region_name AS 区域,
       ROUND(SUM(d.total_revenue), 2) AS 充电收入,
       SUM(d.order_count) AS 订单量,
       ROUND(AVG(d.utilization_rate), 4) AS 平均利用率,
       SUM(d.fault_count) AS 故障次数
FROM fact_station_daily d
JOIN dim_region r ON d.region_id = r.region_id
WHERE d.stat_date >= date('${today}', '-30 day')
GROUP BY r.region_id, r.region_name
ORDER BY 充电收入 DESC
LIMIT 10`;
  const rows = runSql(sql);
  const totalRevenue = rows.reduce((sum, r) => sum + Number(r["充电收入"]), 0);
  const top = rows[0];
  return baseResponse({
    intent: lower.includes("trend") || q.includes("趋势") ? "trend" : "region_revenue_ranking",
    interpretedQuestion: "查询最近 30 天上海各区域充电收入，并按收入从高到低排序",
    timeRange: "最近 30 天",
    metrics: ["充电收入", "订单量", "平均利用率"],
    dimensions: ["区域"],
    sql,
    rows,
    summary: top ? `最近 30 天，${top["区域"]}充电收入最高，占 Top10 区域收入的 ${(Number(top["充电收入"]) / totalRevenue * 100).toFixed(1)}%。头部区域通常兼具高人流、商务办公和交通枢纽属性，建议继续追问站点贡献和故障影响。` : "没有查到区域收入数据。",
    kpis: [
      { label: "Top10 总收入", value: fmtMoney(totalRevenue) },
      { label: "收入最高区域", value: top ? String(top["区域"]) : "无" },
      { label: "最高区域收入", value: top ? fmtMoney(Number(top["充电收入"])) : "0 元" },
      { label: "覆盖区域", value: `${rows.length} 个` }
    ],
    chart: {
      type: "bar",
      title: "最近 30 天区域充电收入排名",
      xKey: "区域",
      yKey: "充电收入",
      data: rows
    },
    columns: ["区域", "充电收入", "订单量", "平均利用率", "故障次数"],
    followUps: ["那浦东里面哪些站点贡献最大？", "再看这些区域的故障情况", "按工作日和休息日拆开看"],
    tableNames: ["fact_station_daily", "dim_region"],
    mapHighlight: { regionIds: rows.slice(0, 3).map((r) => String(r.region_id)) },
    nextContext: { selectedRegions: rows.slice(0, 3).map((r) => r.region_id), timeRange: "最近 30 天" }
  });
}

function mergePendingClarification(question: string, context: Record<string, unknown>) {
  const explicitClarificationFor =
    typeof context.clarificationFor === "string"
      ? context.clarificationFor
      : typeof (context.clarificationFor as { originalQuestion?: unknown } | undefined)?.originalQuestion === "string"
        ? String((context.clarificationFor as { originalQuestion: string }).originalQuestion)
        : "";
  if (explicitClarificationFor) {
    const { pendingClarification: _pendingClarification, clarificationFor: _clarificationFor, ...restContext } = context;
    return {
      question: `${explicitClarificationFor}\n用户澄清：${question}`,
      context: {
        ...restContext,
        clarificationResolved: true,
        clarificationOriginalQuestion: explicitClarificationFor
      }
    };
  }
  const pending = context.pendingClarification as { originalQuestion?: string; reason?: string } | undefined;
  if (!pending?.originalQuestion) return { question, context };
  const looksLikeClarificationReply = /我说|我是说|指的是|意思是|前面|上面|刚才|他们|这些|这个|那个|继续|按/.test(question);
  if (!looksLikeClarificationReply) return { question, context };
  const { pendingClarification: _pendingClarification, ...restContext } = context;
  return {
    question: `${pending.originalQuestion}\n用户澄清：${question}`,
    context: {
      ...restContext,
      clarificationResolved: true,
      clarificationOriginalQuestion: pending.originalQuestion
    }
  };
}

export async function answerQuestion(question: string, context: Record<string, unknown> = {}): Promise<QueryResponse> {
  const merged = mergePendingClarification(question, context);
  const effectiveQuestion = merged.question;
  const effectiveContext = merged.context;
  const hasContextPointer = /他们|这些|上述|上面|刚才|那个|这个|其中|交集|重合|继续/.test(effectiveQuestion);
  const pointerResolvedInSentence = hasInSentenceAntecedent(effectiveQuestion);
  const hasUsableContext = Array.isArray(effectiveContext.lastBlocks) || Array.isArray(effectiveContext.selectedStations) || typeof effectiveContext.selectedRegion === "string";
  const plannerContext = {
    ...effectiveContext,
    ...(hasContextPointer && pointerResolvedInSentence
      ? { coreferenceHint: "用户问题中的指代词可在同一句内解析，不要因为出现他们/这些就要求上一轮上下文。" }
      : {}),
    ...(/企业|运营商/.test(effectiveQuestion)
      ? { entityHint: "当前 Demo 数据对象是充电站和区域；如果用户说企业但问题语义是营业额排名，可按充电站/运营点口径回答，并在解释中说明口径。" }
      : {}),
    ...(/累计|累加|从前往后|从高到低|到\s*(?:Top|top)\s*几|一半|50%/.test(effectiveQuestion)
      ? { planningHint: "这是累计贡献类问题：按目标指标降序排列，计算累计值和累计占比，找出首次达到阈值的 TopN。不要改写成区域收入排名。" }
      : {})
  };

  if (sensitiveWords.some((word) => effectiveQuestion.includes(word))) {
    return blocked(effectiveQuestion, "这个问题涉及个人敏感信息，当前 Demo 不支持查询手机号、车牌或可识别个人身份的数据。你可以改问聚合指标。", [
      "不同车辆类型的平均充电时长如何？",
      "各区域用户分群订单量如何？",
      "最近 30 天各区域收入排名如何？"
    ]);
  }

  const aiResponse = await answerQuestionWithAi(effectiveQuestion, plannerContext);
  if (aiResponse) return aiResponse;

  const highConfidenceCalculator =
    answerLossTopRevenueAndLossShare(effectiveQuestion) ||
    answerRevenueAndLossTopShare(effectiveQuestion) ||
    answerRevenueTopShare(effectiveQuestion) ||
    answerRevenueTopVsLossTopFaultLoss(effectiveQuestion);
  if (highConfidenceCalculator) return highConfidenceCalculator;

  const contextualIntersection = answerTopSetIntersection(effectiveQuestion, effectiveContext);
  if (contextualIntersection) return contextualIntersection;

  if (effectiveContext.forceStableContracts === true) {
    const revenueVsLossFaultComparison = answerRevenueTopVsLossTopFaultLoss(effectiveQuestion);
    if (revenueVsLossFaultComparison) return revenueVsLossFaultComparison;

    const contextualLossFaultComparison = answerLossTopFaultLossComparison(effectiveQuestion, effectiveContext);
    if (contextualLossFaultComparison) return contextualLossFaultComparison;

    const lossTopRevenueAndLossShare = answerLossTopRevenueAndLossShare(effectiveQuestion);
    if (lossTopRevenueAndLossShare) return lossTopRevenueAndLossShare;

    const contractedResponse = answerRevenueAndLossTopShare(effectiveQuestion);
    if (contractedResponse) return contractedResponse;

    const revenueTopShareResponse = answerRevenueTopShare(effectiveQuestion);
    if (revenueTopShareResponse) return revenueTopShareResponse;
  }

  const comparativePointerNeedsSecondSet = /(?:和|跟|与).{0,4}(?:他们|这些|上述|前者|后者).{0,8}(?:比起来|相比|比较|对比)|(?:比起来如何|差值是多少)/.test(effectiveQuestion) && !hasTwoComparableRankedSets(effectiveQuestion);
  if (comparativePointerNeedsSecondSet && !hasUsableContext) {
    return clarification(
      effectiveQuestion,
      "这个问题里已经有一个站点集合，但“和他们比起来”还需要另一个可比较对象。请说明“他们”指哪组站点，我会把澄清内容并回原问题继续查询。",
      ["他们指亏损额 Top10 站点", "他们指上一轮结果里的站点", "改成：营业额 Top10 和亏损额 Top10 的故障损失差值是多少"],
      effectiveContext
    );
  }
  if (hasContextPointer && !pointerResolvedInSentence && !hasUsableContext) {
    return clarification(
      effectiveQuestion,
      "这个追问里有上下文指代，但我没有拿到上一轮可继承的结果。为了避免乱查或乱编，需要你明确对象。",
      ["先查营业额 Top3 和亏损额 Top3", "指定要分析的站点或区域", "重新输入完整问题"],
      effectiveContext
    );
  }

  const { interpretation, trace } = await interpretWithDeepSeek(effectiveQuestion);
  const shouldAvoidDefaultFallback =
    /累计|累加|从前往后|从高到低|到\s*(?:Top|top)\s*几|一半|50%/.test(effectiveQuestion) ||
    (interpretation && interpretation.confidence >= 0.75 && interpretation.intent !== "region_revenue_ranking");
  if (shouldAvoidDefaultFallback) {
    const response = clarification(
      effectiveQuestion,
      "我已经理解这是一个开放式分析问题，但本轮 QueryPlan 没有生成可安全执行的查询。为了避免回落到不相关的默认报表，请补充确认分析对象口径，例如按站点、区域还是运营商。",
      ["按充电站口径继续", "按区域口径继续", "改问：按营业额从高到低累计，到 Top 几达到总营业额 50%"],
      effectiveContext
    );
    response.trust.modelTrace = trace;
    if (interpretation) {
      response.trust.schemaMatches = [
        {
          table: "DeepSeek 意图识别",
          fields: [interpretation.intent, interpretation.normalizedQuestion],
          reason: interpretation.reason,
          confidence: interpretation.confidence
        },
        ...response.trust.schemaMatches
      ];
    }
    return response;
  }
  const response = answerQuestionByRules(effectiveQuestion, effectiveContext);
  response.trust.modelTrace = trace;

  if (interpretation) {
    response.trust.schemaMatches = [
      {
        table: "DeepSeek 意图识别",
        fields: [interpretation.intent, interpretation.normalizedQuestion],
        reason: interpretation.reason,
        confidence: interpretation.confidence
      },
      ...response.trust.schemaMatches
    ];
  }

  return response;
}

