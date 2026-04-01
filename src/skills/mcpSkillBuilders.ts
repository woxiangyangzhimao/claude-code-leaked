import type {
  createSkillCommand,
  parseSkillFrontmatterFields,
} from './loadSkillsDir.js'

/**
 * MCP (Model Context Protocol) 技能发现所需的两个 loadSkillsDir 函数的只写注册表。
 * 这是一个依赖图的叶子节点模块：它除了类型什么也不导入。
 * 这样做的目的是打破循环依赖：client.ts -> mcpSkills.ts -> loadSkillsDir.ts -> ... -> client.ts。
 * 
 * 为什么不用动态导入 `await import('loadSkillsDir')`？
 * 因为在 Bun 打包的二进制文件中，动态导入会导致运行时崩溃（路径解析会变成基于 /$bunfs/root/... 而非源码树）。
 * 如果在代码里写死字面量导入，它虽然可以工作，但会被 dependency-cruiser (循环依赖检查工具) 抓到。
 * 因为 loadSkillsDir 传递性地引用了几乎所有东西，增加这一条边会引发大量的循环依赖报警。
 * 
 * 注册发生在 loadSkillsDir.ts 模块初始化时（在任何 MCP server 连入之前静态求值）。
 */

export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP skill builders not registered — loadSkillsDir.ts has not been evaluated yet',
    )
  }
  return builders
}
