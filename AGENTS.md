# WindowFinder 프로젝트 메모

이 저장소에서 작업할 때 이 요약과 [상세 프로젝트 메모](docs/PROJECT_MEMORY.md)를 참고한다.
메모는 2026-09-18, `a52c548` / v1.0.39 기준이다. 이후 변경된 소스가 메모보다 우선한다.
2026-09-18 후속 작업: Git Stage/Unstage UI와 staged-only 커밋 동작을 반영했다.
2026-09-19 전체 검토: [개선점 검토](docs/IMPROVEMENT_REVIEW.md)에 재현 근거와 수정 우선순위를 기록했다.
2026-09-19 VCS 고도화: Git/SVN diff 작업창, SVN 선택 커밋, Git 커밋 대상 검증을 추가했다.
검토 항목 중 R02(Git discard), R07(배포 소스 일치), R09(VCS 취소)는 수정했다. 나머지는 별도 후속 작업이다.

## 프로젝트 개요

- Windows 11 탐색기 UX를 구현한 **macOS 로컬 파일 탐색기**. 주요 UI 언어는 한국어.
- `server.js`: Node.js CommonJS + 내장 모듈만 사용하는 HTTP/파일시스템 API 서버.
- `public/app.js`: 프레임워크 없는 DOM 기반 UI, 전역 `state`와 함수들로 구성.
- `public/index.html`, `public/style.css`: 레이아웃·SVG 스프라이트·테마.
- `public/vendor/`: highlight.js, 추가 언어 정의, marked의 저장소 내 배포본.
- `native/main.swift`: Cocoa/WKWebView 창, 네이티브 드래그, 서버 실행, 자동 업데이트.
- `native/WindowFinderSync.m`: Finder 우클릭 확장. `windowfinder://open?path=...`로 앱에 전달.
- `package.json`, npm 런타임 의존성, 프런트엔드 번들러는 없다.

## 실행과 검증

```sh
node server.js                      # http://127.0.0.1:8890
node server.js 8891                 # 개발용 별도 포트
node --check server.js
node --check public/app.js
node --test tests/*.test.js
for script in build.sh deploy.sh install.sh make-dmg.sh WindowFinder.command; do
  zsh -n "$script" || break
done
```

- 네이티브 셸과 `WindowFinder.command`의 포트는 8890으로 고정되어 있다.
- 앱 표시 이름은 `WindowFinder`, 터미널 실행 명령과 URL 스킴은 소문자 `windowfinder`로 통일한다.
  네이티브 앱은 쓰기 가능한 표준 bin 경로에 `windowfinder [폴더]` 명령을 자동 설치한다.
- `./build.sh`: Node SEA + Swift 셸 + Finder 확장 → `dist/WindowFinder.app`, `.dmg`.
- `SKIP_DMG=1 ./build.sh`: DMG 없이 앱 빌드. 현재 네이티브 타깃은 arm64/macOS 12+.
- `./deploy.sh [버전]`: clean main과 도구·인증·버전을 확인한 뒤 버전 커밋 → 빌드 → 동일 커밋 태그·원자적 푸시 → Release → 업데이트 feed 순으로 배포한다. 기능 변경과 테스트는 먼저 커밋한다.
- `install.sh`: `/Applications` 앱 교체와 Finder 재시작을 포함한다. 단순 검증 명령으로 취급하지 않는다.

## 변경 시 보존할 동작

- 서버는 `127.0.0.1`에만 바인딩한다. `safePath()`는 절대 경로 정규화이며 저장소 내부로 제한하는 함수가 아니다.
- 파일 조작은 실제 사용자 파일에 적용된다. 삭제 UI는 Finder를 통한 휴지통 이동이다.
- 복사/이동 API는 HTTP 200에서도 `{ ok: false, results }`로 부분 실패를 반환할 수 있다.
  각 항목의 `completed` / `failed` / `skipped`, 실제 `destination`을 확인한다.
- 이름 충돌은 `copy`, `copy 2` 식으로 회피한다. 같은 폴더로 이동하면 `skipped`다.
- 볼륨 간 이동은 EXDEV 발생 시 대상 볼륨의 임시 디렉터리에 복사한 뒤 옮기고 원본을 삭제한다.
  실패 시 원본 보존, 나머지 항목 계속 처리, 상대 심볼릭 링크 보존을 유지한다.
