var PATENT_STATUS = {
  US: {
    codeMap: {
      "CTNF": { name: "非最终驳回 (Non-Final Rejection)", type: "office_action", stage: "审查中" },
      "CTFR": { name: "最终驳回 (Final Rejection)", type: "office_action", stage: "审查中" },
      "CTRS": { name: "限制性要求 (Restriction Requirement)", type: "office_action", stage: "审查中" },
      "CTAV": { name: "放弃意向通知 (Notice of Abandonment)", type: "notification", stage: "审查中" },
      "CTED": { name: "撤回回复 (Response after Final - Withdrawn)", type: "response", stage: "审查中" },
      "CTEQ": { name: "其他回复 (Other Response)", type: "response", stage: "审查中" },
      "CTMS": { name: "其他文件 (Miscellaneous)", type: "misc", stage: "审查中" },
      "NOA": { name: "授权通知 (Notice of Allowance)", type: "allowance", stage: "授权" },
      "AIPA": { name: "授权意向通知 (Notice of Allowance Data Verification Completed)", type: "allowance", stage: "授权" },
      "NFOA": { name: "首次非最终驳回 (Non-Final Office Action - First)", type: "office_action", stage: "审查中" },
      "FOA": { name: "首次最终驳回 (Final Office Action)", type: "office_action", stage: "审查中" },
      "OA": { name: "审查意见 (Office Action)", type: "office_action", stage: "审查中" },
      "RCEX": { name: "请求继续审查 (Request for Continued Examination)", type: "request", stage: "审查中" },
      "AMSB": { name: "修改提交 (Amendment Submitted)", type: "response", stage: "审查中" },
      "A": { name: "授权 (Allowed)", type: "allowance", stage: "授权" },
      "F": { name: "最终驳回 (Final Rejection)", type: "office_action", stage: "审查中" },
      "Q": { name: "非最终驳回 (Non-Final Rejection)", type: "office_action", stage: "审查中" },
      "R": { name: "限制性要求 (Restriction Requirement)", type: "office_action", stage: "审查中" },
      "M": { name: "其他文件 (Miscellaneous)", type: "misc", stage: "审查中" },
      "N": { name: "其他文件 (Miscellaneous)", type: "misc", stage: "审查中" },
      "P": { name: "授权 (Allowed)", type: "allowance", stage: "授权" },
      "B": { name: "维持驳回 (Ex Parte Quayle)", type: "office_action", stage: "审查中" },
      "EX.A": { name: "审查员答辩意见 (Examiner's Answer)", type: "office_action", stage: "复审" },
      "A...": { name: "非最终驳回后修改/复审请求 (Amendment/Request for Reconsideration-After Non-Final Rejection)", type: "response", stage: "审查中" },
      "A.NE": { name: "最终驳回后答复 (Response After Final Action)", type: "response", stage: "审查中" },
      "A.NE.AFCP": { name: "最终驳回后考虑计划请求 (After Final Consideration Program Request)", type: "request", stage: "审查中" },
      "A.NE.AFCP.D": { name: "最终驳回后考虑计划决定 (After Final Consideration Program Decision)", type: "notification", stage: "审查中" },
      "A.NA": { name: "授权通知后修改 (Amendment after Notice of Allowance)", type: "response", stage: "授权" },
      "REM": { name: "申请人意见陈述 (Applicant Arguments/Remarks Made in an Amendment)", type: "response", stage: "审查中" },
      "CLM": { name: "权利要求 (Claims)", type: "misc", stage: "审查中" },
      "SPEC": { name: "说明书 (Specification)", type: "misc", stage: "审查中" },
      "ABST": { name: "摘要 (Abstract)", type: "misc", stage: "审查中" },
      "IDS": { name: "信息披露声明 (Information Disclosure Statement)", type: "misc", stage: "审查中" },
      "FOR": { name: "外国引用文献 (Foreign Reference)", type: "misc", stage: "审查中" },
      "892": { name: "审查员引用文献列表 (List of References Cited by Examiner)", type: "misc", stage: "审查中" },
      "1449": { name: "申请人引用且审查员考虑的文献列表 (List of References Cited by Applicant and Considered by Examiner)", type: "misc", stage: "审查中" },
      "SRNT": { name: "审查员检索策略和结果 (Examiner's Search Strategy and Results)", type: "misc", stage: "审查中" },
      "SRFW": { name: "检索信息 (Search Information including Classification, Databases and Other Search Related Notes)", type: "misc", stage: "审查中" },
      "FWCLM": { name: "权利要求索引 (Index of Claims)", type: "misc", stage: "审查中" },
      "BIB": { name: "书目数据表 (Bibliographic Data Sheet)", type: "misc", stage: "审查中" },
      "EXIN": { name: "审查员面谈记录 (Examiner Interview Summary Record)", type: "notification", stage: "审查中" },
      "IIFW": { name: "授权信息 (Issue Information including Classification, Examiner, Name, Claim, Renumbering, etc.)", type: "allowance", stage: "授权" },
      "ISSUE.NTF": { name: "授权公告通知 (Issue Notification)", type: "allowance", stage: "授权" },
      "IFEE": { name: "授权费缴纳 (Issue Fee Payment)", type: "request", stage: "授权" },
      "WFEE": { name: "费用工作表 (Fee Worksheet)", type: "misc", stage: "审查中" },
      "N417": { name: "电子提交确认回执 (Electronic Filing System Acknowledgment Receipt)", type: "notification", stage: "审查中" },
      "N570": { name: "代理委托书沟通 (Communication - Re: Power of Attorney)", type: "notification", stage: "审查中" },
      "N572": { name: "代理委托书回复 (Response - Re: Informal Power of Attorney)", type: "notification", stage: "审查中" },
      "M327": { name: "申请人杂项通知 (Miscellaneous Communication to Applicant - No Action Count)", type: "notification", stage: "审查中" },
      "PA..": { name: "代理委托书 (Power of Attorney)", type: "misc", stage: "审查中" },
      "R3.73": { name: "受让人所有权证明 (Assignee Showing of Ownership per 37 CFR 3.73)", type: "misc", stage: "审查中" },
      "R46C.REQ": { name: "申请人更正请求 (Request under 37CFR 1.46(c) to Correct/Update/Change Applicant)", type: "request", stage: "审查中" },
      "TRAN.LET": { name: "传送信函 (Transmittal Letter)", type: "misc", stage: "审查中" },
      "APP.FILE.REC": { name: "申请受理回执 (Filing Receipt)", type: "notification", stage: "审查前" },
      "PET.PCT": { name: "PCT法律审查请愿 (Petition for Review by the PCT Legal Office)", type: "request", stage: "审查中" },
      "PET.OP.DEC": { name: "请愿决定 (Office of Petitions Decision)", type: "notification", stage: "审查中" },
      "PETDEC": { name: "请愿决定 (Petition Decision)", type: "notification", stage: "审查中" },
      "PET.DEC.TC": { name: "技术中心请愿决定 (Petition Decision Routed to Technology Center)", type: "notification", stage: "审查中" },
      "RFN.REQ": { name: "退费请求 (Refund Request)", type: "request", stage: "审查中" },
      "XT/": { name: "延期请求 (Extension of Time)", type: "request", stage: "审查中" },
      "136A": { name: "延期授权 (Authorization for Extension of Time)", type: "request", stage: "审查中" },
      "IMIS": { name: "内部杂项文件 (Miscellaneous Internal Document)", type: "misc", stage: "审查中" },
      "SCORE": { name: "补充内容占位页 (Supplemental Complex Repository for Examiners)", type: "misc", stage: "审查中" },
      "DRW.NONBW": { name: "非黑白线条图 (Drawings - Other than Black and White Line Drawings)", type: "misc", stage: "审查中" },
      "SES.LOSS": { name: "小实体资格丧失通知 (Notification of Loss of Entitlement to Small Entity Status)", type: "notification", stage: "审查中" },
      "PA": { name: "初步修改 (Preliminary Amendment)", type: "request", stage: "审查前" },
      "WDR": { name: "审查前正式通知答复 (Applicant Response to Pre-Exam Formalities Notice)", type: "response", stage: "审查前" },
      "DRW": { name: "黑白线条图 (Drawings - Black and White Line Drawings)", type: "misc", stage: "审查中" },
      "SEQ": { name: "序列表 (Sequence Listing)", type: "misc", stage: "审查中" },
      "ABN": { name: "放弃 (Abandonment)", type: "notification", stage: "审查中" },
      "TRN": { name: "新申请传送 (Transmittal of New Application)", type: "misc", stage: "审查前" },
      "CFP": { name: "外国优先权认证副本 (Certified Copy of Foreign Priority Application)", type: "misc", stage: "审查前" },
      "NTC.PUB": { name: "公开通知 (Notice of Publication)", type: "notification", stage: "审查中" },
      "DO.EO.MISS": { name: "指定局/选定局缺失要求通知 (Notice of DO/EO Missing Requirements Mailed)", type: "notification", stage: "审查中" },
      "DO.EO.ACPT": { name: "指定局/选定局受理通知 (Notice of Designated Office/Elected Office Acceptance Mailed)", type: "notification", stage: "审查中" },
      "RES.ER": { name: "选举/限制答复 (Response to Election / Restriction Filed)", type: "response", stage: "审查中" },
      "EGRN": { name: "电子授权当日通知 (eGrant day-of Notification)", type: "allowance", stage: "授权" },
      "NTC.EGRN": { name: "电子授权当日通知 (eGrant day-of Notification)", type: "allowance", stage: "授权" },
      "EGRT": { name: "电子授权通知 (eGrant Notification)", type: "allowance", stage: "授权" },
      "ISS.NTF": { name: "授权公告通知 (Issue Notification)", type: "allowance", stage: "授权" },
      "PTO.FEE": { name: "专利局费用通知 (PTO Fee Notification)", type: "notification", stage: "授权" },
    },
    typeNames: {
      "office_action": "审查意见",
      "response": "申请人答复",
      "request": "申请人请求",
      "allowance": "授权通知",
      "notification": "通知",
      "misc": "其他文件",
    },
    stageNames: {
      "审查前": "审查前",
      "审查中": "审查中",
      "授权": "已授权",
      "复审": "复审阶段",
      "完成": "已结案",
    },
    abstract: {
      "office_action": "审查员发出审查意见",
      "response": "申请人提交答复",
      "request": "申请人提出请求",
      "allowance": "审查员同意授权",
      "notification": "官方通知",
      "misc": "其他往来文件",
    },
    aiAnalysisTypes: ["office_action", "response"],
  },
};

