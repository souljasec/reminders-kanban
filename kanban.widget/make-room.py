#!/usr/bin/python3 -I
"""Move desktop icons out from under the Kanban widget, like Apple's own widgets do.

usage: make-room.py X Y W H   (widget rect in screen points, origin top-left)
Each covered icon goes to the nearest free grid slot that is clear of the
widget and of every other icon.
"""
import subprocess
import sys

CELL_W, CELL_H = 122, 112     # Finder desktop grid at icon size 64 / spacing 54
HALF_W = 52                    # icon + label footprint around its centre point
TOP, BOTTOM = 40, 62
MARGIN = 12                    # gap kept between widget and icons


def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()


def foot(cx, cy):
    return (cx - HALF_W, cy - TOP, cx + HALF_W, cy + BOTTOM)


def hit(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def main():
    x, y, w, h = (float(v) for v in sys.argv[1:5])
    widget = (x - MARGIN, y - MARGIN, x + w + MARGIN, y + h + MARGIN)

    raw = osa('''tell application "Finder"
      set ps to desktop position of every item of desktop
      set out to ""
      repeat with p in ps
        set out to out & (item 1 of p) & "," & (item 2 of p) & linefeed
      end repeat
      set b to bounds of window of desktop
      return out & "S" & (item 3 of b) & "," & (item 4 of b)
    end tell''')
    if not raw:
        return
    lines = raw.splitlines()
    sw, sh = (int(v) for v in lines[-1][1:].split(","))
    icons = [tuple(int(v) for v in ln.split(",")) for ln in lines[:-1] if ln]

    # candidate slots: Finder-style grid anchored top-right
    slots = [(sw - 65 - CELL_W * i, 65 + CELL_H * j)
             for i in range(sw // CELL_W) for j in range((sh - 30) // CELL_H)]
    slots = [s for s in slots if s[0] - HALF_W >= 0 and s[1] + BOTTOM <= sh]

    placed = list(icons)
    moves = []
    for idx, (cx, cy) in enumerate(icons):
        if not hit(foot(cx, cy), widget):
            continue
        others = [foot(*p) for k, p in enumerate(placed) if k != idx]
        free = [s for s in slots
                if not hit(foot(*s), widget) and not any(hit(foot(*s), o) for o in others)]
        if not free:
            continue
        best = min(free, key=lambda s: (s[0] - cx) ** 2 + (s[1] - cy) ** 2)
        placed[idx] = best
        moves.append((idx + 1, best))

    if moves:
        body = "\n".join(
            f"set desktop position of item {i} of desktop to {{{px}, {py}}}" for i, (px, py) in moves)
        osa(f'tell application "Finder"\n{body}\nend tell')
    print(f"moved {len(moves)}")


if __name__ == "__main__":
    main()
