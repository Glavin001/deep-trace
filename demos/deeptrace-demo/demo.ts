/**
 * DeepTrace End-to-End Demo
 *
 * Generates realistic trace data with both "good" and "bad" runs
 * to demonstrate the full DeepTrace debugging workflow:
 *   1. Trace capture
 *   2. Graph enrichment
 *   3. Trace summary
 *   4. Divergence analysis
 *   5. Agent query interface
 *
 * Prerequisites: npm run stack:up (ClickHouse + OTel Collector running)
 */

import { trace, context, SpanStatusCode, propagation } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// ─── OTel Setup ──────────────────────────────────────────────────────────────

const provider = new NodeTracerProvider({
  resource: new Resource({ [ATTR_SERVICE_NAME]: 'deeptrace-demo' }),
});

provider.addSpanProcessor(
  new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    }),
  ),
);

provider.register();
const tracer = trace.getTracer('deeptrace-demo');

// ─── Simulated Application Functions ─────────────────────────────────────────

async function validateInput(input: string): Promise<{ valid: boolean; sanitized: string }> {
  return tracer.startActiveSpan('validateInput', async (span) => {
    span.setAttribute('function.name', 'validateInput');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', input);
    span.setAttribute('code.filepath', 'app/services/validation.ts');
    span.setAttribute('code.lineno', 15);

    await sleep(5);
    const sanitized = input.trim().toLowerCase();
    const valid = sanitized.length > 0 && sanitized.length < 200;

    span.setAttribute('function.return.value', JSON.stringify({ valid, sanitized }));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return { valid, sanitized };
  });
}

async function lookupUser(userId: string): Promise<{ id: string; name: string; role: string }> {
  return tracer.startActiveSpan('lookupUser', async (span) => {
    span.setAttribute('function.name', 'lookupUser');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', userId);
    span.setAttribute('code.filepath', 'app/services/users.ts');
    span.setAttribute('code.lineno', 42);
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.statement', `SELECT * FROM users WHERE id = '${userId}'`);

    await sleep(25);
    const user = { id: userId, name: 'Alice', role: 'admin' };

    span.setAttribute('function.return.value', JSON.stringify(user));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return user;
  });
}

async function processOrder(orderId: string, userId: string, shouldFail: boolean): Promise<any> {
  return tracer.startActiveSpan('processOrder', async (span) => {
    span.setAttribute('function.name', 'processOrder');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', orderId);
    span.setAttribute('function.args.1', userId);
    span.setAttribute('code.filepath', 'app/services/orders.ts');
    span.setAttribute('code.lineno', 78);

    await sleep(15);

    // Validate the order
    const validation = await validateOrderItems(orderId, shouldFail);
    if (!validation.valid) {
      span.recordException(new Error(validation.error!));
      span.setStatus({ code: SpanStatusCode.ERROR, message: validation.error });
      span.setAttribute('function.return.value', JSON.stringify({ error: validation.error }));
      span.end();
      return { error: validation.error };
    }

    // Calculate total
    const total = await calculateTotal(orderId, shouldFail);

    // Charge payment
    const payment = await chargePayment(orderId, total, shouldFail);

    const result = { orderId, userId, total, paymentId: payment.id, status: 'completed' };
    span.setAttribute('function.return.value', JSON.stringify(result));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  });
}

