// 사용법: npm run release:bump -- 0.2.0
// tauri.conf.json / Cargo.toml / package.json 버전을 올리고, 커밋 + v<버전> 태그를 만든다.
// dev 브랜치에서만 실행된다. 푸시는 직접 한다: git push origin dev --follow-tags
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('사용법: npm run release:bump -- <major.minor.patch>')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'dev') {
  console.error(`dev 브랜치에서만 실행한다 (현재: ${branch})`)
  process.exit(1)
}
if (git('status', '--porcelain', '--untracked-files=no')) {
  console.error('커밋되지 않은 변경이 있다. 먼저 커밋하라.')
  process.exit(1)
}
if (git('tag', '--list', `v${version}`)) {
  console.error(`태그 v${version} 이미 존재`)
  process.exit(1)
}

const edit = (file, fn) => {
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (before === after) throw new Error(`${file}: 버전 치환 실패`)
  writeFileSync(file, after)
}

edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`))
edit('package.json', (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`))
edit('src-tauri/Cargo.toml', (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`))
// Cargo.lock의 app 패키지 버전 갱신
edit('src-tauri/Cargo.lock', (s) =>
  s.replace(/(name = "app"\r?\nversion = ")[^"]+(")/, `$1${version}$2`),
)

git('add', 'src-tauri/tauri.conf.json', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock')
git('commit', '-m', `chore: release v${version}`)
git('tag', '-a', `v${version}`, '-m', `v${version}`)

console.log(`v${version} 커밋·태그 완료. 푸시: git push origin dev --follow-tags`)
