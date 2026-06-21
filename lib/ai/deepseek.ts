export type DeepSeekIntent =
  | "region_revenue_ranking"
  | "low_utilization_suggestion"
  | "fault_anomaly"
  | "forecast"
  | "root_cause"
  | "comparison"
  | "station_ranking"
  | "multi_metric_station_analysis"
  | "loss_margin_analysis"
  | "revenue_extreme_comparison"
  | "privacy"
  | "out_of_scope"
  | "unknown";

export type DeepSeekInterpretation = {
  intent: DeepSeekIntent;
  normalizedQuestion: string;
  confidence: number;
  reason: string;
};

export type DeepSeekTrace = {
  provider: "deepseek";
  configured: boolean;
  called: boolean;
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
};

export type AiSubQuery = {
  name: string;
  purpose: string;
  sql: string;
  chartType?: "bar" | "line" | "table" | "forecast" | "pie" | "bubble";
  xKey?: string;
  yKey?: string;
  sizeKey?: string;
  tables?: string[];
  fields?: string[];
};

export type AiQueryPlan = {
  canAnswer: boolean;
  reason: string;
  missingData?: string[];
  interpretedQuestion: string;
  timeRange?: string;
  metrics?: string[];
  dimensions?: string[];
  subQueries: AiSubQuery[];
  followUps?: string[];
};

export type AiSummary = {
  summary: string;
  kpis?: { label: string; value: string; delta?: string }[];
  followUps?: string[];
};

export type AiAnswerAudit = {
  pass: boolean;
  confidence: number;
  failureType?: "metric_binding_error" | "missing_subquery" | "wrong_context_reference" | "answer_question_mismatch" | "hallucinated_data" | "visualization_mismatch" | "unknown";
  reason: string;
  repairInstruction?: string;
};

const intentGuide = `
你是 ChargeBI 智能充电运营问数助手的意图识别器。
只输出 JSON，不要输出 Markdown。

可选 intent：
- region_revenue_ranking：区域收入、订单、利用率排名
- low_utilization_suggestion：低利用率站点、优化建议
- fault_anomaly：故障、离线、异常站点
- forecast：未来、高峰压力、预测
- root_cause：为什么下降、原因分析、归因
- comparison：浦东和徐汇等区域对比
- station_ranking：某区域内站点贡献、站点排名
- multi_metric_station_analysis：同一个问题中同时询问站点营业额、净利率、利润率等多个经营指标
- loss_margin_analysis：询问亏损额最高、亏损最多、净利率最低、利润率最低等负向经营指标
- revenue_extreme_comparison：询问营业额/收入最高和最低站点，并比较订单、利用率、故障率等差异
- privacy：手机号、车牌、个人明细等敏感问题
- out_of_scope：旅游、路线、股票、美食等非充电运营问题
- unknown：无法判断

输出格式：
{
  "intent": "region_revenue_ranking",
  "normalizedQuestion": "最近 30 天各区域充电收入排名如何？",
  "confidence": 0.9,
  "reason": "用户询问区域收入排名"
}
`;

