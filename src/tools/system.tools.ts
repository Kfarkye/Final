import { z } from "zod";
import { RegisteredTool } from "./types";

export const systemTools: RegisteredTool<any>[] = [
  {
    definition: {
      name: "get_current_time",
      description: "Returns the current date and time in the user's local timezone.",
      schema: z.object({})
    },
    handler: (_args: any, context: any) => {
      const now = new Date();
      const tz = context?.userTimezone || "America/New_York";
      return {
        utc: now.toISOString(),
        local: new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZoneName: "short",
        }).format(now),
        localDate: new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now),
        timeZone: tz,
      };
    }
  },
  {
    definition: {
      name: "run_script",
      description:
        "Run JavaScript code in a secure sandbox. " +
        "Code runs as an async function body — use `return` to emit a value and `await` for async. " +
        "`console.log/warn/error` output is captured in the `logs` array. " +
        "Results must be JSON-serializable (Promises are auto-awaited). " +
        "No network access. 64MB memory limit, 5s timeout. " +
        "Use this to verify JS semantics, run math proofs, test dedup logic with mock data, etc.",
      schema: z.object({
        code: z.string().min(1, "Code cannot be empty"),
        timeoutMs: z.number().int().min(100).max(10000).default(5000)
          .describe("Execution timeout in milliseconds (default: 5000, max: 10000)")
      })
    },
    handler: async (args) => {
      const ivm = (await import("isolated-vm")).default;
      const logs: string[] = [];
      const errors: string[] = [];
      const isolate = new ivm.Isolate({ memoryLimit: 64 });
      
      try {
        const context = await isolate.createContext();
        const jail = context.global;
        
        // Set up console capture via Reference callbacks
        const logCallback = new ivm.Reference((...msgArgs: any[]) => {
          logs.push(msgArgs.map(String).join(' '));
        });
        const errCallback = new ivm.Reference((...msgArgs: any[]) => {
          const msg = msgArgs.map(String).join(' ');
          logs.push(`[ERROR] ${msg}`);
          errors.push(msg);
        });
        const warnCallback = new ivm.Reference((...msgArgs: any[]) => {
          logs.push(`[WARN] ${msgArgs.map(String).join(' ')}`);
        });
        
        await jail.set('global', jail.derefInto());
        await jail.set('_logRef', logCallback);
        await jail.set('_errRef', errCallback);
        await jail.set('_warnRef', warnCallback);
        
        // Install console using evalClosure for proper Reference handling
        await context.eval(`
          global.console = {
            log: function() {
              var args = Array.prototype.slice.call(arguments);
              _logRef.applyIgnored(undefined, args, { arguments: { copy: true } });
            },
            error: function() {
              var args = Array.prototype.slice.call(arguments);
              _errRef.applyIgnored(undefined, args, { arguments: { copy: true } });
            },
            warn: function() {
              var args = Array.prototype.slice.call(arguments);
              _warnRef.applyIgnored(undefined, args, { arguments: { copy: true } });
            }
          };
        `);

        // P0 FIX: Wrap user code in an async IIFE so:
        //   1. Top-level `return` works (it's inside a function body)
        //   2. Top-level `await` works (it's an async function)
        //   3. The Promise is resolved INSIDE the isolate before crossing the boundary
        //
        // We JSON.stringify the result inside the isolate to avoid structured-clone
        // failures on Promises, class instances, functions, etc.
        const wrappedCode = `
          (async function() {
            try {
              ${args.code}
            } catch(e) {
              return { __error: true, message: String(e && e.message || e) };
            }
          })().then(function(val) {
            try {
              if (val === undefined) return JSON.stringify({ __type: 'undefined' });
              return JSON.stringify(val);
            } catch(e) {
              return JSON.stringify({ __serializationError: String(e) });
            }
          }).catch(function(e) {
            return JSON.stringify({ __error: true, message: String(e && e.message || e) });
          })
        `;

        const script = await isolate.compileScript(wrappedCode);
        const timeoutMs = args.timeoutMs || 5000;
        
        // Run returns the stringified promise result (already awaited inside)
        const rawResult = await script.run(context, { timeout: timeoutMs, promise: true });
        
        // Parse the JSON-serialized result
        let result: any;
        try {
          result = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
        } catch {
          result = String(rawResult);
        }

        // Check for user-code errors
        if (result && typeof result === 'object' && result.__error) {
          return {
            success: false,
            error: `Script error: ${result.message}`,
            logs,
          };
        }

        // Handle undefined return
        if (result && typeof result === 'object' && result.__type === 'undefined') {
          return { success: true, logs, result: logs.length > 0 ? logs : 'undefined (no return value)' };
        }

        return {
          success: true,
          logs,
          result: typeof result === 'object' ? JSON.stringify(result) : String(result),
        };

      } catch (err: any) {
        return {
          success: false,
          error: `Sandbox execution failed: ${err.message}`,
          logs,
          errors,
        };
      } finally {
        isolate.dispose();
      }
    }
  }
];
