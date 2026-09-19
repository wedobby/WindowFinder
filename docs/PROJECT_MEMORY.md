# WindowFinder 상세 프로젝트 메모

분석일: 2026-09-18. 기준: `main`, 커밋 `a52c548` (`publish update manifest v1.0.39`).
`VERSION`과 `latest.json`의 버전은 모두 `1.0.39`였고, 분석 시작 시 작업 트리는 깨끗했다.
저장소 소스와 기존 테스트를 근거로 작성했으며, 향후 작업에서는 변경된 소스를 우선한다.
2026-09-18 후속 변경: Git Stage/Unstage 및 staged-only 커밋 구현 내용을 아래에 반영했다.
2026-09-18–19 전체 검토 결과는 [개선점 검토](IMPROVEMENT_REVIEW.md)에 기록했다.
2026-09-19 VCS UI 고도화에서 R02(Git discard)·R09(VCS 취소)를 수정했으며, 나머지 결함은 남아 있다.

## 목적과 기술 구성

Windows 탐색기의 탐색·선택·파일 조작 UX를 macOS에 제공하는 개인용 로컬 파일 탐색기다.
브라우저와 네이티브 앱이 같은 HTML/CSS/JavaScript 및 로컬 API를 사용한다.
별도 데이터베이스나 서버 프레임워크는 없고, Node 서버의 런타임 의존성은 내장 모듈뿐이다.
브라우저에는 저장소에 포함된 highlight.js와 marked를 로드한다.

```text
브라우저 / Swift DropWebView
    → public/index.html + style.css + app.js
    → HTTP /api/*, 기본 127.0.0.1:8890
    → server.js
    → fs / child_process
    → 실제 파일시스템, osascript/JXA, Git/SVN, macOS 명령

Finder 우클릭 → WindowFinderSync.appex
    → windowfinder://open?path=... → Swift AppDelegate → 해당 폴더 창

앱 빌드 → Node SEA(서버와 정적 자산) + Swift 셸 + Finder Sync 확장
```

## 파일별 역할과 수정 위치

| 파일 | 역할 / 진입점 |
| --- | --- |
| `server.js` | 경로·메타데이터·전송 헬퍼, `api` 핸들러 맵, 정적 서빙, `handleRequest`, `startServer`, 실행 모드 분기 |
| `public/app.js` | `state`, `apiGet`/`apiOp`, `navigate`/`refresh`, 렌더링, VCS, 클립보드, 드래그, 미리보기, 단축키 |
| `public/index.html` | DOM 골격, 도구 창, 모달, SVG 아이콘 정의, vendor 스크립트 로딩 순서 |
| `public/style.css` | CSS 변수 기반 테마, 파일 목록·그래프·미리보기 스타일 |
| `public/vendor/*` | highlight.js, DOS/PowerShell 언어 정의, marked |
| `native/main.swift` | `AppDelegate`, `DropWebView`, `FileDragSource`, 파일 프라미스, 업데이트 |
| `native/WindowFinderSync.m` | `FIFinderSync` 확장, Finder 메뉴와 URL 스킴 호출 |
| `native/WindowFinderSync.entitlements` | Finder 확장의 App Sandbox 및 사용자 선택 파일 읽기 권한 |
| `sea-config.json` | Node SEA의 main과 내장 정적 자산 목록 |
| `build.sh`, `make-dmg.sh` | 앱·확장 컴파일, ad-hoc 서명, 검증, DMG 생성 |
| `deploy.sh`, `install.sh` | GitHub 릴리스 발행 / 배포 앱 설치 |
| `tests/clipboard.test.js` | 프런트엔드 복사·잘라내기·붙여넣기 상태와 경합 테스트 |
| `tests/transfer.test.js` | 서버 전송·실패 복구·심볼릭 링크·네이티브 클립보드 테스트 |
| `tests/git-stage.test.js` | 실제 임시 Git 저장소의 Stage/Unstage, 부분 stage 커밋, rename·삭제·최초 커밋 테스트 |
| `tests/vcs-review.test.js` | diff 크기·경로·rename, literal discard, Git 커밋 토큰, SVN XML·선택 커밋 |
| `tests/vcs-cancel.test.js` | 실제 HTTP 연결 수명·프로세스 그룹 취소·후속 명령 중단 |
| `tests/vcs-ui.test.js` | 상태 그룹·SVN 커밋 가능 상태·diff 줄 번호·HTML escape |

