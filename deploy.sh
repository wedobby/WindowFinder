#!/bin/zsh
# WindowFinder 배포: 버전 커밋 → 빌드 → GitHub Release → latest.json 갱신
#
# 사용:
#   ./deploy.sh          # 패치 버전 자동 증가 (1.0.0 → 1.0.1) 후 배포
#   ./deploy.sh 1.2.0    # 지정 버전으로 배포
set -e
cd "$(dirname "$0")"

GITHUB_REPO="wedobby/WindowFinder"

die() { echo "배포 중단: $*" >&2; exit 1; }
require_clean_tree() {
  local repo_changes
  repo_changes=$(git status --porcelain)
  [ -z "$repo_changes" ] || die "소스 변경을 모두 커밋한 깨끗한 작업 트리에서 실행하세요."
}
valid_version() { [[ "$1" =~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ]]; }

# 모든 사전 검사는 VERSION이나 Git 이력을 바꾸기 전에 수행한다.
[ "$#" -le 1 ] || die "사용법: ./deploy.sh [major.minor.patch]"
for tool in git gh node npx swiftc clang codesign ditto curl tar; do
  command -v "$tool" >/dev/null || die "필요한 도구가 없습니다: $tool"
done
[ -x ./build.sh ] || die "실행 가능한 build.sh가 필요합니다."
[ "$(git symbolic-ref --quiet --short HEAD)" = main ] || die "main 브랜치에서 실행하세요."
require_clean_tree
OLD=$(cat VERSION)
valid_version "$OLD" || die "현재 VERSION이 올바르지 않습니다: $OLD"
if [ "$#" -eq 1 ]; then
  VER="$1"
else
  VER=$(node -e 'const v = process.argv[1].split("."); v[2] = String(BigInt(v[2]) + 1n); console.log(v.join("."));' "$OLD")
fi
valid_version "$VER" || die "버전은 major.minor.patch 형식이어야 합니다: $VER"
node -e '
  const old = process.argv[1].split(".").map(BigInt), next = process.argv[2].split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (next[i] !== old[i]) process.exit(next[i] > old[i] ? 0 : 1);
  process.exit(1);
' "$OLD" "$VER" || die "새 버전은 현재 v$OLD 보다 커야 합니다."
TAG="v$VER"
git show-ref --verify --quiet "refs/tags/$TAG" && die "이미 존재하는 로컬 태그입니다: $TAG"
gh auth status >/dev/null || die "gh auth login을 먼저 실행하세요."
REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")
[ -z "$REMOTE_TAG" ] || die "이미 존재하는 원격 태그입니다: $TAG"

echo "== v$VER 소스 확정 =="
echo "$VER" > VERSION
git add -- VERSION
git commit -q -m "release v$VER"
RELEASE_COMMIT=$(git rev-parse HEAD)

echo "== v$VER 빌드 =="
SKIP_DMG=1 ./build.sh
ZIP="WindowFinder-$VER.zip"
ditto -c -k --keepParent dist/WindowFinder.app "dist/$ZIP"

# 빌드 도중 편집/커밋이 있었다면 다른 소스의 ZIP을 태그와 함께 게시하지 않는다.
require_clean_tree
[ "$(git rev-parse HEAD)" = "$RELEASE_COMMIT" ] || die "빌드 도중 커밋이 변경되었습니다."
echo "== 확정 커밋 $RELEASE_COMMIT 태그 & 푸시 =="
git tag "$TAG" "$RELEASE_COMMIT"
git push -q --atomic origin "${RELEASE_COMMIT}:refs/heads/main" "refs/tags/$TAG"

echo "== GitHub Release 업로드 =="
gh release create "$TAG" "dist/$ZIP" \
  --repo "$GITHUB_REPO" \
  --verify-tag \
  --title "WindowFinder v$VER" \
  --notes "WindowFinder release v$VER"

# ZIP 업로드까지 성공한 릴리스만 자동 업데이트 채널에 공개한다.
LATEST_JSON="{ \"version\": \"$VER\", \"zip\": \"https://github.com/$GITHUB_REPO/releases/download/v$VER/$ZIP\" }"
echo "$LATEST_JSON" > latest.json
git add -- latest.json
git commit -q -m "publish update manifest v$VER"
git push -q origin main

echo ""
echo "배포 완료: v$VER → $GITHUB_REPO"
echo "설치된 앱들은 다음 실행 시(또는 4시간마다) 자동 업데이트를 확인합니다."
