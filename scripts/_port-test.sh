#!/bin/zsh
set -u
CLI=/Users/bug/Documents/Projects/contactsheet/dist/cli.js
FX=/Users/bug/Documents/Projects/contactsheet/spike/fixture-app
cd "$FX"
CFG=contactsheet.config.json
cp $CFG $CFG.orig

echo "== 场景1:config 端口(5301)被普通进程占 → 顺延 =="
node -e 'require("http").createServer().listen(5301)' & DUMMY=$!
sleep 0.5
python3 -c "import json;d=json.load(open('$CFG'));d['port']=5301;json.dump(d,open('$CFG','w'))"
node "$CLI" > /tmp/pt1.log 2>&1 & CS1=$!
sleep 2.5
grep -o "顺延到 [0-9]*" /tmp/pt1.log || echo "❌ 没顺延"
curl -s -m 2 -o /dev/null -w "顺延端口可用: %{http_code}\n" http://localhost:5302/__cs
kill $CS1 2>/dev/null; wait $CS1 2>/dev/null

echo "== 场景2:显式 --port 撞占用 → 报错退出 =="
node "$CLI" --port 5301 > /tmp/pt2.log 2>&1
echo "exit=$? $(grep -o '被其他进程占用' /tmp/pt2.log || echo '❌ 没报错')"
kill $DUMMY 2>/dev/null

echo "== 场景3:同项目已在跑 → 提示直接用,退出 0 =="
node "$CLI" --port 5301 > /tmp/pt3a.log 2>&1 & CS2=$!
sleep 2
python3 -c "import json;d=json.load(open('$CFG'));d['port']=5301;json.dump(d,open('$CFG','w'))"
node "$CLI" > /tmp/pt3.log 2>&1
echo "exit=$? $(grep -o '已经有一个 contactsheet 在跑' /tmp/pt3.log || echo '❌ 没识别')"
kill $CS2 2>/dev/null; wait $CS2 2>/dev/null

mv $CFG.orig $CFG
echo "== 场景4:init 认 dev script 端口 =="
TMP=$(mktemp -d)
mkdir -p "$TMP/app"
echo '{"name":"t","scripts":{"dev":"next dev -p 3100"},"dependencies":{"next":"16.0.0"}}' > "$TMP/package.json"
(cd "$TMP" && node "$CLI" init 2>&1 | grep -o "target http://localhost:[0-9]*")
rm -rf "$TMP"
