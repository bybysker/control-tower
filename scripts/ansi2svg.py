#!/usr/bin/env python3
"""Turn a captured Ink frame (raw pty bytes) into a crisp SVG for the README.

    ./dist/cli.js --once  (under `script`, see CONTRIBUTING) > frame.raw
    python3 scripts/ansi2svg.py frame.raw docs/assets/dashboard.svg

Takes the LAST frame Ink painted, maps SGR colours to fills, draws selection
backgrounds as rects, and lays text on a fixed character grid. No fonts are
embedded: GitHub renders it with the viewer's monospace font.
"""
import re, sys, html

CLEAR = '\x1b[2J\x1b[3J\x1b[H'
ANSI16 = {30:'#1B1F26',31:'#E86B70',32:'#9BB05C',33:'#E0B341',34:'#5FA8D3',35:'#C98BDA',36:'#4FC1D9',37:'#E9EDF3',
          90:'#727E8C',91:'#FF7B7B',92:'#B5D46F',93:'#F0C95C',94:'#7CC2E8',95:'#DDA9EA',96:'#7FD8EA',97:'#FFFFFF'}
FG, BG = '#DCE2EA', '#0C0F13'
CW, LH, FS, PAD = 7.8, 19, 13, 18   # char width, line height, font size, padding (px)

def xterm256(n: int) -> str:
    """The 256-colour palette chalk falls back to for hex colours it cannot emit as truecolor."""
    if n < 16:
        return ANSI16[30 + n] if n < 8 else ANSI16[90 + n - 8]
    if n >= 232:
        g = 8 + (n - 232) * 10
        return '#%02X%02X%02X' % (g, g, g)
    n -= 16
    lv = [0, 95, 135, 175, 215, 255]
    return '#%02X%02X%02X' % (lv[n // 36], lv[(n % 36) // 6], lv[n % 6])

def last_frame(raw: str) -> str:
    i = raw.rfind(CLEAR); fr = raw[i+len(CLEAR):] if i >= 0 else raw
    j = fr.rfind('\x1b[G'); fr = fr[j+3:] if j >= 0 else fr
    fr = re.sub(r'(\x1b\[\?25[hl])+\s*$', '', fr).replace('\r', '')
    return fr.strip('\n')

def segments(line: str):
    """Yield (text, fg, bg, bold, dim) runs for one line."""
    fg, bg, bold, dim = None, None, False, False
    pos = 0
    for m in re.finditer(r'\x1b\[([0-9;]*)m', line):
        if m.start() > pos: yield line[pos:m.start()], fg, bg, bold, dim
        pos = m.end()
        codes = [int(c) if c else 0 for c in (m.group(1) or '0').split(';')]
        k = 0
        while k < len(codes):
            c = codes[k]
            if c == 0: fg, bg, bold, dim = None, None, False, False
            elif c == 1: bold = True
            elif c == 2: dim = True
            elif c == 22: bold = dim = False
            elif c == 39: fg = None
            elif c == 49: bg = None
            elif c in (38, 48) and codes[k+1:k+2] == [2] and len(codes) >= k+5:
                col = '#%02X%02X%02X' % tuple(codes[k+2:k+5])
                if c == 38: fg = col
                else: bg = col
                k += 4
            elif c in (38, 48) and codes[k+1:k+2] == [5] and len(codes) >= k+3:
                col = xterm256(codes[k+2])          # e.g. 48;5;188 = the selection background
                if c == 38: fg = col
                else: bg = col
                k += 2
            elif c in ANSI16: fg = ANSI16[c]
            elif c - 10 in ANSI16: bg = ANSI16[c - 10]
            k += 1
    if pos < len(line): yield line[pos:], fg, bg, bold, dim

def main(src, dst):
    raw = open(src, encoding='utf-8', errors='replace').read()
    lines = last_frame(raw).split('\n')
    cols = max(len(re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', l)) for l in lines)
    W, H = int(cols*CW + 2*PAD), int(len(lines)*LH + 2*PAD)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, &quot;Liberation Mono&quot;, monospace" font-size="{FS}">',
           f'<rect width="{W}" height="{H}" rx="10" fill="{BG}"/>']
    texts = []
    for i, line in enumerate(lines):
        y = PAD + LH*(i+1) - 5; x = PAD; col = 0
        spans = []
        for text, fg, bgc, bold, dim in segments(line):
            n = len(text)
            if bgc and text:
                out.append(f'<rect x="{PAD+col*CW:.1f}" y="{y-FS+2:.1f}" width="{n*CW:.1f}" height="{LH}" fill="{bgc}"/>')
            attrs = f' fill="{fg or FG}"'
            if bold: attrs += ' font-weight="600"'
            if dim: attrs += ' opacity="0.55"'
            spans.append(f'<tspan x="{PAD+col*CW:.1f}"{attrs}>{html.escape(text)}</tspan>')
            col += n
        texts.append(f'<text y="{y}" xml:space="preserve">{"".join(spans)}</text>')
    out += texts + ['</svg>']
    open(dst, 'w', encoding='utf-8').write('\n'.join(out))
    print(f'{dst}: {cols} cols × {len(lines)} rows → {W}×{H}px')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
