# 拖 PDF 到豆包输入框：模拟 DragDrop 需要真实 COM 拖拽，pyautogui 做不了
# 改用剪贴板法：点击输入框 → Ctrl+V 粘贴文件（Chromium 支持 CF_HDROP 粘贴文件）
import pyautogui, time
import win32gui, win32con, win32clipboard
import ctypes
import os, sys

PDF = r'C:\Users\Administrator\AppData\Roaming\Paper Reader\pdfs\2.pdf'  # Cache Engineering 论文

def set_clipboard_file(path):
    win32clipboard.OpenClipboard()
    win32clipboard.EmptyClipboard()
    # CF_HDROP
    files = (path + '\0').encode('utf-16-le') + b'\0\0'
    # DROPHEADER struct
    class DROPFILES(ctypes.Structure):
        _fields_ = [('pFiles', ctypes.c_uint32), ('pt', ctypes.c_long * 2), ('fNC', ctypes.c_int), ('fWide', ctypes.c_int)]
    df = DROPFILES()
    df.pFiles = ctypes.sizeof(DROPFILES)
    df.fWide = 1
    data = bytes(df) + files
    win32clipboard.SetClipboardData(15, data)  # CF_HDROP = 15
    win32clipboard.CloseClipboard()

def find_doubao():
    wins = []
    def cb(h, acc):
        if win32gui.GetWindowText(h) == '豆包':
            acc.append(h)
    win32gui.EnumWindows(cb, wins)
    return wins[0] if wins else None

h = find_doubao()
win32gui.ShowWindow(h, win32con.SW_RESTORE)
try:
    win32gui.SetForegroundWindow(h)
except Exception:
    pass
time.sleep(1)

if not os.path.exists(PDF):
    print('pdf not found:', PDF)
    sys.exit(1)

# 点击输入框中心（窗口 680,300 尺寸 1200x800，输入框约 y=960-1100 居中）
pyautogui.click(680 + 900, 300 + 1040)
time.sleep(0.8)
set_clipboard_file(PDF)
time.sleep(0.5)
pyautogui.hotkey('ctrl', 'v')
time.sleep(3)
pyautogui.screenshot().save(r'D:\paper-reader-app\build\db-step3-pasted.png')
print('pasted, shot saved')
