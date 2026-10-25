// Core
import { describe, expect, it } from 'vitest'
// Utils
import { syntheticGraph } from './syntheticGraph'

describe('syntheticGraph', () => {
  it('builds the target size with distinct edges between existing nodes, the same every time', () => {
    const graph = syntheticGraph()

    expect(graph.nodes).toHaveLength(50)
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(100)
    const ids = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)).toBe(true)
    expect(syntheticGraph()).toEqual(graph)
  })
})
