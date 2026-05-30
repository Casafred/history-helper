# 02 - USPTO API 注册与使用指南

## 1. API 概览

USPTO 提供两套 API 体系：

| API 体系 | 基础地址 | 状态 | 说明 |
|----------|----------|------|------|
| Open Data Portal (ODP) API | https://api.uspto.gov | ✅ 当前推荐 | 新统一平台，将逐步替代旧 API |
| Developer Hub API | https://developer.uspto.gov | ⚠️ 迁移中 | 将于 2026 年 5 月 29 日下线 |

**本项目统一使用 ODP API。**

## 2. 注册流程

### 2.1 创建 USPTO.gov 账户

1. 访问 https://data.uspto.gov
2. 点击页面顶部 "Create a USPTO.gov account"
3. 填写信息：
   - 有效邮箱地址（无需美国公民身份）
   - 设置密码
   - 验证邮箱
4. 完成注册

**重要提醒**：自 2026 年 6 月 18 日起，访问 ODP 必须登录 USPTO.gov 账户。

### 2.2 获取 API Key

1. 登录 https://data.uspto.gov
2. 访问 Getting Started 页面：https://data.uspto.gov/apis/getting-started
3. 按指引生成 API Key
4. API Key 将通过 `X-API-KEY` 请求头传递

### 2.3 注册注意事项

- ✅ 免费，无需付费
- ✅ 无需美国公民身份，任何有效邮箱均可注册
- ✅ 注册后立即获得 API Key
- ⚠️ 请妥善保管 API Key，不要泄露至公开仓库

## 3. API 认证方式

所有 API 请求必须在 HTTP 请求头中携带 API Key：

```
X-API-KEY: your_api_key_here
```

示例 curl 请求：

```bash
curl -X "GET" \
  "https://api.uspto.gov/api/v1/patent/applications/14412875" \
  -H "X-API-KEY: YOUR_API_KEY"
```

## 4. API 限流规则

- 官方文档：https://data.uspto.gov/apis/api-rate-limits
- 建议请求间隔：**至少 1 秒**
- 本项目实现：所有 API 调用之间强制等待 1.5 秒，留有安全余量
- 如遇 429 状态码，实施指数退避重试策略

## 5. 核心 API 端点

### 5.1 专利申请数据查询

#### 按申请号查询

```
GET /api/v1/patent/applications/{applicationNumberText}
```

**参数说明**：
- `applicationNumberText`：美国专利申请号（8位数字，如 14412875）

**返回数据**：
- 申请元数据（申请人、发明人、分类号、状态等）
- 通信地址
- 专利权转让记录
- 代理律师信息
- 外国优先权
- 续案/分案关系
- 专利期限调整
- 审查事件历史
- 公开/授权文档元数据

**示例**：
```bash
curl -X "GET" \
  "https://api.uspto.gov/api/v1/patent/applications/14412875" \
  -H "X-API-KEY: YOUR_API_KEY"
```

#### 搜索专利申请

```
POST /api/v1/patent/applications/search
GET  /api/v1/patent/applications/search
```

**查询语法**（GET 方式通过 `q` 参数）：
- 精确匹配：`applicationNumberText:14412875`
- 布尔运算：`applicationMetaData.applicationTypeLabelName:Utility AND applicationMetaData.applicationStatusCode:150`
- 通配符：`applicationMetaData.firstApplicantName:Rockwel*`
- 范围查询：`applicationMetaData.filingDate:[2021-08-04 TO 2021-09-04]`
- 比较运算：`applicationMetaData.applicationStatusCode:>600`

**分页参数**：
- `offset`：起始位置（默认 0）
- `limit`：每页数量（默认 25）

**筛选参数**：
- `filters`：字段值过滤
- `rangeFilters`：范围过滤
- `sort`：排序字段和方向
- `fields`：指定返回字段
- `facets`：分面统计

### 5.2 申请元数据

```
GET /api/v1/patent/applications/{applicationNumberText}/meta-data
```

返回申请的核心元数据，包括：
- 申请类型（Utility/Design/Plant/Reissue）
- 申请状态码和描述
- 提交日期和生效日期
- 授权日期
- 审查员姓名
- 分类号（USPC/CPC）
- 发明名称

### 5.3 审查事件历史

```
GET /api/v1/patent/applications/{applicationNumberText}/transactions
```

返回完整的审查事件时间线，包括：
- 每次审查意见发出日期
- 申请人回复日期
- 缴费记录
- 状态变更记录

**关键字段**：
- `eventDate`：事件日期
- `eventCode`：事件代码
- `eventDescriptionText`：事件描述

### 5.4 审查文档

```
GET /api/v1/patent/applications/{applicationNumberText}/documents
```

返回申请关联的所有文档列表，包括：
- 审查意见通知书（Non-Final Rejection, Final Rejection 等）
- 申请人回复（Amendment, Remarks 等）
- 通知函（Restriction Requirement, Advisory Action 等）

