"""打开 Superagent 面板：确认服务在跑，从最新日志取带 token 的地址，交给默认浏览器。

用法：python scripts/open-panel.py [--print]
"""
import glob
import os
import re
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = re.compile(r'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+')


def newest_token() -> str | None:
    """最新一份日志里的面板地址；服务重启会换 token，所以只认最新日志。"""
    logs = sorted(glob.glob(str(ROOT / '.artifacts' / '*.log')), key=os.path.getmtime, reverse=True)
    for log in logs:
        try:
            text = Path(log).read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        found = URL.search(text)
        if found:
            return found.group(0)
    return None


def main() -> int:
    status = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'dsh-superagent'), 'status'],
                            capture_output=True, text=True, encoding='utf-8', errors='replace')
    # 0 正常运行，2 有组件报错，3 等待 setup：三种都有面板可看。
    if status.returncode not in (0, 2, 3):
        print('服务没有在运行。先执行：')
        print(r'    python scripts\dsh-superagent start')
        return 1
    url = newest_token()
    if url is None:
        print('日志里没有面板地址，先启动一次服务。')
        return 1
    print(url)
    if '--print' not in sys.argv:
        webbrowser.open(url)
    return 0


if __name__ == '__main__':
    sys.exit(main())
