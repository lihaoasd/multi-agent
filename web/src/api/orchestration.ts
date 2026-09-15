import { apiRequest } from './client'

/** 编排图（contract.md / orchestration.md §7；S7） */

export interface OrchestrationNode {
  readonly instanceId: string
  readonly x: number
  readonly y: number
  readonly collapsed: boolean
}

export interface OrchestrationEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly createdAt: string
}

export interface OrchestrationGraph {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly version: number
  readonly updatedAt: string
  readonly updatedBy: string
  readonly nodes: readonly OrchestrationNode[]
  readonly edges: readonly OrchestrationEdge[]
}

export const orchestrationApi = {
  get: (projectId: string): Promise<OrchestrationGraph> =>
    apiRequest('GET', `/api/projects/${encodeURIComponent(projectId)}/orchestration`),
  save: (
    projectId: string,
    payload: {
      readonly version: number
      readonly nodes: readonly OrchestrationNode[]
      readonly edges: readonly { readonly id?: string; readonly from: string; readonly to: string }[]
    },
  ): Promise<OrchestrationGraph> =>
    apiRequest('PUT', `/api/projects/${encodeURIComponent(projectId)}/orchestration`, payload),
}
