import sqlite3, os
path = os.path.expandvars(r'%APPDATA%\Paper Reader\paper-reader.db')
print('db:', path, 'size:', os.path.getsize(path) if os.path.exists(path) else 'MISSING')
db = sqlite3.connect(path)
for r in db.execute("SELECT id, title, import_type, last_opened_at FROM papers ORDER BY last_opened_at DESC").fetchall():
    print(r[0], '|', str(r[1])[:55], '|', r[2], '|', r[3])