async function validateOrderItems(orderId: string, shouldFail: boolean): Promise<{ valid: boolean; error?: string }> {
  return tracer.startActiveSpan('validateOrderItems', async (span) => {
    span.setAttribute('function.name', 'validateOrderItems');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', orderId);
    span.setAttribute('code.filepath', 'app/services/orders.ts');
    span.setAttribute('code.lineno', 120);
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.statement', `SELECT * FROM order_items WHERE order_id = '${orderId}'`);

    await sleep(20);

    if (shouldFail) {
      const error = 'Item SKU-4532 is out of stock';
      span.recordException(new Error(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.setAttribute('function.return.value', JSON.stringify({ valid: false, error }));
      span.end();
      return { valid: false, error };
    }

    span.setAttribute('function.return.value', JSON.stringify({ valid: true }));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return { valid: true };
  });
}

async function calculateTotal(orderId: string, _shouldFail: boolean): Promise<number> {
  return tracer.startActiveSpan('calculateTotal', async (span) => {
    span.setAttribute('function.name', 'calculateTotal');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', orderId);
    span.setAttribute('code.filepath', 'app/services/pricing.ts');
    span.setAttribute('code.lineno', 33);

    await sleep(10);
    const total = 149.99;

    span.setAttribute('function.return.value', String(total));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return total;
  });
}

async function chargePayment(orderId: string, amount: number, shouldFail: boolean): Promise<{ id: string; status: string }> {
  return tracer.startActiveSpan('chargePayment', async (span) => {
    span.setAttribute('function.name', 'chargePayment');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', orderId);
    span.setAttribute('function.args.1', String(amount));
    span.setAttribute('code.filepath', 'app/services/payments.ts');
    span.setAttribute('code.lineno', 56);
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.url', 'https://api.stripe.example/charges');

    await sleep(50);

    if (shouldFail) {
      const error = 'Payment declined: insufficient funds';
      span.recordException(new Error(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.end();
      throw new Error(error);
    }

    const result = { id: `pay_${Date.now()}`, status: 'charged' };
    span.setAttribute('function.return.value', JSON.stringify(result));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  });
}

async function sendNotification(userId: string, message: string): Promise<void> {
  return tracer.startActiveSpan('sendNotification', async (span) => {
    span.setAttribute('function.name', 'sendNotification');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('function.args.0', userId);
    span.setAttribute('function.args.1', message);
    span.setAttribute('code.filepath', 'app/services/notifications.ts');
    span.setAttribute('code.lineno', 22);
    span.setAttribute('messaging.system', 'email');

    await sleep(30);

    span.setAttribute('function.return.value', 'sent');
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });
}

// ─── Scenario Runners ────────────────────────────────────────────────────────

async function runGoodScenario(): Promise<string> {
  return tracer.startActiveSpan('POST /api/checkout', async (span) => {
    span.setAttribute('function.name', 'POST /api/checkout');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.url', '/api/checkout');
    span.setAttribute('code.filepath', 'app/api/checkout/route.ts');
    span.setAttribute('code.lineno', 8);

    const traceId = span.spanContext().traceId;
    console.log(`  Good trace ID: ${traceId}`);

    const input = await validateInput('  Order #1234  ');
    const user = await lookupUser('user-001');
    const order = await processOrder('order-1234', user.id, false);
    await sendNotification(user.id, `Order ${order.orderId} confirmed! Total: $${order.total}`);

    span.setAttribute('function.return.value', JSON.stringify({ status: 'success', order }));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return traceId;
  });
}

async function runBadScenario(): Promise<string> {
  return tracer.startActiveSpan('POST /api/checkout', async (span) => {
    span.setAttribute('function.name', 'POST /api/checkout');
    span.setAttribute('function.type', 'user_function');
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.url', '/api/checkout');
    span.setAttribute('code.filepath', 'app/api/checkout/route.ts');
    span.setAttribute('code.lineno', 8);

    const traceId = span.spanContext().traceId;
    console.log(`  Bad trace ID:  ${traceId}`);

    try {
      const input = await validateInput('  Order #5678  ');
      const user = await lookupUser('user-002');
      const order = await processOrder('order-5678', user.id, true);

      if (order.error) {
        span.recordException(new Error(order.error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: order.error });
        span.setAttribute('function.return.value', JSON.stringify({ status: 'error', error: order.error }));
        span.end();
        return traceId;
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch (err: any) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
    }

    return traceId;
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('');
  console.log('DeepTrace End-to-End Demo');
  console.log('========================');
  console.log('');
  console.log('Generating traces...');
  console.log('');

  // Run good scenario
  console.log('1. Running GOOD scenario (successful checkout):');
  const goodTraceId = await runGoodScenario();
  await sleep(100);

  // Run bad scenario
  console.log('2. Running BAD scenario (out of stock + payment failure):');
  const badTraceId = await runBadScenario();
  await sleep(100);

  // Flush spans
  console.log('');
  console.log('Flushing spans to collector...');
  await provider.forceFlush();
  await sleep(2000); // Wait for collector to forward to ClickHouse

  console.log('');
  console.log('Traces generated successfully!');
  console.log('');
  console.log('Next steps:');
  console.log(`  1. View traces:     Open http://localhost:3005/traces`);
  console.log(`  2. Inspect good:    http://localhost:3005/traces/${goodTraceId}`);
  console.log(`  3. Inspect bad:     http://localhost:3005/traces/${badTraceId}`);
  console.log(`  4. Compare:         http://localhost:3005/compare`);
  console.log(`     Good ID: ${goodTraceId}`);
  console.log(`     Bad ID:  ${badTraceId}`);
  console.log('');
  console.log('  5. Query via API:');
  console.log(`     curl http://localhost:3004/api/dt/traces/${goodTraceId}/summary | jq`);
  console.log(`     curl http://localhost:3004/api/dt/traces/${badTraceId}/summary | jq`);
  console.log(`     curl "http://localhost:3004/api/dt/diff?good=${goodTraceId}&bad=${badTraceId}" | jq`);
  console.log('');
  console.log('  6. Agent tools:');
  console.log(`     npx tsx demos/deeptrace-demo/agent-demo.ts ${goodTraceId} ${badTraceId}`);
  console.log('');

  await provider.shutdown();
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
