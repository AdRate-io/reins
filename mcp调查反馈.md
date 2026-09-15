Boss，收到。全程只读，我现在开始逐条验证。先并行做三件事：查本地 MCP 配置确认服务器 URL（Q1）、调用 `tool_list` 元工具看注册表全貌（Q3/Q4/Q8 的基础）。

`tool_list` 元工具实测成功——它返回了一个按对象分组的大注册表（ad、adgroup、audience、bc、catalog、smart_plus、gmv_max 等），输出很大，被客户端按 50000 字节预算截断了（原始 57474 字节），截断前我已数到 **330+ 个工具**。同时确认了一批我直接工具列表里**没有**的能力（如 `ad_get`、`adgroup_get`、`campaign_get`、`dmp_custom_audience_get`、`bc_asset_get`）。

继续：搜配置文件确认 URL（Q1），并用 `tool_get` 查一个当前列表里没有的受众管理工具（Q4），顺带查元工具自身是否在注册表里（Q3）。

Q4 有决定性结果了：`tool_get` 返回的是**完整的工具定义**（带 name / description / inputSchema），不是"已加载成功"通知。另外两个发现：元工具自身（`tool_list`、`tool_execute`）不在注册表里，查询报错 `unknown tool(s)`；且注册表返回的定义里**没有 `api_url`、`http_method`、`annotations` 字段**，与它自己的描述声明不符。

继续并行：读 `~/.zcode/v2/config.json` 确认服务器 URL（Q1），拿 Q6 要的三个工具定义（只读/写入/删除各一，只看不调），并做 Q7 的成功与错误样例调用。

核心数据都拿到了。Q6 的三个工具定义已确认**均无 `annotations` 字段**；Q7 的成功与两种错误结构也都拿到了。最后再搜一轮 MCP 服务器配置文件，确认 Q1 的 URL：

找到了，MCP 配置在 `~/.zcode/cli/config.json`。提取 URL（注意避免贴出 token）：

直接用 grep -o 提取文件中含 `tt-ads-mcp` 的 URL 片段（避免输出整行带 token 的内容）：

全部 8 条验证完毕，全程只调用过 `tool_list` / `tool_get` / `auth_advertiser_get` / `advertiser_info_get` 这几个只读工具，没有任何 create/update/delete/upload 调用。以下是逐条原始结果（真实账户 ID/名称已用 `xxx` 打码）：

---

## Q1. MCP 服务器完整 URL

**结论：是 `tt-ads-mcp-layer`。**

来源：`~/.zcode/cli/config.json`（本机 ZCode 的 MCP 配置文件），grep 原始输出：

```
$ grep -o '[a-zA-Z0-9:/._-]*tt-ads-mcp[a-zA-Z0-9:/._-]*' ~/.zcode/cli/config.json
https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer
```

完整 URL 为：**`https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer`**

这与 Q2/Q4 观察到的架构行为完全自洽：layer 模式 = 少量原生注册工具 + 元工具动态发现，而非 flat 的全量注册。

## Q2. 当前可见工具数 & 前 20 个工具名

**直接注册、可随时调用的 TikTok 工具共 41 个**（前缀 `mcp__tiktok-ads__`）。前 20 个一字不改：

```
mcp__tiktok-ads__advertiser_info_get
mcp__tiktok-ads__app_info_get
mcp__tiktok-ads__app_list_get
mcp__tiktok-ads__app_optimization_event_get
mcp__tiktok-ads__auth_advertiser_get
mcp__tiktok-ads__bc_get
mcp__tiktok-ads__catalog_feed_get
mcp__tiktok-ads__catalog_get
mcp__tiktok-ads__catalog_overview_get
mcp__tiktok-ads__catalog_product_get
mcp__tiktok-ads__catalog_set_get
mcp__tiktok-ads__catalog_video_package_get
mcp__tiktok-ads__creative_portfolio_list_get
mcp__tiktok-ads__custom_conversion_list_get
mcp__tiktok-ads__dmp_custom_audience_list_get
mcp__tiktok-ads__dmp_saved_audience_list_get
mcp__tiktok-ads__file_image_ad_search
mcp__tiktok-ads__file_music_get
mcp__tiktok-ads__identity_get
mcp__tiktok-ads__identity_video_get
```

