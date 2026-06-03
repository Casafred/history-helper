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
      "PEFN": { name: "审查前正式要求通知 (Pre-Exam Formalities Notice)", type: "office_action", stage: "审查前" },
      "ERSP": { name: "选举/限制答复 (Response to Election / Restriction Filed)", type: "response", stage: "审查中" },
      "EGRN": { name: "电子授权当日通知 (eGrant day-of Notification)", type: "allowance", stage: "授权" },
      "NTC.EGRN": { name: "电子授权当日通知 (eGrant day-of Notification)", type: "allowance", stage: "授权" },
      "EGRT": { name: "电子授权通知 (eGrant Notification)", type: "allowance", stage: "授权" },
      "ISS.NTF": { name: "授权公告通知 (Issue Notification)", type: "allowance", stage: "授权" },
      "PTO.FEE": { name: "专利局费用通知 (PTO Fee Notification)", type: "notification", stage: "授权" },
      "MIL": { name: "杂项来函 (Miscellaneous Incoming Letter)", type: "misc", stage: "审查中" },
      "LRI": { name: "面谈请求函 (Letter Requesting Interview with Examiner)", type: "request", stage: "审查中" },
      "PDOC": { name: "优先权文件电子获取 (Priority Documents electronically retrieved by USPTO from a participating IP Office)", type: "misc", stage: "审查前" },
      "ERSP2": { name: "选举/限制答复 (Response to Election / Restriction Filed)", type: "response", stage: "审查中" },
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
  EP: {
    codeMap: {
      "1001P": { name: "欧洲专利授权请求 (Request for Grant)", type: "request", stage: "审查前" },
      "1001": { name: "欧洲专利授权请求 (Request for Grant)", type: "request", stage: "审查前" },
      "1002": { name: "发明人指定 (Designation of Inventor)", type: "misc", stage: "审查前" },
      "1001-6E": { name: "电子提交确认回执 (Acknowledgement of Receipt)", type: "notification", stage: "审查前" },
      "DESC": { name: "说明书 (Description)", type: "misc", stage: "审查中" },
      "CLMS": { name: "权利要求 (Claims)", type: "misc", stage: "审查中" },
      "ABST": { name: "摘要 (Abstract)", type: "misc", stage: "审查中" },
      "DRAW": { name: "附图 (Drawings)", type: "misc", stage: "审查中" },
      "PRIODOC-X": { name: "优先权文件 (Priority Document)", type: "misc", stage: "审查前" },
      "SRCH-START": { name: "检索开始 (Search Started)", type: "notification", stage: "审查中" },
      "1503": { name: "欧洲检索报告 (European Search Report)", type: "office_action", stage: "审查中" },
      "1507": { name: "检索报告传输通知 (Communication re Search Report Transmission)", type: "notification", stage: "审查中" },
      "1703": { name: "欧洲检索意见 (European Search Opinion)", type: "office_action", stage: "审查中" },
      "SRCHSTRAEP": { name: "检索策略信息 (Search Strategy Information)", type: "misc", stage: "审查中" },
      "FEES": { name: "费用通知 (Letter Concerning Fees)", type: "notification", stage: "审查中" },
      "ABEX": { name: "检索后修改 (Amendments Before Examination)", type: "response", stage: "审查中" },
      "CLMSABEX": { name: "检索后修改权利要求 (Amended Claims After Search)", type: "response", stage: "审查中" },
      "CLMS-HWA": { name: "标注修改权利要求 (Amended Claims with Annotations)", type: "response", stage: "审查中" },
      "RECEIPT-OLF": { name: "电子回执 (Electronic Receipt)", type: "notification", stage: "审查中" },
      "2901": { name: "程序参与方通知 (Communication for Party)", type: "notification", stage: "审查中" },
      "1133": { name: "即将公开通知 (Notification of Forthcoming Publication)", type: "notification", stage: "审查中" },
      "1083": { name: "公开及指定费通知 (Information about Publication)", type: "notification", stage: "审查中" },
      "EX-START": { name: "实质审查开始 (Examination Started)", type: "notification", stage: "审查中" },
      "2004": { name: "授权意向通知 (Communication about Intention to Grant)", type: "allowance", stage: "授权" },
      "2056": { name: "书目数据 (Bibliographic Data)", type: "misc", stage: "授权" },
      "2906I": { name: "授权意向附件 (Annex to Intention to Grant)", type: "allowance", stage: "授权" },
      "2035-4": { name: "授权意向签名 (Intention to Grant - Signatures)", type: "allowance", stage: "授权" },
      "EDREXFINAL": { name: "授权文本定稿 (Text Intended for Grant - Clean)", type: "allowance", stage: "授权" },
      "EDREX": { name: "授权文本审批版 (Text Intended for Grant - Draft)", type: "allowance", stage: "授权" },
      "1038": { name: "后续提交附函 (Letter Accompanying Subsequently Filed Items)", type: "misc", stage: "审查中" },
      "CLMSTRAN-DE": { name: "德文权利要求翻译 (German Translation of Claims)", type: "misc", stage: "授权" },
      "CLMSTRAN-FR": { name: "法文权利要求翻译 (French Translation of Claims)", type: "misc", stage: "授权" },
      "2006A": { name: "授权决定 (Decision to Grant)", type: "allowance", stage: "授权" },
      "2047": { name: "欧洲专利证书 (Certificate for European Patent)", type: "allowance", stage: "授权" },
      "2057": { name: "异议期届满通知 (Communication re Expiry of Opposition Period)", type: "notification", stage: "授权" },
      "WDP": { name: "撤回 (Withdrawal)", type: "notification", stage: "审查中" },
      "REEX": { name: "限缩修改 (Amendments in Examination)", type: "response", stage: "审查中" },
      "CLMSREEX": { name: "审查中修改权利要求 (Amended Claims in Examination)", type: "response", stage: "审查中" },
      "BREVET": { name: "授权专利 (Granted Patent)", type: "allowance", stage: "授权" },
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
  CN: {
    codeMap: {
      "100001-CN": { name: "权利要求书 (Claims)", type: "misc", stage: "审查前" },
      "100002-CN": { name: "说明书 (Description)", type: "misc", stage: "审查前" },
      "100003-CN": { name: "说明书附图 (Drawings)", type: "misc", stage: "审查前" },
      "100004-CN": { name: "说明书摘要 (Abstract)", type: "misc", stage: "审查前" },
      "110401-CN": { name: "实质审查请求 (Request for Substantive Examination)", type: "request", stage: "审查中" },
      "200103-CN": { name: "申请费缴纳通知 (Notice of Payment of Application Fee)", type: "notification", stage: "审查前" },
      "200021-CN": { name: "费用减免审批通知 (Notice of Approval for Fee Reduction)", type: "notification", stage: "审查前" },
      "210304-CN": { name: "初步审查合格通知 (Notification of Qualification of Preliminary Examination)", type: "notification", stage: "审查中" },
      "210305-CN": { name: "申请公布通知 (Notice of Publication of Invention Patent Application)", type: "notification", stage: "审查中" },
      "210307-CN": { name: "进入实质审查阶段通知 (Notice of Entering Substantive Examination Stage)", type: "notification", stage: "审查中" },
      "210401": { name: "第一次审查意见通知书 (First Notice of Examination Opinions)", type: "office_action", stage: "审查中" },
      "210401-CN": { name: "第一次审查意见通知书-原文 (First Notice of Examination Opinions - Original)", type: "office_action", stage: "审查中" },
      "210402": { name: "第二次审查意见通知书 (Second Notice of Examination Opinions)", type: "office_action", stage: "审查中" },
      "210402-CN": { name: "第二次审查意见通知书-原文 (Second Notice of Examination Opinions - Original)", type: "office_action", stage: "审查中" },
      "210403": { name: "第三次审查意见通知书 (Third Notice of Examination Opinions)", type: "office_action", stage: "审查中" },
      "0-CN": { name: "检索报告 (First Search)", type: "misc", stage: "审查中" },
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
  DE: {
    codeMap: {},
    descMap: {
      "beschreibung": "说明书",
      "ansprüche": "权利要求书",
      "zusammenfassung": "摘要",
      "zeichnung": "附图",
      "anschreiben": "申请信函",
      "antrag: erteilung eines patents": "专利授权申请",
      "erfinderbenennung": "发明人声明",
      "empfangsbestätigung für eine patentanmeldung": "专利申请受理确认",
      "empfangsbestätigung": "受理确认",
      "bibliografie-mitteilung standard": "标准书目通知",
      "bibliographiemitteilung": "书目通知",
      "bibliografie": "书目通知",
      "anschreiben zur bibliografie-mitteilung": "书目通知信函",
      "einleitung der nationalen phase eines patents": "国家阶段进入",
      "prüfungsbescheid": "审查意见通知书",
      "recherchebericht": "检索报告",
      "erteilungsbescheid": "授权通知",
      "patentschrift": "专利说明书",
      "offenlegungsschrift": "公开说明书",
      "eingabe": "申请人意见陈述",
      "prüfungsantrag": "实质审查请求",
      "einspruch": "异议",
      "zurücknahme": "撤回",
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
  JP: {
    codeMap: {
      "A63": { name: "专利申请文件 (Request for a Patent)", type: "misc", stage: "审查前" },
      "A63-JP": { name: "专利申请文件-原文 (Request for a Patent - Original)", type: "misc", stage: "审查前" },
      "A621": { name: "实质审查请求 (Request for Examination)", type: "request", stage: "审查中" },
      "A621-JP": { name: "实质审查请求-原文 (Request for Examination - Original)", type: "request", stage: "审查中" },
      "A131": { name: "驳回理由通知书 (Notice of Reasons for Refusal)", type: "office_action", stage: "审查中" },
      "A131-JP": { name: "驳回理由通知书-原文 (Notice of Reasons for Refusal - Original)", type: "office_action", stage: "审查中" },
      "A523": { name: "自愿修改 (Written Amendment - Voluntary)", type: "response", stage: "审查中" },
      "A523-JP": { name: "自愿修改-原文 (Written Amendment - Voluntary - Original)", type: "response", stage: "审查中" },
      "A53": { name: "意见书 (Written Opinion)", type: "response", stage: "审查中" },
      "A53-JP": { name: "意见书-原文 (Written Opinion - Original)", type: "response", stage: "审查中" },
      "A01": { name: "授权决定 (Decision to Grant a Patent)", type: "allowance", stage: "授权" },
      "A01-JP": { name: "授权决定-原文 (Decision to Grant a Patent - Original)", type: "allowance", stage: "授权" },
      "A971007": { name: "检索报告 (Search Report by Registered Search Organization)", type: "misc", stage: "审查中" },
      "A971007-JP": { name: "检索报告-原文 (Search Report - Original)", type: "misc", stage: "审查中" },
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

  // EP-specific patterns (check first)
  if (/intention to grant|decision to grant|text intended for grant/.test(text)) return "allowance";
  if (/certificate for.*european patent/.test(text)) return "allowance";
  if (/european search report/.test(text)) return "office_action";
  if (/european search opinion/.test(text)) return "office_action";
  if (/communication.*intention to grant/.test(text)) return "allowance";
  if (/examination started/.test(text)) return "notification";
  if (/search started/.test(text)) return "notification";
  if (/amendments?.*(?:before|in) examination|amended claims/.test(text)) return "response";
  if (/request for grant/.test(text)) return "request";
  if (/withdrawal/.test(text)) return "notification";
  if (/opposition/.test(text)) return "notification";

  // CN-specific patterns (desc is in English from GD API)
  if (/notice of examination opinions/.test(text)) return "office_action";
  if (/request for substantive examination/.test(text)) return "request";
  if (/qualification of preliminary examination/.test(text)) return "notification";
  if (/publication of invention patent application/.test(text)) return "notification";
  if (/entering the substantive examination stage/.test(text)) return "notification";
  if (/payment of application fee/.test(text)) return "notification";
  if (/fee reduction/.test(text)) return "notification";
  if (/right.?claiming document/.test(text)) return "misc";
  if (/specification summary|instructions|attached drawings/.test(text)) return "misc";
  if (/first search/.test(text)) return "misc";

  // JP-specific patterns (desc is in English from GD API)
  if (/notice of reasons for refusal/.test(text)) return "office_action";
  if (/written opinion/.test(text)) return "response";
  if (/written amendment.*voluntary/.test(text)) return "response";
  if (/request for a patent/.test(text)) return "misc";
  if (/request for examination/.test(text)) return "request";
  if (/decision to grant a patent/.test(text)) return "allowance";
  if (/search report by registered/.test(text)) return "misc";
  if (/appeal against decision of refusal/.test(text)) return "office_action";
  if (/trial decision/.test(text)) return "office_action";
  if (/claims|description|abstract|drawings/.test(text) && /translated|original/.test(text)) return "misc";

  // DE-specific patterns (desc is in German from GD API, no docCode)
  if (/beschreibung/.test(text)) return "misc";
  if (/ansprüche/.test(text)) return "misc";
  if (/zusammenfassung/.test(text)) return "misc";
  if (/zeichnung/.test(text)) return "misc";
  if (/anschreiben/.test(text)) return "misc";
  if (/antrag.*erteilung|request for patent/.test(text)) return "request";
  if (/erfinderbenennung/.test(text)) return "misc";
  if (/empfangsbestätigung/.test(text)) return "notification";
  if (/bibliografie|bibliographiemitteilung/.test(text)) return "notification";
  if (/prüfungsbescheid/.test(text)) return "office_action";
  if (/recherchebericht/.test(text)) return "office_action";
  if (/erteilungsbescheid/.test(text)) return "allowance";
  if (/patentschrift/.test(text)) return "allowance";
  if (/offenlegungsschrift/.test(text)) return "notification";
  if (/eingabe/.test(text)) return "response";
  if (/prüfungsantrag/.test(text)) return "request";
  if (/einspruch/.test(text)) return "notification";
  if (/zurücknahme/.test(text)) return "notification";
  if (/bescheid/.test(text)) return "office_action";

  // US-specific patterns (order matters: specific before general)
  // Allowance
  if (/notice of allowance|allowed|allowance/.test(text)) return "allowance";
  if (/egrant|e-grant/.test(text)) return "allowance";

  // Office actions (examiner-initiated)
  if (/pre.?exam formalities notice/.test(text)) return "office_action";
  if (/restriction requirement|election of species requirement/.test(text)) return "office_action";
  if (/final rejection/.test(text)) return "office_action";
  if (/non.?final rejection/.test(text)) return "office_action";
  if (/office action/.test(text)) return "office_action";
  if (/examiner's answer/.test(text)) return "office_action";
  if (/rejection/.test(text)) return "office_action";

  // Responses (applicant-initiated replies)
  if (/response.*pre.?exam formalities/.test(text)) return "response";
  if (/election.*restriction.*filed|response to election/.test(text)) return "response";
  if (/amendment.*after.*non.?final|reconsideration.*after.*non.?final/.test(text)) return "response";
  if (/response after final|after final consideration/.test(text)) return "response";
  if (/amendment.*after.*notice of allowance/.test(text)) return "response";
  if (/applicant argument|applicant remark|remarks made in an amendment/.test(text)) return "response";

  // Requests (applicant-initiated procedural)
  if (/preliminary amendment/.test(text)) return "request";
  if (/letter requesting interview/.test(text)) return "request";
  if (/rce|continued examination/.test(text)) return "request";
  if (/request for continued examination/.test(text)) return "request";
  if (/request for/.test(text)) return "request";

  // Notifications (official notices)
  if (/abandonment/.test(text)) return "notification";
  if (/notice of publication/.test(text)) return "notification";
  if (/notice|notification/.test(text)) return "notification";

  // Misc documents
  if (/miscellaneous incoming letter/.test(text)) return "misc";
  if (/priority documents? electronically retrieved/.test(text)) return "misc";
  if (/transmittal of new application/.test(text)) return "misc";
  if (/sequence listing/.test(text)) return "misc";
  if (/certified copy/.test(text)) return "misc";
  if (/black and white line drawings?/.test(text)) return "misc";
  if (/information disclosure statement/.test(text)) return "misc";

  // General fallbacks (broadest patterns last)
  if (/response|amendment|reply|remand/.test(text)) return "response";
  if (/appeal/.test(text)) return "office_action";

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

  // Try descMap for translation (e.g., DE documents have no docCode)
  let translatedName = desc || code || typeName;
  if (officeMap.descMap && desc) {
    const descLower = desc.toLowerCase();
    // Try matching from longest key to shortest for best match
    const sortedKeys = Object.keys(officeMap.descMap).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      if (descLower.includes(key)) {
        translatedName = officeMap.descMap[key];
        break;
      }
    }
  }

  return { name: translatedName, type: type, stage: "审查中" };
}

function shouldIncludeInAIAnalysis(office, type) {
  const officeMap = PATENT_STATUS[office];
  if (!officeMap || !officeMap.aiAnalysisTypes) return type === "office_action" || type === "response";
  return officeMap.aiAnalysisTypes.indexOf(type) !== -1;
}
