# 도검강호로 세이브 에디터 v1.0

*도검강호로* (`daojianjianghulu`, Steam AppID `2361680`) 전용 오프라인 세이브 에디터입니다.  
게임 바이너리 역공학(REA)으로 검증된 `PlayerData_<슬롯>.save` 포맷(`LEB128` + `KeyPlayerDatammjh2023<ID>` + `Raw DEFLATE` + UTF-8/UTF-16LE JSON)을 손실 없이 읽고 기록합니다.

## 3가지 실행 방식

1. **단일 HTML 오프라인 웹 앱** (`dist/PathOfKungFuSaveEditor-v1.0.html`)
   - 외부 네트워크 연결이 완전히 차단된 단일 HTML 파일입니다(`connect-src 'none'`).
   - 브라우저에서 바로 열어 `.save` 파일을 불러오거나 샘플 데이터를 편집해 새 `.save` 파일로 내려받을 수 있습니다.
   - 6개 키보드 접근성 탭(`기본·재화`, `능력·전투`, `특성·경맥`, `무학·심결`, `소지품·장비`, `동료·검증`), 빠른 프리셋 6종, 자동/밝게/어둡게 테마 전환을 제공합니다.
2. **Python 3 CLI & 로컬 루프백 브리지** (`pokf_editor.py`)
   - 외부 패키지 설치 없이 Python 3 표준 라이브러리만으로 동작합니다.
   - `discover`, `inspect`, `validate`, `presets`, `apply`, `restore`, `demo`, `serve` 명령을 지원합니다.
   - `python3 pokf_editor.py serve --open-browser` 실행 시 `127.0.0.1` 전용 서버와 `X-Pokf-Token` CSRF 보호를 통해 저장 폴더 자동 탐색·백업·복원을 수행합니다.
3. **Windows 독립 실행형 데스크톱 앱** (`dist/PathOfKungFuSaveEditor-v1.0.exe`)
   - `.NET Framework 4.8` + `WebView2` 기반 64비트 실행 파일입니다.
   - 기본 저장 폴더(`%USERPROFILE%\AppData\LocalLow\HuaLongZ\saves\`)를 자동 탐색하며 `WebView2` 설정에서 개발자 도구·호스트 객체·외부 탐색을 차단합니다.

## 안전 장치

- **자동 백업 우선 원칙**: 모든 덮어쓰기·복원 작업 전 `backups/` 폴더에 타임스탬프 `.bak` 사본을 생성하고 SHA-256 해시를 대조 검증합니다(최대 20개 보관).
- **원자적 파일 교체**: 임시 파일 작성 및 플러시 후 원자적으로 교체(`os.replace` / Win32 `MoveFileExW`)하므로 쓰기 도중 중단되어도 원본이 손상되지 않습니다.
- **경로·링크 보안 검증**: 심볼릭 링크, Windows NTFS 정션 및 리파스 포인트, 하드 링크, UNC 경로, NTFS 대체 데이터 스트림(`:`), Windows 예약 장치 이름(`CON`, `NUL` 등)을 모두 거부합니다.
- **게임 실행 잠금**: 게임 프로세스(`daojianjianghulu`)가 실행 중이면 세이브 덮어쓰기를 거부합니다.

## 주요 CLI 사용 예

```bash
# 저장 폴더 자동 탐색
python3 pokf_editor.py discover

# 저장 파일 내용 및 키 확인
python3 pokf_editor.py inspect PlayerData_1.save

# 무결성·스키마 검증
python3 pokf_editor.py validate PlayerData_1.save

# 프리셋 적용 (자동 백업 후 저장)
python3 pokf_editor.py apply PlayerData_1.save --preset wealth

# 로컬 웹 UI 서버 실행
python3 pokf_editor.py serve --open-browser
```

## 테스트 실행

```bash
# 카탈로그 및 단일 HTML 무결성 확인
python3 tools/extract_catalog.py --check-only
python3 build.py --check

# 코덱·코어·카탈로그 단위 테스트
node tests/test_editor.cjs

# CLI·HTTP 보안 테스트
python3 -W error -B -m unittest discover -s tests -v

# 브라우저 E2E (Mode A file:// + Mode B 루프백 HTTP)
node tests/test_playwright_e2e.cjs
```

## 라이선스

- 본 도구 소스: `LICENSE` 참조
- 포함된 Microsoft WebView2 SDK 바이너리: `dist/WebView2-LICENSE.txt` 참조
