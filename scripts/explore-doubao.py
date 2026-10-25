# 豆包交互探索：点击新对话 → 输入框出现 → 输入测试文本 → 截图
import pyautogui
import win32gui, win32con
import time, sys

def find_doubao():
    wins = []
    def cb(h, acc):
        if win32gui.GetWindowText(h) == '豆包':
            acc.append(h)
    win32gui.EnumWindows(cb, wins)
    return wins[0] if wins else None

def shot(name):
    pyautogui.screenshot().save(rf'D:\paper-reader-app\build\{name}.png')
    print('shot', name)

h = find_doubao()
if not h:
    print('no window'); sys.exit(1)
win32gui.ShowWindow(h, win32con.SW_RESTORE)
try:
    win32gui.SetForegroundWindow(h)
except Exception:
    pass
time.sleep(1.0)
x0, y0, x1, y1 = win32gui.GetWindowRect(h)
wx, wy = x1 - x0, y1 - y0
print('rect:', x0, y0, wx, wy)

# 实拍 doubao-main.png 坐标系（1200x800 窗口）：
# 左栏「新对话」项：文字行 y=214-235，图标 x=20-60 → 点击 (60, 224)
# 若窗口已放大，比例换算
sx, sy = wx / 1200, wy / 800
click_x = x0 + int(60 * sx)
click_y = y0 + int(224 * sy)
print('click new-chat at', click_x, click_y)
pyautogui.click(click_x, click_y)
time.sleep(1.5)
shot('db-step2-newchat')
