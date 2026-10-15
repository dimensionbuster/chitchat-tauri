// npm version 의 `preversion` 훅: dev 브랜치에서만 릴리스 버전을 올린다.
import { execFileSync } from 'node:child_process'

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
if (branch !== 'dev') {
  console.error(`dev 브랜치에서만 실행한다 (현재: ${branch})`)
  process.exit(1)
}