`app.js`와 `server.js`에 기능이 집중되어 있다. 작업 전 관련 함수와 호출부를 함께 찾아야 한다.
`app.js`의 문자열 하이라이트 구현에는 NUL 구분자가 실제 바이트로 포함되어 있다.
일반 `rg`가 binary로 판정하면 `rg -an '패턴' public/app.js`를 사용한다.

## 런타임과 데이터 흐름

- 개발: `node server.js [port]` 또는 `node server.js --serve [port]`.
- `WindowFinder.command`: 8890의 `/api/home`을 확인하고 서버가 없으면 실행한 뒤 브라우저를 연다.
- 앱: Swift가 `/api/home`을 확인하고 내장 `WindowFinder-server --serve 8890`을 실행한다.
  서버는 앱 종료 후에도 살아 있을 수 있으며 다음 앱 실행에서 재사용한다.
- 따라서 이미 실행 중인 서버의 응답을 새 소스/새 바이너리의 동작으로 오인하지 않도록 확인한다.
- 브라우저 초기화: `initSidebar()` → `/api/home` → URL hash 또는 홈으로 `navigate()`.
  `/api/list` 결과를 `state.entries`에 저장하고 정렬·렌더한 뒤 VCS 조회와 폴더 감시를 시작한다.
- 엔트리의 주요 필드: `name`, `path`, `isDir`, `size`, `mtime`, `ctime`, `hidden`, `symlink`, `ext`, 선택적 `dname`.
  `dname`은 Finder 현지화 표시 이름이다. 파일 작업에는 원래 경로를 사용한다.
- `/Applications`에는 `/System/Applications`, Utilities에는 시스템 Utilities를 병합한다.
- `.app`은 파일시스템상 디렉터리지만 UI에서 앱처럼 열고, 별도의 패키지 내용 보기로 탐색한다.
- `fs.watch` → `/api/watch` SSE → UI의 800ms debounce.
  이름 편집·러버밴드 선택·드래그·검색 중이면 자동 갱신을 미룬다.

## API 지도

아래 GET/POST는 클라이언트의 사용 방식이다. 라우터는 `/api/` 뒤 이름으로 `api` 객체의 핸들러를 찾는다.

| 기능 | 경로 | 주요 내용 |
| --- | --- | --- |
| 탐색 | GET `home`, `list`, `tree`, `search` | 즐겨찾기 위치·볼륨, 목록, 하위 폴더, 이름 검색 |
| 변경 감지 | GET `watch` | SSE 변경 이벤트 |
| 파일 조회 | GET `file`, `text`, `head` | 원본/미디어 Range, UTF-8 텍스트, base64 바이너리 앞부분 |
| 아이콘 | GET `sysicon`, `appicon`, `thumb` | NSWorkspace/JXA, ICNS 변환, Quick Look |
| 속성 | GET `props`, `dirinfo`, `dirsize`, `opener` | 파일 속성, 저장소/IDE 정보, 크기 NDJSON, 기본 연결 앱 |
| Finder 연동 | GET `pasteboard`, POST `upload` | 파일 클립보드 참조 / 브라우저 외부 드롭 업로드 |
| 네트워크 | GET `netbrowse` | Bonjour `_smb._tcp` 탐색, 30초 캐시 |
| VCS 읽기 | GET `vcs`, `gitgraph`, `gitshow`, `svnlog` | 상태, 그래프, 커밋 변경 파일, SVN 로그 |
| 변경 미리보기 | GET `vcsdiff` | tool/root/path/staged로 Git index·worktree 또는 SVN BASE diff, 최대 256KiB |
| VCS 쓰기 | POST `vcsop`, `vcsstream` | 허용된 Git/SVN 명령 실행, 긴 작업 출력 스트리밍 |
| 연동 설정 | GET `integrations`, `apps` | Git/SVN·편집기 설치 상태, 선택 가능한 앱 목록 |
| 파일·앱 조작 | POST `op` | `{ op, ... }`로 작업 지정 |

