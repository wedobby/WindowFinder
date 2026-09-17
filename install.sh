#!/bin/zsh
# WindowFinder 설치 (Apple Silicon Mac 전용)
# 사용: curl -fsSL https://raw.githubusercontent.com/wedobby/WindowFinder/main/install.sh | zsh
set -e
BASE="https://raw.githubusercontent.com/wedobby/WindowFinder/main"

echo "최신 버전 확인 중…"
INFO=$(curl -fsSL "$BASE/latest.json")
VER=$(echo "$INFO" | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
ZIP_URL=$(echo "$INFO" | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['zip'])")

echo "v$VER 다운로드 중…"
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT
curl -fsSL -o "$TMP/app.zip" "$ZIP_URL"
ditto -x -k "$TMP/app.zip" "$TMP"

echo "/Applications에 설치 중…"
osascript -e 'tell application "WindowFinder" to quit' >/dev/null 2>&1 || true
pkill -f "WindowFinder-server" 2>/dev/null || true
rm -rf /Applications/WindowFinder.app
ditto "$TMP/WindowFinder.app" /Applications/WindowFinder.app
# 다운로드 격리 해제 (서명 없는 사내 앱이라 Gatekeeper가 막는 것 방지)
xattr -dr com.apple.quarantine /Applications/WindowFinder.app 2>/dev/null || true

# 사내 설치본의 Finder Sync 확장을 등록하고 즉시 활성화한다.
# macOS가 별도 승인을 요구하면 앱의 "Finder 메뉴 확장 설정…"에서 켤 수 있다.
FINDER_EXT_ID="com.wedobby.windowfinder.findersync"
FINDER_EXT="/Applications/WindowFinder.app/Contents/PlugIns/WindowFinderSync.appex"
/usr/bin/pluginkit -a "$FINDER_EXT" 2>/dev/null || true
/usr/bin/pluginkit -e use -i "$FINDER_EXT_ID" 2>/dev/null || true
echo "Finder 우클릭 메뉴 적용 중…"
/usr/bin/killall Finder 2>/dev/null || true

open /Applications/WindowFinder.app
echo "설치 완료: WindowFinder v$VER — 이후 업데이트는 앱이 자동으로 안내합니다."
