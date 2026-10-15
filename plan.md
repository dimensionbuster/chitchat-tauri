# chitchat-tauri plan

Goal: Electron chitchat -> Tauri 2 (Windows only) + Trystero (no own signaling server).

## Status
- [x] Tauri 2 scaffold, Rust commands (windows, tray, single-instance, storage, power, adblock, blobs), JS adapter (electronApi compatible)
- [x] Trystero mesh + Yjs provider; framework-free core/ (store, config, mesh, provider, room, net/*)
- [x] Network layer rewrite: removed 3 hand-rolled WebRTC stacks (~7k lines), Firebase, IndexedDB file cache
- [x] Disk blob store (content-addressed SHA-256, streaming, resumable) + swarm TransferService (segment hash, stall detection by progress, throughput-based window)
- [x] Profile pictures via blobs + awareness hashes
- [x] Net lab (WSL2 peer behind NAT + tc netem): 2GB both ways, peer leave/return, app restart resume, corruption recovery, 2-source swarm all PASS (docs/network-review.md)
- [x] Custom titlebar, YouTube embed, ad block (URL-checked WebResourceRequested handler), connection status in chat header
- [x] Updater (tauri-plugin-updater, signed) + NSIS installer builds (ChitChat_0.1.0_x64-setup.exe ~3.6MB); docs/RELEASE.md
- [ ] Confirm GitHub repo name used in updater endpoint (assumed dimensionbuster/chitchat-tauri); back up ~/.tauri/chitchat-updater.key
- [ ] Parallel bulk lanes (extra RTCPeerConnections) for high-RTT links (single SCTP ~1MB/s at 100ms RTT)
- [ ] Real second-device check (different home network / mobile hotspot); symmetric-NAT UX (TURN is optional via localStorage chitchat-turn)
- [ ] Tray menu / notification stacking visual check; run installer + update flow end-to-end on a clean profile
- [ ] Move remaining non-Vue logic (useWatchPartyQueue etc.) into core/ if React migration happens

## Known differences from Electron
- App identifier com.dimensionbuster.chitchat: new data dir, Electron IndexedDB/settings are not migrated (chat history re-syncs from peers).
- System resume detected by timer drift in JS (no powerMonitor in Tauri).
- Hidden windows keep running: Chromium flags disable background throttling for all WebView2 windows.

## Notes
- Electron-only: session.webRequest ad block, powerSaveBlocker, local HTTP server for YouTube origin.
- STUN still public (Google). TURN not available serverless.

