// Core
import { readFileSync, writeFileSync } from 'node:fs'

// Keep notices beside the built UI so the collector's embedded assets include them.
const sources = [
  ['Technology asset provenance', '../src/map/nodeCards/logos/README.md'],
  ['Devicon — MIT', '../src/map/nodeCards/logos/LICENSE-devicon.txt'],
  ['Keycloak — Apache-2.0', '../src/map/nodeCards/logos/keycloak/LICENSE.txt'],
  ['OpenSearch — BSD-3-Clause', '../src/map/nodeCards/logos/opensearch/LICENSE.txt'],
  ['Lucide — ISC / MIT', '../src/map/icons/LICENSE-lucide.txt'],
]
const notices = sources.map(([title, path]) => `${title}\n${'='.repeat(title.length)}\n\n${readFileSync(new URL(path, import.meta.url), 'utf8')}`).join('\n\n')
writeFileSync(new URL('../dist/third-party-icons.txt', import.meta.url), notices)