const queryPlanGuide = `
你是 ChargeBI 智能问数系统的查询规划器。你必须输出严格 JSON，不要输出 Markdown。

当前日期固定为 2026-06-20。

数据库只包含以下表和字段：
1. dim_region(region_id, region_name, region_type, parent_region, city, center_lng, center_lat, map_x, map_y, population_level, business_tag)
2. dim_station(station_id, station_name, region_id, address, lng, lat, map_x, map_y, station_type, operator, open_date, parking_spaces, charger_count, fast_charger_count, slow_charger_count, status, service_hours)
3. dim_charger(charger_id, station_id, charger_type, connector_type, power_kw, install_date, current_status, last_online_at)
4. fact_charging_session(session_id, charger_id, station_id, region_id, user_segment, vehicle_type, start_time, end_time, charging_minutes, energy_kwh, electricity_fee, service_fee, total_fee, payment_status, session_status, tariff_period)
5. fact_station_daily(stat_date, station_id, region_id, order_count, active_charger_count, total_charging_minutes, total_energy_kwh, total_revenue, electricity_revenue, service_revenue, avg_order_value, utilization_rate, fault_count, offline_minutes, health_score)
6. fact_fault_ticket(ticket_id, charger_id, station_id, region_id, fault_type, fault_level, created_at, resolved_at, status, impact_minutes, lost_revenue_estimate)
7. fact_maintenance(maintenance_id, ticket_id, station_id, engineer_team, dispatch_time, arrival_time, finish_time, action_type, result, response_minutes, repair_minutes)
8. dim_calendar(date, year, month, week_of_year, day_of_week, is_workday, is_weekend, is_holiday, holiday_name, is_adjusted_workday, day_part_rules)
9. fact_weather_daily(weather_date, region_id, weather_type, min_temp, max_temp, rainfall_mm, severe_weather_flag)

指标词典：
- 营业额/收入/流水 = SUM(fact_station_daily.total_revenue)
- 订单量 = SUM(fact_station_daily.order_count)
- 利用率 = AVG(fact_station_daily.utilization_rate)
- 故障次数 = SUM(fact_station_daily.fault_count)
- 故障率 = SUM(fact_station_daily.fault_count) * 1.0 / NULLIF(dim_station.charger_count * 天数, 0)
- 服务费收入 = SUM(fact_station_daily.service_revenue)
- 运维成本估算 = SUM(total_revenue) * 0.16 + SUM(order_count) * 0.8
- 盈利额 = 服务费收入 - 故障损失估算 - 运维成本估算
- 亏损额 = MAX(0, 故障损失估算 + 运维成本估算 - 服务费收入)
- 净利率 = 盈利额 / 营业额
- 故障损失估算来自 fact_fault_ticket.lost_revenue_estimate

时间表达：
- 过去一周/最近7天：stat_date >= date('2026-06-20', '-7 day')
- 过去两周/前两周/最近14天：stat_date >= date('2026-06-20', '-14 day')
- 最近30天：stat_date >= date('2026-06-20', '-30 day')
- 本月：stat_date >= date('2026-06-20', 'start of month')

权限与数据可得性：
- 手机号、车牌、个人身份、用户明细：canAnswer=false，说明隐私限制。
- 如果用户问数据库没有的数据，例如满意度、投诉、真实利润、真实电力采购成本、租金、人力成本：canAnswer=false，missingData 写缺失字段。
- 如果可以用估算口径计算，必须在 reason 里说明“估算口径”，但面向用户的字段名不要出现“示例”两个字。

多轮上下文规则：
- 用户问题可能是追问，context 中可能包含 lastIntent、timeRange、selectedStations、selectedRegion、lastBlocks、conversationTurns。
- 如果 context 中包含 answerVerifierRepairInstruction，说明上一版候选答案被审查子 Agent 拦截。必须优先遵守该修复指令重新规划，不能重复同一失败类型。
- 如果 context 中包含 coreferenceHint、entityHint、planningHint，必须优先遵守这些提示。它们来自产品层对当前 query 的低风险语义补充，不是要求你套固定模板。
- 如果问题出现“他们、这些、上述、上面、刚才、那个、这个、交集、重合、继续”等指代词，必须优先结合 context 解析。
- 如果同一句话中已经有明确先行对象，例如“营业额最高的企业/站点”“亏损额 Top10 站点”“从高到低累计的站点”，后面的“他们/这些”优先绑定这个句内对象，不要误判为缺少上一轮上下文。
- 如果 context 不足以确定指代对象，canAnswer=false，reason 说明需要澄清，followUps 给出 2-3 个可选澄清方向。
- 不能把追问改写成无关的新问题；不能因为问题短就回到默认区域收入排名。

SQL 规则：
- 只能生成 SELECT 或 WITH 查询。
- 只能访问上述表。
- 每条 SQL 必须 LIMIT 20 以内。
- 多意图问题必须拆成多个 subQueries，不要合并成一个问题。
- 每条 SQL 尽量返回 station_id、站点、区域，便于地图联动。
- 如果用户同时问“营业额最高的 N 个”和“亏损额最高的 N 个”，必须拆成至少 2 个 subQueries：营业额 TopN、亏损额 TopN。
- 如果用户追问“分别占整体营业额/整体亏损额百分之多少”，每个 subQuery 必须计算整体总额，并返回对应占比字段；不能改写成“最高和最低站点对比”。
- 如果用户问“按 A 指标选出的 TopN 对象的 B 指标是多少，并占总体 A 指标多少”，必须返回 B 指标汇总，同时用 A 指标计算占比；禁止用 B 指标除以总体 A 指标。例如“亏损额 Top10 的营业总额，以及他们占总亏损额多少”中，占比分子必须是这些站点的亏损额，不是营业额。
- 如果用户问“从高到低累计、从前往后加起来、到 Top 几达到总额一半/50%”，必须生成累计贡献查询：按指标降序排序，计算 running_total、overall_total、running_share，并找出 running_share >= 0.5 的最小 rank。
- 只有用户明确同时出现“最高”和“最低”时，才允许生成最高 vs 最低对比问题；“亏损额最高”不是“营业额最低”。

可视化规则：
- chartType 可选：bar、line、pie、bubble、table、forecast。
- 问“占比、比例、构成、结构、分布”时优先 pie，并让 xKey 为类别，yKey 为占比或数值。
- 问“趋势、走势、变化、按天、按周、每日”时优先 line，并让 xKey 为日期/时间，yKey 为指标。
- 问“影响、权重、贡献度、关系、相关、分布格局”且结果有两个以上数值指标时优先 bubble，并尽量填写 sizeKey。
- 问排名、Top、最高、最低时优先 bar。
- 如果结果只有 1 行且没有多个指标可比较，chartType 必须使用 table，不要为了有图而画没有比较意义的单柱图。
- 如果图形无法准确表达问题，chartType 使用 table。

输出 JSON 格式：
{
  "canAnswer": true,
  "reason": "可通过 fact_station_daily 计算",
  "missingData": [],
  "interpretedQuestion": "结构化理解",
  "timeRange": "过去 7 天",
  "metrics": ["营业额", "订单量"],
  "dimensions": ["站点"],
  "subQueries": [
    {
      "name": "营业额最高站点",
      "purpose": "找出过去7天营业额最高站点",
      "sql": "SELECT ... LIMIT 1",
      "chartType": "bar",
      "xKey": "站点",
      "yKey": "营业额",
      "sizeKey": "",
      "tables": ["fact_station_daily", "dim_station"],
      "fields": ["total_revenue", "station_name"]
    }
  ],
  "followUps": ["继续追问建议"]
}
`;

