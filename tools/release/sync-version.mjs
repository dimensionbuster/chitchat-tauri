// npm version 의 `version` 훅에서 실행된다. package.json 버전을 tauri.conf.json / Cargo.toml / Cargo.lock 에 맞추고 stage 한다.
// 이후 npm 이 이 변경까지 포함해 커밋하고 v<버전> 태그를 만든다.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

const edit = (file, fn) => {
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (before === after) throw new Error(`${file}: 버전 치환 실패`)
  writeFileSync(file, after)
}

edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`))
edit('src-tauri/Cargo.toml', (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`))
edit('src-tauri/Cargo.lock', (s) => s.replace(/(name = "app"\r?\nversion = ")[^"]+(")/, `$1${version}$2`))

execFileSync('git', ['add', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'])
