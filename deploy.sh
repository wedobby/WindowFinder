#!/bin/zsh
# WindowFinder 배포: 빌드 → GitHub Release → latest.json 갱신
#
# 사용:
#   ./deploy.sh          # 패치 버전 자동 증가 (1.0.0 → 1.0.1) 후 배포
#   ./deploy.sh 1.2.0    # 지정 버전으로 배포
set -e
cd "$(dirname "$0")"

GITHUB_REPO="wedobby/WindowFinder"
UPDATE_BASE="https://raw.githubusercontent.com/$GITHUB_REPO/main"

# 버전 결정 (인자 없으면 패치 자동 증가)
if [ -n "$1" ]; then
  echo "$1" > VERSION
else
  OLD=$(cat VERSION)
  NEW=$(echo "$OLD" | awk -F. '{ printf "%d.%d.%d", $1, $2, $3 + 1 }')
  echo "$NEW" > VERSION
fi
VER=$(cat VERSION)

echo "== v$VER 빌드 =="
SKIP_DMG=1 ./build.sh >/dev/null
ZIP="TDFileExplorer-$VER.zip"
ditto -c -k --keepParent dist/TDFileExplorer.app "dist/$ZIP"

command -v gh >/dev/null || { echo "GitHub CLI(gh)가 필요합니다"; exit 1; }
gh auth status >/dev/null || { echo "gh auth login을 먼저 실행하세요"; exit 1; }

echo "== 소스 저장소 커밋 & 푸시 =="
git add latest.json VERSION
git commit -q -m "release v$VER" || true
git tag -f "v$VER" >/dev/null 2>&1
git push -q origin main "v$VER"

echo "== GitHub Release 업로드 =="
gh release create "v$VER" "dist/$ZIP" \
  --repo "$GITHUB_REPO" \
  --title "WindowFinder v$VER" \
  --notes "WindowFinder release v$VER"

LATEST_JSON="{ \"version\": \"$VER\", \"zip\": \"https://github.com/$GITHUB_REPO/releases/download/v$VER/$ZIP\" }"
echo "$LATEST_JSON" > latest.json
git add latest.json
git commit -q -m "publish update manifest v$VER" || true
git push -q origin main

echo ""
echo "배포 완료: v$VER → $GITHUB_REPO"
echo "설치된 앱들은 다음 실행 시(또는 4시간마다) 자동으로 업데이트를 안내합니다."
