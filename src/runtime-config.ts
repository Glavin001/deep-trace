import * as path from 'path';

export interface RuntimeConfig {
    debugLogEnabled: boolean;
    consoleExporterEnabled: boolean;
    localExporterEnabled: boolean;
    jsonlEnabled: boolean;
    jsonlDir: string;
    jsonlFile: string;
    logFile: string;
    maxSpans: number;
    serverPort: number;
    isDevelopment: boolean;
    serviceName: string;
    otlpHttpEndpoint?: string;
    otlpHeaders: Record<string, string>;
    otlpTimeoutMillis: number;
    otlpConcurrencyLimit: number;
}

export interface SpanRequestAttributes {
    url?: string;
    host?: string;
    target?: string;
}

function parseInteger(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseHeaderList(rawValue: string | undefined): Record<string, string> {
    if (!rawValue) return {};

    return rawValue
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((headers, part) => {
            const separatorIndex = part.indexOf('=');
            if (separatorIndex <= 0) return headers;
            const key = part.slice(0, separatorIndex).trim();
            const value = part.slice(separatorIndex + 1).trim();
            if (key) headers[key] = value;
            return headers;
        }, {});
}

function normalizeOtlpHttpEndpoint(rawValue: string | undefined): string | undefined {
    if (!rawValue) return undefined;

    try {
        const url = new URL(rawValue);
        if (!url.pathname || url.pathname === '/') {
            url.pathname = '/v1/traces';
        }
        return url.toString();
    } catch {
        return rawValue;
    }
}

export function buildRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): RuntimeConfig {
    const jsonlDir = env.DEBUG_PROBE_DIR || path.join(cwd, '.debug');
    const tracesEndpoint = env.DEBUG_PROBE_OTLP_ENDPOINT
        || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        || env.OTEL_EXPORTER_OTLP_ENDPOINT;

    return {
        debugLogEnabled: env.DEBUG_PROBE_LOG !== 'false',
        consoleExporterEnabled: env.DEBUG_PROBE_CONSOLE === 'true',
        localExporterEnabled: env.DEBUG_PROBE_LOCAL_EXPORTER !== 'false',
        jsonlEnabled: env.DEBUG_PROBE_JSONL !== 'false',
        jsonlDir,
        jsonlFile: path.join(jsonlDir, 'traces.jsonl'),
        logFile: path.join(jsonlDir, 'probe.log'),
        maxSpans: parseInteger(env.DEBUG_PROBE_MAX_SPANS, 10000),
        serverPort: parseInteger(env.DEBUG_PROBE_PORT, 43210),
        isDevelopment: env.NODE_ENV === 'development',
        serviceName: env.OTEL_SERVICE_NAME || env.DEBUG_PROBE_SERVICE_NAME || 'deep-trace-node',
        otlpHttpEndpoint: normalizeOtlpHttpEndpoint(tracesEndpoint),
        otlpHeaders: parseHeaderList(env.DEBUG_PROBE_OTLP_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS),
        otlpTimeoutMillis: parseInteger(env.DEBUG_PROBE_OTLP_TIMEOUT_MS, 10000),
        otlpConcurrencyLimit: parseInteger(env.DEBUG_PROBE_OTLP_CONCURRENCY, 10),
    };
}

export function isInternalSpanRequest(
    attributes: SpanRequestAttributes,
    runtimeConfig: Pick<RuntimeConfig, 'serverPort' | 'otlpHttpEndpoint'>,
): boolean {
    const { url, host, target } = attributes;
    const values = [url, host, target].filter((value): value is string => Boolean(value));

    if (runtimeConfig.serverPort > 0) {
        const debugHosts = [
            `localhost:${runtimeConfig.serverPort}`,
            `127.0.0.1:${runtimeConfig.serverPort}`,
        ];
        if (
            values.some(value => debugHosts.some(debugHost => value.includes(debugHost)))
            || target?.includes('/remote-debug/')
        ) {
            return true;
        }
    }

    if (!runtimeConfig.otlpHttpEndpoint) return false;

    try {
        const endpoint = new URL(runtimeConfig.otlpHttpEndpoint);
        const endpointHost = endpoint.host;
        const endpointPath = endpoint.pathname;

        const urlMatches = url ? new URL(url) : undefined;
        if (urlMatches && urlMatches.host === endpointHost && urlMatches.pathname === endpointPath) {
            return true;
        }

        if (host === endpointHost && (!target || target === endpointPath || target.startsWith(endpointPath))) {
            return true;
        }

        if (values.some(value => value.includes(endpointHost) && value.includes(endpointPath))) {
            return true;
        }
    } catch {
        if (values.some(value => value.includes(runtimeConfig.otlpHttpEndpoint!))) {
            return true;
        }
    }

    return false;
}
