#!/usr/bin/env python3
import sys
import json
import base64
import os

PADDLE_OCR_VL_URL = "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing"
PADDLE_OCR_VL_TOKEN = "70b270c8275606a7a97f8c4e8617cdeb935ed74c"
GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing"


def read_pdf_base64(pdf_path):
    with open(pdf_path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def ocr_with_paddle_vl(pdf_base64):
    import requests as req

    headers = {
        "Authorization": f"token {PADDLE_OCR_VL_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "file": pdf_base64,
        "fileType": 2,
        "useDocOrientationClassify": True,
        "useDocUnwarping": False,
        "useLayoutDetection": True,
        "useChartRecognition": False,
        "layoutThreshold": 0.5,
        "prettifyMarkdown": True,
        "showFormulaNumber": False,
        "visualize": False,
    }

    all_markdown = []
    all_text = []
    all_blocks = []
    page_dimensions = {}

    try:
        print(f"[DEBUG] PaddleOCR-VL calling with fileType=2 (PDF), b64 len={len(pdf_base64)}", file=sys.stderr)
        resp = req.post(PADDLE_OCR_VL_URL, json=payload, headers=headers, timeout=180)
        print(f"[DEBUG] PaddleOCR-VL response status={resp.status_code}", file=sys.stderr)
        if resp.status_code != 200:
            print(f"[DEBUG] PaddleOCR-VL error response: {resp.text[:300]}", file=sys.stderr)
            return "", "", [], {}
        data = resp.json()
        print(f"[DEBUG] PaddleOCR-VL errorCode={data.get('errorCode')} errorMsg={data.get('errorMsg', 'N/A')}", file=sys.stderr)
        if data.get("errorCode") == 0:
            results = data.get("result", {}).get("layoutParsingResults", [])
            print(f"[DEBUG] PaddleOCR-VL layoutParsingResults count={len(results)}", file=sys.stderr)
            for page_idx, r in enumerate(results):
                page_num = page_idx + 1
                md = r.get("markdown", {}).get("text", "")
                if md:
                    all_markdown.append(md)
                pruned = r.get("prunedResult", {})
                pw = pruned.get("width", 0)
                ph = pruned.get("height", 0)
                if pw and ph:
                    page_dimensions[page_num] = {"width": pw, "height": ph}
                parsing_list = pruned.get("parsing_res_list", [])
                for block in parsing_list:
                    content = block.get("block_content", "")
                    label = block.get("block_label", "")
                    bbox = block.get("block_bbox", None)
                    block_id_str = f"B_p{page_num}_{block.get('block_id', len(all_blocks))}"
                    all_blocks.append({
                        "block_id": block_id_str,
                        "page": page_num,
                        "label": label,
                        "content": content,
                        "bbox": bbox,
                        "order": block.get("block_order", 0),
                        "group_id": block.get("group_id", 0),
                    })
                    if content and label in ("text", "title", "table", "formula"):
                        all_text.append(content)
        else:
            print(f"[DEBUG] PaddleOCR-VL API error: {json.dumps(data, ensure_ascii=False)[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"PaddleOCR-VL error: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        print(traceback.format_exc(), file=sys.stderr)

    markdown = "\n\n---\n\n".join(all_markdown)
    plain_text = "\n".join(all_text)
    print(f"[DEBUG] PaddleOCR-VL result: markdown={len(markdown)} chars, text={len(plain_text)} chars, blocks={len(all_blocks)}", file=sys.stderr)
    return markdown, plain_text, all_blocks, page_dimensions


def ocr_with_glm(pdf_base64, api_key):
    import requests as req

    file_data = f"data:application/pdf;base64,{pdf_base64}"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "glm-ocr",
        "file": file_data,
        "return_crop_images": False,
        "need_layout_visualization": False,
    }

    all_markdown = []
    all_text = []
    all_blocks = []
    page_dimensions = {}

    try:
        print(f"[DEBUG] GLM OCR calling with PDF data URL, b64 len={len(pdf_base64)}", file=sys.stderr)
        resp = req.post(GLM_OCR_URL, headers=headers, json=payload, timeout=180)
        print(f"[DEBUG] GLM OCR response status={resp.status_code}", file=sys.stderr)
        if resp.status_code != 200:
            print(f"[DEBUG] GLM OCR error response: {resp.text[:300]}", file=sys.stderr)
            return "", "", [], {}
        data = resp.json()
        print(f"[DEBUG] GLM OCR response keys={list(data.keys())}", file=sys.stderr)
        md = data.get("md_results", "")
        if md:
            all_markdown.append(md)
        layout_details = data.get("layout_details", [])
        data_info = data.get("data_info", {})
        pages_info = data_info.get("pages", [])
        for page_idx, page_details in enumerate(layout_details):
            page_num = page_idx + 1
            if page_idx < len(pages_info):
                pi = pages_info[page_idx]
                pw = pi.get("width", 0)
                ph = pi.get("height", 0)
                if pw and ph:
                    page_dimensions[page_num] = {"width": pw, "height": ph}
            if isinstance(page_details, list):
                for block_idx, block in enumerate(page_details):
                    content = block.get("content", "")
                    label = block.get("label", "")
                    bbox_2d = block.get("bbox_2d", None)
                    block_id_str = f"B_p{page_num}_{block_idx}"
                    pw = page_dimensions.get(page_num, {}).get("width", 0)
                    ph = page_dimensions.get(page_num, {}).get("height", 0)
                    pixel_bbox = None
                    if bbox_2d and len(bbox_2d) == 4 and pw and ph:
                        x1 = int(bbox_2d[0] * pw)
                        y1 = int(bbox_2d[1] * ph)
                        x2 = int(bbox_2d[2] * pw)
                        y2 = int(bbox_2d[3] * ph)
                        pixel_bbox = [x1, y1, x2, y2]
                    all_blocks.append({
                        "block_id": block_id_str,
                        "page": page_num,
                        "label": label,
                        "content": content,
                        "bbox": pixel_bbox,
                        "order": block.get("index", block_idx),
                        "group_id": 0,
                    })
                    if content and label in ("text", "title", "table", "formula"):
                        all_text.append(content)
    except Exception as e:
        print(f"GLM OCR error: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        print(traceback.format_exc(), file=sys.stderr)

    markdown = "\n\n---\n\n".join(all_markdown)
    plain_text = "\n".join(all_text)
    print(f"[DEBUG] GLM OCR result: markdown={len(markdown)} chars, text={len(plain_text)} chars, blocks={len(all_blocks)}", file=sys.stderr)
    return markdown, plain_text, all_blocks, page_dimensions


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_pdf.py <pdf_file> [engine] [api_key]", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    engine = sys.argv[2] if len(sys.argv) > 2 else "paddle_ocr_vl"
    api_key = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.exists(pdf_path):
        result = {"text": "", "markdown": "", "engine": "none", "error": "PDF file not found"}
        print(json.dumps(result, ensure_ascii=False))
        return

    text = ""
    markdown = ""
    used_engine = "none"
    blocks = []
    page_dimensions = {}

    print(f"[DEBUG] main: engine={engine} pdf_path={pdf_path}", file=sys.stderr)

    pdf_base64 = read_pdf_base64(pdf_path)
    print(f"[DEBUG] main: PDF base64 length={len(pdf_base64)}", file=sys.stderr)

    if engine == "paddle_ocr_vl":
        md, plain, blks, pdims = ocr_with_paddle_vl(pdf_base64)
        if plain.strip():
            text = plain
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "paddle_ocr_vl"
        elif md.strip():
            text = md
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "paddle_ocr_vl"

    if not text and engine == "glm_ocr" and api_key:
        md, plain, blks, pdims = ocr_with_glm(pdf_base64, api_key)
        if plain.strip():
            text = plain
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "glm_ocr"
        elif md.strip():
            text = md
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "glm_ocr"

    if not text and api_key and engine != "glm_ocr":
        md, plain, blks, pdims = ocr_with_glm(pdf_base64, api_key)
        if plain.strip():
            text = plain
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "glm_ocr"
        elif md.strip():
            text = md
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "glm_ocr"

    if not text and not markdown and engine != "paddle_ocr_vl":
        md, plain, blks, pdims = ocr_with_paddle_vl(pdf_base64)
        if plain.strip():
            text = plain
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "paddle_ocr_vl"
        elif md.strip():
            text = md
            markdown = md
            blocks = blks
            page_dimensions = pdims
            used_engine = "paddle_ocr_vl"

    result = {
        "text": text,
        "markdown": markdown,
        "engine": used_engine,
        "char_count": len(text),
        "blocks": blocks,
        "page_dimensions": page_dimensions,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
