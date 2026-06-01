#!/usr/bin/env python3
import sys
import json
import base64
import os

PADDLE_OCR_VL_URL = "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing"
PADDLE_OCR_VL_TOKEN = "70b270c8275606a7a97f8c4e8617cdeb935ed74c"
GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing"


def pdf_to_images_base64(pdf_path, max_pages=30, dpi=200):
    pages = []
    try:
        import fitz
        doc = fitz.open(pdf_path)
        total = min(len(doc), max_pages)
        print(f"[DEBUG] pdf_to_images_base64: pdf has {len(doc)} pages, extracting {total}", file=sys.stderr)
        for i in range(total):
            page = doc[i]
            mat = fitz.Matrix(dpi / 72, dpi / 72)
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            b64 = base64.b64encode(img_bytes).decode("ascii")
            pages.append(b64)
            print(f"[DEBUG] pdf_to_images_base64: page {i+1} b64 len={len(b64)}", file=sys.stderr)
        doc.close()
    except ImportError as e:
        print(f"[DEBUG] pdf_to_images_base64 ImportError: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[DEBUG] pdf_to_images_base64 error: {type(e).__name__}: {e}", file=sys.stderr)
        import traceback
        print(traceback.format_exc(), file=sys.stderr)
    return pages


def ocr_with_paddle_vl(image_base64_list):
    import requests as req

    all_markdown = []
    all_text = []

    for i, img_b64 in enumerate(image_base64_list):
        headers = {
            "Authorization": f"token {PADDLE_OCR_VL_TOKEN}",
            "Content-Type": "application/json",
        }
        payload = {
            "file": img_b64,
            "fileType": 1,
            "useDocOrientationClassify": True,
            "useDocUnwarping": False,
            "useLayoutDetection": True,
            "useChartRecognition": False,
            "layoutThreshold": 0.5,
            "prettifyMarkdown": True,
            "showFormulaNumber": False,
            "visualize": False,
        }
        try:
            print(f"[DEBUG] PaddleOCR-VL calling page {i+1}, img_b64 len={len(img_b64)}", file=sys.stderr)
            resp = req.post(PADDLE_OCR_VL_URL, json=payload, headers=headers, timeout=180)
            print(f"[DEBUG] PaddleOCR-VL response status={resp.status_code}", file=sys.stderr)
            if resp.status_code != 200:
                print(f"[DEBUG] PaddleOCR-VL response text={resp.text[:200]}", file=sys.stderr)
            data = resp.json()
            print(f"[DEBUG] PaddleOCR-VL response data keys={list(data.keys())} errorCode={data.get('errorCode')}", file=sys.stderr)
            if data.get("errorCode") == 0:
                results = data.get("result", {}).get("layoutParsingResults", [])
                print(f"[DEBUG] PaddleOCR-VL layoutParsingResults count={len(results)}", file=sys.stderr)
                for r in results:
                    md = r.get("markdown", {}).get("text", "")
                    if md:
                        all_markdown.append(md)
                    pruned = r.get("prunedResult", {})
                    parsing_list = pruned.get("parsing_res_list", [])
                    for block in parsing_list:
                        content = block.get("block_content", "")
                        label = block.get("block_label", "")
                        if content and label in ("text", "title", "table", "formula"):
                            all_text.append(content)
        except Exception as e:
            print(f"PaddleOCR-VL page {i+1} error: {type(e).__name__}: {e}", file=sys.stderr)
            import traceback
            print(traceback.format_exc(), file=sys.stderr)

    markdown = "\n\n---\n\n".join(all_markdown)
    plain_text = "\n".join(all_text)
    print(f"[DEBUG] PaddleOCR-VL total plain_text chars={len(plain_text)}", file=sys.stderr)
    return markdown, plain_text


def ocr_with_glm(image_base64_list, api_key):
    import requests as req

    all_markdown = []
    all_text = []

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    for i, img_b64 in enumerate(image_base64_list):
        file_data = f"data:image/png;base64,{img_b64}"
        payload = {
            "model": "glm-ocr",
            "file": file_data,
            "return_crop_images": False,
            "need_layout_visualization": False,
        }
        try:
            resp = req.post(GLM_OCR_URL, headers=headers, json=payload, timeout=180)
            data = resp.json()
            md = data.get("md_results", "")
            if md:
                all_markdown.append(md)
            layout_details = data.get("layout_details", [])
            for page_details in layout_details:
                for block in page_details:
                    content = block.get("content", "")
                    label = block.get("label", "")
                    if content and label in ("text", "title", "table", "formula"):
                        all_text.append(content)
        except Exception as e:
            print(f"GLM OCR page {i+1} error: {e}", file=sys.stderr)

    markdown = "\n\n---\n\n".join(all_markdown)
    plain_text = "\n".join(all_text)
    return markdown, plain_text


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

    print(f"[DEBUG] main: engine={engine} pdf_path={pdf_path}", file=sys.stderr)

    if engine == "paddle_ocr_vl":
        images = pdf_to_images_base64(pdf_path)
        print(f"[DEBUG] main: images extracted count={len(images)}", file=sys.stderr)
        if images:
            md, plain = ocr_with_paddle_vl(images)
            if plain.strip():
                text = plain
                markdown = md
                used_engine = "paddle_ocr_vl"

    if not text and engine == "glm_ocr" and api_key:
        images = pdf_to_images_base64(pdf_path)
        if images:
            md, plain = ocr_with_glm(images, api_key)
            if plain.strip():
                text = plain
                markdown = md
                used_engine = "glm_ocr"

    if not text and api_key:
        images = pdf_to_images_base64(pdf_path)
        if images:
            md, plain = ocr_with_glm(images, api_key)
            if plain.strip():
                text = plain
                markdown = md
                used_engine = "glm_ocr"

    result = {
        "text": text,
        "markdown": markdown,
        "engine": used_engine,
        "char_count": len(text),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