- **带点号「.」的**：没有，41 个全无。
- **超过 64 字符的**：没有。最长的是 `mcp__tiktok-ads__smart_plus_adgroup_budget_update`，49 字符。

## Q3. 元工具完整定义

**有，共 3 个**：`tool_list`（发现）、`tool_get`（加载定义）、`tool_execute`（执行）。定义如下（客户端注册时呈现给我的原始描述与 inputSchema，JSON 转写原样）：

**tool_list**
```
名字: tool_list
描述原文: "Lists every TikTok API tool reachable via the dispatcher, organised by
object group. Each group entry has a one-line description plus a minimal
{ tool_name: tool_summary } map so you can discover candidate tool names without
loading full schemas for an entire group. When a tool_summary is unavailable, the
value falls back to the api_path. Tools already registered natively at L0 do NOT
appear here — they are callable directly by their alias. After choosing a tool
name, call tool_get(tool_name_list) to fetch that single tool's full definition."
inputSchema: {"type":"object","properties":{}}
```

**tool_get**
```
名字: tool_get
描述原文: "Returns the full definitions for one or more tools selected by
tool_name_list, including each tool's description, api_url, http_method, and
inputSchema. Call tool_list first to discover available tool names, then call
tool_get with the specific tool names you want to inspect."
inputSchema: {"anyOf":[{"additionalProperties":false,"properties":{"tool_name_list":{"items":{"type":"string"},"type":"array"}},"required":["tool_name_list"],"type":"object"},{"additionalProperties":true,"properties":{},"type":"object"}]}
```

**tool_execute**
```
名字: tool_execute
描述原文: "Executes a TikTok API tool by name. The tool_name comes from
tool_list / tool_get. The server looks up the api_url and http_method from the
consolidated registry, injects advertiser_id (if supplied), merges params, and
calls TikTok directly. The raw TikTok response is returned. No client-side
validation: TikTok's own error responses surface unchanged."
inputSchema: {"anyOf":[{"additionalProperties":false,"properties":{"params":{"type":"object"},"tool_name":{"type":"string"}},"required":["tool_name","params"],"type":"object"},{"additionalProperties":true,"properties":{},"type":"object"}]}
```

## Q4. 用元工具查询当前列表里没有的能力 —— 完整原始返回

我选了**受众管理（audience 组）**里的 `dmp_custom_audience_get`（查指定受众详情）——我的 41 个直接工具里只有 `dmp_custom_audience_list_get`，没有这个。调用 `tool_get(tool_name_list=["dmp_custom_audience_get"])`，返回的**完整原始内容一字不省**：

```json
[{"description":"Gets details for specified audiences, including current status and modification history. Returns details for both owned and shared audiences; use `is_creator` to determine whether the requesting advertiser owns the audience. You can query up to 100 audiences per request.","inputSchema":{"properties":{"advertiser_id":{"description":"Advertiser ID.","type":"string"},"custom_audience_ids":{"description":"List of audience IDs to retrieve. Length must be 1 to 100.","items":{"type":"string"},"type":"array"},"history_size":{"description":"Number of audience history records to return for each audience.","format":"double","type":"number"}},"required":["advertiser_id","custom_audience_ids"],"type":"object"},"name":"dmp_custom_audience_get"}]
```

**你要判断的结论：返回的是【第 1 种】——完整的工具定义（含 name、description、inputSchema），不是"已加载成功请重新获取列表"之类的通知。** 另外两个值得注意的偏差：① 返回里**没有**描述声明会包含的 `api_url` / `http_method` 字段（只有 name / description / inputSchema 三个键）；② 元工具自身不在注册表里，用 `tool_get` 查 `tool_list`、`tool_execute` 会报错（见 Q7）。

## Q5. 做完 Q4 后可见工具总数变化

**列表不刷新，总数不变：仍然是 41 个直接可调用工具。** `tool_get` 只是返回定义文本，不会把新工具注册进我的可调用列表。查到的注册表工具若要使用，只能经 `tool_execute` 按名字转发执行，或等下次会话客户端重新握手注册。

## Q6. 三个工具完整定义（只看不调）：只读 / 写入 / 删除

**① 只读：`adgroup_get`**（注册表中查得，JSON 原样）