`op`에는 `mkdir`, `newfile`, `rename`, `trash`, `copy`, `move`, `setPasteboard`,
`open`, `openWith`, `reveal`, `openApp`, `openNet`, `mountNet`, `eject`, `fork`,
`editor`, `vscode`(호환), `terminal`, `writeText`가 있다.
`editor`는 `{editor: "vscode"|"zed", paths: [...]}`로 bundle ID allowlist를 사용하고,
`openWith`는 `{app: "/절대경로/앱.app", paths: [...]}`로 선택 앱을 실제 실행한다.
대상은 1–512개 절대 경로이며 빈 값·NUL·잘못된 앱 번들은 거부한다. 셸 문자열로 합치지 않는다.

검색은 파일명 기준 재귀 탐색이며 500개/8초 제한을 사용한다.
`text`는 앞 256KiB, `head`는 기본 64KiB/최대 256KiB를 반환한다.
`dirsize`는 진행 상태를 NDJSON으로 보낸다. `vcsstream`은 stdout/stderr 텍스트를 보내고
`__DONE__:<exitcode>`로 끝내며, 프런트엔드는 AbortController를 사용한다.
VCS 스트림은 응답 close 시 실행 중 프로세스 그룹에 SIGTERM을 보내고 필요 시 SIGKILL한다.
취소 후 다음 단계 명령은 실행하지 않는다. UI는 ‘취소 요청됨’으로 표시하며 이미 반영된 변경을 복원하지 않는다.

## 파일 전송과 클립보드 계약

`transferItems()`는 선택 항목을 중복 제거한 뒤 순차 처리한다. 하나가 실패해도 다음 항목을 처리한다.
응답은 `{ ok, results: [{ source, destination, status, error? }] }`이며 상태는
`completed`, `failed`, `skipped`다. 부분 실패도 HTTP 200이므로 `ok`와 항목별 결과가 중요하다.

- `uniqueDest()`는 `lstat`으로 끊어진 심볼릭 링크까지 충돌로 취급한다.
- 이름 충돌 시 `file copy.ext`, `file copy 2.ext` 식으로 새 이름을 선택한다.
- 같은 폴더로 이동하면 원본을 그대로 두고 `skipped`를 반환한다.
- 일반 이동은 rename. EXDEV이면 대상 폴더의 `.windowfinder-move-*` 임시 디렉터리에 복사하고,
  최종 위치로 rename한 다음에 원본을 삭제한다. 임시 디렉터리는 정리한다.
- 복사는 `recursive`, `errorOnExist`, `force: false`, `verbatimSymlinks` 옵션을 사용한다.
- 삭제는 `moveToTrash()`에서 Finder AppleScript를 사용한다.

클립보드는 JXA로 NSPasteboard의 파일 URL을 읽고 쓴다. 시스템 클립보드에는 cut/copy 구분이 없어
서버가 `{ paths, pendingPaths, changeCount }`인 `cutMarker`를 별도로 유지한다.
NFC 정규화 비교로 macOS의 한글 경로 분해를 처리하되 실제 작업에는 원래 경로를 유지한다.
이동 완료 항목만 pending에서 제거하고 실패/건너뜀 항목은 재시도 대상으로 남긴다.

프런트엔드의 `clipboardWrite`와 서버의 `withPasteboard()`는 클립보드 작업을 직렬화한다.
`doPaste()`는 대기 중인 쓰기를 모두 기다리고 시작 시점의 대상 폴더를 고정한다.
중복 붙여넣기를 막고, 진행 중 다른 복사 선택이 생겼으면 이전 결과로 덮어쓰지 않는다.
시스템 클립보드가 정상적으로 비어 있을 때는 오래된 로컬 선택을 되살리지 않는다.

