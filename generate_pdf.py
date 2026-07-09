#!/usr/bin/env python3
import os
from weasyprint import HTML, CSS

workspace = '/workspace'
html_file = os.path.join(workspace, 'user-manual-v0.6.html')
pdf_file = os.path.join(workspace, 'PatentLens-用户使用说明书-V0.6.0.pdf')
font_file = os.path.join(workspace, 'fonts', 'NotoSansSC-Regular.ttf')

css_string = '''
@font-face {
    font-family: "NotoSansSC";
    src: url("file://''' + font_file + '''") format("truetype");
    font-weight: normal;
    font-style: normal;
}
body {
    font-family: "NotoSansSC", "Noto Sans CJK SC", "WenQuanYi Zen Hei", "Microsoft YaHei", sans-serif !important;
}
'''

print(f"Generating PDF from {html_file}...")
HTML(filename=html_file, base_url=workspace).write_pdf(
    pdf_file,
    stylesheets=[CSS(string=css_string)],
    presentational_hints=True
)
print(f"PDF generated: {pdf_file}")
print(f"File size: {os.path.getsize(pdf_file) / 1024 / 1024:.2f} MB")
