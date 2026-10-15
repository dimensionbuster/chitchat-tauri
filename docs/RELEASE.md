# 릴리스 절차

## 한 번만 하는 설정

1. **서명 키**: 업데이트 파일은 키로 서명되고, 앱은 공개키로 검증한다.
   - 개인키: `~/.tauri/chitchat-updater.key` (**비밀번호 없음. 절대 저장소에 넣지 말고 안전한 곳에 백업**한다. 잃어버리면 기존 사용자에게 업데이트를 보낼 수 없다.)
   - 공개키: `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 이미 들어 있다.
   - 새로 만들려면: `npx tauri signer generate -w ~/.tauri/chitchat-updater.key` (공개키를 설정에 반영해야 하며, 키를 바꾸면 이미 설치된 앱은 업데이트를 받지 못한다).
2. **엔드포인트**: `plugins.updater.endpoints`가 `https://github.com/dimensionbuster/chitchat-tauri/releases/latest/download/latest.json`을 가리킨다. 저장소 이름이 다르면 이 주소를 바꾼다.

## 새 버전 내기

1. `src-tauri/tauri.conf.json`과 `src-tauri/Cargo.toml`, `package.json`의 버전을 올린다.
2. 서명하면서 빌드한다.
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$HOME\.tauri\chitchat-updater.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npx tauri build
   ```
   결과: `src-tauri/target/release/bundle/nsis/ChitChat_<버전>_x64-setup.exe`와 `.sig`.
3. GitHub Release(태그 `v<버전>`)를 만들고 설치 파일(`.exe`)과 아래 `latest.json`을 올린다.
   ```json
   {
     "version": "0.1.1",
     "notes": "변경 내용",
     "pub_date": "2026-10-15T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<.sig 파일의 내용 전체>",
         "url": "https://github.com/dimensionbuster/chitchat-tauri/releases/download/v0.1.1/ChitChat_0.1.1_x64-setup.exe"
       }
     }
   }
   ```
4. 설치된 앱은 시작 30초 뒤와 6시간마다 확인하고, 새 버전이 있으면 한 번 물어본 뒤 설치한다. 홈 화면의 "업데이트 확인"으로 수동 확인도 된다.

## 참고

- 로그인 시 자동 시작은 릴리스 빌드에서만 켜진다. 테스트 실행은 `CHITCHAT_NO_AUTOSTART=1`로 끈다.
- 앱 식별자는 `com.dimensionbuster.chitchat`이다. 바꾸면 사용자 데이터 폴더가 달라진다(Electron 버전의 데이터는 이어받지 않는다).
