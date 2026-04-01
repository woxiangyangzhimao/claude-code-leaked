// Content for the verify bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import cliMd from './verify/examples/cli.md'
import serverMd from './verify/examples/server.md'
import skillMd from './verify/SKILL.md'

/**
 * 这里的 Markdown 文件会在 Bun 构建时通过 TEXT Loader 直接被打包成字符串常量。
 * 目的是避免在生产环境 (运行时) 再去做磁盘 IO 读取。
 */
export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/cli.md': cliMd,
  'examples/server.md': serverMd,
}
