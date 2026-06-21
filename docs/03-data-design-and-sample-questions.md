# 数据库设计与样例问题库 v1.0

## 设计目标

本设计服务于 ChargeBI 智能充电运营问数助手的作品集 Demo。

数据库需要同时满足：

- 支撑开放式自然语言问数
- 体现 Schema 匹配价值
- 支撑地图展示
- 支撑趋势、排名、对比、异常、归因、预测和建议类问题
- 支撑多轮上下文追问
- 保持中等复杂度，便于个人构建和部署

## 数据构建策略

采用“公开数据结构参考 + 上海都市圈模拟运营数据”。

真实参考数据可用于：

- 充电站点字段设计
- 充电会话字段设计
- 充电时长、能耗、费用等分布参考

模拟补全数据用于：

- 上海区域和商圈标签
- 经纬度点位
- 故障工单
- 运维记录
- 节假日和天气
- 电价和服务费
- 站点健康度
- 用户和车辆类型的匿名聚合信息

## 推荐数据库

第一版建议使用 SQLite 或 DuckDB。

选择理由：

- 部署简单稳定
- 适合个人网站 Demo
- 易于生成样例数据
- 易于执行 SQL 查询
- 不需要单独维护数据库服务

## 表结构总览

建议中等版数据库包含 10 张核心表：

| 表名 | 中文名 | 用途 |
|---|---|---|
| dim_region | 区域维表 | 上海区域、商圈、功能区 |
| dim_station | 充电站维表 | 地图点位和站点属性 |
| dim_charger | 充电桩维表 | 单桩状态、功率、类型 |
| fact_charging_session | 充电会话事实表 | 订单、收入、充电时长、能耗 |
| fact_station_daily | 站点日汇总表 | 加速查询趋势、排名和地图指标 |
| fact_fault_ticket | 故障工单事实表 | 故障率、异常、运维分析 |
| fact_maintenance | 运维记录事实表 | 响应时长、处理结果 |
| dim_tariff | 电价规则维表 | 峰谷电价和服务费 |
| dim_calendar | 日历维表 | 工作日、休息日、节假日 |
| fact_weather_daily | 天气日表 | 天气对订单和收入的影响 |

## 实体关系

核心关系：

- 一个区域包含多个充电站
- 一个充电站包含多个充电桩
- 一个充电桩产生多笔充电会话
- 一个充电桩可能产生多张故障工单
- 一张故障工单可能关联一条或多条运维记录
- 充电会话通过日期关联日历，通过站点关联区域
- 站点日汇总由充电会话、故障、运维和日历派生

## 表设计

### dim_region

区域维表，用于地图分组、区域排名和区域对比。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| region_id | TEXT | 区域 ID | R_PUDONG |
| region_name | TEXT | 区域名称 | 浦东新区 |
| region_type | TEXT | 区域类型 | 行政区/商圈/交通枢纽/产业园 |
| parent_region | TEXT | 上级区域 | 上海都市圈 |
| city | TEXT | 城市 | 上海 |
| center_lng | REAL | 区域中心经度 | 121.544 |
| center_lat | REAL | 区域中心纬度 | 31.221 |
| population_level | TEXT | 人流等级 | 高/中/低 |
| business_tag | TEXT | 业务标签 | 商务办公/居住社区/交通枢纽 |

### dim_station

充电站维表，用于地图点位、站点筛选和站点经营分析。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| station_id | TEXT | 站点 ID | ST_PD_001 |
| station_name | TEXT | 站点名称 | 陆家嘴中心充电站 |
| region_id | TEXT | 所属区域 | R_PUDONG |
| address | TEXT | 地址 | 浦东新区银城中路 |
| lng | REAL | 经度 | 121.507 |
| lat | REAL | 纬度 | 31.239 |
| station_type | TEXT | 站点类型 | 商业综合体/社区/园区/高速/交通枢纽 |
| operator | TEXT | 运营商 | ChargeBI 示范运营 |
| open_date | DATE | 开站日期 | 2024-07-01 |
| parking_spaces | INTEGER | 车位数 | 40 |
| charger_count | INTEGER | 充电桩数量 | 24 |
| fast_charger_count | INTEGER | 快充桩数量 | 16 |
| slow_charger_count | INTEGER | 慢充桩数量 | 8 |
| status | TEXT | 站点状态 | 正常/维护中/低利用/高负荷 |
| service_hours | TEXT | 服务时间 | 00:00-24:00 |

### dim_charger