## UI 상태와 부가 기능

- 전역 `state`가 현재 폴더, 원본/정렬 목록, 경로 Set 선택, 히스토리, 클립보드, 보기, VCS를 관리한다.
- `localStorage`의 `fx.*` 키에 보기·정렬·숨김/시스템 파일·미리보기 옵션·테마·즐겨찾기·네트워크 드라이브·웹 링크·패널 폭을 저장한다.
- 테마: system, light, dark, blue, red, gray. CSS 변수와 `data-theme`로 적용한다.
- 미리보기: 이미지/영상/음성/PDF, 코드 하이라이트, JSON pretty, Markdown, CSV/TSV 표, 텍스트/hex 판별, 내용 검색.
- 전용 창 URL: `?graph=git#경로`, `?svnlog=1#경로`, `?viewer=1#파일경로`.
  `?commit=git` 또는 `?commit=svn`은 시작 시 커밋 모달을 연다.
- 이미지 뷰어는 확대·축소·회전과 같은 폴더 파일의 이전/다음 이동을 지원한다.
- 네트워크 드라이브 연결/기억/재연결, Bonjour 서버 탐색, 사용자 웹 링크도 구현되어 있다.
- `writeText` API는 존재하지만 현재 UI에서 이 op를 호출하는 텍스트 편집기는 확인되지 않았다.

Git/SVN은 시스템 CLI를 사용한다. GUI 실행 환경을 위해 `/opt/homebrew/bin`, `/usr/local/bin`,
`/opt/local/bin`을 PATH에 보충하고 자식 프로세스에는 `ko_KR.UTF-8` 로케일을 적용한다.
SVN의 switch/cleanup/lock/unlock도 구현되어 있다.

### Git Stage/Unstage (2026-09-18 추가)

- Git 메뉴 및 파일·폴더 우클릭에서 선택 항목 Stage/Unstage를 실행한다.
- `gitChangesModal()`은 상태·커밋 창에서 Unstaged/Staged를 나눠 표시하며 파일별·선택·전체 처리를 제공한다.
  삭제 파일도 목록에 나타나며, stage 작업 후 커밋 메시지를 유지한다.
- `gitChangeState()`는 XY의 index와 worktree 변경을 구분한다. 부분 stage 파일은 양쪽 목록에 나타난다.
  충돌은 Unstaged 쪽에 표시하고, 충돌이 남았거나 staged 항목이 없으면 커밋 버튼을 비활성화한다.
- UI는 `/api/vcsstream`의 `action: 'commit'`을 사용하며 index만 커밋한다. 자동 전체 stage는 하지 않는다.
  `/api/vcsop`에도 `commit`을 지원한다. 기존 `commitAll` API는 호환용으로 남아 있으며 UI에서는 호출하지 않는다.
- `gitStatus()`는 `git status --porcelain=v1 -z --untracked-files=all`을 읽고
  `{ statuses, originalPaths }`를 반환한다. rename의 목적지와 원본 경로를 구분하고 특수문자 경로를 보존한다.
- `gitIndexOp()`는 `--literal-pathspecs`를 사용한다. Stage는 `add -A -- <paths>`,
  Unstage는 `restore --staged`이며 rename은 원본 경로도 함께 해제한다.
  HEAD가 없는 최초 커밋 전에는 `rm --cached -r -f --ignore-unmatch`로 index만 해제한다.
- 브랜치 조회는 symbolic-ref를 우선 사용하여 최초 커밋 전 저장소도 감지한다. detached HEAD는 짧은 해시로 표시한다.

### Git/SVN 변경 작업창 (2026-09-19)

