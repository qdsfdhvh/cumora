/**
 * Which `AgentRuntimeClient` impl this process uses.
 *
 * Personal build: the managed-pod HTTP runtime (Kubernetes per-agent
 * pods) has been removed along with the rest of Cumora Cloud. Agent
 * turns always run in this server process via `inprocClient` — agent
 * *engines* still execute wherever their paired BYOA computer lives.
 */
import type { AgentRuntimeClient } from './client.js'
import { inprocClient } from './inproc-client.js'

export const runtime: AgentRuntimeClient = inprocClient
