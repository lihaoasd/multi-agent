/**
 * 开发模式：并行启动服务端（tsx watch）与前端（vite）。
 * 说明：只用 stdio: 'inherit'（受限沙箱下 piped stdio 不可用），Ctrl+C 一并收摊。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

const targets = [
  { name: 'server', entry: 'node_modules/tsx/dist/cli.mjs', args: ['watch', 'src/bootstrap/main.ts'] },
  { name: 'web', entry: 'node_modules/vite/bin/vite.js', args: ['--config', 'web/vite.config.ts'] },
]

const children = []

function shutdown(signal) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  if (signal !== undefined) process.stdout.write(`[dev] 收到 ${signal}，已停止全部子进程\n`)
}

let failed = false
for (const target of targets) {
  const entry = resolve(root, target.entry)
  if (!existsSync(entry)) {
    console.error(`[dev] 缺少依赖入口：${target.entry}（请先 npm install）`)
    failed = true
    continue
  }
  const child = spawn(process.execPath, [entry, ...target.args], { cwd: root, stdio: 'inherit' })
  child.on('exit', (code) => {
    process.stdout.write(`[dev] ${target.name} 已退出（code=${code ?? 'null'}）\n`)
    shutdown()
  })
  children.push(child)
}

if (failed) {
  process.exitCode = 1
} else {
  process.stdout.write('[dev] 服务端 http://127.0.0.1:3000 · 前端 http://127.0.0.1:5173\n')
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal)
    process.exit(0)
  })
}