充电桩维表，用于单桩状态、功率和故障分析。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| charger_id | TEXT | 充电桩 ID | CH_PD_001_01 |
| station_id | TEXT | 所属站点 | ST_PD_001 |
| charger_type | TEXT | 桩类型 | 快充/慢充 |
| connector_type | TEXT | 接口类型 | 国标直流/国标交流 |
| power_kw | REAL | 额定功率 | 120 |
| install_date | DATE | 安装日期 | 2024-07-01 |
| current_status | TEXT | 当前状态 | 可用/占用/离线/故障/维护 |
| last_online_at | DATETIME | 最近在线时间 | 2026-06-20 10:30:00 |

### fact_charging_session

充电会话事实表，是问数的核心事实表。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| session_id | TEXT | 会话 ID | SE_202606200001 |
| charger_id | TEXT | 充电桩 ID | CH_PD_001_01 |
| station_id | TEXT | 站点 ID | ST_PD_001 |
| region_id | TEXT | 区域 ID | R_PUDONG |
| user_segment | TEXT | 用户类型 | 私家车/网约车/出租车/物流车 |
| vehicle_type | TEXT | 车辆类型 | 纯电轿车/纯电 SUV/商用车 |
| start_time | DATETIME | 开始时间 | 2026-06-20 08:15:00 |
| end_time | DATETIME | 结束时间 | 2026-06-20 09:05:00 |
| charging_minutes | INTEGER | 充电时长分钟 | 50 |
| energy_kwh | REAL | 充电电量 | 42.5 |
| electricity_fee | REAL | 电费收入 | 48.20 |
| service_fee | REAL | 服务费收入 | 12.80 |
| total_fee | REAL | 总收入 | 61.00 |
| payment_status | TEXT | 支付状态 | 已支付/退款/异常 |
| session_status | TEXT | 会话状态 | 完成/中断/失败 |
| tariff_period | TEXT | 电价时段 | 峰/平/谷 |

隐私策略：

- 不存储手机号、车牌号、真实用户 ID。
- 如需要用户维度，仅使用匿名分群字段。

### fact_station_daily

站点日汇总表，用于提升查询稳定性和响应速度。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| stat_date | DATE | 统计日期 | 2026-06-20 |
| station_id | TEXT | 站点 ID | ST_PD_001 |
| region_id | TEXT | 区域 ID | R_PUDONG |
| order_count | INTEGER | 订单量 | 168 |
| active_charger_count | INTEGER | 活跃充电桩数 | 21 |
| total_charging_minutes | INTEGER | 总充电分钟数 | 7420 |
| total_energy_kwh | REAL | 总充电电量 | 6210.5 |
| total_revenue | REAL | 总收入 | 8930.4 |
| electricity_revenue | REAL | 电费收入 | 7010.3 |
| service_revenue | REAL | 服务费收入 | 1920.1 |
| avg_order_value | REAL | 平均客单价 | 53.16 |
| utilization_rate | REAL | 利用率 | 0.245 |
| fault_count | INTEGER | 故障次数 | 3 |
| offline_minutes | INTEGER | 离线分钟数 | 220 |
| health_score | REAL | 站点健康度 | 86.5 |

### fact_fault_ticket

故障工单事实表，用于异常分析和故障归因。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| ticket_id | TEXT | 工单 ID | FT_20260620001 |
| charger_id | TEXT | 充电桩 ID | CH_PD_001_01 |
| station_id | TEXT | 站点 ID | ST_PD_001 |
| region_id | TEXT | 区域 ID | R_PUDONG |
| fault_type | TEXT | 故障类型 | 离线/支付失败/枪线异常/过温/通信异常 |
| fault_level | TEXT | 故障等级 | 低/中/高 |
| created_at | DATETIME | 故障创建时间 | 2026-06-20 11:20:00 |
| resolved_at | DATETIME | 解决时间 | 2026-06-20 15:40:00 |
| status | TEXT | 工单状态 | 待处理/处理中/已解决/已关闭 |
| impact_minutes | INTEGER | 影响服务分钟数 | 260 |
| lost_revenue_estimate | REAL | 预估收入损失 | 180.5 |

### fact_maintenance

运维记录事实表，用于分析响应效率和处理效果。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| maintenance_id | TEXT | 运维记录 ID | MT_20260620001 |
| ticket_id | TEXT | 关联工单 ID | FT_20260620001 |
| station_id | TEXT | 站点 ID | ST_PD_001 |
| engineer_team | TEXT | 运维团队 | 浦东一组 |
| dispatch_time | DATETIME | 派单时间 | 2026-06-20 11:30:00 |
| arrival_time | DATETIME | 到达时间 | 2026-06-20 12:10:00 |
| finish_time | DATETIME | 完成时间 | 2026-06-20 15:40:00 |
| action_type | TEXT | 处理动作 | 远程重启/现场维修/更换模块 |
| result | TEXT | 处理结果 | 已恢复/需复检/待备件 |
| response_minutes | INTEGER | 响应时长 | 40 |
| repair_minutes | INTEGER | 维修时长 | 210 |