- 클립보드 쓰기는 직렬화한다. `cutMarker`의 `changeCount`, Unicode NFC 비교,
  `pendingPaths`를 통한 미완료 항목 재시도와 새 복사 선택 보호를 유지한다.
- 네이티브 창 내부 드래그는 이동, 다른 창은 복사이며 Option 키는 이를 반전한다.
  브라우저 드래그와 Swift 파일 프라미스 경로는 별도 구현이다.
- 네이티브 브리지는 `fxDrag`, `fxNewWindow`, `fxCloseWindow`, `fxCheckUpdate`와
  `fxInternalDrop`, `fxNativeDragEnded`, `fx-refresh`를 양쪽에서 맞춰 변경한다.
- 표시 이름 `dname`과 실제 `name`/`path`를 구분한다. `.app`은 디렉터리여도 실행 앱으로 취급한다.
- 사용자 설정은 `localStorage`의 `fx.*` 키를 쓴다. 이름 변경 시 기존 설정 호환성을 고려한다.
- Git 상태는 NUL 구분 porcelain의 XY 두 칼럼을 구분한다. 부분 stage 파일은 양쪽 목록에 표시한다.
  UI 커밋은 `commit`으로 index만 커밋하고 자동 `add -A`를 수행하지 않는다.
  `gitIndexOp()`는 literal pathspec, 최초 커밋 전 unstage, rename의 원본/새 경로 해제를 처리한다.
- Git/SVN 변경·커밋 화면은 `vcsChangesModal()`을 공유한다. 파일 행 클릭은 diff, 체크박스는 작업 대상이다.
  Git 커밋은 모든 Staged 항목, SVN 커밋은 선택한 유효 경로만 포함한다(`--depth empty`).
  Git은 `commitToken`/`expectedToken`으로 index·HEAD·브랜치의 외부 변경을 확인한다.
- `vcsdiff`는 256KiB로 제한하며 Git 외부 diff/textconv를 실행하지 않는다. 화면에는 diff를 HTML escape한다.
  SVN 상태는 XML의 내용·속성 두 칼럼과 tree conflict를 반영하고 경로의 `@`를 peg escape한다.
- VCS 취소는 응답 close 기준이며 프로세스 그룹 종료와 후속 명령 중단을 처리한다.
  모달을 닫거나 교체할 때 `modalCleanup`으로 구독·요청을 정리한다.
- UI 정적 파일을 추가하면 `sea-config.json`의 assets도 확인한다.
- 테스트는 소스 문자열의 구간을 잘라 `vm`에서 실행한다. 함수/구분 주석을 옮기면 추출부도 확인한다.
- `public/app.js`에는 기존 NUL 문자가 있어 검색 시 `rg -a`가 필요할 수 있다.

## 기준 검증 결과

JS 구문 검사와 셸 구문 검사 통과. 기존 테스트 15개는 기본 환경에서 통과했고,
macOS 전용 클립보드 테스트 1개는 샌드박스 밖 재실행에서 통과했다.
전체 앱 빌드, 네이티브 UI, 배포는 이번 분석에서 실행하지 않았다.
후속 Stage/Unstage 작업에는 `tests/git-stage.test.js`의 임시 저장소 테스트와
브라우저에서 개별·선택·전체 Stage/Unstage 및 staged-only 커밋 검증을 추가했다.
변경 후 전체 자동 테스트 22개가 샌드박스 밖 실행에서 통과했다.
전체 검토에서도 22개 통과를 재확인했다. 별도 실험으로 Markdown 스크립트 실행,
Git 변경 취소의 pathspec 확장, 동시 이동 덮어쓰기, 탐색 응답 경합 등을 확인했다.
파일 작업·미리보기·배포를 수정할 때 개선점 검토 문서의 관련 완료 기준을 확인한다.
구조·명령·핵심 계약이 바뀌면 이 문서와 상세 메모의 관련 내용을 갱신한다.
VCS 고도화 후 전체 테스트는 45개 중 44개 통과, 1개는 `svn`/`svnadmin` 부재로 skip했다.
Git 브라우저 검증에서 diff·선택 Stage·개별 Unstage·단축키 커밋·메시지 보존·포커스 순환을 확인했다.
SVN 화면은 모의 API로 검증했으며 실제 SVN CLI 검증으로 간주하지 않는다.

2026-09-19 v1.0.40 배포 준비 최종 검증: 전체 65개 중 64개 통과, 실패 0개, SVN 도구 부재로 1개 skip.
JS·셸 구문 검사와 `git diff --check`도 통과했다.
