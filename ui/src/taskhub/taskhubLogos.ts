// Existing local logos and licensed technology artwork; never loaded from a CDN at runtime.
export const taskhubLogos: Record<string, string> = {
  browser: new URL('../map/nodeCards/logos/chrome/chrome.svg', import.meta.url).href,
  dns: new URL('../map/nodeCards/logos/network/network.svg', import.meta.url).href,
  'load-balancer': new URL('../map/nodeCards/logos/loadBalancer/loadBalancer.svg', import.meta.url).href,
  envoy: new URL('../map/nodeCards/logos/envoy/envoy.svg', import.meta.url).href,
  web: new URL('../map/nodeCards/logos/nextjs/nextjs.svg', import.meta.url).href,
  bff: new URL('../map/nodeCards/logos/nestjs/nestjs.svg', import.meta.url).href,
  projects: new URL('../map/nodeCards/logos/nestjs/nestjs.svg', import.meta.url).href,
  tasks: new URL('../map/nodeCards/logos/fastapi/fastapi.svg', import.meta.url).href,
  comments: new URL('../map/nodeCards/logos/go/go.svg', import.meta.url).href,
  files: new URL('../map/nodeCards/logos/nestjs/nestjs.svg', import.meta.url).href,
  search: new URL('../map/nodeCards/logos/fastapi/fastapi.svg', import.meta.url).href,
  notifications: new URL('../map/nodeCards/logos/python/python.svg', import.meta.url).href,
  realtime: new URL('../map/nodeCards/logos/nodejs/nodejs.svg', import.meta.url).href,
  redis: new URL('../map/nodeCards/logos/redis/redis.svg', import.meta.url).href,
  storage: new URL('../map/nodeCards/logos/s3/s3.svg', import.meta.url).href,
  postgres: new URL('../map/nodeCards/logos/postgresql/postgresql.svg', import.meta.url).href,
  rabbitmq: new URL('../map/nodeCards/logos/rabbitmq/rabbitmq.svg', import.meta.url).href,
  opensearch: new URL('../map/nodeCards/logos/opensearch/opensearch.svg', import.meta.url).href,
  keycloak: new URL('../map/nodeCards/logos/keycloak/keycloak.svg', import.meta.url).href,
}
export const kubernetesLogo = new URL('../map/nodeCards/logos/kubernetes/kubernetes.svg', import.meta.url).href
