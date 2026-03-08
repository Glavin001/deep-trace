/**
 * Next.js instrumentation entry point.
 * Place this at your project root as instrumentation.ts (Next.js auto-loads it).
 *
 * For non-Next.js projects, use --import instead:
 *   tsx --import ./lib/debug-probe/instrumentation.node.ts your-app.ts
 */
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { init } = await import('./instrumentation.node');
        init();
    }
}