**关键字段**：
- `documentIdentifier`：文档唯一标识
- `documentCode`：文档类型代码
- `documentCodeDescriptionText`：文档类型描述
- `officialDate`：文档日期
- `downloadOptionBag`：下载选项（含 PDF 下载链接和页数）

**文档下载**：
```
GET https://api.uspto.gov/api/v1/patent/application/documents/{appNumber}/{documentId}.pdf
```

### 5.5 续案/分案关系

```
GET /api/v1/patent/applications/{applicationNumberText}/continuity
```

返回专利的续案和分案关系链：
- 父案信息（Parent Continuity）
- 子案信息（Child Continuity）

### 5.6 外国优先权

```
GET /api/v1/patent/applications/{applicationNumberText}/foreign-priority
```

返回外国优先权主张信息，可用于关联其他国家的同族申请。

### 5.7 专利权转让

```
GET /api/v1/patent/applications/{applicationNumberText}/assignment
```

### 5.8 代理律师

```
GET /api/v1/patent/applications/{applicationNumberText}/attorney
```

### 5.9 专利期限调整

```
GET /api/v1/patent/applications/{applicationNumberText}/adjustment
```

### 5.10 关联文档

```
GET /api/v1/patent/applications/{applicationNumberText}/associated-documents
```

返回公开文本（PGPub）和授权文本（Grant）的元数据。

## 6. 响应数据结构

### 6.1 核心响应结构

```json
{
  "count": 1,
  "patentFileWrapperDataBag": [
    {
      "applicationNumberText": "14412875",
      "applicationMetaData": {
        "filingDate": "2012-12-19",
        "applicationTypeLabelName": "Utility",
        "applicationStatusCode": 150,
        "applicationStatusDescriptionText": "Patented Case",
        "inventionTitle": "...",
        "examinerNameText": "...",
        "firstApplicantName": "...",
        "grantDate": "2016-06-07",
        "patentNumber": "9362380"
      },
      "eventDataBag": [...],
      "parentContinuityBag": [...],
      "childContinuityBag": [...],
      "foreignPriorityBag": [...]
    }
  ]
}
```

### 6.2 文档响应结构

```json
{
  "documentBag": [
    {
      "applicationNumberText": "16123123",
      "officialDate": "2020-08-31T01:20:29.000-0400",
      "documentIdentifier": "LDXBTPQ7XBLUEX3",
      "documentCode": "WFEE",
      "documentCodeDescriptionText": "Fee Worksheet (SB06)",
      "documentDirectionCategory": "INTERNAL",
      "downloadOptionBag": [
        {
          "mimeTypeIdentifier": "PDF",
          "downloadUrl": "https://api.uspto.gov/api/v1/patent/application/documents/16123123/LDXBTPQ7XBLUEX3.pdf",
          "pageTotalQuantity": 2
        }
      ]
    }
  ]
}
```

## 7. 常见文档类型代码

| 代码 | 说明 |
|------|------|
| CTNF | Non-Final Rejection（非最终驳回） |
| CTF | Final Rejection（最终驳回） |
| CTFR | Advisory Action (PTO-103)（建议性意见） |
| REST | Restriction Requirement（限制性要求） |
| WIDS | Information Disclosure Statement (IDS)（信息披露声明） |
| AMND | Amendment Under 37 CFR 1.129(a)（修正案） |
| APEA | Notice of Appeal（上诉通知） |
| APB  | Appeal Brief（上诉摘要） |
| EX.R | Examiner's Answer（审查员答复） |
| DENV | Decision on Appeal（上诉决定） |
| NTCE | Notice of Allowance（授权通知） |
| ISS  | Issue Notification（发证通知） |

## 8. 错误处理

| HTTP 状态码 | 含义 | 处理方式 |
|-------------|------|----------|
| 400 | 请求参数错误 | 检查请求参数格式 |
| 403 | API Key 无效或缺失 | 检查 X-API-KEY 请求头 |
| 404 | 未找到匹配记录 | 确认申请号是否正确 |
| 413 | 请求体过大 | 缩小查询范围 |
| 429 | 请求频率超限 | 等待后重试（指数退避） |
| 500 | 服务器内部错误 | 稍后重试 |

## 9. 本项目 API 调用规范

1. **请求间隔**：所有 API 调用之间至少等待 1.5 秒
2. **重试策略**：遇 429/500 错误时，指数退避重试（最多 3 次）
3. **超时设置**：单次请求超时 30 秒
4. **User-Agent**：设置合理的 User-Agent 标识
5. **数据缓存**：已获取的审查历史本地缓存，避免重复请求
6. **密钥管理**：API Key 存储在 .env 文件中，禁止提交至 Git

## 10. 参考链接

- ODP API Swagger 文档：https://data.uspto.gov/swagger/index.html
- ODP Getting Started：https://data.uspto.gov/apis/getting-started
- ODP API Rate Limits：https://data.uspto.gov/apis/api-rate-limits
- Developer Hub（旧）：https://developer.uspto.gov/api-catalog
- Global Dossier：https://globaldossier.uspto.gov
- USPTO 联系邮箱：data@uspto.gov
