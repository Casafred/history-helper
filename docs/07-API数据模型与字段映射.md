# 07 - API 数据模型与字段映射

本文档记录 USPTO ODP API 返回的 JSON 结构、Rust 后端的数据模型定义、以及前端使用的字段名之间的映射关系。

## 1. 三层字段映射关系

```
USPTO API JSON (camelCase)
    ↓ serde 反序列化 (#[serde(rename_all = "camelCase")])
Rust 结构体 (snake_case)
    ↓ serde 序列化 (#[serde(rename_all = "camelCase")])
前端 JavaScript (camelCase)
```

由于 Rust 后端使用 `#[serde(rename_all = "camelCase")]`，API JSON 和前端 JavaScript 使用相同的 camelCase 字段名，Rust 内部使用 snake_case。

## 2. 核心响应结构

### 2.1 PatentApplicationResponse

USPTO API 返回的顶层结构，用于申请数据、审查事件、续案关系、外国优先权等端点。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `count` | `count` | `count` | `Option<i64>` | 匹配记录数 |
| `patentFileWrapperDataBag` | `patent_file_wrapper_data_bag` | `patentFileWrapperDataBag` | `Option<Vec<PatentFileWrapperData>>` | 专利案卷数据列表 |

### 2.2 PatentFileWrapperData

单件专利申请的完整数据容器。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `applicationNumberText` | `application_number_text` | `applicationNumberText` | `Option<String>` | 申请号 |
| `applicationMetaData` | `application_meta_data` | `applicationMetaData` | `Option<ApplicationMetaData>` | 申请元数据 |
| `eventDataBag` | `event_data_bag` | `eventDataBag` | `Option<Vec<EventData>>` | 审查事件列表 |
| `parentContinuityBag` | `parent_continuity_bag` | `parentContinuityBag` | `Option<Vec<ParentContinuityData>>` | 父案列表 |
| `childContinuityBag` | `child_continuity_bag` | `childContinuityBag` | `Option<Vec<ChildContinuityData>>` | 子案列表 |
| `foreignPriorityBag` | `foreign_priority_bag` | `foreignPriorityBag` | `Option<Vec<ForeignPriority>>` | 外国优先权列表 |

### 2.3 ApplicationMetaData

申请的核心元数据。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `filingDate` | `filing_date` | `filingDate` | `Option<String>` | 提交日期 (yyyy-MM-dd) |
| `applicationTypeLabelName` | `application_type_label_name` | `applicationTypeLabelName` | `Option<String>` | 申请类型 (Utility/Design/Plant) |
| `applicationStatusCode` | `application_status_code` | `applicationStatusCode` | `Option<i64>` | 状态码 |
| `applicationStatusDescriptionText` | `application_status_description_text` | `applicationStatusDescriptionText` | `Option<String>` | 状态描述 |
| `inventionTitle` | `invention_title` | `inventionTitle` | `Option<String>` | 发明名称 |
| `examinerNameText` | `examiner_name_text` | `examinerNameText` | `Option<String>` | 审查员姓名 |
| `firstApplicantName` | `first_applicant_name` | `firstApplicantName` | `Option<String>` | 首位申请人 |
| `grantDate` | `grant_date` | `grantDate` | `Option<String>` | 授权日期 |
| `patentNumber` | `patent_number` | `patentNumber` | `Option<String>` | 专利号 |
| `groupArtUnitNumber` | `group_art_unit_number` | `groupArtUnitNumber` | `Option<String>` | 审查单元号 |
| `class` | `class` | `class` | `Option<String>` | USPC 分类号 |
| `subclass` | `subclass` | `subclass` | `Option<String>` | USPC 子分类号 |

### 2.4 EventData

审查事件记录。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `eventDate` | `event_date` | `eventDate` | `Option<String>` | 事件日期 |
| `eventCode` | `event_code` | `eventCode` | `Option<String>` | 事件代码 |
| `eventDescriptionText` | `event_description_text` | `eventDescriptionText` | `Option<String>` | 事件描述 |

### 2.5 ParentContinuityData

父案关系。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `parentApplicationNumberText` | `parent_application_number_text` | `parentApplicationNumberText` | `Option<String>` | 父案申请号 |
| `parentApplicationStatusCode` | `parent_application_status_code` | `parentApplicationStatusCode` | `Option<i64>` | 父案状态码 |
| `parentApplicationStatusDescriptionText` | `parent_application_status_description_text` | `parentApplicationStatusDescriptionText` | `Option<String>` | 父案状态描述 |
| `continuityTypeCode` | `continuity_type_code` | `continuityTypeCode` | `Option<String>` | 关系类型 (CON/DIV/CPA) |

### 2.6 ChildContinuityData

子案关系。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `childApplicationNumberText` | `child_application_number_text` | `childApplicationNumberText` | `Option<String>` | 子案申请号 |
| `childApplicationStatusCode` | `child_application_status_code` | `childApplicationStatusCode` | `Option<i64>` | 子案状态码 |
| `childApplicationStatusDescriptionText` | `child_application_status_description_text` | `childApplicationStatusDescriptionText` | `Option<String>` | 子案状态描述 |
| `continuityTypeCode` | `continuity_type_code` | `continuityTypeCode` | `Option<String>` | 关系类型 |

### 2.7 ForeignPriority

外国优先权。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `foreignPriorityCountryCode` | `foreign_priority_country_code` | `foreignPriorityCountryCode` | `Option<String>` | 国家代码 |
| `foreignPriorityDate` | `foreign_priority_date` | `foreignPriorityDate` | `Option<String>` | 优先权日期 |
| `foreignPriorityNumberText` | `foreign_priority_number_text` | `foreignPriorityNumberText` | `Option<String>` | 优先权号 |