- `vcsChangesModal(tool, withCommit, opts)`을 상태·커밋 진입점이 공유한다. Git/SVN 모두 목록+diff+커밋 입력으로 구성한다.
- Git Unstaged/Staged 및 SVN 변경/미추적 탭, 경로 검색, 표시 항목 전체 선택, 개별·선택 작업을 제공한다.
  Git의 전체 Stage/Unstage는 검색 결과와 무관하게 해당 탭 전체에 적용된다.
- 파일 버튼은 diff를 열고 체크박스는 작업 대상을 고른다. Git 커밋은 체크와 무관하게 index 전체,
  SVN 커밋은 체크한 유효 항목만 포함한다. 충돌·누락·미추적·external은 SVN 커밋 대상에서 제외한다.
- diff는 줄 번호·추가/삭제 색상·줄바꿈을 지원한다. 텍스트는 escape하며, 비동기 응답은 요청 세대로 검증한다.
  바이너리·큰 diff를 안내한다. Git staged rename에는 원래 경로도 포함해 rename/mode를 표시한다.
- 여러 줄 메시지와 ⌘/Ctrl+Enter를 지원한다. 초안은 해당 페이지의 Map에 저장하므로 같은 창의 모달 재진입·실패 시 유지되고
  성공 시 제거된다. 페이지 새로고침이나 앱 재시작을 넘는 영구 저장은 아니다.
- 창 활성화·수동 새로고침 시 상태를 갱신한다. Git `commitToken`은 index 항목·HEAD·브랜치의 SHA-256 지문이다.
  UI 재조회와 API `expectedToken` 검증으로 외부 restage/브랜치 변경을 감지한다. 다른 Git 클라이언트와의 원자적 잠금을 제공하는 것은 아니다.
