// Parses docker-compose.yml and checks the structure the stack depends on.
// This does NOT run docker compose. It only proves the file is valid YAML with the expected shape.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docker-compose.yml');
const doc = parse(readFileSync(file, 'utf8'));
const errors = [];
const services = doc?.services ?? {};

for (const name of ['redis', 'api', 'worker', 'ui']) {
  if (!services[name]) errors.push(`missing service: ${name}`);
}

const redis = services.redis;
if (redis) {
  if (redis.image !== 'redis:7-alpine') errors.push('redis image must be redis:7-alpine');
  if (!redis.healthcheck?.test) errors.push('redis needs a healthcheck');
}

for (const name of ['api', 'worker']) {
  const svc = services[name];
  if (!svc) continue;
  if (svc.depends_on?.redis?.condition !== 'service_healthy') {
    errors.push(`${name} must depend_on redis with condition service_healthy`);
  }
  if (svc.environment?.REDIS_URL !== 'redis://redis:6379') errors.push(`${name} REDIS_URL must point at redis:6379`);
}

const worker = services.worker;
if (worker) {
  if (worker.environment?.TRACE_DIR !== '/app/data/traces') errors.push('worker TRACE_DIR must be /app/data/traces');
  if (!worker.command?.join(' ').includes('src/queue/worker.ts')) errors.push('worker command must run src/queue/worker.ts');
  // OTLP export is switched on by .env, so the one worker must read it. A second worker
  // service would split the shared BullMQ queue and send only part of the jobs to OTLP.
  const envFiles = (worker.env_file ?? []).map((e) => (typeof e === 'string' ? e : e.path));
  if (!envFiles.includes('.env')) errors.push('worker must read .env through env_file (optional OTLP export)');
}

if (services['worker-langfuse']) {
  errors.push('worker-langfuse must not exist: a second worker on the same queue splits the jobs');
}
for (const [name, svc] of Object.entries(services)) {
  if (name !== 'worker' && svc.profiles?.includes('langfuse')) {
    errors.push(`${name} must not use the langfuse profile: it would split the shared queue`);
  }
}

const ui = services.ui;
if (ui) {
  if (!ui.command?.join(' ').includes('src/ui/server.ts')) errors.push('ui command must run src/ui/server.ts');
  if (!ui.ports?.includes('4318:4318')) errors.push('ui must publish 4318:4318');
  if (String(ui.environment?.UI_HOST) !== '0.0.0.0') errors.push('ui UI_HOST must be 0.0.0.0 so the published port is reachable');
}

if (services.api && !services.api.ports?.includes('3000:3000')) errors.push('api must publish 3000:3000');

if (!doc?.volumes || !('traces' in doc.volumes)) errors.push('top-level named volume "traces" is missing');
for (const name of ['worker', 'ui']) {
  const mounts = services[name]?.volumes ?? [];
  if (!mounts.includes('traces:/app/data/traces')) errors.push(`${name} must mount traces at /app/data/traces`);
}

for (const [name, svc] of Object.entries(services)) {
  if (svc.profiles && !Array.isArray(svc.profiles)) errors.push(`${name} profiles must be a list`);
  if (svc.env_file) {
    for (const entry of svc.env_file) {
      if (typeof entry === 'string' ? entry !== '.env' : entry.path !== '.env' || entry.required !== false) {
        errors.push(`${name} env_file must reference only .env with required: false`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('docker-compose.yml validation failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log(`docker-compose.yml parses as YAML; services: ${Object.keys(services).join(', ')}`);