function safeParseObject<T>(text: string): T | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function safeParseJson(text: string): DeepSeekInterpretation | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<DeepSeekInterpretation>;
    if (!parsed.intent || !parsed.normalizedQuestion) return null;
    return {
      intent: parsed.intent,
      normalizedQuestion: parsed.normalizedQuestion,
      confidence: Number(parsed.confidence ?? 0.5),
      reason: String(parsed.reason ?? "DeepSeek 意图识别")
    };
  } catch {
    return null;
  }
}

async function callDeepSeekJson<T>(messages: { role: "system" | "user"; content: string }[], temperature = 0.1): Promise<{ value: T | null; trace: DeepSeekTrace }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return { value: null, trace: { provider: "deepseek", configured: false, called: false, ok: false, error: "missing_api_key" } };
  }

  const started = Date.now();
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature,
        messages
      })
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { value: null, trace: { provider: "deepseek", configured: true, called: true, ok: false, status: response.status, latencyMs, error: `http_${response.status}` } };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { value: null, trace: { provider: "deepseek", configured: true, called: true, ok: false, status: response.status, latencyMs, error: "empty_content" } };
    }
    const value = safeParseObject<T>(content);
    return { value, trace: { provider: "deepseek", configured: true, called: true, ok: Boolean(value), status: response.status, latencyMs, error: value ? undefined : "json_parse_failed" } };
  } catch {
    return { value: null, trace: { provider: "deepseek", configured: true, called: true, ok: false, latencyMs: Date.now() - started, error: "network_or_runtime_error" } };
  }
}

export async function generateQueryPlanWithDeepSeek(question: string, context: Record<string, unknown> = {}) {
  return callDeepSeekJson<AiQueryPlan>([
    { role: "system", content: queryPlanGuide },
    {
      role: "user",
      content: JSON.stringify({
        question,
        context
      })
    }
  ]);
}

export async function verifyAnswerWithDeepSeek(input: {
  question: string;
  interpretedQuestion: string;
  metrics?: string[];
  dimensions?: string[];
  sql: string;
  kpis: { label: string; value: string; delta?: string }[];
  table: { columns: string[]; rows: Record<string, unknown>[] };
  blocks?: { title: string; table: { columns: string[]; rows: Record<string, unknown>[] }; chartTitle?: string; chartType?: string; xKey?: string; yKey?: string }[];
  summary: string;
}) {
  return callDeepSeekJson<AiAnswerAudit>([
    {
      role: "system",
      content: `你是 ChargeBI 的答案审查子 Agent。你不参与 SQL 生成，只审查候选答案是否可以放行。只输出 JSON，不要输出 Markdown。
审查目标：
1. 答案是否覆盖用户原始问题里的全部子问题。
2. interpretedQuestion 是否忠实于原始问题，不能把问题改写成另一个问题。
3. 指标绑定是否正确，尤其是“谁占谁”的分子分母必须同量纲。
4. 如果用户问“TopN A 指标对象的 B 指标是多少，并占总体 A 指标多少”，占比必须使用 A 指标作为分子和分母，不能用 B/A。
5. 如果表格、KPI 或 summary 出现跨指标占比，例如“营业额占亏损额”“订单量占营业额”，除非用户明确要求这种比值，否则判为 metric_binding_error。
6. 如果问题里有多个并列意图，候选答案只回答一个，判为 missing_subquery。
7. 如果 summary 说了表格/KPI/SQL 结果里没有的数据，判为 hallucinated_data。
8. 如果占比明显异常（例如业务构成占比超过 100%），且没有合理解释，判为 metric_binding_error。
9. 如果用户问过去一周，但候选答案使用过去两周/14天；或用户问前两周/过去两周，但候选答案使用7天，判为 answer_question_mismatch。
输出格式：
{
  "pass": true,
  "confidence": 0.9,
  "failureType": "",
  "reason": "放行或拦截原因",
  "repairInstruction": "如果不通过，给 Planner 的具体修复指令"
}`
    },
    { role: "user", content: JSON.stringify(input) }
  ], 0);
}

