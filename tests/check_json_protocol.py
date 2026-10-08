import json

path = r"C:\Users\SQY\AppData\Local\Temp\jout.txt"
raw = open(path, 'rb').read()
print("  原始字节数:", len(raw))

text = None
for enc in ('gbk', 'utf-8', 'utf-8-sig', 'latin-1'):
    try:
        text = raw.decode(enc)
        print("  解码方式:", enc)
        break
    except Exception:
        continue

if text is None:
    print("  ❌ 无法解码")
    raise SystemExit(1)

ok = bad = 0
for i, line in enumerate(text.splitlines(), 1):
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
        ok += 1
        if ok == 1:
            print("  首个 JSON 对象字段:", sorted(obj.keys()))
            print("    img =", obj.get("img"))
            if "pic" in obj:
                print("    pic =", obj.get("pic"))
            print("    timing =", obj.get("timing"))
    except Exception as e:
        bad += 1
        print("  ❌ 第%d行非法 JSON: %s" % (i, e))
        print("     ", line[:160])

print()
print("  合法 JSON 行: %d" % ok)
print("  非法 JSON 行: %d" % bad)
print("  结论:", "✅ 全部合法" if bad == 0 else "❌ 存在非法行")