### dim_tariff

电价规则维表，用于收入拆分和峰谷分析。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| tariff_id | TEXT | 电价规则 ID | TF_SH_2026_SUMMER_PEAK |
| region_id | TEXT | 适用区域 | R_PUDONG |
| effective_start | DATE | 生效开始 | 2026-06-01 |
| effective_end | DATE | 生效结束 | 2026-09-30 |
| period_name | TEXT | 时段名称 | 峰/平/谷 |
| start_hour | INTEGER | 开始小时 | 8 |
| end_hour | INTEGER | 结束小时 | 11 |
| electricity_price | REAL | 电价元/kWh | 1.12 |
| service_price | REAL | 服务费元/kWh | 0.38 |

### dim_calendar

日历维表，用于解析时间表达和节假日分析。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| date | DATE | 日期 | 2026-06-20 |
| year | INTEGER | 年 | 2026 |
| month | INTEGER | 月 | 6 |
| week_of_year | INTEGER | 年内周 | 25 |
| day_of_week | INTEGER | 星期 | 6 |
| is_workday | BOOLEAN | 是否工作日 | false |
| is_weekend | BOOLEAN | 是否周末 | true |
| is_holiday | BOOLEAN | 是否节假日 | false |
| holiday_name | TEXT | 节假日名称 | 端午节 |
| is_adjusted_workday | BOOLEAN | 是否调休工作日 | false |
| day_part_rules | TEXT | 时段规则 | 凌晨/早高峰/日间/晚高峰/夜间 |

### fact_weather_daily

天气日表，用于归因分析和建议类问题。

| 字段 | 类型 | 说明 | 示例 |
|---|---|---|---|
| weather_date | DATE | 日期 | 2026-06-20 |
| region_id | TEXT | 区域 ID | R_PUDONG |
| weather_type | TEXT | 天气类型 | 晴/雨/高温/台风/阴 |
| min_temp | REAL | 最低气温 | 24 |
| max_temp | REAL | 最高气温 | 33 |
| rainfall_mm | REAL | 降雨量 | 8.5 |
| severe_weather_flag | BOOLEAN | 是否极端天气 | false |

## 指标词典

### 基础指标

| 指标 | 口径 | 主要表 |
|---|---|---|
| 订单量 | 完成状态的充电会话数量 | fact_charging_session |
| 充电收入 | total_fee 求和 | fact_charging_session |
| 电费收入 | electricity_fee 求和 | fact_charging_session |
| 服务费收入 | service_fee 求和 | fact_charging_session |
| 平均客单价 | 充电收入 / 订单量 | fact_charging_session |
| 充电电量 | energy_kwh 求和 | fact_charging_session |
| 平均充电时长 | charging_minutes 平均值 | fact_charging_session |

### 运营指标

| 指标 | 口径 | 主要表 |
|---|---|---|
| 站点利用率 | 总充电分钟数 / 站点可服务分钟数 | fact_station_daily, dim_station |
| 充电桩利用率 | 单桩充电分钟数 / 单桩可服务分钟数 | fact_charging_session, dim_charger |
| 故障率 | 故障桩数或故障次数 / 总桩数 | fact_fault_ticket, dim_charger |
| 离线率 | 离线分钟数 / 可服务分钟数 | fact_station_daily |
| 运维响应时长 | arrival_time - dispatch_time | fact_maintenance |
| 站点健康度 | 利用率、故障、离线、收入综合评分 | fact_station_daily |
| 示例净利率 | (服务费收入 - 故障损失估算 - 运维成本估算) / 总收入 | fact_station_daily, fact_fault_ticket |
| 示例亏损额 | MAX(0, 故障损失估算 + 运维成本估算 - 服务费收入) | fact_station_daily, fact_fault_ticket |
| 运维成本估算 | 总收入 * 16% + 订单量 * 0.8 元 | fact_station_daily |

说明：

- 当前 Demo 没有真实成本、租金和电力采购结算数据，因此“净利率”是作品集 Demo 的示例经营指标。
- 示例净利率和示例亏损额用于展示多指标问数能力，不代表真实财务口径。
- 运维成本估算采用演示口径，用于让经营效率问题具备可解释的差异，不代表真实财务成本。

