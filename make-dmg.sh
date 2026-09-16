#!/bin/zsh
# dist/TDFileExplorer.app → dist/TDFileExplorer.dmg
# (build.sh를 이미 실행해 앱이 만들어져 있어야 합니다)
set -e
cd "$(dirname "$0")"
APP="dist/TDFileExplorer.app"
[ -d "$APP" ] || { echo "먼저 ./build.sh 를 실행하세요"; exit 1; }
ROOT="dist/dmgroot"
rm -rf "$ROOT" dist/TDFileExplorer.dmg
mkdir -p "$ROOT"
cp -R "$APP" "$ROOT/"
ln -s /Applications "$ROOT/Applications"
hdiutil create -volname TDFileExplorer -srcfolder "$ROOT" -ov -format UDZO dist/TDFileExplorer.dmg
rm -rf "$ROOT"
echo "완료: dist/TDFileExplorer.dmg"
