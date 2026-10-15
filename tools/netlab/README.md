# 네트워크 랩

실제 Tauri 앱(Windows, WebView2) ↔ WSL2의 Chromium 피어(별도 NAT 네트워크)로 파일 전송과 동기화를 시험한다.
같은 PC의 두 창과 달리 NAT, 지연, 패킷 손실, 대역폭 제한을 적용할 수 있다.

## 구성

- Windows: `tauri dev`를 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`로 실행 (러너가 CDP로 제어).
- WSL(Ubuntu, root): Node 18+ 와 `/opt/lab`에 `npm i playwright && npx playwright install --with-deps chromium`.
- `peer.cjs`: 헤드리스 Chromium으로 앱(dist)을 열고 Tauri 명령(블롭 저장소 등)을 Node가 대신 구현한다. 제어 API로 시드 파일 생성, `tc netem`, 손상 주입을 한다.

## 사용

```bash
bash tools/netlab/deploy.sh 1          # 빌드 → WSL 배포 → 피어 1개 시작 (2면 swarm용 피어 2개)
node tools/netlab/run.mjs smoke        # 연결 확인 (연결 시간, ICE 경로)
node tools/netlab/run.mjs xfer lab2win 100 "delay 50ms loss 0.1%"   # 전송 + 네트워크 조건
node tools/netlab/chaos.mjs peer-leave # 전송 중 송신 피어 이탈/복귀
node tools/netlab/chaos.mjs app-restart  # 전송 중 수신 앱 재시작 후 이어받기
node tools/netlab/chaos.mjs corrupt      # 손상 데이터 → 해시 검증 → 재시도
node tools/netlab/chaos.mjs swarm        # 보유 피어 2명에서 동시 수신 (deploy.sh 2)
node tools/netlab/bench.mjs lab2win 1024 4 64      # 채널 처리량 (Trystero 액션)
node tools/netlab/bench-raw.mjs lab2win 64 4096 64 # 전용 RTCDataChannel 처리량
```

## 주의

- `netem`은 WSL 쪽 송신(egress)에만 걸린다. Windows → WSL 방향의 손실/지연은 요청·응답 지연으로만 반영된다.
- 이 환경의 원시 UDP 상한(약 16MB/s)이 WebRTC 처리량을 약 7MB/s로 제한한다. 절대 속도보다 **성공 여부, 복구, 메모리, 진행률**을 보는 시험이다.
- 대용량 시험 파일은 `test-data/`(gitignore)에 생긴다. 끝나면 지운다.