export async function summarizeWithDeepSeek(input: {
  question: string;
  plan: AiQueryPlan;
  results: { name: string; rows: Record<string, unknown>[] }[];
}) {
  return callDeepSeekJson<AiSummary>([
    {
      role: "system",
      content: `你是 ChargeBI 的业务分析师。只输出 JSON。必须基于提供的 SQL 结果总结，不能编造结果中不存在的数据。
summary 必须使用结构化 Markdown 文本，不要输出一整段自然段。固定包含：
**结论**
- 用 1-2 条 bullet 说明最重要发现，核心站点、金额、占比要加粗。

**关键数据**
- 用 bullet 列出 Top1、Top2、合计、占比等关键数字。

**业务解读**
- 用 bullet 说明这个结果意味着什么，避免堆砌数字。

输出格式：{"summary":"**结论**\\n- ...\\n\\n**关键数据**\\n- ...\\n\\n**业务解读**\\n- ...","kpis":[{"label":"指标名","value":"指标值"}],"followUps":["追问建议1","追问建议2","追问建议3"]}`
    },
    { role: "user", content: JSON.stringify(input) }
  ], 0.2);
}

export async function interpretWithDeepSeek(question: string): Promise<{ interpretation: DeepSeekInterpretation | null; trace: DeepSeekTrace }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      interpretation: null,
      trace: { provider: "deepseek", configured: false, called: false, ok: false, error: "missing_api_key" }
    };
  }

  const started = Date.now();
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.1,
        messages: [
          { role: "system", content: intentGuide },
          { role: "user", content: question }
        ]
      })
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        interpretation: null,
        trace: { provider: "deepseek", configured: true, called: true, ok: false, status: response.status, latencyMs, error: `http_${response.status}` }
      };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return {
        interpretation: null,
        trace: { provider: "deepseek", configured: true, called: true, ok: false, status: response.status, latencyMs, error: "empty_content" }
      };
    }
    const interpretation = safeParseJson(content);
    return {
      interpretation,
      trace: {
        provider: "deepseek",
        configured: true,
        called: true,
        ok: Boolean(interpretation),
        status: response.status,
        latencyMs,
        error: interpretation ? undefined : "json_parse_failed"
      }
    };
  } catch {
    return {
      interpretation: null,
      trace: { provider: "deepseek", configured: true, called: true, ok: false, latencyMs: Date.now() - started, error: "network_or_runtime_error" }
    };
  }
}

export function questionFromIntent(interpretation: DeepSeekInterpretation, originalQuestion: string) {
  const normalized = interpretation.normalizedQuestion || originalQuestion;
  switch (interpretation.intent) {
    case "region_revenue_ranking":
      return normalized.includes("区域") ? normalized : "最近 30 天各区域充电收入排名如何？";
    case "low_utilization_suggestion":
      return normalized.includes("利用率") ? normalized : "哪些站点利用率最低，可能需要优化？";
    case "fault_anomaly":
      return normalized.includes("故障") ? normalized : "上周故障率最高的 5 个站点是哪些？";
    case "forecast":
      return normalized.includes("未来") || normalized.includes("预测") ? normalized : "未来 7 天哪些站点可能出现高峰压力？";
    case "root_cause":
      return normalized.includes("为什么") || normalized.includes("下降") ? normalized : "为什么本月订单量下降？";
    case "comparison":
      return normalized.includes("对比") || normalized.includes("浦东") || normalized.includes("徐汇") ? normalized : "浦东和徐汇最近 30 天哪个区域利用率更高？";
    case "station_ranking":
      return normalized.includes("站点") ? normalized : "浦东里面哪些站点贡献最大？";
    case "multi_metric_station_analysis":
      return normalized.includes("净利率") || normalized.includes("利润率") ? normalized : "过去一周哪个站点的营业额最高？哪个站点的净利率最高？";
    case "loss_margin_analysis":
      return normalized.includes("亏损") || normalized.includes("最低") ? normalized : "过去一周哪个站点的亏损额最高，净利率最低？";
    case "revenue_extreme_comparison":
      return normalized.includes("最高") && normalized.includes("最低") ? normalized : "全上海，营业额最高的站点和营业额最低的站点分别是哪个？二者之间的订单、利用率、故障率差多少？";
    case "privacy":
      return "查询某个用户手机号和充电记录";
    case "out_of_scope":
      return "帮我规划人民广场到迪士尼的路线";
    default:
      return originalQuestion;
  }
}