### 时间指标

| 时间表达 | 解析规则 |
|---|---|
| 今天 | 当前日期 |
| 昨天 | 当前日期前 1 天 |
| 最近 7 天 | 当前日期向前滚动 7 天 |
| 最近 30 天 | 当前日期向前滚动 30 天 |
| 本周 | 当前自然周 |
| 上周 | 上一个自然周 |
| 本月 | 当前自然月 |
| 上月 | 上一个自然月 |
| 工作日 | dim_calendar.is_workday = true |
| 休息日 | is_weekend = true 或 is_holiday = true |
| 节假日 | dim_calendar.is_holiday = true |
| 凌晨 | 00:00-06:00 |
| 早高峰 | 07:00-10:00 |
| 晚高峰 | 17:00-21:00 |
| 夜间 | 21:00-24:00 |

## 样例问题库

### 推荐问题

这些问题用于首页引导，让用户一眼知道可以问什么。

1. 最近 30 天上海各区域充电收入排名如何？
2. 哪些站点的利用率最低，可能需要运营优化？
3. 上周故障率最高的 5 个站点是哪些？
4. 浦东新区和徐汇区最近 30 天的订单量有什么差异？
5. 节假日的充电收入和平时相比有什么变化？
6. 未来 7 天哪些站点可能出现高峰压力？

### 趋势类问题

| 问题 | 预期图表 | 核心表 |
|---|---|---|
| 最近 30 天充电收入趋势怎么样？ | 折线图 | fact_station_daily |
| 本月订单量每天变化如何？ | 折线图 | fact_station_daily |
| 最近 12 个月服务费收入有什么变化？ | 折线图 | fact_charging_session |
| 晚高峰订单量最近两周是否上升？ | 折线图 | fact_charging_session |

### 排名类问题

| 问题 | 预期图表 | 核心表 |
|---|---|---|
| 哪些区域订单量最高？ | 柱状图 | fact_station_daily, dim_region |
| 最近 30 天收入最高的 10 个站点是哪些？ | 柱状图 | fact_station_daily, dim_station |
| 哪些站点服务费收入占比最高？ | 柱状图 | fact_charging_session |
| 凌晨时段订单最多的区域有哪些？ | 柱状图 | fact_charging_session, dim_region |

### 对比类问题

| 问题 | 预期图表 | 核心表 |
|---|---|---|
| 浦东和徐汇哪个区域利用率更高？ | 分组柱状图 | fact_station_daily |
| 工作日和休息日的订单量差异有多大？ | 柱状图 | fact_charging_session, dim_calendar |
| 快充和慢充的平均客单价有什么差异？ | 柱状图 | fact_charging_session, dim_charger |
| 商业综合体和社区站点哪个收入更稳定？ | 折线图 | fact_station_daily, dim_station |

### 异常类问题

| 问题 | 预期图表 | 核心表 |
|---|---|---|
| 上周哪些站点故障率异常？ | 表格 + 地图高亮 | fact_fault_ticket |
| 最近 7 天哪些站点收入突然下降？ | 表格 + 折线图 | fact_station_daily |
| 哪些区域离线时长偏高？ | 柱状图 + 地图高亮 | fact_station_daily |
| 本月是否有订单失败率异常的站点？ | 表格 | fact_charging_session |

### 归因类问题

| 问题 | 分析方向 | 核心表 |
|---|---|---|
| 为什么本月订单量下降？ | 区域、站点、时段、天气、故障拆解 | fact_station_daily, fact_fault_ticket, fact_weather_daily |
| 为什么临港新片区利用率偏低？ | 站点类型、订单时段、车位数、故障 | dim_station, fact_station_daily |
| 为什么上周收入下降但订单量没怎么变？ | 客单价、电量、服务费、快慢充结构 | fact_charging_session, dim_charger |
| 为什么某些站点节假日表现更好？ | 站点类型、区域标签、节假日 | dim_station, dim_calendar |

### 预测类问题

第一版使用简单趋势外推，不做复杂机器学习。

| 问题 | 分析方法 | 输出 |
|---|---|---|
| 未来 7 天哪些站点可能出现高峰压力？ | 近 30 天趋势 + 同星期模式 | 高风险站点列表 |
| 下周浦东新区订单量大概会怎样？ | 近 8 周同周期外推 | 趋势预测 |
| 哪些站点节假日前需要提前巡检？ | 历史节假日故障 + 高负荷站点 | 巡检建议 |

### 建议类问题

