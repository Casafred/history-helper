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
      "CTNF.NE": { name: "非最终驳回 - 新审查员 (Non-Final Rejection - New Examiner)", type: "office_action", stage: "审查中" },
      "NOA": { name: "授权通知 (Notice of Allowance)", type: "allowance", stage: "授权" },
      "AIPA": { name: "授权意向通知 (Notice of Allowance Data Verification Completed)", type: "allowance", stage: "授权" },
      "NFOA": { name: "首次非最终驳回 (Non-Final Office Action - First)", type: "office_action", stage: "审查中" },
      "FOA": { name: "首次最终驳回 (Final Office Action)", type: "office_action", stage: "审查中" },
      "OA": { name: "审查意见 (Office Action)", type: "office_action", stage: "审查中" },
      "RCEX": { name: "请求继续审查 (Request for Continued Examination)", type: "request", stage: "审查中" },
      "AMSB": { name: "补充修改 (Amendment Submitted)", type: "response", stage: "审查中" },
      "A": { name: "授权 (Allowed)", type: "allowance", stage: "授权" },
      "F": { name: "最终驳回 (Final Rejection)", type: "office_action", stage: "审查中" },
      "Q": { name: "非最终驳回 (Non-Final Rejection)", type: "office_action", stage: "审查中" },
      "R": { name: "限制性要求 (Restriction Requirement)", type: "office_action", stage: "审查中" },
      "M": { name: "其他文件 (Miscellaneous)", type: "misc", stage: "审查中" },
      "N": { name: "其他文件 (Miscellaneous)", type: "misc", stage: "审查中" },
      "P": { name: "授权 (Allowed)", type: "allowance", stage: "授权" },
      "B": { name: "维持驳回 (Ex Parte Quayle)", type: "office_action", stage: "审查中" },
      "EX.A": { name: "审查员驳回样本 (Examiner's Answer)", type: "office_action", stage: "复审" },
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
  },
};

function classifyDocCode(code, desc) {
  if (!code && !desc) return "misc";
  const text = ((code || "") + " " + (desc || "")).toLowerCase();

  if (/notice of allowance|allowed|allowance/.test(text)) return "allowance";
  if (/abandonment/.test(text)) return "notification";
  if (/restriction|election of species/.test(text)) return "office_action";
  if (/final rejection/.test(text)) return "office_action";
  if (/non.?final rejection/.test(text)) return "office_action";
  if (/office action/.test(text)) return "office_action";
  if (/rejection/.test(text)) return "office_action";
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