function classifyDocCode(code, desc) {
  if (!code && !desc) return "misc";
  const text = ((code || "") + " " + (desc || "")).toLowerCase();

  if (/notice of allowance|allowed|allowance/.test(text)) return "allowance";
  if (/egrant|e-grant/.test(text)) return "allowance";
  if (/abandonment/.test(text)) return "notification";
  if (/preliminary amendment/.test(text)) return "request";
  if (/pre.?exam formalities/.test(text)) return "response";
  if (/election.*restriction.*filed/.test(text)) return "response";
  if (/notice of publication/.test(text)) return "notification";
  if (/transmittal of new application/.test(text)) return "misc";
  if (/sequence listing/.test(text)) return "misc";
  if (/certified copy/.test(text)) return "misc";
  if (/black and white line drawings?/.test(text)) return "misc";
  if (/restriction|election of species/.test(text)) return "office_action";
  if (/final rejection/.test(text)) return "office_action";
  if (/non.?final rejection/.test(text)) return "office_action";
  if (/office action/.test(text)) return "office_action";
  if (/rejection/.test(text)) return "office_action";
  if (/amendment.*after.*non.?final|reconsideration.*after.*non.?final/.test(text)) return "response";
  if (/response after final|after final consideration/.test(text)) return "response";
  if (/amendment.*after.*notice of allowance/.test(text)) return "response";
  if (/applicant argument|applicant remark|remarks made in an amendment/.test(text)) return "response";
  if (/response|amendment|reply|remand/.test(text)) return "response";
  if (/rce|continued examination|request for/.test(text)) return "request";
  if (/notice|notification/.test(text)) return "notification";
  if (/appeal|examiner's answer/.test(text)) return "office_action";

  return "misc";
}

function getStatusInfo(office, code, desc) {
  const officeMap = PATENT_STATUS[office];
  if (!officeMap) return { name: desc || code || "未知文件", type: "misc", stage: "未知" };

  const upperCode = (code || "").toUpperCase();
  if (officeMap.codeMap[upperCode]) {
    const info = officeMap.codeMap[upperCode];
    return { name: info.name, type: info.type, stage: info.stage };
  }

  const type = classifyDocCode(code, desc);
  const typeName = officeMap.typeNames[type] || "其他文件";
  return { name: desc || code || typeName, type: type, stage: "审查中" };
}

function shouldIncludeInAIAnalysis(office, type) {
  const officeMap = PATENT_STATUS[office];
  if (!officeMap || !officeMap.aiAnalysisTypes) return type === "office_action" || type === "response";
  return officeMap.aiAnalysisTypes.indexOf(type) !== -1;
}