| 问题 | 建议逻辑 | 输出 |
|---|---|---|
| 哪些低利用率站点需要优化？ | 低利用率 + 高车位数 + 非故障 | 站点名单与建议 |
| 哪些站点应该优先增加快充桩？ | 高利用率 + 排队压力 + 高收入 | 扩容建议 |
| 哪些站点需要优先运维？ | 高故障率 + 高收入损失 | 运维优先级 |
| 如何提升凌晨时段利用率？ | 低谷时段订单 + 区域类型 | 运营建议 |

### 权限与隐私类问题

| 用户问题 | 系统处理 |
|---|---|
| 查询某个用户的手机号 | 拒绝查询，说明涉及敏感个人信息 |
| 帮我看具体车牌的充电记录 | 拒绝查询，建议改问匿名聚合指标 |
| 导出所有用户明细 | 拒绝查询，建议查看区域或用户分群统计 |

示例回复：

> 这个问题涉及个人敏感信息，当前 Demo 不支持查询手机号、车牌或可识别个人身份的数据。你可以改问“各区域用户分群订单量”或“不同车辆类型的平均充电时长”。

### 超范围问题

| 用户问题 | 系统处理 |
|---|---|
| 上海今天哪里最好玩？ | 说明当前只支持充电运营数据，并推荐可问问题 |
| 帮我规划从人民广场到迪士尼路线 | 说明不支持路径规划 |
| 查询股票走势 | 说明不在数据范围内 |

## 多轮对话样例

### 样例一：区域收入追问

用户：最近 30 天哪个区域收入最高？

系统：浦东新区收入最高，并展示区域排名。

用户：那浦东里面哪些站点贡献最大？

系统：继承“最近 30 天”和“浦东新区”上下文，返回站点排名。

用户：这些站点的故障情况呢？

系统：继承“这些站点”指代，查询故障工单和离线时长。

### 样例二：利用率与建议

用户：哪些站点利用率最低？

系统：返回低利用率站点列表和地图高亮。

用户：只看商业综合体站点。

系统：在低利用率条件上追加站点类型筛选。

用户：给我一些优化建议。

系统：结合时段分布、站点类型、故障状态给出运营建议。

### 样例三：异常归因

用户：为什么本月订单量下降？

系统：拆解区域、站点、时段、天气、故障因素。

用户：主要看徐汇。

系统：将分析范围切换到徐汇区。

用户：是不是因为故障变多？

系统：查询徐汇区本月故障次数、影响时长和收入损失，与上月对比。

## Schema 匹配展示策略

默认向用户展示中等细度。

展示内容：

- 命中的业务意图
- 命中的指标
- 命中的时间范围
- 命中的区域或站点
- 命中的表和字段
- 匹配理由
- 置信度

示例：

| 项目 | 结果 |
|---|---|
| 业务意图 | 区域收入排名 |
| 时间范围 | 最近 30 天 |
| 指标 | 充电收入 total_revenue |
| 维度 | 区域 region_name |
| 命中表 | fact_station_daily, dim_region |
| 匹配理由 | 问题包含“区域”和“收入排名”，需要按区域聚合收入 |
| 置信度 | 0.91 |

## SQL 生成与校验策略

第一版只允许：

- SELECT 查询
- 只读访问
- 白名单表
- LIMIT 限制
- 禁止 DELETE、UPDATE、INSERT、DROP、ALTER、CREATE
- 禁止访问个人敏感字段

如果 SQL 生成失败：

1. 解释失败原因。
2. 展示可选修正方向。
3. 推荐 2 到 3 个相近问题。

## 数据生成建议

第一版样例数据规模：

| 表 | 建议规模 |
|---|---:|
| dim_region | 10-15 行 |
| dim_station | 80-150 行 |
| dim_charger | 800-2000 行 |
| fact_charging_session | 100000-300000 行 |
| fact_station_daily | 30000-60000 行 |
| fact_fault_ticket | 3000-10000 行 |
| fact_maintenance | 2500-9000 行 |
| dim_tariff | 50-150 行 |
| dim_calendar | 365-400 行 |
| fact_weather_daily | 3650-6000 行 |

说明：

- 充电会话数据量需要足够大，才能让趋势、排名和异常分析显得真实。
- 前端展示不直接加载全量数据，只通过 API 查询聚合结果。
- Demo 部署时可压缩为较小 SQLite 或 DuckDB 文件。

## 下一步待确认

后续页面原型和 PRD 需要继续明确：

- 首页具体布局
- 问答卡片样式
- 地图控件与筛选方式
- 图表组件规范
- AI 工作流状态展示
- 错误和澄清交互
- 作品集详情页结构
