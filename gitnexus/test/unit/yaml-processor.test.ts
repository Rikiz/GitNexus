import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processStructure } from '../../src/core/ingestion/structure-processor.js';
import { isYamlFile, processYaml } from '../../src/core/ingestion/yaml-processor.js';

describe('yaml-processor', () => {
  it('detects YAML files by extension', () => {
    expect(isYamlFile('api/spec.yaml')).toBe(true);
    expect(isYamlFile('api/spec.yml')).toBe(true);
    expect(isYamlFile('api/spec.json')).toBe(false);
  });

  it('extracts service + endpoints from OpenAPI-style yaml', () => {
    const graph = createKnowledgeGraph();
    const filePath = 'api/openapi.yaml';
    processStructure(graph, [filePath]);

    const yamlContent = `
openapi: 3.0.0
info:
  title: user-service
paths:
  /api/v1/users:
    get:
      summary: list users
  /api/v1/users/{id}:
    get:
      summary: get user by id
`;

    const res = processYaml(graph, [{ path: filePath, content: yamlContent }], new Set([filePath]));

    expect(res.services).toBeGreaterThanOrEqual(1);
    expect(res.endpoints).toBe(2);
    expect(res.serviceEndpointRelations).toBe(2);

    const serviceNodes = graph.nodes.filter((n) => n.label === 'Interface');
    expect(serviceNodes.some((n) => n.properties.name === 'user-service')).toBe(true);

    const routeNodes = graph.nodes.filter((n) => n.label === 'Route');
    const routeNames = routeNodes.map((n) => n.properties.name);
    expect(routeNames).toContain('/api/v1/users');
    expect(routeNames).toContain('/api/v1/users/{id}');

    const exposes = graph.relationships.filter((r) => r.type === 'SERVICE_EXPOSES_ENDPOINT');
    const belongs = graph.relationships.filter((r) => r.type === 'ENDPOINT_BELONGS_TO_SERVICE');
    expect(exposes).toHaveLength(2);
    expect(belongs).toHaveLength(2);
  });

  it('handles service maps and endpoint arrays flexibly', () => {
    const graph = createKnowledgeGraph();
    const filePath = 'config/services.yml';
    processStructure(graph, [filePath]);

    const yamlContent = `
services:
  auth-service:
    endpoints:
      - /api/v1/login
      - /api/v1/logout
  profile-service:
    routes:
      read: /api/v1/profile
`;

    const res = processYaml(graph, [{ path: filePath, content: yamlContent }], new Set([filePath]));

    expect(res.services).toBeGreaterThanOrEqual(2);
    expect(res.endpoints).toBe(3);
    expect(res.serviceEndpointRelations).toBe(3);

    const routeNames = graph.nodes
      .filter((n) => n.label === 'Route')
      .map((n) => n.properties.name)
      .sort();
    expect(routeNames).toEqual(['/api/v1/login', '/api/v1/logout', '/api/v1/profile']);
  });

  it('creates endpoints even when service is not explicit', () => {
    const graph = createKnowledgeGraph();
    const filePath = 'api/routes.yaml';
    processStructure(graph, [filePath]);

    const yamlContent = `
endpoints:
  - /health
  - /ready
`;

    const res = processYaml(graph, [{ path: filePath, content: yamlContent }], new Set([filePath]));

    expect(res.endpoints).toBe(2);
    expect(res.fileRouteLinks).toBe(2);
    expect(res.serviceEndpointRelations).toBe(0);

    const handlesRoute = graph.relationships.filter((r) => r.type === 'HANDLES_ROUTE');
    expect(handlesRoute).toHaveLength(2);
  });
});

