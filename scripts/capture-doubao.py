# 用 PrintWindow 直接截豆包窗口位图（绕过遮挡/后台）
import win32gui, win32con
import ctypes
from ctypes import wintypes
import time, sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

def find_doubao():
    wins = []
    def cb(h, acc):
        t = win32gui.GetWindowText(h)
        if t == '豆包':
            acc.append(h)
    win32gui.EnumWindows(cb, wins)
    return wins[0] if wins else None

def print_window(h, path):
    x0, y0, x1, y1 = win32gui.GetWindowRect(h)
    w, hgt = x1 - x0, y1 - y0
    hdc = user32.GetWindowDC(h)
    memdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, hgt)
    gdi32.SelectObject(memdc, bmp)
    # PW_RENDERFULLCONTENT = 2 (对 DirectComposition/Chromium 窗口有效)
    user32.PrintWindow(h, memdc, 2)
    # BMP 落盘
    class BMIH(ctypes.Structure):
        _fields_ = [('biSize', wintypes.UINT), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                    ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                    ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                    ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]
    class BMI(ctypes.Structure):
        _fields_ = [('bmiHeader', BMIH), ('biColors', wintypes.UINT * 3)]
    bmi = BMI()
    bmi.bmiHeader.biSize = ctypes.sizeof(BMIH)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -hgt  # top-down
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(w * hgt * 4)
    gdi32.GetDIBits(memdc, bmp, 0, hgt, buf, ctypes.byref(bmi), 0)
    from PIL import Image
    img = Image.frombytes('RGBA', (w, hgt), buf.raw, 'raw', 'BGRA', 0, 1)
    img.convert('RGB').save(path)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(memdc); user32.ReleaseDC(h, hdc)
    return img.size

h = find_doubao()
if not h:
    print('not found'); sys.exit(1)
print('hwnd:', hex(h))
# 恢复并前置
win32gui.ShowWindow(h, win32con.SW_RESTORE)
try:
    win32gui.SetForegroundWindow(h)
except Exception:
    pass
time.sleep(1.2)
size = print_window(h, r'D:\paper-reader-app\build\db-print.png')
print('captured:', size)
