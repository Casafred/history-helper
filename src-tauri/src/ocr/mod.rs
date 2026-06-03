use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const PADDLE_OCR_VL_URL: &str =
    "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing";
const PADDLE_OCR_VL_TOKEN: &str = "70b270c8275606a7a97f8c4e8617cdeb935ed74c";
const GLM_OCR_URL: &str = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrBlock {
    pub block_id: String,
    pub page: u32,
    pub label: String,
    pub content: String,
    pub bbox: Option<Vec<f64>>,
    pub order: u32,
    pub group_id: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PageDimension {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrResult {
    pub text: String,
    pub markdown: String,
    pub engine: String,
    pub char_count: usize,
    pub blocks: Vec<OcrBlock>,
    pub page_dimensions: std::collections::HashMap<u32, PageDimension>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct OcrClient {
    client: Client,
}

impl OcrClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    pub async fn extract_with_paddle_vl(&self, pdf_base64: &str) -> OcrResult {
        let payload = serde_json::json!({
            "file": pdf_base64,
            "fileType": 2,
            "useDocOrientationClassify": true,
            "useDocUnwarping": false,
            "useLayoutDetection": true,
            "useChartRecognition": false,
            "layoutThreshold": 0.5,
            "prettifyMarkdown": true,
            "showFormulaNumber": false,
            "visualize": false,
        });

        let resp = match self
            .client
            .post(PADDLE_OCR_VL_URL)
            .header("Authorization", format!("token {}", PADDLE_OCR_VL_TOKEN))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                log::error!("PaddleOCR-VL request error: {}", e);
                return OcrResult {
                    text: String::new(),
                    markdown: String::new(),
                    engine: "none".to_string(),
                    char_count: 0,
                    blocks: vec![],
                    page_dimensions: std::collections::HashMap::new(),
                    error: Some(format!("PaddleOCR-VL request failed: {}", e)),
                };
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            log::error!("PaddleOCR-VL HTTP error {}: {}", status, &body[..body.len().min(300)]);
            return OcrResult {
                text: String::new(),
                markdown: String::new(),
                engine: "none".to_string(),
                char_count: 0,
                blocks: vec![],
                page_dimensions: std::collections::HashMap::new(),
                error: Some(format!("PaddleOCR-VL HTTP {}: {}", status, &body[..body.len().min(200)])),
            };
        }

        let data: serde_json::Value = match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                log::error!("PaddleOCR-VL JSON parse error: {}", e);
                return OcrResult {
                    text: String::new(),
                    markdown: String::new(),
                    engine: "none".to_string(),
                    char_count: 0,
                    blocks: vec![],
                    page_dimensions: std::collections::HashMap::new(),
                    error: Some(format!("PaddleOCR-VL JSON parse error: {}", e)),
                };
            }
        };

        let error_code = data.get("errorCode").and_then(|v| v.as_i64()).unwrap_or(-1);
        if error_code != 0 {
            let msg = data
                .get("errorMsg")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            log::error!("PaddleOCR-VL API error: {}", msg);
            return OcrResult {
                text: String::new(),
                markdown: String::new(),
                engine: "none".to_string(),
                char_count: 0,
                blocks: vec![],
                page_dimensions: std::collections::HashMap::new(),
                error: Some(format!("PaddleOCR-VL API error: {}", msg)),
            };
        }

        let results = data
            .get("result")
            .and_then(|r| r.get("layoutParsingResults"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut all_markdown = Vec::new();
        let mut all_text = Vec::new();
        let mut all_blocks = Vec::new();
        let mut page_dimensions = std::collections::HashMap::new();

        for (page_idx, page_result) in results.iter().enumerate() {
            let page_num = (page_idx + 1) as u32;

            if let Some(md_text) = page_result
                .get("markdown")
                .and_then(|m| m.get("text"))
                .and_then(|t| t.as_str())
            {
                if !md_text.is_empty() {
                    all_markdown.push(md_text.to_string());
                }
            }

            let pruned = page_result.get("prunedResult").cloned().unwrap_or_default();
            let pw = pruned.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let ph = pruned.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if pw > 0 && ph > 0 {
                page_dimensions.insert(page_num, PageDimension { width: pw, height: ph });
            }

            let parsing_list = pruned
                .get("parsing_res_list")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            for block in &parsing_list {
                let content = block
                    .get("block_content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let label = block
                    .get("block_label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let bbox = block
                    .get("block_bbox")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<f64>>());
                let block_order = block
                    .get("block_order")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let group_id = block
                    .get("group_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let block_id_num = block
                    .get("block_id")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(all_blocks.len() as u64);

                let block_id = format!("B_p{}_{}", page_num, block_id_num);

                let is_text_label = ["text", "title", "table", "formula"].contains(&label.as_str());
                all_blocks.push(OcrBlock {
                    block_id,
                    page: page_num,
                    label,
                    content: content.clone(),
                    bbox,
                    order: block_order,
                    group_id,
                });

                if !content.is_empty() && is_text_label
                {
                    all_text.push(content);
                }
            }
        }

        let markdown = all_markdown.join("\n\n---\n\n");
        let text = all_text.join("\n");
        let char_count = text.len();

        log::info!(
            "PaddleOCR-VL result: markdown={} chars, text={} chars, blocks={}",
            markdown.len(),
            text.len(),
            all_blocks.len()
        );

        OcrResult {
            text,
            markdown,
            engine: "paddle_ocr_vl".to_string(),
            char_count,
            blocks: all_blocks,
            page_dimensions,
            error: None,
        }
    }

    pub async fn extract_with_glm(&self, pdf_base64: &str, api_key: &str) -> OcrResult {
        let file_data = format!("data:application/pdf;base64,{}", pdf_base64);

        let payload = serde_json::json!({
            "model": "glm-ocr",
            "file": file_data,
            "return_crop_images": false,
            "need_layout_visualization": false,
        });

        let resp = match self
            .client
            .post(GLM_OCR_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                log::error!("GLM OCR request error: {}", e);
                return OcrResult {
                    text: String::new(),
                    markdown: String::new(),
                    engine: "none".to_string(),
                    char_count: 0,
                    blocks: vec![],
                    page_dimensions: std::collections::HashMap::new(),
                    error: Some(format!("GLM OCR request failed: {}", e)),
                };
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            log::error!("GLM OCR HTTP error {}: {}", status, &body[..body.len().min(300)]);
            return OcrResult {
                text: String::new(),
                markdown: String::new(),
                engine: "none".to_string(),
                char_count: 0,
                blocks: vec![],
                page_dimensions: std::collections::HashMap::new(),
                error: Some(format!("GLM OCR HTTP {}: {}", status, &body[..body.len().min(200)])),
            };
        }

        let data: serde_json::Value = match resp.json().await {
            Ok(d) => d,
            Err(e) => {
                log::error!("GLM OCR JSON parse error: {}", e);
                return OcrResult {
                    text: String::new(),
                    markdown: String::new(),
                    engine: "none".to_string(),
                    char_count: 0,
                    blocks: vec![],
                    page_dimensions: std::collections::HashMap::new(),
                    error: Some(format!("GLM OCR JSON parse error: {}", e)),
                };
            }
        };

        let mut all_markdown = Vec::new();
        let mut all_text = Vec::new();
        let mut all_blocks = Vec::new();
        let mut page_dimensions = std::collections::HashMap::new();

        if let Some(md) = data.get("md_results").and_then(|v| v.as_str()) {
            if !md.is_empty() {
                all_markdown.push(md.to_string());
            }
        }

        let pages_info = data
            .get("data_info")
            .and_then(|d| d.get("pages"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let layout_details = data
            .get("layout_details")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for (page_idx, page_details) in layout_details.iter().enumerate() {
            let page_num = (page_idx + 1) as u32;

            if page_idx < pages_info.len() {
                let pi = &pages_info[page_idx];
                let pw = pi.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let ph = pi.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if pw > 0 && ph > 0 {
                    page_dimensions.insert(page_num, PageDimension { width: pw, height: ph });
                }
            }

            if let Some(blocks_arr) = page_details.as_array() {
                for (block_idx, block) in blocks_arr.iter().enumerate() {
                    let content = block
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let label = block
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let bbox_2d = block
                        .get("bbox_2d")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_f64()).collect::<Vec<f64>>());

                    let pixel_bbox = if let Some(ref bbox) = bbox_2d {
                        if bbox.len() == 4 {
                            if let Some(dim) = page_dimensions.get(&page_num) {
                                Some(vec![
                                    (bbox[0] * dim.width as f64) as f64,
                                    (bbox[1] * dim.height as f64) as f64,
                                    (bbox[2] * dim.width as f64) as f64,
                                    (bbox[3] * dim.height as f64) as f64,
                                ])
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    let block_order = block
                        .get("index")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(block_idx as u64) as u32;

                    let block_id = format!("B_p{}_{}", page_num, block_idx);

                    let is_text_label = ["text", "title", "table", "formula"].contains(&label.as_str());
                    all_blocks.push(OcrBlock {
                        block_id,
                        page: page_num,
                        label,
                        content: content.clone(),
                        bbox: pixel_bbox,
                        order: block_order,
                        group_id: 0,
                    });

                    if !content.is_empty() && is_text_label
                    {
                        all_text.push(content);
                    }
                }
            }
        }

        let markdown = all_markdown.join("\n\n---\n\n");
        let text = all_text.join("\n");
        let char_count = text.len();

        log::info!(
            "GLM OCR result: markdown={} chars, text={} chars, blocks={}",
            markdown.len(),
            text.len(),
            all_blocks.len()
        );

        OcrResult {
            text,
            markdown,
            engine: "glm_ocr".to_string(),
            char_count,
            blocks: all_blocks,
            page_dimensions,
            error: None,
        }
    }

    pub async fn extract(
        &self,
        pdf_base64: &str,
        engine: &str,
        api_key: &str,
    ) -> OcrResult {
        let mut result = OcrResult {
            text: String::new(),
            markdown: String::new(),
            engine: "none".to_string(),
            char_count: 0,
            blocks: vec![],
            page_dimensions: std::collections::HashMap::new(),
            error: None,
        };

        if engine == "paddle_ocr_vl" || engine == "auto" {
            let paddle_result = self.extract_with_paddle_vl(pdf_base64).await;
            if !paddle_result.text.is_empty() || !paddle_result.markdown.is_empty() {
                return paddle_result;
            }
            if paddle_result.error.is_some() && engine == "paddle_ocr_vl" {
                return paddle_result;
            }
            log::warn!("PaddleOCR-VL returned empty, trying fallback...");
        }

        if (engine == "glm_ocr" || !api_key.is_empty()) && result.text.is_empty() {
            let glm_result = self.extract_with_glm(pdf_base64, api_key).await;
            if !glm_result.text.is_empty() || !glm_result.markdown.is_empty() {
                return glm_result;
            }
            if glm_result.error.is_some() && engine == "glm_ocr" {
                return glm_result;
            }
        }

        if engine != "paddle_ocr_vl" && result.text.is_empty() && result.markdown.is_empty() {
            let paddle_result = self.extract_with_paddle_vl(pdf_base64).await;
            if !paddle_result.text.is_empty() || !paddle_result.markdown.is_empty() {
                return paddle_result;
            }
        }

        result.error = Some("所有 OCR 引擎均未能提取文本".to_string());
        result
    }
}

impl Default for OcrClient {
    fn default() -> Self {
        Self::new()
    }
}