## 3. 文档列表响应结构

### 3.1 DocumentBagResponse

文档列表端点 `/documents` 返回的结构，与其他端点不同。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `documentBag` | `document_bag` | `documentBag` | `Option<Vec<DocumentInfo>>` | 文档列表 |

### 3.2 DocumentInfo

单个文档信息。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `applicationNumberText` | `application_number_text` | `applicationNumberText` | `Option<String>` | 申请号 |
| `officialDate` | `official_date` | `officialDate` | `Option<String>` | 文档日期 |
| `documentIdentifier` | `document_identifier` | `documentIdentifier` | `Option<String>` | 文档唯一标识 |
| `documentCode` | `document_code` | `documentCode` | `Option<String>` | 文档类型代码 |
| `documentCodeDescriptionText` | `document_code_description_text` | `documentCodeDescriptionText` | `Option<String>` | 文档类型描述 |
| `documentDirectionCategory` | `document_direction_category` | `documentDirectionCategory` | `Option<String>` | 方向 (INCOMING/OUTGOING/INTERNAL) |
| `downloadOptionBag` | `download_option_bag` | `downloadOptionBag` | `Option<Vec<DownloadOption>>` | 下载选项 |

### 3.3 DownloadOption

文档下载信息。

| API JSON 字段 | Rust 字段 | 前端字段 | 类型 | 说明 |
|---------------|-----------|----------|------|------|
| `mimeTypeIdentifier` | `mime_type_identifier` | `mimeTypeIdentifier` | `Option<String>` | 格式 (PDF/XML) |
| `downloadUrl` | `download_url` | `downloadUrl` | `Option<String>` | 下载链接 |
| `pageTotalQuantity` | `page_total_quantity` | `pageTotalQuantity` | `Option<i64>` | 总页数 |

## 4. 命令返回结构

### 4.1 CommandResult

所有 Tauri 命令的统一返回格式。

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | `bool` | 是否成功 |
| `data` | `Option<serde_json::Value>` | 成功时返回的数据 |
| `error` | `Option<String>` | 失败时的错误信息 |

### 4.2 前端使用方式

```javascript
const result = await invoke("fetch_application", { appNumber: "14412875" });
if (result.success) {
    const data = result.data;
    const bag = data.patentFileWrapperDataBag?.[0];
    const meta = bag.applicationMetaData;
    console.log(meta.inventionTitle);
} else {
    console.error(result.error);
}
```

## 5. 专利号转换结构

### 5.1 PatentNumber

`convert_patent_number` 命令返回的数据结构。

| Rust 字段 | 前端字段 | 类型 | 说明 |
|-----------|----------|------|------|
| `office` | `office` | `PatentOffice` (序列化为字符串) | 识别的专利局 |
| `raw` | `raw` | `String` | 原始输入 |
| `application_number` | `applicationNumber` | `Option<String>` | 标准化申请号 |
| `publication_number` | `publicationNumber` | `Option<String>` | 公开号（待实现） |
| `patent_number` | `patentNumber` | `Option<String>` | 专利号（待实现） |
| `filing_date` | `filingDate` | `Option<String>` | 提交日期（待实现） |

## 6. 常见文档类型代码速查

| 代码 | 英文描述 | 中文说明 | 类别 |
|------|----------|----------|------|
| CTNF | Non-Final Rejection | 非最终驳回 | 审查意见 |
| CTF | Final Rejection | 最终驳回 | 审查意见 |
| CTFR | Advisory Action (PTO-103) | 建议性意见 | 审查意见 |
| REST | Restriction Requirement | 限制性要求 | 审查意见 |
| NTCE | Notice of Allowance | 授权通知 | 审查意见 |
| EX.Q | Ex Parte Quayle | Quayle 决定 | 审查意见 |
| EX.R | Examiner's Answer | 审查员答复 | 审查意见 |
| AMND | Amendment | 修正案 | 申请人回复 |
| ROA | Response to Office Action | 审查意见答复 | 申请人回复 |
| APEA | Notice of Appeal | 上诉通知 | 申请人回复 |
| APB | Appeal Brief | 上诉摘要 | 申请人回复 |
| WIDS | Information Disclosure Statement | 信息披露声明 | 申请人提交 |
| WFEE | Fee Worksheet | 费用工作表 | 费用 |
| NTCE | Notice of Allowance | 授权通知 | 授权 |
| ISS | Issue Notification | 发证通知 | 授权 |
| PGPUB | Pre-Grant Publication | 公开文本 | 公开 |

## 7. 续案关系类型代码

| 代码 | 英文 | 中文说明 |
|------|------|----------|
| CON | Continuation | 续案 |
| DIV | Divisional | 分案 |
| CPA | Continuation-in-Part | 部分续案 |
| CONT | Continuation | 续案（旧代码） |

## 8. API 端点与数据模型对应表

| API 端点 | 返回结构 | 前端 Tab |
|----------|----------|----------|
| `GET /applications/{num}` | `PatentApplicationResponse` | 概览 |
| `GET /applications/{num}/meta-data` | `PatentApplicationResponse` | 概览 |
| `GET /applications/{num}/transactions` | `PatentApplicationResponse` (eventDataBag) | 审查时间线 |
| `GET /applications/{num}/documents` | `DocumentBagResponse` | 审查文档 |
| `GET /applications/{num}/continuity` | `PatentApplicationResponse` | 续案/分案 |
| `GET /applications/{num}/foreign-priority` | `PatentApplicationResponse` | 续案/分案 |
