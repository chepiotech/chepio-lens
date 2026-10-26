export type Microfrontend = { name: string; framework: string; pages?: string[] }
export type NodeMetadata = { technologies?: string[]; pages?: string[]; microfrontends?: Microfrontend[] }

export const FRONTEND_FRAMEWORKS = new Set(['react', 'vue', 'angular', 'svelte', 'solid', 'preact', 'nextjs', 'nuxt', 'qwik'])
const encoder = new TextEncoder()

function label(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text || /[\u0000-\u001f\u007f-\u009f]/.test(text)) return undefined
  let result = ''
  let size = 0
  for (const char of text) {
    size += encoder.encode(char).length
    if (size > limit) break
    result += char
  }
  return result
}

function technology(value: unknown): string | undefined {
  const raw = label(value, 48)
  if (!raw || !/^[a-zA-Z0-9 .+#_-]+$/.test(raw)) return undefined
  const text = raw.toLowerCase()
  const aliases: Record<string, string> = { vuejs: 'vue', reactjs: 'react', 'next.js': 'nextjs', nuxtjs: 'nuxt' }
  return Object.hasOwn(aliases, text) ? aliases[text] : text
}

/** Static SDK settings only. Limits and normalization mirror conventions/src/node_metadata.rs. */
export function normalizeNodeMetadata(input: unknown): Required<NodeMetadata> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const technologies = [...new Set((Array.isArray(value.technologies) ? value.technologies : []).slice(0, 16)
    .map(technology).filter((item): item is string => item !== undefined))]
  let remaining = 32
  const paths = (input: unknown): string[] => {
    const values = Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : []
    const result = [...new Set(values.slice(0, remaining).map((item) => {
      const path = item.split(/[?#]/, 1)[0]!.trim()
      return path.startsWith('/') && !path.startsWith('//') ? label(path, 160) : undefined
    }).filter((item): item is string => item !== undefined))]
    remaining -= result.length
    return result
  }
  const pages = paths(value.pages)
  const microfrontends: Microfrontend[] = []
  for (const item of (Array.isArray(value.microfrontends) ? value.microfrontends : []).slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const name = label(item.name, 64)
    const framework = technology(item.framework)
    if (!name || !framework || !FRONTEND_FRAMEWORKS.has(framework) || microfrontends.some((entry) => entry.name === name)) continue
    microfrontends.push({ name, framework, pages: paths(item.pages) })
  }
  return { technologies, pages, microfrontends }
}