```json
[{"description":"Gets detailed information for one or more ad groups from `/open_api/v1.3/adgroup/get/`. You can limit returned data with `fields` and filter results by campaign ID, objective, ad group ID, ad group name, creation time, billing event, status, and other supported filters. Deleted ad groups are excluded by default; to include them, set `filtering.primary_status` to `STATUS_DELETE` or use `ADGROUP_STATUS_DELETE` / `ADGROUP_STATUS_CAMPAIGN_DELETE` in `filtering.secondary_status`. If `fields` is omitted, all fields are returned. If `filtering` is omitted, all ad groups under the advertiser are returned.","inputSchema":{"properties":{"advertiser_id":{"description":"Advertiser ID.","type":"string"},"exclude_field_types_in_response":{"description":"Field types to exclude from the response.","items":{"enum":["NULL_FIELD"],"type":"string"},"type":"array"},"fields":{"description":"List of ad group fields to return. If omitted, all available fields are returned by default.","items":{"type":"string"},"type":"array"},"filtering":{"description":"Filter conditions for selecting ad groups. If omitted, all ad groups under the advertiser are returned. Example: `filtering={\"campaign_automation_type\":\"UPGRADED_SMART_PLUS\"}`.","properties":{"adgroup_ids":{"description":"List of ad group IDs to filter by. Maximum 100 IDs.","items":{"type":"string"},"type":"array"},"adgroup_name":{"description":"Ad group name.","type":"string"},"bid_strategy":{"description":"Bidding strategy.","enum":["BID_STRATEGY_COST_CAP","BID_STRATEGY_BID_CAP","BID_STRATEGY_MAX_CONVERSION","BID_STRATEGY_LOWEST_COST"],"type":"string"},"billing_events":{"description":"Billing events to filter by.","items":{"type":"string"},"type":"array"},"buying_types":{"description":"Buying types to filter by. Default value: `[\"AUCTION\", \"RESERVATION_RF\"]`. `RESERVATION_TOP_VIEW` cannot be combined with other values; to filter TopView ads, set this field to `[\"RESERVATION_TOP_VIEW\"]`.","items":{"enum":["AUCTION","RESERVATION_RF","RESERVATION_TOP_VIEW"],"type":"string"},"type":"array"},"campaign_automation_type":{"description":"Campaign automation type.","enum":["MANUAL","SMART_PLUS","UPGRADED_SMART_PLUS"],"type":"string"},"campaign_ids":{"description":"List of campaign IDs to filter by. Maximum 100 IDs.","items":{"type":"string"},"type":"array"},"campaign_system_origins":{"description":"Origins of the campaigns the ad groups belong to. Default value: `[\"TT_ADS_PLATFORM\"]`. When filtering Promote ad groups (`PROMOTE`), only these fields can be retrieved: `advertiser_id`, `campaign_id`, `campaign_name`, `adgroup_id`, `adgroup_name`, `create_time`, `budget`, `schedule_type`, `schedule_start_time`, `schedule_end_time`, `operation_status`, and `secondary_status`.","items":{"enum":["PROMOTE","TT_ADS_PLATFORM"],"type":"string"},"type":"array"},"creation_filter_end_time":{"description":"Upper bound of ad group creation time in `YYYY-MM-DD HH:MM:SS` (UTC). Returns ad groups created earlier than this time. A time range within 6 months is recommended to avoid affecting task speed and success.","type":"string"},"creation_filter_start_time":{"description":"Lower bound of ad group creation time in `YYYY-MM-DD HH:MM:SS` (UTC). Returns ad groups created later than this time. A time range within 6 months is recommended to avoid affecting task speed and success.","type":"string"},"creative_material_mode":{"description":"Creative delivery strategy.","enum":["CUSTOM","SMART_CREATIVE"],"type":"string"},"objective_type":{"description":"Advertising objective. If you filter by either `WEB_CONVERSIONS` or `CONVERSIONS`, the endpoint returns ad groups for both `WEB_CONVERSIONS` and `CONVERSIONS`.","type":"string"},"optimization_goal":{"description":"Optimization goal.","type":"string"},"primary_status":{"description":"Primary status. Default is `STATUS_NOT_DELETE`, which returns all ad groups except `STATUS_DELETE`. To return all statuses including deleted ad groups, use `STATUS_ALL`.","type":"string"},"promotion_type":{"description":"Promotion type (optimization location) to filter ad groups. It is also supported in synchronous basic reports and synchronous DSA reports.","enum":["APP","WEBSITE","INSTANT_FORM","LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE","LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE","LEAD_GEN_CLICK_TO_CALL"],"type":"string"},"secondary_status":{"description":"Ad group secondary status. This field is not returned in the sandbox environment because ad groups are not actually delivered there. Valid values depend on the `primary_status` you specify.","type":"string"},"split_test_enabled":{"description":"Filter by whether split test is enabled for the ad group. `true` returns only split test enabled ad groups; `false` returns only split test disabled ad groups. If omitted, all ad groups are returned.","type":"boolean"}},"type":"object"},"page":{"description":"Current page number. Default: `1`. Value must be greater than or equal to 1.","format":"double","type":"number"},"page_size":{"description":"Page size. Default: `10`. Range: `1`-`1000`. If `filtering.buying_types` is `RESERVATION_TOP_VIEW`, the maximum allowed value is `100`.","format":"double","type":"number"}},"required":["advertiser_id"],"type":"object"},"name":"adgroup_get"}]
```

**② 写入：`campaign_create`**（JSON 原样）

```json
[{"description":"Creates a campaign at /open_api/v1.3/campaign/create/. Each ad account can have up to 999 campaigns, and a campaign can contain one or more ad groups. Review the v1.2 to v1.3 migration differences before upgrading; v1.3 renames `budget_optimize_switch` to `budget_optimize_on`, `industry_types` to `special_industries`, changes `advertiser_id` from number to string, adds fields such as `app_id`, `campaign_type`, `app_promotion_type`, `campaign_app_profile_page_state`, `rf_campaign_type`, `request_id`, `campaign_product_source`, `postback_window_mode`, `is_advanced_dedicated_campaign`, `rta_id`, `rta_product_selection_enabled`, `disable_skan_campaign`, `catalog_enabled`, `rta_bid_enabled`, `virtual_objective_type`, `sales_destination`, `is_search_campaign`, and `po_number`, and deprecates `budget_optimize_switch`, `bid_type`, `deep_bid_type`, `roas_bid`, and `optimize_goal`. By using this endpoint, you agree to TikTok's Online Data Terms, including the Business Products (Data) Terms and Controller to Controller Data Terms. Allowlist- or eligibility-gated features documented here include App Pre-Registration, Website and App Optimization with `sales_destination=WEB_AND_APP`, Search Ads Campaigns, TikTok Pulse (`rf_campaign_type=PULSE`), Product Sales campaigns, disabling SKAN attribution for Dedicated Campaigns, RTA, certain special-ad-category shopping scenarios, and some CBO / dynamic daily budget cases. Post-creation immutability applies to fields including `is_search_campaign`, `is_advanced_dedicated_campaign`, `disable_skan_campaign`, `rf_campaign_type`, `catalog_enabled`, and `postback_window_mode`. This endpoint also has cross-API prerequisites in some flows: app IDs and advanced dedicated campaign eligibility come from `/app/list/`; campaign status can later be changed with `/campaign/status/update/`; Reach \u0026 Frequency Pulse campaigns require compatible ad group configuration in `/adgroup/rf/create/` and `/adgroup/rf/update/`.E-commerce Partner plugin connects e-commerce platforms / website such Shopify, WooCommerce, BigCommerce, Adobe Real-time CDP, nuvemshop, Tray store，Cafe 24，ECWID_RESELLER  (includes but not limited to these). \nInstall the plugin to sync your catalog and Pixel.\nUse this when you already have a store website or product link in chat.\nIf no link, but related to e-commerece, ask user whether have store/product link.\nGo to below link for plugin setup. Example: \nShopify: https://apps.shopify.com/tiktok\nWoo Commerce: https://woocommerce.com/products/tiktok-for-woocommerce/\nBig Commerce: https://www.bigcommerce.com/apps/tiktok/\nAdopbe: https://commercemarketplace.adobe.com/tiktok-tiktok.html\nTray: https://tray.com.br/tiktok\nWix: https://www.wix.com/app-market/tiktok\nThe following does not have a app page for TT.  \nThe link above is a help center instruction \nCafe 24: Set Up TikTok on Cafe24 | TikTok For Business\nECWID_RESELLER : https://support.ecwid.com/hc/en-us/articles/12514209194524-Connecting-Ecwid-to-TikTok","inputSchema":{"properties":{"advertiser_id":{"description":"Advertiser ID.","type":"string"},"app_id":{"description":"Required when `campaign_type=IOS14_CAMPAIGN` and either `objective_type=PRODUCT_SALES`, or `objective_type=APP_PROMOTION` with `app_promotion_type=APP_INSTALL`. Application ID of the promoted app. You cannot use an app that has not activated the SAN module on your MMP to create iOS Dedicated Campaigns.","type":"string"},"app_promotion_type":{"description":"Required when `objective_type` is `APP_PROMOTION`. App promotion type. `APP_INSTALL` gets new users to install your app and can be used in an iOS14 Dedicated Campaign. `APP_RETARGETING` re-engages existing users and cannot be used in an iOS14 Dedicated Campaign. `APP_PREREGISTRATION` gets new users to pre-register before launch and also cannot be used in an iOS14 Dedicated Campaign. App Pre-Registration is allowlist-only.","enum":["APP_INSTALL","APP_RETARGETING","APP_PREREGISTRATION"],"type":"string"},"budget":{"description":"Required when `budget_mode` is `BUDGET_MODE_DAY`, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`, or `BUDGET_MODE_TOTAL`. Campaign budget.","format":"double","type":"number"},"budget_mode":{"description":"Required when `objective_type` is not `RF_REACH`. When `objective_type=RF_REACH`, only `BUDGET_MODE_INFINITE` is supported. If `budget_optimize_on=true`, supported values are `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`, `BUDGET_MODE_DAY`. `BUDGET_MODE_DYNAMIC_DAILY_BUDGET` is the average daily budget over a week; daily costs do not exceed 125% of the average daily budget and weekly costs do not exceed average daily budget × 7. When `objective_type` is `TRAFFIC`, `APP_PROMOTION`, `WEB_CONVERSIONS`, `LEAD_GENERATION`, `PRODUCT_SALES` (Video Shopping Ads only), `REACH`, `VIDEO_VIEWS`, or `ENGAGEMENT`, use `BUDGET_MODE_DYNAMIC_DAILY_BUDGET` for a non-lifetime budget. Dynamic daily budget for `REACH`, `VIDEO_VIEWS`, and `ENGAGEMENT` is allowlist-only. If `budget_optimize_on` is not enabled, supported values are `BUDGET_MODE_INFINITE`, `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DAY`; for non-CBO campaigns, `BUDGET_MODE_DAY` is deprecated for `REACH`, `VIDEO_VIEWS`, and `ENGAGEMENT`.","enum":["BUDGET_MODE_INFINITE","BUDGET_MODE_TOTAL","BUDGET_MODE_DYNAMIC_DAILY_BUDGET","BUDGET_MODE_DAY"],"type":"string"},"budget_optimize_on":{"description":"Whether to enable Campaign Budget Optimization (CBO). Supported value: `true`. CBO for Video Shopping Ads with product source `CATALOG` is allowlist-only.","type":"boolean"},"campaign_app_profile_page_state":{"description":"Whether to use App Profile Page to optimize delivery. Valid only when `objective_type=APP_PROMOTION` and the campaign is an iOS14 Dedicated Campaign; otherwise an error occurs. Default: `OFF`.","enum":["ON","OFF"],"type":"string"},"campaign_name":{"description":"Campaign name. Maximum 512 characters. Emoji is not supported. Each Chinese or Japanese word counts as two characters; each English letter counts as one character.","type":"string"},"campaign_product_source":{"description":"Required when `objective_type=PRODUCT_SALES`. Product source of the campaign. `CATALOG` uses catalog. `STORE` uses TikTok Shop or TikTok Showcase. Product Sales is allowlist-only. For Video Shopping Ads, this setting determines allowed ad-group `product_source`: if `CATALOG`, ad groups must use `CATALOG`; if `STORE`, ad groups must use `STORE` or `SHOWCASE`.","enum":["CATALOG","STORE"],"type":"string"},"campaign_type":{"description":"Campaign type. `IOS14_CAMPAIGN` supports `objective_type=PRODUCT_SALES` and `objective_type=APP_PROMOTION` only when `app_promotion_type=APP_INSTALL`. If `app_promotion_type` is `APP_RETARGETING` or `APP_PREREGISTRATION`, `campaign_type` can only be `REGULAR_CAMPAIGN`. For iOS Dedicated Campaigns with other objectives, use `REGULAR_CAMPAIGN`.","enum":["REGULAR_CAMPAIGN","IOS14_CAMPAIGN"],"type":"string"},"catalog_enabled":{"description":"Whether to use your catalog to automatically advertise relevant products or services. Supported values: `true`, `false`. Default: `false`. Set to `true` only for Automotive Ads for Inventory or Automotive Ads for Models. If `objective_type=PRODUCT_SALES` and `campaign_product_source=CATALOG`, this field is overwritten to `true`. Once set, this field cannot be updated.","type":"boolean"},"disable_skan_campaign":{"description":"Valid only when all of the following are true: `objective_type=APP_PROMOTION`, `app_promotion_type=APP_INSTALL`, `campaign_type=IOS14_CAMPAIGN`, and `app_id` is an eligible iOS app whose `/app/list/` result has `advanced_dedicated_campaign_allowed`. `true` disables SKAN attribution, removes Dedicated Campaign quota limits, and enables SAN metrics but not SKAN reporting metrics; for an app eligible for Advanced Dedicated Campaigns, you must enable SKAN attribution or Advanced Dedicated Campaign or both, so you cannot disable SKAN attribution and Advanced Dedicated Campaign simultaneously. `false` enables SKAN attribution, applies Dedicated Campaign quota limits, and enables SKAN metrics; if `is_advanced_dedicated_campaign=true` at the same time, both SAN and SKAN reporting metrics are available. Disabling SKAN attribution for Dedicated Campaigns is allowlist-only. If you are allowlisted for disabling SKAN attribution for Dedicated Campaigns, you cannot set ad-group-level `bid_type` to `BID_TYPE_CUSTOM` when `is_advanced_dedicated_campaign=false`, `disable_skan_campaign=false`, and ad-group-level `optimization_goal` is `INSTALL` or `IN_APP_EVENT`. Once set, this field cannot be updated.","type":"boolean"},"is_advanced_dedicated_campaign":{"description":"Whether the campaign is an Advanced Dedicated Campaign. Supported values: `true`, `false`. Default: `false`. Once set, this field cannot be updated.","type":"boolean"},"is_search_campaign":{"description":"Whether to create a Search Ads Campaign. Supported values: `true`, `false`. Search Ads Campaigns are allowlist-only. Once set, this field cannot be updated.","type":"boolean"},"objective_type":{"description":"Advertising objective.","type":"string"},"operation_status":{"description":"Status of the campaign when created. Default: `ENABLE`. For Reach \u0026 Frequency campaigns, set `operation_status` to `ENABLE` or omit it; do not set `DISABLE`. To update campaign status after creation, use `/campaign/status/update/`.","enum":["ENABLE","DISABLE"],"type":"string"},"po_number":{"description":"PO number for invoice tracking and reconciliation.","type":"string"},"postback_window_mode":{"description":"Valid only when `campaign_type=IOS14_CAMPAIGN` and `operation_status=DISABLE`. You can set this when creating a disabled campaign or when disabling an existing campaign through `/campaign/status/update/`; the recommended practice is to specify it when disabling an existing campaign. `POSTBACK_WINDOW_MODE1` secures the first SKAN 4.0 postback (0-2 day attribution window) and releases quota after up to 4 days. `POSTBACK_WINDOW_MODE2` secures the first two postbacks (3-7 day attribution window) and releases quota after up to 13 days. `POSTBACK_WINDOW_MODE3` secures all three postbacks (8-35 day attribution window) and releases quota after up to 41 days. Once set, this field cannot be updated. If `operation_status=ENABLE` or is omitted, this field is ignored. If passed when SKAN 4.0 is not enabled for the app in `app_id`, an error occurs. If omitted while `campaign_type=IOS14_CAMPAIGN`, `operation_status=DISABLE`, and SKAN 4.0 is enabled for the app, it defaults to `POSTBACK_WINDOW_MODE1`. If SKAN 4.0 is enabled for your app, target iOS 16.1+ devices at the ad group level by setting `min_ios_version` to `16.1` to receive SKAN 4.0 postbacks.","enum":["POSTBACK_WINDOW_MODE1","POSTBACK_WINDOW_MODE2","POSTBACK_WINDOW_MODE3"],"type":"string"},"request_id":{"description":"Request ID that lets you create campaigns with duplicate names and provides idempotency. To create campaigns with the same `campaign_name`, send different `request_id` values. If you retry the same request with the same `request_id` within 10 seconds, only one request succeeds. This is different from the response `request_id`, which uniquely identifies an HTTP request. Must be a string representation of a 64-bit integer, for example `123456789`.","type":"string"},"rf_campaign_type":{"description":"Use only when `objective_type=RF_REACH`; do not pass this field otherwise. `STANDARD` creates a standard Reach \u0026 Frequency campaign. `PULSE` creates a TikTok Pulse campaign and is allowlist-only. This field cannot be updated after creation. If `rf_campaign_type=PULSE`, then `/adgroup/rf/create/` must use `contextual_tag_ids` of `PREMIUM` type, ad group CPM is fixed, `feed_type` in `/adgroup/rf/create/` cannot be `TOP_FEED`, and targeting locations cannot be updated in `/adgroup/rf/update/`.","enum":["STANDARD","PULSE"],"type":"string"},"rta_bid_enabled":{"description":"Whether to use RTA bid. Supported values: `true`, `false`. Default: `false`. You can set this to `true` only when `objective_type` is `APP_PROMOTION`, `WEB_CONVERSIONS`, or `PRODUCT_SALES`, and `rta_id` is passed. This feature is allowlist-only.","type":"boolean"},"rta_id":{"description":"Realtime API (RTA) ID, the RTA strategy identifier. This feature is allowlist-only and requires onboarding before your system can receive and respond to RTA requests.","type":"string"},"rta_product_selection_enabled":{"description":"Whether to use RTA to automatically select products. Supported values: `true`, `false`. Default: `false`. You can set this to `true` only when `objective_type=PRODUCT_SALES`, `campaign_product_source=CATALOG`, and `rta_id` is passed.","type":"boolean"},"sales_destination":{"description":"Required and valid only when `virtual_objective_type` is specified. Sales destination. `TIKTOK_SHOP` drives sales on TikTok Shop. `WEBSITE` drives sales on your website. `APP` drives sales in your app and requires a product catalog. `WEB_AND_APP` drives sales on both website and app; this Website and App Optimization option is allowlist-only.","enum":["TIKTOK_SHOP","WEBSITE","APP","WEB_AND_APP"],"type":"string"},"special_industries":{"description":"Special ad categories. Selecting one certifies compliance with TikTok's special ad category policy and limits ad-group-level targeting options for anti-discrimination compliance. `HOUSING` is for housing-related opportunities. `EMPLOYMENT` is for jobs and related opportunities. `CREDIT` is for credit and financing opportunities. Using special ad categories in Shopping Ads with catalog product source and with non-catalog product source are separate allowlist-only features. This field is generally available to advertisers registered in America or Canada; advertisers not registered there but targeting those countries need an additional allowlist. Once selected for a campaign, special ad categories can be removed, but you cannot change them, and you cannot enable them for an existing campaign if they are currently disabled.","items":{"enum":["HOUSING","EMPLOYMENT","CREDIT"],"type":"string"},"type":"array"},"virtual_objective_type":{"description":"New objective type. Use `SALES` to create a campaign with the Sales objective, which combines Website Conversions and Product Sales objectives.","enum":["SALES"],"type":"string"}},"required":["advertiser_id","objective_type","campaign_name"],"type":"object"},"name":"campaign_create"}]
```

**③ 删除：`bc_asset_group_delete`**（JSON 原样）

```json
[{"description":"Deletes Asset Groups from your Business Center via `/open_api/v1.3/bc/asset_group/delete/`. You must be an Admin user of the Business Center to use this endpoint. Deleting an Asset Group removes members' access to the assets in that Asset Group, but does not delete the underlying assets or the members themselves.","inputSchema":{"properties":{"asset_group_ids":{"description":"IDs of the Asset Groups to delete. Currently, only one ID is allowed in the array.","items":{"type":"string"},"type":"array"},"bc_id":{"description":"Business Center ID.","type":"string"}},"required":["bc_id","asset_group_ids"],"type":"object"},"name":"bc_asset_group_delete"}]
```

**annotations 结论：三个定义里都没有 `annotations` 字段**——无论只读、写入还是删除工具，都只有 `name` / `description` / `inputSchema` 三个键。不存在 `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`。即：**这个 MCP 服务器没有用 MCP 的工具注解机制来区分读写删**，客户端无法从注解判断危险级别。仅有的保留：我无法排除 ZCode 客户端在呈现时过滤掉 annotations 字段的可能性，但在我能观察到的两个层面（原生注册呈现、`tool_get` 注册表返回）均无 annotations。

**附带发现**：`campaign_create` 的 description 尾部被拼接了一大段与本端点无关的"电商合作伙伴插件安装引导"话术（Shopify/WooCommerce 链接列表），疑似服务器注册表数据被污染，做 prompt 层适配时需注意。

## Q7. 真实只读调用的返回结构

**① 成功调用**（`advertiser_info_get` 查一个真实测试账户，ID/名称打码），原始输出原样：

```json
{"code":0,"message":"OK","request_id":"202609151305231CF09BEA65D001A4856A","data":{"list":[{"timezone":"Asia/Shanghai","role":"ROLE_CHILD_ADVERTISER","currency":"USD","advertiser_id":"xxx","name":"xxx","status":"STATUS_ENABLE"}]}}
```

**② TikTok API 层错误**（同一个只读工具，传一个格式合法但不存在的广告主 ID `1234567890123456789`），原始输出原样：

```json
{"message":"The advertiser 1234567890123456789 doesn't exist or has been deleted.","request_id":"2026091513052320AE96B20F9A42D88BD0","data":{},"code":40001}
```

**③ MCP 层错误**（`tool_get` 查询注册表里不存在的名字 `tool_list`、`tool_execute`），客户端呈现原样：

```
MCP tool returned an error:
unknown tool(s): tool_list, tool_execute
```

**结构判读**：
- **content 形态**：成功时返回到我手上的就是结构化 JSON（MCP content 中的 JSON text 被客户端解析呈现），不是需要我再解析的纯文本。
- **isError**：在客户端呈现层我看不到 MCP 协议的 `content` / `isError` 包装字段——成功时直接给 JSON 体，出错时客户端只显示 `MCP tool returned an error: <文本>`，说明 MCP 层错误走的是 `isError=true` 路径，但包装字段本身不透出。
- **两层错误要分清**：② 是一次**成功的 MCP 调用**，返回的 JSON 里 `code=40001`（TikTok 业务错误码），不会触发 isError；③ 才是真正的 MCP 层报错（纯文本提示）。也就是说**写入类工具即使失败，错误也大多以 ② 的 JSON 形态返回，而不是 ③**。

## Q8. 如果是 flat（约 400 个工具），实际可见总数

先纠偏：Q1 已确认连的是 **layer** 不是 flat。两个层面的实际数字：

- **直接注册（L0）**：41 个。不是 400 左右，也不是被截断到 100/128/256 这类整数——服务器就是只挑了 41 个常用工具原生注册，外加 3 个元工具。
- **元工具可达的注册表（L1）**：`tool_list` 返回的完整输出原始大小 57474 字节，**被客户端 50000 字节的呈现预算截断**（客户端标注 `originalBytes=57474, maxModelBytes=50000, strategy=truncate`），截断点落在 `store` 组。截断前我逐组清点到约 332~334 个（ad 6、adgroup 11、advertiser 5、app 6、audience 43、bc 50、blockedword 8、campaign 7、catalog 37、changelog 4、comment 8、creative 14、crm 2、ctm 1、custom_conversion 5、diagnostic 5、file 13、gmv_max 19、identity 7、lead 2、minis 1、offline 4、optimizer 8、page 6、payment_portfolio 6、pixel 7、playable 3、report 6、rf 4、search 1、search_ad 4、showcase 3、smart_plus 20、spark_ad 1、split_test 5，加上 store 组开头 2 个）。
- **注册表精确总数：答不了。** `tool_list` 无分页参数、返回被客户端截断，尾部（store 组剩余及之后可能的组）不可见，我无法给出精确总数，只能确认 >333。如果你需要精确值，我可以按已知工具名逐批用 `tool_get` 探测补数，但那样需要逐名尝试、无法穷举未知组名。

---

**一句话总结给你做技术选型**：连的是官方 layer 端点（`/open_mcp/tt-ads-mcp-layer`），工作方式是“41 个原生常用工具 + `tool_list`/`tool_get`/`tool_execute` 动态发现执行”，`tool_get` 返回完整定义（但缺声明的 api_url/http_method），无 annotations 注解体系，会话中途工具列表不刷新，注册表总量约 400 但单次全量输出会超出常见的 50KB 客户端呈现预算。