#!/usr/bin/env python3
import sys


def extract_text(pdf_path):
    text = ""
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        for page in reader.pages:
            try:
                text += page.extract_text() or ""
            except Exception:
                pass
    except ImportError:
        try:
            from PyPDF2 import PdfReader
            reader = PdfReader(pdf_path)
            for page in reader.pages:
                try:
                    text += page.extract_text() or ""
                except Exception:
                    pass
        except ImportError:
            print("Error: No PDF library found. Install pypdf or PyPDF2.", file=sys.stderr)
    return text


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_pdf.py <pdf_file>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    text = extract_text(pdf_path)
    print(text, end="")


if __name__ == "__main__":
    main()
