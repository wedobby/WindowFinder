#!/bin/zsh
# Build WindowFinder: single executable (Node SEA) → .app bundle → .dmg
set -e
cd "$(dirname "$0")"

APP_NAME="WindowFinder"
FINDER_EXT_NAME="WindowFinderSync"
FINDER_EXT_ID="com.wedobby.windowfinder.findersync"
DIST="dist"
APP="$DIST/$APP_NAME.app"
APPEX="$APP/Contents/PlugIns/$FINDER_EXT_NAME.appex"
PORT_DEFAULT=8890
VERSION=$(cat VERSION 2>/dev/null || echo "1.0.0")
# Public update feed for the WindowFinder project. A local update-url.txt can
# override this for an internal mirror without being committed.
UPDATE_URL=$(cat update-url.txt 2>/dev/null || echo "https://raw.githubusercontent.com/wedobby/WindowFinder/main")

echo "[1/4] SEA blob 생성"
rm -rf "$DIST" sea-prep.blob
mkdir -p "$DIST"
node --experimental-sea-config sea-config.json

echo "[2/4] 단일 실행파일 생성 (node 바이너리에 주입)"
# Homebrew node는 SEA sentinel이 스트립되어 있어 공식 배포판 바이너리를 사용한다 (1회 다운로드 후 캐시)
NODE_VER="$(node -p 'process.version')"
ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64" || ARCH="arm64"
CACHE="$HOME/.cache/windowfinder"
NODE_BIN="$CACHE/node-$NODE_VER-$ARCH"
if [ ! -f "$NODE_BIN" ]; then
  echo "  공식 node $NODE_VER 다운로드 중…"
  mkdir -p "$CACHE"
  TARBALL="node-$NODE_VER-darwin-$ARCH"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/$TARBALL.tar.gz" | tar -xz -C "$CACHE" "$TARBALL/bin/node"
  mv "$CACHE/$TARBALL/bin/node" "$NODE_BIN"
  rm -rf "$CACHE/$TARBALL"
fi
cp "$NODE_BIN" "$DIST/$APP_NAME"
chmod +w "$DIST/$APP_NAME"
codesign --remove-signature "$DIST/$APP_NAME" 2>/dev/null || true
npx -y postject "$DIST/$APP_NAME" NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign --force --sign - "$DIST/$APP_NAME"
rm -f sea-prep.blob

echo "[3/4] .app 번들 구성 (네이티브 WKWebView 셸 + Finder 확장 컴파일)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" \
  "$APPEX/Contents/MacOS"
# 앱 실행 파일 = Swift 네이티브 셸 (자체 창, Chrome 불필요)
swiftc -O -target arm64-apple-macos12.0 -o "$APP/Contents/MacOS/$APP_NAME" native/main.swift
# 서버(단일 실행파일)는 리소스로 내장, 셸이 자동 실행
mv "$DIST/$APP_NAME" "$APP/Contents/Resources/${APP_NAME}-server"
cp assets/icon.icns "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.wedobby.windowfinder</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  $( [ -n "$UPDATE_URL" ] && echo "<key>WindowFinderUpdateURL</key><string>$UPDATE_URL</string>" )
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Folder</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
  </dict></array>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>WindowFinder URL</string>
    <key>CFBundleURLSchemes</key><array><string>windowfinder</string></array>
  </dict></array>
</dict></plist>
PLIST

# Finder 우클릭 메뉴 확장. Xcode 프로젝트 없이도 배포 빌드가 가능하도록
# App Extension 엔트리 포인트를 Objective-C로 직접 컴파일한다.
clang -O2 -fobjc-arc -fblocks -fapplication-extension \
  -arch arm64 -mmacosx-version-min=12.0 \
  -framework Cocoa -framework FinderSync \
  -o "$APPEX/Contents/MacOS/$FINDER_EXT_NAME" native/WindowFinderSync.m

cat > "$APPEX/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$FINDER_EXT_NAME</string>
  <key>CFBundleDisplayName</key><string>WindowFinder Finder 확장</string>
  <key>CFBundleIdentifier</key><string>$FINDER_EXT_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>$FINDER_EXT_NAME</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSExtension</key><dict>
    <key>NSExtensionAttributes</key><dict/>
    <key>NSExtensionPointIdentifier</key><string>com.apple.FinderSync</string>
    <key>NSExtensionPrincipalClass</key><string>WindowFinderSync</string>
  </dict>
</dict></plist>
PLIST

chmod +x "$APP/Contents/MacOS/$APP_NAME"
codesign --force --sign - --entitlements native/WindowFinderSync.entitlements "$APPEX"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"

if [ -n "$SKIP_DMG" ]; then
  echo "[4/4] DMG 생략 (SKIP_DMG) — 필요하면 ./make-dmg.sh"
  echo ""
  echo "완료: $APP"
  exit 0
fi
echo "[4/4] DMG 생성"
DMGROOT="$DIST/dmgroot"
mkdir -p "$DMGROOT"
cp -R "$APP" "$DMGROOT/"
ln -s /Applications "$DMGROOT/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMGROOT" -ov -format UDZO "$DIST/$APP_NAME.dmg" -quiet
rm -rf "$DMGROOT"

echo ""
echo "완료:"
echo "  $APP"
echo "  $DIST/$APP_NAME.dmg"
