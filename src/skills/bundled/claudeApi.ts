import { readdir } from 'fs/promises'
import { getCwd } from '../../utils/cwd.js'
import { registerBundledSkill } from '../bundledSkills.js'

// claudeApiContent.js 打包了 247KB 的 .md 纯文本内容。
// 为了防止浪费内存，这里做了一个惰性加载 (Lazy-load)：只有在 getPromptForCommand 
// 被真正调用时（即用户敲下 /claude-api / /api），这些文本才会进入内存。
type SkillContent = typeof import('./claudeApiContent.js')

type DetectedLanguage =
  | 'python'
  | 'typescript'
  | 'java'
  | 'go'
  | 'ruby'
  | 'csharp'
  | 'php'
  | 'curl'

/** 语言特征指纹表：通过探测当前目录的文件是否存在，猜测当前项目开发语言 */
const LANGUAGE_INDICATORS: Record<DetectedLanguage, string[]> = {
  python: ['.py', 'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
  typescript: ['.ts', '.tsx', 'tsconfig.json', 'package.json'],
  java: ['.java', 'pom.xml', 'build.gradle'],
  go: ['.go', 'go.mod'],
  ruby: ['.rb', 'Gemfile'],
  csharp: ['.cs', '.csproj'],
  php: ['.php', 'composer.json'],
  curl: [],
}

/**
 * 读取当前工作区目录并探测项目的主力语言。
 * 如果找到了特征文件，就返回对应的语言枚举，用于后续给模型定向投射该语言的 SDK 文档。
 */
async function detectLanguage(): Promise<DetectedLanguage | null> {
  const cwd = getCwd()
  let entries: string[]
  try {
    entries = await readdir(cwd)
  } catch {
    return null
  }

  for (const [lang, indicators] of Object.entries(LANGUAGE_INDICATORS) as [
    DetectedLanguage,
    string[],
  ][]) {
    if (indicators.length === 0) continue
    for (const indicator of indicators) {
      if (indicator.startsWith('.')) {
        if (entries.some(e => e.endsWith(indicator))) return lang
      } else {
        if (entries.includes(indicator)) return lang
      }
    }
  }
  return null
}

/** 根据探测到的语言，仅从打包好的静态文件映射中剔出对应语言和 shared 公共部分的 markdown 文档路径 */
function getFilesForLanguage(
  lang: DetectedLanguage,
  content: SkillContent,
): string[] {
  return Object.keys(content.SKILL_FILES).filter(
    path => path.startsWith(`${lang}/`) || path.startsWith('shared/'),
  )
}

function processContent(md: string, content: SkillContent): string {
  // Strip HTML comments. Loop to handle nested comments.
  let out = md
  let prev
  do {
    prev = out
    out = out.replace(/<!--[\s\S]*?-->\n?/g, '')
  } while (out !== prev)

  out = out.replace(
    /\{\{(\w+)\}\}/g,
    (match, key: string) =>
      (content.SKILL_MODEL_VARS as Record<string, string>)[key] ?? match,
  )
  return out
}

/**
 * 将查找到的所有相关 MD 文档组装成带 XML Tag（例如 <doc path="...">）格式的大型字符串。
 * 这样做是为了通过 XML 结构清晰地向 Claude 模型注入知识背景，防止产生幻觉。
 */
function buildInlineReference(
  filePaths: string[],
  content: SkillContent,
): string {
  const sections: string[] = []
  for (const filePath of filePaths.sort()) {
    const md = content.SKILL_FILES[filePath]
    if (!md) continue
    sections.push(
      `<doc path="${filePath}">\n${processContent(md, content).trim()}\n</doc>`,
    )
  }
  return sections.join('\n\n')
}

const INLINE_READING_GUIDE = `## Reference Documentation

The relevant documentation for your detected language is included below in \`<doc>\` tags. Each tag has a \`path\` attribute showing its original file path. Use this to find the right section:

### Quick Task Reference

**Single text classification/summarization/extraction/Q&A:**
→ Refer to \`{lang}/claude-api/README.md\`

**Chat UI or real-time response display:**
→ Refer to \`{lang}/claude-api/README.md\` + \`{lang}/claude-api/streaming.md\`

**Long-running conversations (may exceed context window):**
→ Refer to \`{lang}/claude-api/README.md\` — see Compaction section

**Prompt caching / optimize caching / "why is my cache hit rate low":**
→ Refer to \`shared/prompt-caching.md\` + \`{lang}/claude-api/README.md\` (Prompt Caching section)

**Function calling / tool use / agents:**
→ Refer to \`{lang}/claude-api/README.md\` + \`shared/tool-use-concepts.md\` + \`{lang}/claude-api/tool-use.md\`

**Batch processing (non-latency-sensitive):**
→ Refer to \`{lang}/claude-api/README.md\` + \`{lang}/claude-api/batches.md\`

**File uploads across multiple requests:**
→ Refer to \`{lang}/claude-api/README.md\` + \`{lang}/claude-api/files-api.md\`

**Agent with built-in tools (file/web/terminal) (Python & TypeScript only):**
→ Refer to \`{lang}/agent-sdk/README.md\` + \`{lang}/agent-sdk/patterns.md\`

**Error handling:**
→ Refer to \`shared/error-codes.md\`

**Latest docs via WebFetch:**
→ Refer to \`shared/live-sources.md\` for URLs`

/**
 * 构建发给 Claude 的最终系统提示词。
 * 它巧妙地把 "基础提示词"、"如何阅读指南(Reading Guide)" 以及 "带 XML 的官方 API 文档" 拼接在了一起。
 * 当你在对话中问 "用 Python 写一个使用 tools_use 的 Agent"，AI 不会直接瞎编，而是根据这里拼接好的文档写出高分代码。
 */
function buildPrompt(
  lang: DetectedLanguage | null,
  args: string,
  content: SkillContent,
): string {
  // Take the SKILL.md content up to the "Reading Guide" section
  const cleanPrompt = processContent(content.SKILL_PROMPT, content)
  const readingGuideIdx = cleanPrompt.indexOf('## Reading Guide')
  const basePrompt =
    readingGuideIdx !== -1
      ? cleanPrompt.slice(0, readingGuideIdx).trimEnd()
      : cleanPrompt

  const parts: string[] = [basePrompt]

  if (lang) {
    const filePaths = getFilesForLanguage(lang, content)
    const readingGuide = INLINE_READING_GUIDE.replace(/\{lang\}/g, lang)
    parts.push(readingGuide)
    parts.push(
      '---\n\n## Included Documentation\n\n' +
        buildInlineReference(filePaths, content),
    )
  } else {
    // 降级策略: 没有探测到语言，丢给它所有文档，让它去问用户
    parts.push(INLINE_READING_GUIDE.replace(/\{lang\}/g, 'unknown'))
    parts.push(
      'No project language was auto-detected. Ask the user which language they are using, then refer to the matching docs below.',
    )
    parts.push(
      '---\n\n## Included Documentation\n\n' +
        buildInlineReference(Object.keys(content.SKILL_FILES), content),
    )
  }

  // Preserve the "When to Use WebFetch" and "Common Pitfalls" sections
  const webFetchIdx = cleanPrompt.indexOf('## When to Use WebFetch')
  if (webFetchIdx !== -1) {
    parts.push(cleanPrompt.slice(webFetchIdx).trimEnd())
  }

  if (args) {
    parts.push(`## User Request\n\n${args}`)
  }

  return parts.join('\n\n')
}

/**
 * 注册 /claude-api (也称 /api) 高阶技能。
 * 该技能通过 RAG (检索增强生成) 机制，充当使用 Anthropic API 时的“专家模式”。
 * 当用户提到 SDK、Agent 等词汇时，系统会自动触发此技能。
 */
export function registerClaudeApiSkill(): void {
  registerBundledSkill({
    name: 'claude-api',
    description:
      'Build apps with the Claude API or Anthropic SDK.\n' +
      'TRIGGER when: code imports `anthropic`/`@anthropic-ai/sdk`/`claude_agent_sdk`, or user asks to use Claude API, Anthropic SDKs, or Agent SDK.\n' +
      'DO NOT TRIGGER when: code imports `openai`/other AI SDK, general programming, or ML/data-science tasks.',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    userInvocable: true,
    async getPromptForCommand(args) {
      // 惰性加载超大内存的静态文件
      const content = await import('./claudeApiContent.js')
      // 智能探测用户当前目录语言
      const lang = await detectLanguage()
      // 拼接巨无霸 Prompt
      const prompt = buildPrompt(lang, args, content)
      return [{ type: 'text', text: prompt }]
    },
  })
}
