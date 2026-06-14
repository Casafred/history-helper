#!/usr/bin/env python3
"""
Merge multiple PDF files with cover pages into a single PDF.

Usage:
  python3 merge_pdf.py --output /path/to/output.pdf --items 'JSON'

Where --items is a JSON array of objects:
  [
    {
      "pdf_path": "/tmp/doc1.pdf",
      "original_title": "Non-Final Rejection",
      "chinese_title": "非最终驳回",
      "date": "2024-01-15",
      "doc_code": "CTNF"
    },
    ...
  ]

Each item gets a cover page with its titles, then the original PDF content.
"""

import sys
import json
import argparse
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from PyPDF2 import PdfReader, PdfWriter

# Register Chinese CID font
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))

PAGE_W, PAGE_H = A4  # 595.28 x 841.89 points

# Colors
COLOR_PRIMARY = HexColor('#2e3348')
COLOR_ACCENT = HexColor('#4a6fa5')
COLOR_TEXT = HexColor('#333333')
COLOR_LIGHT = HexColor('#888888')
COLOR_LINE = HexColor('#cccccc')


def create_cover_page(output_path, original_title, chinese_title, date, doc_code, index, total, logo_path=None):
    """Create a single cover page PDF."""
    c = canvas.Canvas(output_path, pagesize=A4)

    # Background accent bar at top
    c.setFillColor(COLOR_PRIMARY)
    c.rect(0, PAGE_H - 80, PAGE_W, 80, fill=1, stroke=0)

    # Logo in top-left of accent bar
    logo_drawn = False
    if logo_path and os.path.exists(logo_path):
        try:
            from reportlab.lib.utils import ImageReader
            logo_img = ImageReader(logo_path)
            iw, ih = logo_img.getSize()
            # Fit logo into 36x36 area within the top bar
            max_size = 36
            scale = min(max_size / iw, max_size / ih)
            lw, lh = iw * scale, ih * scale
            c.drawImage(logo_img, 40, PAGE_H - 58, width=lw, height=lh, mask='auto')
            logo_drawn = True
        except Exception:
            pass

    # Document index badge
    c.setFillColor(HexColor('#ffffff'))
    c.setFont('Helvetica-Bold', 14)
    badge_x = 84 if logo_drawn else 40
    c.drawString(badge_x, PAGE_H - 35, f"Document {index} / {total}")

    # Date in top bar
    if date:
        c.setFont('Helvetica', 12)
        c.drawRightString(PAGE_W - 40, PAGE_H - 35, date)

    # Decorative line
    c.setStrokeColor(COLOR_ACCENT)
    c.setLineWidth(3)
    c.line(40, PAGE_H - 90, PAGE_W - 40, PAGE_H - 90)

    # Header: "by PatentLens" in italic bold artistic style
    c.saveState()
    c.setFont('Helvetica-BoldOblique', 13)
    c.setFillColor(COLOR_ACCENT)
    c.drawRightString(PAGE_W - 40, PAGE_H - 108, "by PatentLens")
    c.restoreState()

    # Chinese title (large, prominent)
    y_pos = PAGE_H - 160
    if chinese_title:
        c.setFillColor(COLOR_PRIMARY)
        c.setFont('STSong-Light', 28)
        # Wrap long titles
        _draw_wrapped_text(c, chinese_title, 40, y_pos, PAGE_W - 80, 28, 'STSong-Light')
        y_pos -= 50

    # Original title
    if original_title:
        c.setFillColor(COLOR_ACCENT)
        c.setFont('Helvetica-Bold', 20)
        _draw_wrapped_text(c, original_title, 40, y_pos, PAGE_W - 80, 20, 'Helvetica-Bold')
        y_pos -= 40

    # Separator line
    c.setStrokeColor(COLOR_LINE)
    c.setLineWidth(1)
    c.line(40, y_pos + 10, PAGE_W - 40, y_pos + 10)

    # Document code
    if doc_code:
        y_pos -= 30
        c.setFillColor(COLOR_LIGHT)
        c.setFont('Helvetica', 14)
        c.drawString(40, y_pos, f"Code: {doc_code}")

    # Footer line
    c.setStrokeColor(COLOR_LINE)
    c.setLineWidth(0.5)
    c.line(40, 50, PAGE_W - 40, 50)

    # Footer text
    c.setFillColor(COLOR_LIGHT)
    c.setFont('Helvetica', 9)
    c.drawString(40, 35, "PatentLens - Merged Patent Examination Document")

    c.save()


def _draw_wrapped_text(c, text, x, y, max_width, font_size, font_name):
    """Draw text with word wrapping. Returns the Y position after the last line."""
    c.setFont(font_name, font_size)
    words = list(text) if 'STSong' in font_name else text.split()

    lines = []
    current_line = ""
    for word in words:
        test_line = current_line + word
        if c.stringWidth(test_line, font_name, font_size) > max_width:
            if current_line:
                lines.append(current_line)
            current_line = word
        else:
            current_line = test_line
    if current_line:
        lines.append(current_line)

    line_height = font_size * 1.4
    for line in lines:
        c.drawString(x, y, line)
        y -= line_height

    return y


def merge_pdfs(items, output_path, logo_path=None):
    """Merge multiple PDFs with cover pages into a single PDF."""
    writer = PdfWriter()
    total = len(items)

    for i, item in enumerate(items):
        pdf_path = item['pdf_path']
        original_title = item.get('original_title', '')
        chinese_title = item.get('chinese_title', '')
        date = item.get('date', '')
        doc_code = item.get('doc_code', '')

        # Create cover page
        cover_path = pdf_path + '.cover.pdf'
        create_cover_page(
            cover_path,
            original_title=original_title,
            chinese_title=chinese_title,
            date=date,
            doc_code=doc_code,
            index=i + 1,
            total=total,
            logo_path=logo_path
        )

        # Add cover page
        cover_reader = PdfReader(cover_path)
        for page in cover_reader.pages:
            writer.add_page(page)

        # Add original PDF pages
        if os.path.exists(pdf_path):
            try:
                pdf_reader = PdfReader(pdf_path)
                for page in pdf_reader.pages:
                    writer.add_page(page)
            except Exception as e:
                print(f"Warning: Failed to read PDF {pdf_path}: {e}", file=sys.stderr)
        else:
            print(f"Warning: PDF not found: {pdf_path}", file=sys.stderr)

        # Clean up cover page temp file
        try:
            os.unlink(cover_path)
        except:
            pass

    # Write merged PDF
    with open(output_path, 'wb') as f:
        writer.write(f)


def main():
    parser = argparse.ArgumentParser(description='Merge PDFs with cover pages')
    parser.add_argument('--output', required=True, help='Output PDF path')
    parser.add_argument('--items', required=False, help='JSON array of items (inline)')
    parser.add_argument('--items-file', required=False, help='Path to JSON file containing items array')
    parser.add_argument('--logo', required=False, help='Path to logo image for cover pages')
    args = parser.parse_args()

    if args.items_file:
        with open(args.items_file, 'r', encoding='utf-8') as f:
            items = json.load(f)
    elif args.items:
        items = json.loads(args.items)
    else:
        print("Error: Either --items or --items-file must be provided", file=sys.stderr)
        sys.exit(1)

    merge_pdfs(items, args.output, logo_path=args.logo)
    print(json.dumps({"success": True, "output": args.output, "count": len(items)}))


if __name__ == '__main__':
    main()
