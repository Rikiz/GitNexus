/**
 * YAML Processor
 *
 * Standalone YAML extractor for API-oriented metadata:
 * - service/interface names
 * - endpoint URIs
 *
 * Follows the same custom-processor pattern as markdown/cobol:
 * parse files directly and write nodes/relationships into the graph.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph } from '../graph/types.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

const YAML_EXTENSIONS = new Set(['.yaml', '.yml']);

const SERVICE_CONTAINER_KEYS = new Set([
  'service',
  'services',
  'component',
  'components',
  'interface',
  'interfaces',
  'application',
  'applications',
  'module',
  'modules',
  'api',
  'apis',
]);

const SERVICE_NAME_KEYS = new Set([
  'service',
  'service_name',
  'servicename',
  'component',
  'component_name',
  'componentname',
  'interface',
  'interface_name',
  'interfacename',
  'application',
  'application_name',
  'name',
]);

const ENDPOINT_VALUE_KEYS = new Set([
  'endpoint',
  'endpoints',
  'uri',
  'uris',
  'url',
  'urls',
  'path',
  'paths',
  'route',
  'routes',
  'basepath',
  'base_path',
]);

const HTTP_METHOD_KEYS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

interface YamlFile {
  path: string;
  content: string;
}

export interface YamlProcessResult {
  services: number;
  endpoints: number;
  serviceEndpointRelations: number;
  fileRouteLinks: number;
  parseErrors: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeServiceName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Keep IDs compact and deterministic.
  return trimmed.slice(0, 200);
}

function endpointFromString(value: string): string | null {
  let raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const parsed = new URL(raw);
      raw = parsed.pathname || '/';
    } catch {
      return null;
    }
  }

  if (!raw.startsWith('/')) {
    if (raw.startsWith('api/')) {
      raw = `/${raw}`;
    } else {
      return null;
    }
  }

  raw = raw.replace(/\/{2,}/g, '/');
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/[\]{}]*$/.test(raw)) return null;
  return raw;
}

function inferServiceFromObject(
  node: Record<string, unknown>,
  parentKey?: string,
  currentKey?: string,
): string | undefined {
  for (const key of [
    'service',
    'service_name',
    'serviceName',
    'component',
    'component_name',
    'componentName',
    'interface',
    'interface_name',
    'interfaceName',
  ]) {
    const value = node[key];
    if (typeof value === 'string') {
      return normalizeServiceName(value) ?? undefined;
    }
  }

  if (typeof node.kind === 'string' && node.kind.toLowerCase() === 'service') {
    const metadata = node.metadata;
    if (isRecord(metadata) && typeof metadata.name === 'string') {
      return normalizeServiceName(metadata.name) ?? undefined;
    }
  }

  const info = node.info;
  if (isRecord(info) && typeof info.title === 'string') {
    return normalizeServiceName(info.title) ?? undefined;
  }

  if (!parentKey || !SERVICE_CONTAINER_KEYS.has(parentKey.toLowerCase()) || !currentKey) {
    return undefined;
  }
  if (/^\d+$/.test(currentKey)) return undefined;
  const asEndpoint = endpointFromString(currentKey);
  if (asEndpoint) return undefined;
  return normalizeServiceName(currentKey) ?? undefined;
}

export function isYamlFile(filePath: string): boolean {
  return YAML_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export const processYaml = (
  graph: KnowledgeGraph,
  files: YamlFile[],
  allPathSet: Set<string>,
): YamlProcessResult => {
  const result: YamlProcessResult = {
    services: 0,
    endpoints: 0,
    serviceEndpointRelations: 0,
    fileRouteLinks: 0,
    parseErrors: 0,
  };

  for (const file of files) {
    if (!isYamlFile(file.path)) continue;
    if (!allPathSet.has(file.path)) continue;

    const fileNodeId = generateId('File', file.path);
    if (!graph.getNode(fileNodeId)) continue;

    const services = new Map<string, { id: string; name: string }>();
    const endpoints = new Map<string, { id: string; name: string }>();
    const linkedEndpointKeys = new Set<string>();

    const getOrCreateService = (serviceName: string): { id: string; name: string } => {
      const key = serviceName.toLowerCase();
      const existing = services.get(key);
      if (existing) return existing;

      const nodeId = generateId('Interface', `yaml:${file.path}:${serviceName}`);
      const created = { id: nodeId, name: serviceName };
      services.set(key, created);

      graph.addNode({
        id: nodeId,
        label: 'Interface',
        properties: {
          name: serviceName,
          filePath: file.path,
          language: 'yaml',
          description: 'YAML service/interface',
        },
      });
      graph.addRelationship({
        id: generateId('CONTAINS', `${fileNodeId}->${nodeId}`),
        type: 'CONTAINS',
        sourceId: fileNodeId,
        targetId: nodeId,
        confidence: 1.0,
        reason: 'yaml-service-definition',
      });

      result.services++;
      return created;
    };

    const getOrCreateEndpoint = (endpoint: string, reason: string): { id: string; name: string } => {
      const existing = endpoints.get(endpoint);
      if (existing) return existing;

      const nodeId = generateId('Route', `yaml:${file.path}:${endpoint}`);
      const created = { id: nodeId, name: endpoint };
      endpoints.set(endpoint, created);

      graph.addNode({
        id: nodeId,
        label: 'Route',
        properties: {
          name: endpoint,
          filePath: file.path,
          language: 'yaml',
          description: 'YAML API endpoint',
        },
      });
      graph.addRelationship({
        id: generateId('HANDLES_ROUTE', `${fileNodeId}->${nodeId}`),
        type: 'HANDLES_ROUTE',
        sourceId: fileNodeId,
        targetId: nodeId,
        confidence: 0.9,
        reason,
      });

      result.endpoints++;
      result.fileRouteLinks++;
      return created;
    };

    const linkServiceToEndpoint = (serviceName: string, endpoint: string, reason: string): void => {
      const service = getOrCreateService(serviceName);
      const route = getOrCreateEndpoint(endpoint, reason);

      const relationKey = `${service.name.toLowerCase()}->${route.name}`;
      if (linkedEndpointKeys.has(relationKey)) return;
      linkedEndpointKeys.add(relationKey);

      graph.addRelationship({
        id: generateId('SERVICE_EXPOSES_ENDPOINT', `${service.id}->${route.id}`),
        type: 'SERVICE_EXPOSES_ENDPOINT',
        sourceId: service.id,
        targetId: route.id,
        confidence: 0.9,
        reason,
      });
      graph.addRelationship({
        id: generateId('ENDPOINT_BELONGS_TO_SERVICE', `${route.id}->${service.id}`),
        type: 'ENDPOINT_BELONGS_TO_SERVICE',
        sourceId: route.id,
        targetId: service.id,
        confidence: 0.9,
        reason,
      });

      result.serviceEndpointRelations++;
    };

    const addEndpointCandidate = (rawValue: string, serviceName: string | undefined, reason: string) => {
      const endpoint = endpointFromString(rawValue);
      if (!endpoint) return;
      getOrCreateEndpoint(endpoint, reason);
      if (serviceName) linkServiceToEndpoint(serviceName, endpoint, reason);
    };

    const collectEndpointsFromValue = (
      value: unknown,
      serviceName: string | undefined,
      reason: string,
      allowLooseStringValues = false,
    ): void => {
      if (typeof value === 'string') {
        addEndpointCandidate(value, serviceName, reason);
        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) collectEndpointsFromValue(item, serviceName, reason);
        return;
      }

      if (!isRecord(value)) return;

      for (const [rawKey, nested] of Object.entries(value)) {
        addEndpointCandidate(rawKey, serviceName, `${reason}-map-key`);

        const lower = rawKey.toLowerCase();
        const keySuggestsEndpoint =
          ENDPOINT_VALUE_KEYS.has(lower) ||
          lower.includes('path') ||
          lower.includes('uri') ||
          lower.includes('endpoint') ||
          lower.includes('route') ||
          lower === 'url';

        if ((allowLooseStringValues || keySuggestsEndpoint) && typeof nested === 'string') {
          addEndpointCandidate(nested, serviceName, `${reason}-${lower}`);
        }

        if (isRecord(nested) || Array.isArray(nested)) {
          collectEndpointsFromValue(nested, serviceName, reason, allowLooseStringValues);
        }
      }
    };

    const walk = (
      node: unknown,
      serviceName: string | undefined,
      parentKey: string | undefined,
      currentKey: string | undefined,
    ): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, serviceName, parentKey, undefined);
        return;
      }
      if (!isRecord(node)) return;

      const inferred = inferServiceFromObject(node, parentKey, currentKey);
      const activeService = inferred ?? serviceName;
      if (inferred) getOrCreateService(inferred);

      for (const [rawKey, value] of Object.entries(node)) {
        const key = rawKey.trim();
        const lower = key.toLowerCase();

        // OpenAPI-style: paths: { "/api/v1/users": { get: ... } }
        if (lower === 'paths' && isRecord(value)) {
          for (const [routeKey, routeValue] of Object.entries(value)) {
            addEndpointCandidate(routeKey, activeService, 'yaml-openapi-path');
            walk(routeValue, activeService, lower, routeKey);
          }
          continue;
        }

        const endpointFromKey = endpointFromString(key);
        if (endpointFromKey && (isRecord(value) || Array.isArray(value))) {
          addEndpointCandidate(endpointFromKey, activeService, 'yaml-endpoint-map-key');
        }

        if (SERVICE_NAME_KEYS.has(lower) && typeof value === 'string') {
          const explicit = normalizeServiceName(value);
          if (explicit) {
            getOrCreateService(explicit);
            // Give precedence to explicit name for nested endpoint fields
            collectEndpointsFromValue(node, explicit, 'yaml-service-block');
          }
        }

        if (ENDPOINT_VALUE_KEYS.has(lower)) {
          collectEndpointsFromValue(value, activeService, `yaml-${lower}`, true);
        }

        if (HTTP_METHOD_KEYS.has(lower) && currentKey) {
          addEndpointCandidate(currentKey, activeService, `yaml-http-${lower}`);
        }

        if (SERVICE_CONTAINER_KEYS.has(lower) && isRecord(value)) {
          for (const [childKey, childVal] of Object.entries(value)) {
            const childService =
              (isRecord(childVal)
                ? inferServiceFromObject(childVal, lower, childKey)
                : undefined) ??
              normalizeServiceName(childKey) ??
              activeService;
            if (childService) getOrCreateService(childService);
            walk(childVal, childService, lower, childKey);
          }
          continue;
        }

        if (SERVICE_CONTAINER_KEYS.has(lower) && Array.isArray(value)) {
          for (const item of value) {
            const childService = isRecord(item)
              ? inferServiceFromObject(item, lower, undefined) ?? activeService
              : activeService;
            if (childService) getOrCreateService(childService);
            walk(item, childService, lower, undefined);
          }
          continue;
        }

        const keySuggestsEndpoint =
          lower.includes('path') ||
          lower.includes('uri') ||
          lower.includes('endpoint') ||
          lower.includes('route') ||
          lower === 'url';
        if (keySuggestsEndpoint && typeof value === 'string') {
          addEndpointCandidate(value, activeService, `yaml-${lower}`);
        }

        if (isRecord(value) || Array.isArray(value)) {
          walk(value, activeService, lower, key);
        }
      }
    };

    try {
      const docs: unknown[] = [];
      yaml.loadAll(
        file.content,
        (doc: unknown) => {
          docs.push(doc);
        },
        { schema: yaml.JSON_SCHEMA },
      );
      for (const doc of docs) {
        walk(doc, undefined, undefined, undefined);
      }
    } catch {
      result.parseErrors++;
      continue;
    }

    // If one service is defined in this file, link orphan endpoints to it.
    if (services.size === 1) {
      const onlyService = services.values().next().value;
      if (onlyService) {
        for (const endpoint of endpoints.values()) {
          linkServiceToEndpoint(onlyService.name, endpoint.name, 'yaml-single-service-fallback');
        }
      }
    }
  }

  return result;
};
