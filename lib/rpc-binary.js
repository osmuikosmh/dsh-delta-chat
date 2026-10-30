import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate a `deltachat-rpc-server` executable for the current platform.
 *
 * The kernel is a Rust binary, so the plugin does not vendor one: npm's
 * `@deltachat/stdio-rpc-server-<platform>-<arch>` optional dependencies
 * install exactly the right binary per machine. Resolution order:
 *
 * 1. explicit config `binary`
 * 2. `DELTA_CHAT_RPC_SERVER` environment variable
 * 3. a local `bin/deltachat-rpc-server` (developer override, not shipped)
 * 4. the platform's stdio-rpc-server npm package
 * 5. `deltachat-rpc-server` on PATH
 */
export const RPC_PACKAGE = '@deltachat/stdio-rpc-server'

const BINARY_NAMES = ['deltachat-rpc-server', 'deltachat-rpc-server.exe']

function exists(file) {
  try {
    return Boolean(file) && fs.existsSync(file)
  } catch {
    return false
  }
}

function resolvePackageBinary(target) {
  const spec = `${RPC_PACKAGE}-${target}`
  for (const name of BINARY_NAMES) {
    try {
      const file = fileURLToPath(import.meta.resolve(`${spec}/${name}`))
      if (exists(file)) return file
    } catch {
      // package for this platform is not installed - try the next name
    }
  }
  return null
}

function findOnPath(names = BINARY_NAMES) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (exists(file)) return file
    }
  }
  return null
}

/** Package name for one platform/arch pair, e.g. `darwin-arm64`. */
export function packageTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** Every reason a resolution attempt failed, for the final error message. */
export function triedHints(config = {}, platform = process.platform, arch = process.arch) {
  return {
    target: packageTarget(platform, arch),
    package: `${RPC_PACKAGE}-${packageTarget(platform, arch)}`,
    explicit: config.binary ? String(config.binary) : '',
    env: process.env.DELTA_CHAT_RPC_SERVER || '',
  }
}

/**
 * Resolve the RPC kernel and explain where it came from, so the service can
 * log a useful source and a friendlier "install this package" error.
 */
export function resolveBinary(config = {}, options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const packageRoot = options.packageRoot

  const explicit = config.binary ? String(config.binary).trim() : ''
  if (explicit) {
    const file = path.resolve(explicit)
    if (exists(file)) return { path: file, source: 'config' }
    throw new Error(`配置里的 binary 不存在：${file}`)
  }

  const fromEnv = String(process.env.DELTA_CHAT_RPC_SERVER || '').trim()
  if (fromEnv) {
    const file = path.resolve(fromEnv)
    if (exists(file)) return { path: file, source: 'env' }
    throw new Error(`DELTA_CHAT_RPC_SERVER 指向的文件不存在：${file}`)
  }

  if (packageRoot) {
    for (const name of BINARY_NAMES) {
      const file = path.join(packageRoot, 'bin', name)
      if (exists(file)) return { path: file, source: 'bundled' }
    }
  }

  const fromPackage = resolvePackageBinary(packageTarget(platform, arch))
  if (fromPackage) return { path: fromPackage, source: 'package' }

  const fromPath = findOnPath()
  if (fromPath) return { path: fromPath, source: 'path' }

  const hints = triedHints(config, platform, arch)
  throw new Error(
    `找不到可在 ${hints.target} 上运行的 deltachat-rpc-server。` +
    `请安装可选依赖 ${hints.package}（npm i ${hints.package}），` +
    '或把已有的二进制路径写进配置项 binary / 环境变量 DELTA_CHAT_RPC_SERVER。',
  )
}