- SVN은 `status --xml`을 사용해 속성만 변경된 항목·tree conflict·잠금도 보존한다.
  선택 커밋은 명시적 경로 + `--depth empty`; 추가된 상위 폴더가 빠지면 함께 선택하도록 안내한다.
  depth의 대상 한정 의미는 [Subversion 문서](https://svnbook.red-bean.com/en/1.8/svn.advanced.sparsedirs.html)를 참고한다.
- `modalCleanup`은 이전 모달의 focus 구독과 스트림 요청을 정리한다. 열린 모달 뒤 파일 탐색기 단축키는 차단하고 Tab 포커스를 모달 안에 유지한다.
- Git 상태·diff 조회는 `--no-optional-locks`로 index stat-cache 갱신을 막는다.
  커밋 직전 검증 통과 경로에서 새 diff 조회를 시작하지 않아 조회와 커밋의 index 잠금 경합을 줄인다.
- 검증: 전체 45개 중 44개 통과. 실제 SVN 작업 사본 테스트 1개는 CLI 부재로 skip.
  Git은 임시 실제 저장소, SVN 화면은 모의 API로 검증하며 실제 SVN CLI 검증과 구분한다.
  Git 브라우저에서 staged/unstaged diff·rename·binary·검색·선택 Stage·개별 Unstage·메시지 실패 보존·성공 초기화·⌘Enter 커밋을 확인했다.
  커밋 후 index의 버전만 반영되고 추가 worktree 수정과 미선택 파일이 유지됨을 실제 Git으로 확인했다.
  SVN 모의 화면에서는 추가·속성 변경·충돌·누락 상태와 선택한 폴더 경로만 담긴 커밋 요청을 확인했다.

## 네이티브 연동

JS → Swift 메시지: `fxDrag`, `fxNewWindow`, `fxCloseWindow`, `fxCheckUpdate`.
Swift → JS 호출/이벤트: `fxInternalDrop`, `fxNativeDragEnded`, `fx-refresh`, `fx-settings`.
네이티브 드래그 세션은 브리지 메시지에서 경로를 예약하고 다음 `mouseDragged`에서 시작한다.

- 앱 → Finder: NSFilePromiseProvider와 파일 URL을 함께 제공. 충돌 시 덮어쓰기/둘 다 유지/건너뛰기 선택.
- 앱 창 → 앱 창: 같은 창이면 이동, 다른 창이면 복사. Option 키로 반전.
- Finder → 네이티브 앱: Swift가 파일 URL을 받아 URL hash의 현재 폴더로 `/api/op` copy를 요청.
- 브라우저 모드: 외부 드롭은 `/api/upload`; 드래그 아웃은 Chrome DownloadURL 기반 단일 파일 대체 경로.
- Finder Sync는 사용자 홈, Applications, System Applications, Users/Shared, Volumes를 감시한다.
  파일/빈 공간/사이드바 메뉴에서 URL 스킴으로 경로들을 전달하며 앱은 폴더를 중복 제거해 연다.
- 앱 실행 시 쓰기 가능한 `/opt/homebrew/bin` 또는 `/usr/local/bin`에 `windowfinder`가 없으면 CLI를 만든다.
  `windowfinder [폴더]`는 `open -a WindowFinder`로 앱을 연다. 메뉴 제목도 `WindowFinder`로 명시한다.

로그 위치: `/tmp/windowfinder.log`(command 런처), `/tmp/windowfinder-server.log`(내장 서버),
`/tmp/windowfinder-shell.log`(Swift 셸). Finder 확장은 `com.wedobby.windowfinder.findersync` os_log를 사용한다.

## 빌드·배포·업데이트

`build.sh`는 기존 `dist/`와 SEA blob을 정리하고 다음 순서로 실행한다.

1. 현재 Node로 `sea-config.json`의 SEA blob을 생성한다.
2. 같은 버전의 공식 Node 바이너리를 `~/.cache/windowfinder`에 다운로드/캐시한다.
3. `npx -y postject`로 blob을 주입하고 ad-hoc 서명한다.
4. Swift 셸과 Objective-C Finder 확장을 arm64/macOS 12 타깃으로 컴파일하고 앱에 넣는다.
5. 앱과 확장을 서명·검증하고, `SKIP_DMG`가 없으면 DMG를 만든다.

Node 바이너리 선택에는 x64 분기가 있지만 Swift/확장 타깃은 arm64 고정이므로
현재 배포 파이프라인을 Intel/universal 지원으로 해석하지 않는다. 최소 Node 버전은 별도 명시되어 있지 않다.
분석 환경은 Node v22.22.1이었다. 빌드에는 네트워크, Node/npx, Swift/clang 및 macOS 도구가 필요하다.

`deploy.sh [버전]`은 clean main·도구·gh 인증·증가 버전·중복 태그 검사 → VERSION 커밋 →
DMG 제외 빌드 → `WindowFinder-<버전>.zip` 생성 → 소스/HEAD 동일성 재검사 → 동일 커밋 태그 →
main·태그 원자적 푸시 → GitHub Release 생성 → latest.json 커밋·푸시 순이다.
기능 변경과 테스트를 먼저 완료·커밋한다. 실패한 커밋을 무시하거나 태그를 강제 이동하지 않는다.
`gh` 설치·인증과 Git 푸시 인증이 필요하다. 단순 빌드 확인 목적으로 실행하지 않는다.

업데이트 feed 기본값은 `https://raw.githubusercontent.com/wedobby/WindowFinder/main`이며
로컬 `update-url.txt`로 덮어쓴다. 빌드 시 Info.plist의 `WindowFinderUpdateURL`에 들어간다.
manifest는 `{ version, zip }`. HTTP(S)와 공유 폴더 경로를 지원한다.
Swift가 시작 5초 후와 4시간마다 확인하며, 백그라운드 확인은 새 버전을 자동 적용하고
수동 확인은 사용자에게 업데이트 여부를 묻는다. 앱 교체 후 내장 서버를 종료하고 앱을 재실행한다.

`.gitignore`: `dist/`, `sea-prep.blob`, 로그, `.DS_Store`, `update-url.txt`, `deploy-dest.txt`.
현재 배포 스크립트에서는 `deploy-dest.txt`를 읽는 처리가 없다.
`install.sh`는 다운로드한 앱으로 `/Applications/WindowFinder.app`을 교체하고 격리를 해제하며,
Finder 확장을 등록/활성화하고 Finder를 재시작한다.

## README와 구현의 차이

향후 관련 작업 시 아래 항목을 소스에서 재확인한다. 이번 분석에서는 기존 소스를 수정하지 않았다.

- 업데이트 정책과 버전 포함 ZIP 이름은 2026-09-19 README에도 반영했다. `build.sh` 자체는 ZIP을 생성하지 않는다.
- Git 그래프 API는 최근 100개 고정이다. 페이지 추가 조회와 날짜 범위 처리는 SVN 로그에 구현되어 있다.
- 네이티브 Finder 드롭은 현재 폴더를 대상으로 삼는다. 브라우저 드롭은 겨눈 폴더 행을 대상으로 삼는 별도 경로다.
- README에 상세히 나오지 않는 테마 선택, 네트워크 드라이브, 웹 링크, 확장 미리보기 기능이 존재한다.

## 검증 기준과 이번 결과

```sh
node --check server.js
node --check public/app.js
for script in build.sh deploy.sh install.sh make-dmg.sh WindowFinder.command; do
  zsh -n "$script" || break
done
node --test tests/*.test.js
```

JS 구문 검사와 셸 구문 검사는 통과했다. 전체 테스트 16개 중 기본 샌드박스 환경에서
15개가 통과했고, macOS 전용 150개 Unicode 파일 클립보드/이동 테스트는
`pb.writeObjects is not a function`으로 실패했다. 같은 테스트를 샌드박스 밖에서
`node --test --test-name-pattern='macOS cut/paste' tests/transfer.test.js`로 재실행한 결과 통과했다.
이 실패는 환경 제한에 따른 것으로 판단하며 제품 결함으로 기록하지 않는다.

테스트는 `node:test`와 `vm`을 사용한다. 클라이언트 테스트는 `let clipboardWrite =`부터
`async function doTrash()` 직전까지 추출한다. 서버 테스트는 `// ---------- mode dispatch ----------`
직전까지 추출하여 포트를 열지 않고 핸들러를 실행한다. 이 경계 변경 시 테스트 추출부도 확인한다.
macOS 통합 테스트는 전용 이름의 NSPasteboard와 임시 파일을 사용하며 일반 클립보드를 변경하지 않는다.

커버리지는 전송/클립보드에 집중되어 있다. 전체 HTTP 라우팅, UI, Git/SVN, 빌드,
업데이트·설치·배포까지 검증한 결과는 아니다. 이번 분석에서는 앱 빌드·설치·배포를 실행하지 않았다.

후속 Git 작업에서는 자동 테스트 6개를 추가했다. 최초 커밋 전, Unicode/특수문자,
폴더·삭제·rename, 부분 stage 이후 편집 보존, index만 커밋하는 두 API 경로와 UI 상태 분리를 검증한다.
브라우저의 별도 개발 포트와 임시 Git 저장소에서 개별·선택·전체 Stage/Unstage,
메시지 보존, 실제 커밋, 우클릭 및 Git 메뉴 동작을 확인했다.
변경 후 `node --test tests/*.test.js`를 샌드박스 밖에서 실행하여 22개 모두 통과했다.

## 후속 작업 시 메모 유지

2026-09-18–19 전체 검토에서 파일 API, 프런트엔드/VCS, 네이티브/배포를 나누어 확인했다.
JS 구문 검사와 기존 자동 테스트 22개는 재실행에서도 통과했다.
별도 임시 환경에서 아래 결함을 재현하거나 코드로 확인했으며, 상세 위치·확인 수준·완료 기준은
[개선점 검토](IMPROVEMENT_REVIEW.md)를 따른다.

- 우선 수정: Markdown HTML 실행, Git discard의 literal 경로 누락, 동시 이동 덮어쓰기,
  탐색 응답 순서 경합, 변경 API의 요청 출처·메서드 검증 누락.
- 배포 전 수정: 불완전한 앱의 업데이트 적용, 작업 도중 자동 재시작, 배포 ZIP과 태그 소스 불일치.
- 후속 안정화: VCS 취소, 파일 스트림 오류, rename의 끊어진 링크 충돌, 업로드 부분 파일,
  이전 서버 재사용, Finder 드롭 실패 표시, 외부 페이지의 네이티브 브리지.

이번 검토는 문서만 추가·갱신했다. 제품 코드 수정, 앱 교체, 버전 증가, 배포는 하지 않았다.
Stage/Unstage와 이름 변경 등 앞선 미커밋 작업은 그대로 유지했다.

동작 변경 후 관련 테스트와 브라우저/네이티브 분기를 함께 확인한다.
정적 자산 변경은 SEA 포함 여부, 브리지 변경은 Swift/JS 양쪽, 전송 변경은 부분 실패 계약을 확인한다.
버전·아키텍처·실행 명령·알려진 차이가 바뀌면 이 문서와 루트 `AGENTS.md`를 함께 갱신한다.

2026-09-19 배포 준비에서 R07을 수정했다. `tests/deploy.test.js`는 임시 저장소와 모의 빌드/GitHub 명령으로
실패 시 중단, dirty/main/버전/인증 사전 검사, 빌드 소스와 태그 일치, feed 게시 순서를 검증한다.

2026-09-19 v1.0.40 배포 준비 최종 검증: 전체 65개 중 64개 통과, 실패 0개, SVN 도구 부재로 1개 skip.
JS·셸 구문 검사와 `git diff --check`도 통과했다.

## 연동 설정 후속 작업 (2026-09-19)

- `getIntegrations()`는 PATH 실행파일의 버전을 시간 제한 내 확인한다. macOS Git/SVN shim은 개발도구 경로를 먼저 검증해 자동 설치 안내 실행을 피한다.
- 설치 상태는 15초 캐시와 진행 중 요청 공유를 사용한다. `GET /api/integrations?refresh=1`로 새로 확인한다.
  응답은 `{git, svn, editors: {vscode, zed}}`이며 `home`·`vcs`에도 포함된다.
- 저장소 상태 및 폴더 요약은 미설치 VCS 명령을 실행하지 않는다. UI는 도구 버튼·상태 배지·우클릭·새로 만들기·속성/미리보기를 함께 제어한다.
- 기본 편집기는 `fx.editor`에 저장하며 다른 창에 storage 이벤트로 반영한다. 최초 선택은 설치된 VS Code, 없으면 Zed 순이다. 저장된 편집기가 제거되면 선택을 보존하고 실행을 비활성화한다.
- 설정은 상단 버튼, ⌘, 또는 네이티브 메뉴에서 연다. 작업 모달이 열렸거나 도구 전용 창이면 교체를 막아 진행 중 작업을 취소하지 않는다.
- 다른 앱으로 열기는 /Applications, ~/Applications, /System/Applications의 앱을 검색한다. 하위 폴더는 3단계까지만 탐색하고 앱 번들 내부에는 들어가지 않으며 realpath 중복을 제거한다.
  선택 파일·폴더를 지정 앱에 전달하며 확장자 연결이나 macOS 기본 앱은 바꾸지 않는다.
- 실제 Mac에서 Git/VS Code 감지와 SVN/Zed 미설치를 확인했다. 브라우저에서 실제 앱 목록·검색과 설치 조합 4가지, Zed 선택·재로드 유지, 실행 요청 인수, 실패 시 재시도를 확인했다.
  Zed 실행과 미설치 도구 조합은 모의 API로 검증했으며 실제 Zed/SVN 실행 검증은 아니다.

연동 설정 최종 검증: 전체 76개 중 75개 통과, 실패 0개, 실제 SVN CLI 테스트 1개는 도구 부재로 skip.
Swift arm64/macOS12 컴파일과 JS 문법·diff 검사도 통과했다. 배포 테스트는 개인 zsh 초기화와 실제 gh 설치에 영향받지 않도록 격리했다.
